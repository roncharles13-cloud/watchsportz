# WatchSportZ Feed-Health Canary — Local (Windows) edition

A **free** "robot viewer" that runs on **your own PC**. Every run it headless-loads a
rotating sample of live embeds with Playwright, checks whether the video actually
plays, and POSTs per-source liveness to your site's free `/api/feed-health` endpoint.
No Cloudflare Browser Rendering, no paid plan — it uses your machine's Chromium and
your existing free KV.

**Tradeoff vs a cloud canary:** it only runs while your PC is on and online, so there
are gaps when the machine is off. That's fine — the crowd + client pre-resolve cover
those gaps; the local canary just keeps the health map fresh with real playback tests
whenever your PC is running.

---

## Prerequisites
- **Node.js 18+** installed (`node --version`).
- The **crowd backend deployed** — the `functions/api/feed-health.js` Pages Function +
  the `FEED_HEALTH` KV binding (see the main `project/` README). The canary POSTs to it.

## One-time setup
```powershell
cd canary\local
npm install                 # installs Playwright + downloads Chromium (~130 MB, once)
copy config.example.json config.json
# edit config.json → set "endpoint" to your live site's /api/feed-health
```

## Test it by hand first
```powershell
node canary-local.mjs
```
You'll see lines like:
```
2026-08-15T… probe streamed-st/admin  "Chicago Cubs vs …" → PLAYING (rs4)
2026-08-15T… probe streamed-st/echo   "…"                 → dead (no-video)
2026-08-15T… POST https://…/api/feed-health → 204  {"streamed-st/admin":{"ok":2,"bad":0},…}
```
Then confirm the map is filling: open `https://<your-site>/api/feed-health` — the
sampled sources should appear. (The probe lines work even before the backend is
deployed; only the final POST needs it.)

## Schedule it (Windows Task Scheduler)
Run every 15 minutes via the included `run-canary.cmd` (logs to `canary.log`):

**One-liner (PowerShell/CMD, adjust the path):**
```
schtasks /Create /SC MINUTE /MO 15 /TN "WatchSportZ Canary" /TR "\"D:\OneDrive\Desktop\STREAM\STREAM\canary\local\run-canary.cmd\"" /RL LIMITED /F
```
**or via the GUI:** Task Scheduler → Create Task → Triggers: *Repeat every 15 minutes*
→ Actions: *Start a program* → `run-canary.cmd` → check *Run whether user is logged on
or not*.

Remove it later with: `schtasks /Delete /TN "WatchSportZ Canary" /F`

---

## Knobs (`config.json`)
| Key | Default | Effect |
|---|---|---|
| `sampleMatches` | 6 | matches sampled per run (rotates through all live via `canary-cursor.txt`) |
| `maxFeeds` | 8 | hard cap on headless loads per run |
| `playWaitMs` / `confirmMs` | 9000 / 3500 | how long to wait for playback / confirm frames advance |
| `weight` | 2 | how heavily a canary check counts vs one user outcome |
| `secret` | "" | optional; sent as `X-WSZ-Key`. No-op unless you add a matching check to the Pages Function (the endpoint is public by design — browser flushes post to it too — and is protected by the function's validation caps) |

## Runs HEADFUL (a browser window appears each run) — this is required
**Proven 2026-08-15:** embed.st **detects and blocks headless Chrome** — in headless mode
it shows *"Remove sandbox attributes on the iframe tag"* instead of the player, so every
feed reads as dead. In **headful** mode the same feed plays (1080p, confirmed). So the
canary defaults to `"headless": false`, and a Chromium window pops up while it probes.

This is also *why the cloud version can't work*: Cloudflare Browser Rendering (and most
serverless headless options) are headless-only, so they'd be blocked. Running headful on
your own PC is the thing that actually works.

**Living with the window:**
- It opens and closes on its own each run (~1–3 min). Annoying but harmless.
- To keep it out of your way: run the task under a **separate Windows user account**
  ("Run whether user is logged on or not" runs it in a background session), or schedule
  it for hours you're away, or just let it flash by.
- If you later defeat their detection with a stealth setup, set `"headless": true` in
  `config.json` to go windowless.
