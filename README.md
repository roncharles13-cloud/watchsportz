# WatchSportZ — Project Archive

Live sports streaming web app. Open this folder in Claude Code to continue work.

## Structure

- `project/` — all source files (100% static, no build step)
  - `stream.html` — MAIN FILE. The full single-page app (player, sidebar, ticker, controls, streamed.st API).
  - `index.html` — SEO landing page
  - `analytics.html` — admin dashboard (reads localStorage)
  - `widget.html` — embeddable ticker (runs on 3rd-party sites)
  - `proxy-server.js` — local Node/Express ad-strip proxy. **Not used in production** (kept for reference; it can't defeat the embed's session-bound token — see notes below).
  - `package.json`, `PROXY-README.md` — proxy deps/docs (reference only)
- `transcripts/` — full development conversation history

## Live deployment
- Cloudflare Pages: **watchsportz.pages.dev** (static file drop, no server)

## Data source (updated 2026-08-15)
**Single source: `https://streamed.st`** — the surviving official mirror of the streamed.* API.
- Endpoints used: `/api/sports`, `/api/matches/{live,all-today,all}`, `/api/stream/{source}/{id}`, `/api/images/badge|proxy/*.webp`
- CORS `*`, so the static site calls it directly from the browser.
- Per-mode fetch (Live/Today/Upcoming hit different endpoints) with a 60s cache.
- Previous sources are dead: `streamed.pk` (offline), `ws.kora-api.space` (Kora — served a stale, no-live feed).

## Streams / player
- All streams embed from `embed.st` (only provider; every source type funnels there).
- The player iframe sandbox is **loosened** (`allow-popups allow-top-navigation-by-user-activation`) because embed.st refuses to play in a restrictive sandbox and delivers the video token through its ad flow (WASM + POST `/fetch`, session/fingerprint-bound). Tradeoff: popup ads partly return; documented inline at the iframe tag in `stream.html`.
- Ad-free playback would require a full rewriting media proxy (server + bandwidth + upkeep) and is likely blocked by the embed's fingerprinting — not pursued. Client-side (uBlock Origin / blocking DNS) is the practical ad blocker.
- Multi-feed switcher: each match's sources are fetched in parallel and offered as switchable feeds via the "📺 N feeds" button (mobile-friendly), so a dead feed has fallbacks.

## Run locally
Static site — no server needed. Simplest:
```
cd project
python -m http.server 8777
# then open http://localhost:8777/stream.html
```

## Resilience layer (dead-provider defense)
`stream.html` learns which upstream sources actually deliver a working stream and prefers them:
- **Provider registry** (`PROVIDERS`) — adding/replacing a provider is a config entry, not a code change.
- **Feed-health** — per-`provider/source` score (Laplace-smoothed, decayed) learned from resolve success + playback dwell (≥30s = good; quick bail = bad). Stored in `localStorage['wsz_feed_health_v1']`.
- **Smart default** — best-health feed is auto-selected; **assisted failover** nudges "⟳ Next feed" after ~9s.
- **Scoreboard** — analytics.html → "Feed Reliability" panel (green/amber/red; ◆ = crowd-backed).

## Shared feed-health backend (optional — pools health across ALL viewers)
Without it, each browser learns on its own (still works). With it, a new visitor benefits from everyone's
experience immediately. It's a Cloudflare Pages Function + KV, already written at
`project/functions/api/feed-health.js` (served at `/api/feed-health`). To enable:
1. Cloudflare dashboard → **Workers & Pages → KV → Create namespace** (e.g. `wsz-feed-health`).
2. Your Pages project → **Settings → Functions → KV namespace bindings** → add
   **Variable name: `FEED_HEALTH`** → the namespace above.
3. Redeploy (make sure the `functions/` folder is included in the upload).
4. Verify: `GET /api/feed-health` returns JSON `{}` (then fills as people watch).
- Local test: `npx wrangler pages dev project --kv FEED_HEALTH`
- Free tier is fine (client batches writes, ~1 flush / 90s / viewer, edge-cached reads). If a huge match
  exceeds KV's free 1k writes/day, KV paid is ~$5/mo. The site degrades gracefully if the binding is absent.

## Deploy (Cloudflare Pages)
1. Cloudflare dashboard → Pages → your project → **Create deployment** (or drag-and-drop upload).
2. Upload the contents of `project/` — the HTML pages **and the `functions/` folder** (for the shared backend).
3. No build command, no output dir — it's static (+ Pages Functions auto-detected from `functions/`).
4. Verify `watchsportz.pages.dev/stream.html` loads live matches and a match plays.

## Deploy (GitHub Pages) — free static hosting
The site is GitHub-Pages-ready: all internal links are relative, and it works served from a
project-page subpath (`https://<user>.github.io/<repo>/`). The included workflow
(`.github/workflows/pages.yml`) publishes **only** the `project/` folder.

1. Push this repo to GitHub (see steps below).
2. Repo → **Settings → Pages → Source: GitHub Actions**.
3. The workflow deploys on every push to `main`; your site is at
   `https://<user>.github.io/<repo>/` (entry page: `index.html`, app: `stream.html`).

**Important differences vs Cloudflare Pages:**
- GitHub Pages is **static only** — there are no Functions, so `/api/feed-health` does not
  exist. The client detects this and falls back to **per-browser** health (still fully
  functional: live matches, pre-resolve, health ranking, feed switcher all work). The
  **crowd backend and the canary do not apply on GitHub Pages** — they need a Function host
  (Cloudflare Pages) to POST to.
- **Free GitHub Pages requires a PUBLIC repo.** The `.gitignore` excludes `transcripts/`,
  `.remember/`, `.claude/`, `node_modules/`, and secret configs so they aren't exposed — but
  the site code itself will be public.

### First push
```bash
cd "D:\OneDrive\Desktop\STREAM\STREAM"
git init -b main
git add .
git commit -m "WatchSportZ site + resilience layer"
gh repo create watchsportz --public --source=. --push   # or --private (Pages needs GitHub Pro)
```
Then enable Pages (step 2 above).
