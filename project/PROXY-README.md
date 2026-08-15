# WatchSportZ Proxy Server

Local Node/Express server that sits between WatchSportZ and the embed providers.
Strips ads, blocks popups, and injects a postMessage control bridge so the volume
slider, mute, pause, and play actually control the player.

---

## What It Does

1. **Strips ad scripts** from embed HTML before serving — popups never load
2. **Blocks ~50 ad/tracker domains** at the network level (EasyList compatible)
3. **Injects a control bridge** so `postMessage` from WatchSportZ controls the video natively
4. **Extracts m3u8 URLs** for direct HLS playback (bypass iframe entirely when possible)
5. **Caches sanitized pages** for 30 seconds — instant re-loads

---

## Setup (PowerShell)

```powershell
# 1. Install Node.js if not already (check with: node --version)
# 2. Install dependencies
npm install

# 3. Start the proxy
npm start
```

The proxy runs on `http://localhost:3000`.

---

## How WatchSportZ Connects

In `stream.html`, find the `loadStream` function. Change:

```javascript
$playerFrame.src = stream.embedUrl;
```

To:

```javascript
$playerFrame.src = `http://localhost:3000/proxy?url=${encodeURIComponent(stream.embedUrl)}`;
```

That's it. The iframe now loads from your local proxy. Same-origin policy is
satisfied. Volume control, pause, mute — all work directly because we own the page.

---

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /proxy?url=<embed-url>` | Sanitized embed HTML with control bridge injected |
| `GET /extract?url=<embed-url>` | Returns extracted m3u8 URL as JSON |
| `GET /health` | Server status, cache size, uptime |
| `GET /` | API documentation |

---

## Architecture

```
WatchSportZ (browser)
    ↓
    iframe.src = localhost:3000/proxy?url=<embed>
    ↓
Local Express Proxy
    ├── Server-side fetch (no CORS)
    ├── HTML sanitizer
    │     ├── Strip ad <script> tags by domain match
    │     ├── Remove window.open() inline calls
    │     ├── Rewrite target="_blank" to "_self"
    │     └── Strip meta refresh redirects
    ├── Control bridge injection (postMessage listener)
    └── Send cleaned HTML from localhost:3000
        ↓
    iframe loads cleaned page (same-origin!)
        ├── Volume slider works (direct video.volume)
        ├── Pause works (direct video.pause())
        ├── No ads anywhere
        ├── No popups
        └── No trackers
```

---

## Going to Production

This server runs locally. To ship publicly, deploy the same code to:
- **Netlify Edge Function** — recommended, runs at the edge globally
- **Cloudflare Worker** — same idea, different platform
- **Small VPS** — DigitalOcean droplet, ~$5/mo

Update WatchSportZ to point to your production URL instead of `localhost:3000`.

---

## Customizing the Blocklist

Open `proxy-server.js` and edit the `BLOCKED_DOMAINS` Set near the top.
You can also paste in EasyList domains for ~50,000 entries automatically.

---

## Troubleshooting

**Volume slider still doesn't work?** Open browser DevTools → Console. You should
see `wsz-ready` messages from the iframe. If not, the proxy isn't being hit —
check the iframe `src` URL.

**Page doesn't load?** Check `http://localhost:3000/health` — if that returns
JSON, the server is running. The embed URL might be blocking server-side requests.

**Streams broken?** Some embed providers detect proxies via header inspection.
The proxy spoofs a Chrome User-Agent and Referer, but anti-bot systems can still
fail. Check the proxy console for errors.
