/**
 * ════════════════════════════════════════════════════════════════
 *  WatchSportZ — Feed-Health Canary   (Cloudflare Worker + Browser Rendering)
 * ════════════════════════════════════════════════════════════════
 *  A "robot viewer" that runs on a cron, headless-loads a rotating sample of
 *  live embeds, and checks whether real video actually plays — the token gets
 *  minted, segments flow, and video.currentTime advances. It writes per-source
 *  liveness into the SAME KV the site's feed-health uses, so the health map
 *  reflects real playback tested by a robot: the site knows which feeds work
 *  BEFORE any human clicks. This catches "resolves but dead" feeds (e.g. a 500
 *  manifest, or a feed that never buffers) that resolve-only pre-warm can't see.
 *
 *  This is a SEPARATE deployment from the static Pages site. It needs:
 *    • Browser Rendering enabled on the account (Workers Paid; metered)
 *    • the FEED_HEALTH KV namespace  (the SAME id the Pages Function binds)
 *    • a cron trigger
 *  See ./README.md.
 * ════════════════════════════════════════════════════════════════
 */
import puppeteer from '@cloudflare/puppeteer';

const API_BASE   = 'https://streamed.st';
const KV_KEY     = 'feed_health';       // shared with the Pages Function + client
const CURSOR_KEY = 'canary_cursor';     // rotation offset so all live feeds get covered
const PROVIDER   = 'streamed-st';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ── cost / coverage knobs — raise for coverage, lower for cost ── */
const SAMPLE_MATCHES = 6;      // matches sampled per run (rotates through all live)
const MAX_FEEDS      = 8;      // hard cap on headless page loads per run
const PLAY_WAIT_MS   = 9000;   // let the player mint its token + buffer
const CONFIRM_MS     = 3500;   // window to confirm currentTime advances
const WEIGHT         = 2;      // a canary check counts a bit heavier than one user outcome
const DECAY_AT       = 400;    // rolling-window halving (matches the Pages Function)

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runCanary(env)); },

  // manual trigger for testing:  GET https://<worker>/?key=<CANARY_SECRET>
  async fetch(req, env) {
    const url = new URL(req.url);
    if (env.CANARY_SECRET && url.searchParams.get('key') !== env.CANARY_SECRET)
      return new Response('forbidden', { status: 403 });
    const summary = await runCanary(env);
    return new Response(JSON.stringify(summary, null, 2),
      { headers: { 'Content-Type': 'application/json' } });
  },
};

async function jget(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function record(deltas, sig, ok) {
  const d = deltas[sig] || (deltas[sig] = { ok: 0, bad: 0 });
  d[ok ? 'ok' : 'bad'] += WEIGHT;
}

async function runCanary(env) {
  const t0 = Date.now();
  const deltas = {};
  const results = [];

  // 1) live matches, rotated via a persisted cursor so all get covered over runs
  let live = [];
  try { live = await jget('/api/matches/live'); } catch (_) {}
  const withSrc = (Array.isArray(live) ? live : []).filter(m => m.sources && m.sources.length);
  if (!withSrc.length) return { tested: 0, note: 'no live matches with sources', ms: Date.now() - t0 };
  withSrc.sort((a, b) => (b.popular - a.popular) || (a.date - b.date));

  let cursor = 0;
  if (env.FEED_HEALTH) cursor = parseInt((await env.FEED_HEALTH.get(CURSOR_KEY)) || '0', 10) || 0;
  const start = (((cursor % withSrc.length) + withSrc.length) % withSrc.length);
  const sample = [];
  for (let i = 0; i < Math.min(SAMPLE_MATCHES, withSrc.length); i++)
    sample.push(withSrc[(start + i) % withSrc.length]);
  if (env.FEED_HEALTH)
    await env.FEED_HEALTH.put(CURSOR_KEY, String((start + SAMPLE_MATCHES) % withSrc.length));

  // 2) resolve sources → one embed URL per source type. A resolve-fail is a dead
  //    source and needs no (expensive) browser load — record it and move on.
  const targets = [];
  for (const m of sample) {
    for (const s of m.sources) {
      if (targets.length >= MAX_FEEDS) break;
      const sig = `${PROVIDER}/${s.source}`;
      try {
        const d = await jget(`/api/stream/${s.source}/${s.id}`);
        if (Array.isArray(d) && d.length && d[0].embedUrl)
          targets.push({ sig, embedUrl: d[0].embedUrl, match: m.title });
        else record(deltas, sig, false);
      } catch (_) { record(deltas, sig, false); }
    }
    if (targets.length >= MAX_FEEDS) break;
  }

  // 3) headless playback test for each resolved feed
  if (targets.length && env.BROWSER) {
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      for (const t of targets) {
        const r = await probe(browser, t.embedUrl);
        record(deltas, t.sig, !!r.playing);
        results.push({ sig: t.sig, match: t.match, playing: !!r.playing, ...r });
      }
    } catch (e) {
      results.push({ error: String(e).slice(0, 140) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // 4) merge into the shared KV (same key/format the client + Pages Function use)
  await mergeKV(env, deltas);
  return { tested: targets.length, deltas, results, ms: Date.now() - t0 };
}

// Load an embed top-level (no sandbox → the gate doesn't fire), let the real
// player run, and confirm actual playback (data present + frames advancing).
async function probe(browser, embedUrl) {
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return await page.evaluate(async (PLAY_WAIT_MS, CONFIRM_MS) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await sleep(PLAY_WAIT_MS);
      const v = document.querySelector('video');
      if (!v) return { playing: false, reason: 'no-video' };
      v.muted = true; try { await v.play(); } catch (_) {}
      const t0 = v.currentTime;
      await sleep(CONFIRM_MS);
      return {
        playing: v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > t0,
        readyState: v.readyState, w: v.videoWidth,
      };
    }, PLAY_WAIT_MS, CONFIRM_MS);
  } catch (e) {
    return { playing: false, reason: String(e).slice(0, 60) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function mergeKV(env, deltas) {
  if (!env.FEED_HEALTH || !Object.keys(deltas).length) return;
  const cur = JSON.parse((await env.FEED_HEALTH.get(KV_KEY)) || '{}');
  for (const [sig, d] of Object.entries(deltas)) {
    const r = cur[sig] || (cur[sig] = { ok: 0, bad: 0 });
    r.ok += d.ok; r.bad += d.bad;
    if (r.ok + r.bad > DECAY_AT) { r.ok *= 0.5; r.bad *= 0.5; }   // rolling decay
  }
  await env.FEED_HEALTH.put(KV_KEY, JSON.stringify(cur));
}
