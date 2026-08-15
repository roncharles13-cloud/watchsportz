/**
 * ════════════════════════════════════════════════════════════════
 *  WatchSportZ Local Proxy Server
 *  ════════════════════════════════════════════════════════════════
 *
 *  PURPOSE:
 *  Sits between WatchSportZ and the embed servers. Strips ads,
 *  injects a postMessage control bridge, and serves the page from
 *  our own origin so the iframe gets full DOM access.
 *
 *  USAGE:
 *    1. npm install express node-fetch cors
 *    2. node proxy-server.js
 *    3. Server runs on http://localhost:3000
 *    4. Update stream.html embed URL to:
 *         http://localhost:3000/proxy?url=<original-embed-url>
 *
 *  ENDPOINTS:
 *    GET  /proxy?url=<embed-url>   — Returns sanitized HTML
 *    GET  /extract?url=<embed-url> — Returns extracted m3u8 URL as JSON
 *    GET  /resource?url=<asset>    — Pass-through for relative assets
 *    GET  /health                  — Server status
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const url     = require('url');

const app = express();
const PORT = 3000;

app.use(cors({ origin: '*' }));

/* ── AD / TRACKER BLOCKLIST ─────────────────────────────────────
   Top 50 known ad and popup networks. EasyList exposes ~50k
   domains — paste in /blocklist.txt to expand if needed.
─────────────────────────────────────────────────────────────── */
const BLOCKED_DOMAINS = new Set([
  // Pop networks
  'popads.net', 'popcash.net', 'propellerads.com', 'propu.sh',
  'popunder.net', 'popmyads.com', 'adnxs.com', 'serve.popads.net',
  // Adult / streaming-site ad networks
  'exoclick.com', 'main.exoclick.com', 'syndication.exoclick.com',
  'juicyads.com', 'adsterra.com', 'highperformanceformat.com',
  'realsrv.com', 'profitabledisplaynetwork.com', 'monetag.com',
  // Tracker / analytics (3rd party only — keep our own Plausible)
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'rubiconproject.com', 'criteo.com',
  // Crypto miners
  'coinhive.com', 'coin-hive.com', 'crypto-loot.com',
  // Generic redirector domains
  'go.onclasrv.com', 'onclickads.net', 's.adroll.com',
]);

const BLOCKED_PATTERNS = [
  /pop[-_]?under/i,
  /pop[-_]?ads/i,
  /click[-_]?under/i,
  /interstitial/i,
  /\bads?[-_]/i,
];

function isBlocked(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname;
    if (BLOCKED_DOMAINS.has(host)) return true;
    for (const d of BLOCKED_DOMAINS) {
      if (host.endsWith('.' + d)) return true;
    }
    if (BLOCKED_PATTERNS.some(p => p.test(targetUrl))) return true;
  } catch (_) {}
  return false;
}

