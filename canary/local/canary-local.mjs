#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════
 *  WatchSportZ — Feed-Health Canary  ·  LOCAL (Windows) edition
 * ════════════════════════════════════════════════════════════════
 *  A free "robot viewer" that runs on YOUR PC (no cloud cost). On each run it
 *  headless-loads a rotating sample of live embeds with Playwright, checks
 *  whether video actually plays (token minted, currentTime advancing), and
 *  POSTs per-source liveness to your site's free /api/feed-health endpoint
 *  (Cloudflare Pages Function + KV). Schedule it with Windows Task Scheduler.
 *
 *  Requires: Node 18+, `npm install` here (downloads Chromium), and the crowd
 *  backend deployed so /api/feed-health accepts POSTs. See ./README.md.
 * ════════════════════════════════════════════════════════════════
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = existsSync(join(__dir, 'config.json'))
  ? JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8')) : {};

const ENDPOINT = process.env.WSZ_HEALTH_ENDPOINT || cfg.endpoint || 'https://watchsportz.pages.dev/api/feed-health';
const SECRET   = process.env.WSZ_CANARY_SECRET  || cfg.secret  || '';   // optional; see README
const API_BASE = cfg.apiBase || 'https://streamed.st';
const PROVIDER = 'streamed-st';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* cost/coverage knobs (override in config.json) */
const SAMPLE_MATCHES = cfg.sampleMatches ?? 6;
const MAX_FEEDS      = cfg.maxFeeds      ?? 8;
const PLAY_WAIT_MS   = cfg.playWaitMs    ?? 9000;
const CONFIRM_MS     = cfg.confirmMs     ?? 3500;
const WEIGHT         = cfg.weight        ?? 2;
// IMPORTANT: embed.st BLOCKS headless Chrome (shows "Remove sandbox attributes"
// instead of the player). Headful works. So default to headful — a browser
// window appears each run. Set "headless": true in config only if you've added
// stealth that defeats their detection. (proven 2026-08-15)
const HEADLESS       = cfg.headless      ?? false;
const CURSOR_FILE    = join(__dir, 'canary-cursor.txt');

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function jget(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
function record(deltas, sig, ok) {
  const d = deltas[sig] || (deltas[sig] = { ok: 0, bad: 0 });
  d[ok ? 'ok' : 'bad'] += WEIGHT;
}
const readCursor  = () => { try { return parseInt(readFileSync(CURSOR_FILE, 'utf8'), 10) || 0; } catch { return 0; } };
const writeCursor = (n) => { try { writeFileSync(CURSOR_FILE, String(n)); } catch {} };

// Load an embed top-level (no sandbox → no ad gate), let the real player run,
// and confirm actual playback: data present + frames advancing.
async function probe(browser, embedUrl) {
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  try {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return await page.evaluate(async ({ w, c }) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await sleep(w);
      const v = document.querySelector('video');
      if (!v) return { playing: false, reason: 'no-video' };
      v.muted = true; try { await v.play(); } catch (_) {}
      const t0 = v.currentTime;
      await sleep(c);
      return { playing: v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > t0, readyState: v.readyState, w: v.videoWidth };
    }, { w: PLAY_WAIT_MS, c: CONFIRM_MS });
  } catch (e) {
    return { playing: false, reason: String(e).slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const deltas = {}, results = [];

  // 1) live matches, rotated by a local cursor file so all get covered
  let live = [];
  try { live = await jget('/api/matches/live'); } catch (e) { log('live fetch failed:', e.message); }
  const withSrc = (Array.isArray(live) ? live : []).filter(m => m.sources && m.sources.length);
  if (!withSrc.length) { log('no live matches with sources — nothing to do'); return; }
  withSrc.sort((a, b) => (b.popular - a.popular) || (a.date - b.date));

  const cursor = readCursor();
  const start = (((cursor % withSrc.length) + withSrc.length) % withSrc.length);
  const sample = [];
  for (let i = 0; i < Math.min(SAMPLE_MATCHES, withSrc.length); i++) sample.push(withSrc[(start + i) % withSrc.length]);
  writeCursor((start + SAMPLE_MATCHES) % withSrc.length);

  // 2) resolve sources → embed URLs; a resolve-fail is dead, no browser needed
  const targets = [];
  for (const m of sample) {
    for (const s of m.sources) {
      if (targets.length >= MAX_FEEDS) break;
      const sig = `${PROVIDER}/${s.source}`;
      try {
        const d = await jget(`/api/stream/${s.source}/${s.id}`);
        if (Array.isArray(d) && d.length && d[0].embedUrl) targets.push({ sig, embedUrl: d[0].embedUrl, match: m.title });
        else record(deltas, sig, false);
      } catch (_) { record(deltas, sig, false); }
    }
    if (targets.length >= MAX_FEEDS) break;
  }

  // 3) headless playback test
  if (targets.length) {
    const browser = await chromium.launch({ headless: HEADLESS });
    try {
      for (const t of targets) {
        const r = await probe(browser, t.embedUrl);
        record(deltas, t.sig, !!r.playing);
        results.push({ sig: t.sig, playing: !!r.playing });
        log(`probe ${t.sig.padEnd(18)} "${(t.match || '').slice(0, 32)}" → ${r.playing ? 'PLAYING' : 'dead'} (${r.reason || 'rs' + r.readyState})`);
      }
    } finally { await browser.close().catch(() => {}); }
  }

  // 4) POST liveness to the shared endpoint (free Pages Function → free KV)
  if (Object.keys(deltas).length) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (SECRET) headers['X-WSZ-Key'] = SECRET;
      const r = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ deltas }) });
      log(`POST ${ENDPOINT} → ${r.status}  ${JSON.stringify(deltas)}`);
    } catch (e) { log('POST failed:', e.message); }
  } else {
    log('no deltas to send');
  }
}

main().then(() => process.exit(0)).catch(e => { log('fatal:', e); process.exit(1); });
