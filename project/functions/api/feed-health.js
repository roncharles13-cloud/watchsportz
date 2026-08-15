/**
 * ════════════════════════════════════════════════════════════════
 *  WatchSportZ — Shared Feed-Health store  (Cloudflare Pages Function)
 * ════════════════════════════════════════════════════════════════
 *  Pools per-source stream reliability across ALL viewers so the player
 *  can prefer sources that are actually working right now, network-wide.
 *
 *  ROUTES  (served at  /api/feed-health  because this file lives at
 *           functions/api/feed-health.js):
 *    GET  → the global map  { "provider/source": {ok, bad}, ... }
 *    POST → body { deltas: { "provider/source": {ok, bad}, ... } }
 *           increments the map (bounded, decayed, validated)
 *
 *  SETUP (one time, in the Cloudflare dashboard):
 *    1. Workers & Pages → KV → Create namespace, e.g. "wsz-feed-health".
 *    2. Your Pages project → Settings → Functions → KV namespace bindings
 *       → add binding  Variable name: FEED_HEALTH  →  that namespace.
 *    3. Redeploy. Done. (Local test: `npx wrangler pages dev project
 *       --kv FEED_HEALTH`.)
 *
 *  If the KV binding is missing the endpoint still answers (GET → {},
 *  POST → 503) and the site falls back to per-browser health — nothing
 *  breaks, you just don't get the crowd signal until it's bound.
 * ════════════════════════════════════════════════════════════════
 */

const KEY       = 'feed_health';
const MAX_SIGS  = 200;   // cap distinct sources — guards against key explosion
const MAX_DELTA = 50;    // per-request per-source increment cap (anti-abuse)
const DECAY_AT  = 400;   // when ok+bad passes this, halve both (rolling window)
const SIG_RE    = /^[\w.-]+\/[\w.-]+$/;   // "provider/source"

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ env }) {
  const raw = env.FEED_HEALTH ? (await env.FEED_HEALTH.get(KEY)) : null;
  return new Response(raw || '{}', {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',   // cheap: edge-cache reads for 60s
      ...CORS,
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.FEED_HEALTH) {
    return new Response('KV namespace FEED_HEALTH not bound', { status: 503, headers: CORS });
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return new Response('bad json', { status: 400, headers: CORS }); }

  const deltas = body && body.deltas;
  if (!deltas || typeof deltas !== 'object') {
    return new Response('missing deltas', { status: 400, headers: CORS });
  }

  // read-modify-write. KV is last-write-wins, so concurrent writers can drop a
  // few increments — fine for a statistical heuristic, and client flushes are
  // throttled (~90s) so simultaneous writers are rare.
  const cur = JSON.parse((await env.FEED_HEALTH.get(KEY)) || '{}');
  let count = Object.keys(cur).length;

  for (const [sig, d] of Object.entries(deltas)) {
    if (typeof sig !== 'string' || sig.length > 64 || !SIG_RE.test(sig)) continue;
    const addOk  = Math.max(0, Math.min(MAX_DELTA, Math.floor(Number(d && d.ok)  || 0)));
    const addBad = Math.max(0, Math.min(MAX_DELTA, Math.floor(Number(d && d.bad) || 0)));
    if (!addOk && !addBad) continue;

    let r = cur[sig];
    if (!r) { if (count >= MAX_SIGS) continue; r = cur[sig] = { ok: 0, bad: 0 }; count++; }
    r.ok  += addOk;
    r.bad += addBad;
    if (r.ok + r.bad > DECAY_AT) { r.ok *= 0.5; r.bad *= 0.5; }   // rolling decay
  }

  await env.FEED_HEALTH.put(KEY, JSON.stringify(cur));
  return new Response(null, { status: 204, headers: CORS });
}