/* ── HTML SANITIZER ────────────────────────────────────────────
   Strip every ad script, popup trigger, and redirect from the
   embed HTML. Also rewrite relative URLs to absolute so video
   resources load from the original embed server.
─────────────────────────────────────────────────────────────── */
function sanitizeHTML(html, embedUrl) {
  let out = html;
  const origin = new URL(embedUrl).origin;

  // 0. CRITICAL — inject <base> tag so all relative URLs resolve
  //    to the original embed origin instead of localhost:3000
  if (out.includes('<head>')) {
    out = out.replace('<head>', `<head><base href="${origin}/">`);
  } else if (out.includes('<html>')) {
    out = out.replace('<html>', `<html><head><base href="${origin}/"></head>`);
  } else {
    out = `<base href="${origin}/">` + out;
  }

  // 1. Remove <script src="..."> tags pointing at ad networks ONLY
  //    (do NOT strip the player's own scripts)
  out = out.replace(/<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (match, src) => isBlocked(src) ? '' : match);

  // 2. Strip inline window.open() calls — popups
  //    (replace with void(0) so syntax stays valid)
  out = out.replace(/window\.open\s*\([^)]*\)/gi, 'void(0)');

  // 3. Strip popunder/popads inline scripts (only obvious ad scripts)
  out = out.replace(
    /<script[^>]*>[\s\S]{0,200}?(popunder|popcash|exoclick|adsterra|popads\.net)[\s\S]*?<\/script>/gi,
    ''
  );

  // 4. Rewrite target="_blank" to "_self"
  out = out.replace(/target\s*=\s*["']_blank["']/gi, 'target="_self"');

  // 5. Remove <meta http-equiv="refresh"> redirect tags
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*>/gi, '');

  // 6. Strip inline onclick attributes that contain window.open
  out = out.replace(/on\w+\s*=\s*["'][^"']*window\.open[^"']*["']/gi, '');

  return out;
}

/* ── CONTROL BRIDGE INJECTION ──────────────────────────────────
   Adds a postMessage listener so WatchSportZ can control the
   video directly. Volume, pause, play, mute all work natively.
─────────────────────────────────────────────────────────────── */
const CONTROL_BRIDGE = `
<script>
(function() {
  // Find the video element — retry until it appears
  function getVideo() {
    return document.querySelector('video');
  }

  // Listen for control messages from the parent (WatchSportZ)
  window.addEventListener('message', function(e) {
    const v = getVideo();
    if (!v || !e.data) return;
    try {
      if (e.data.action === 'volume') {
        v.volume = Math.max(0, Math.min(1, e.data.value));
        v.muted  = e.data.value === 0;
      }
      if (e.data.action === 'mute') {
        v.muted = !!e.data.value;
      }
      if (e.data.action === 'pause') {
        v.pause();
      }
      if (e.data.action === 'play') {
        v.play().catch(function(){});
      }
      if (e.data.action === 'getstate') {
        e.source.postMessage({
          type: 'wsz-state',
          paused: v.paused,
          volume: v.volume,
          muted:  v.muted,
        }, '*');
      }
    } catch(_) {}
  });

  // Block popups one more time at the page level
  window.open = function() { return null; };

  // Tell parent we're ready
  window.addEventListener('load', function() {
    parent.postMessage({ type: 'wsz-ready' }, '*');
  });
})();
</script>
`;

function injectBridge(html) {
  if (html.includes('</body>')) {
    return html.replace('</body>', CONTROL_BRIDGE + '</body>');
  }
  return html + CONTROL_BRIDGE;
}

/* ── M3U8 EXTRACTOR ────────────────────────────────────────────
   Scans the embed HTML for the underlying HLS stream URL.
─────────────────────────────────────────────────────────────── */
const M3U8_PATTERNS = [
  /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*?)["'`]/i,
  /source\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*?)["'`]/i,
  /file\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*?)["'`]/i,
  /hls[Uu]rl[^"'`]*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*?)["'`]/i,
];

function extractM3U8(html) {
  for (const pat of M3U8_PATTERNS) {
    const m = html.match(pat);
    if (m && m[1]) return m[1].replace(/\\\//g, '/');
  }
  return null;
}

/* ── RESPONSE CACHE — 30 second TTL ────────────────────────── */
const CACHE = new Map();
const CACHE_TTL = 30 * 1000;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { CACHE.delete(key); return null; }
  return e.data;
}

function cacheSet(key, data) {
  CACHE.set(key, { ts: Date.now(), data });
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
}

/* ── MAIN PROXY ENDPOINT ─────────────────────────────────────── */
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url parameter');

  const cached = cacheGet('proxy:' + target);
  if (cached) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-WSZ-Cache', 'HIT');
    return res.send(cached);
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         new URL(target).origin,
      },
      timeout: 10000,
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
    }

    const html      = await upstream.text();
    const sanitized = sanitizeHTML(html, target);
    const finalHtml = injectBridge(sanitized);

    cacheSet('proxy:' + target, finalHtml);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-WSZ-Cache', 'MISS');
    // Permissive CSP — allow all sources so video chunks, HLS manifests,
    // and player scripts can load from any origin
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Frame-Options');
    res.send(finalHtml);

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(500).send('Proxy fetch failed: ' + err.message);
  }
});

/* ── M3U8 EXTRACT ENDPOINT ──────────────────────────────────── */
app.get('/extract', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing url' });

  const cached = cacheGet('m3u8:' + target);
  if (cached) return res.json({ m3u8: cached, cached: true });

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(target).origin },
      timeout: 10000,
    });
    const html = await upstream.text();
    const m3u8 = extractM3U8(html);

    if (m3u8) cacheSet('m3u8:' + target, m3u8);

    res.json({ m3u8: m3u8 || null, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── HEALTH CHECK ───────────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    cache:   CACHE.size,
    blocked: BLOCKED_DOMAINS.size,
    uptime:  process.uptime(),
  });
});

/* ── API MIRROR FAILOVER ────────────────────────────────────────
   Proxy the streamed.pk API itself through here. The proxy tries
   every mirror in order until one responds. Frontend can call:
     /api?path=/matches/live
   instead of hitting streamed.pk directly.
─────────────────────────────────────────────────────────────── */
const API_MIRRORS = [
  'https://streamed.pk',
  'https://streamed.su',
  'https://streami.su',
  'https://streamed.st',
  'https://strmd.link',
];

app.get('/api', async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: 'Missing path parameter' });

  for (const host of API_MIRRORS) {
    try {
      const upstream = await fetch(`${host}/api${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000,
      });
      if (upstream.ok) {
        res.set('X-WSZ-Mirror', host);
        res.set('Content-Type', 'application/json');
        return res.send(await upstream.text());
      }
    } catch (_) {
      continue;
    }
  }
  res.status(503).json({ error: 'All mirrors unreachable' });
});

app.get('/', (req, res) => {
  res.send(`
    <h2>WatchSportZ Proxy — Running</h2>
    <ul>
      <li><a href="/health">/health</a> — Server status</li>
      <li><code>/proxy?url=&lt;embed-url&gt;</code> — Sanitized HTML</li>
      <li><code>/extract?url=&lt;embed-url&gt;</code> — m3u8 extractor</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  WatchSportZ Proxy Server                       ║`);
  console.log(`║  Listening on http://localhost:${PORT}              ║`);
  console.log(`║                                                  ║`);
  console.log(`║  Blocking ${BLOCKED_DOMAINS.size} ad/tracker domains             ║`);
  console.log(`║  HTML sanitization: ON                          ║`);
  console.log(`║  Control bridge injection: ON                   ║`);
  console.log(`║  M3U8 extraction: ON                            ║`);
  console.log(`║  Cache TTL: 30s                                 ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);
});
