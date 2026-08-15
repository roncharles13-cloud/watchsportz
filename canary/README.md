# WatchSportZ Feed-Health Canary

> ⚠️ **Likely blocked — prefer `local/` instead.** Proven 2026-08-15: embed.st detects
> and blocks **headless** Chrome (shows "Remove sandbox attributes" instead of the
> player). Cloudflare Browser Rendering is headless-only, so this cloud version will
> probably report every feed as dead. The working canary is **`canary/local/`**, which
> runs **headful** Chromium on your own PC. This cloud version is kept only in case a
> future stealth setup defeats their headless detection.

A **"robot viewer"** — a Cloudflare Worker that runs on a cron, headless-loads a
rotating sample of live embeds, checks whether video **actually plays**, and writes
per-source liveness into the same KV the site's feed-health uses. The result: the
health map reflects real playback tested by a robot, so the player prefers
genuinely-working feeds **before any human clicks**.

It catches the failure the client-side pre-resolve can't: a source that *resolves*
but whose stream is dead (e.g. a 500 manifest, or a feed that never buffers).

This is a **separate deployment** from the static Pages site. It shares one thing
with the site: the `FEED_HEALTH` KV namespace.

---

## How it works
1. Cron fires → fetch `streamed.st/api/matches/live`, pick a rotating sample
   (cursor stored in KV so all live matches get covered over successive runs).
2. Resolve each match's sources → embed URLs. A source that won't resolve is
   recorded dead immediately (no browser needed).
3. For each resolved feed: launch headless Chrome, load the embed **top-level**
   (no sandbox → the ad gate doesn't fire), let the real player mint its token,
   and confirm `video.readyState ≥ 2`, `videoWidth > 0`, and `currentTime`
   advancing.
4. Merge the results (`{provider/source: {ok, bad}}`) into the shared KV, with the
   same rolling decay the Pages Function uses. Canary observations are weighted a
   little heavier than a single user outcome (`WEIGHT = 2`).

The client reads this map on load and prefers the highest-health sources — now
partly backed by a robot that's continuously re-testing.

---

## Prerequisites
- **Workers Paid plan** ($5/mo) — Browser Rendering is not on the free plan.
- **Browser Rendering enabled** on the account.
- The **`FEED_HEALTH` KV namespace** already created for the site (Workers & Pages
  → KV). This canary must bind the *same* namespace id.

## Deploy
```bash
cd canary
npm install
# put your KV namespace id into wrangler.toml  (id = "…")
npx wrangler login
npx wrangler deploy
# (optional) protect the manual test endpoint:
npx wrangler secret put CANARY_SECRET
```

## Test it
- Manual run (returns a JSON summary of what it tested):
  `https://wsz-canary.<your-subdomain>.workers.dev/?key=<CANARY_SECRET>`
- Watch a scheduled run live: `npx wrangler tail`
- Confirm it's writing: `GET https://watchsportz.pages.dev/api/feed-health` should
  start showing the sampled sources filling in.

---

## Cost knobs (top of `canary.js`)
Browser Rendering is **metered by browser time**, so tune these to your budget:

| Knob | Default | Effect |
|---|---|---|
| cron interval (`wrangler.toml`) | `*/15` (15 min) | how often it runs |
| `SAMPLE_MATCHES` | 6 | matches sampled per run |
| `MAX_FEEDS` | 8 | hard cap on headless loads per run |
| `PLAY_WAIT_MS` + `CONFIRM_MS` | ~12.5s | browser time per feed |

Rough default: ≤ 8 feeds × ~15s ≈ 2 min browser time per run × 4 runs/hr ≈ ~3 hr/day.
Start conservative (fewer feeds / longer interval), watch the Browser Rendering usage
in the dashboard, then dial up coverage.

## Known risk
Anti-bot: embed providers may fingerprint headless Chrome. We spoof the UA and hide
`navigator.webdriver`, but if the canary starts reporting healthy feeds as dead
(false negatives), that's the likely cause — check a manual run's `results[]`
(`reason: "no-video"` on feeds that *do* play in a real browser) and tune stealth.

## Note
Health is keyed by **source type** (`streamed-st/admin`, …), matching the client's
ranking. A future refinement is per-match liveness (a proven-good feed for a
*specific* match), which would need the client to read per-match hints too.
