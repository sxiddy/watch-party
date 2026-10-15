# Latency, drift and failure handling

This is the "document latency measurements, test conditions and failure handling" part of the brief. Every number here comes from a script in `bench/` that you can re-run, and the raw output is in `docs/results/`.

## The targets

| Requirement | Target | Measured | Result |
|---|---|---|---|
| People per room | ≥ 10 | 15 and 30 bots tested (limit is set to 50) | ✅ |
| Play/pause/seek propagation, p95, local network | ≤ 250 ms | **2.0 ms** through the laptop's Wi-Fi address, 15 viewers; **32 ms** with a simulated LAN Wi-Fi delay on every hop | ✅ |
| Drift after correction | ≤ 500 ms | worst case over 6 runs: **207–338 ms** for normal video, **403–461 ms** for YouTube | ✅ |

## Test conditions

- **Machine:** Windows 11 laptop, Intel i7-13645HX, 16 GB RAM, Node v24.19.0. Server and bots run on the same machine.
- **Network:** the "Wi-Fi address" run connects to the laptop's own Wi-Fi IP (`172.17.63.164`, the campus network) instead of `localhost`. To be clear about what that means: the server and the bots are on the same laptop, so Windows hands the packets straight across and they never actually go over the air. It shows the server and socket stack are fast, not what a phone across the room would see. The simulated runs add an artificial random delay to **every hop**: host → server and server → each viewer.
- **Timer note:** on Windows, Node's `setTimeout` rounds up to roughly 15.6 ms. Each simulated hop is a `setTimeout`, so the simulated rows include about 31 ms of extra delay on top of what was asked for. Those rows are a little pessimistic, not optimistic.
- **Not done yet:** a test with two physical devices (a phone and a laptop) on the same Wi-Fi. The in-app Sync tab measures exactly that when you try it, so it's a 2-minute check on demo day.
- **Transport:** Socket.IO 4 over WebSocket.
- **Load:** one host and N viewers in one room. The host fires 300 play/pause/seek actions about 4–8 per second, faster than a real person clicks.
- **Date:** 15 Oct 2026.

## 1. Control propagation (`bench/latency.js`)

**How it's measured.** All bots live in one Node process, so the time the host *sends* an action and the time each viewer *receives* it are both read from the same `performance.now()` clock. There's no clock-sync error in these numbers. Each action is tagged with a value the server echoes back, so every delivery is matched to its exact send.

| Setup | Viewers | Deliveries | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| In-process (127.0.0.1) | 15 | 4500 / 4500 | 1.23 ms | 2.92 ms | 3.94 ms | 7.69 ms |
| In-process (127.0.0.1) | 30 | 9000 / 9000 | 1.66 ms | 2.89 ms | 3.54 ms | 5.53 ms |
| Through the Wi-Fi address (same laptop) | 15 | 4500 / 4500 | 1.07 ms | **1.99 ms** | 2.48 ms | 3.77 ms |
| Simulated LAN Wi-Fi (5 ± 4 ms per hop) | 15 | 4500 / 4500 | 31.2 ms | **32.1 ms** | 32.6 ms | 34.1 ms |
| Simulated busy Wi-Fi (25 ± 20 ms per hop) | 15 | 4500 / 4500 | 62.6 ms | 93.7 ms | 94.9 ms | 109.9 ms |
| Simulated bad internet (90 ± 60 ms per hop) | 15 | 4500 / 4500 | 200.9 ms | **280.7 ms** ❌ | 298.0 ms | 315.3 ms |

No delivery was lost in any run. The last row misses 250 ms, and that's expected: 90 ms each way is a long-distance internet connection, not a local network. The brief's 250 ms target is for a LAN, and every LAN-like row is far under it. (An earlier version of this table only delayed the server → viewer hop, which made the bad-network rows look about twice as good as they are. Fixed after review.)

**Real browsers.** The app measures the same thing live. Every play/pause/seek carries the click time, converted to server time with the synced clock. Everyone else's browser computes "now − click time" when the message arrives, and the server shows the room's p50/p95 in the **Sync** tab. With two browser tabs on this laptop it showed **p95 ≈ 2 ms**, with drift between the tabs of 15–20 ms. Two caveats: this is message arrival, not the moment the video frame changes (the drift numbers cover that part), and the browser reports these numbers itself, so the server only accepts a few small values per report.

Re-run it:
```bash
npm run bench                                     # 15 viewers, in-process
node bench/latency.js --viewers 30
node bench/latency.js --url http://<your-ip>:3000 # against a running server
node bench/latency.js --delay 90 --jitter 60      # bad network
```

## 2. Drift correction (`bench/drift-sim.js`)

The browser runs this loop every 250 ms (`public/js/sync-core.js` → `DriftController`):

1. Work out where the video *should* be: `basePos + (serverNow − baseTime) × rate`. The server time comes from NTP-style pings, trusting the ping with the lowest round trip.
2. `drift = actual − expected`.
3. |drift| < 40 ms → do nothing.
4. 40–400 ms → change `playbackRate` slightly (up to ±6 %) until it's back within 20 ms. It used to allow ±12 %, but at that speed voices sound noticeably off, so it was lowered after review. Under about 5 % is hard to notice.
5. > 400 ms → jump. The jump aims a little ahead, by the measured average time a seek takes on this device, so the video lands where the room *will* be.
6. YouTube can only change speed in 0.25× steps, so YouTube players skip step 4 and jump at 300 ms instead.

**The simulation.** It runs that exact controller code against 12 fake players for 20 minutes each. The players behave badly on purpose:
- their clocks run 0.5–3 % fast or slow
- they stall (buffer) for 0.3–2.5 s about every 3 minutes
- seeks take 80–450 ms to land
- their clock sync is off by up to ±15 ms
- the check loop jitters between 200 and 300 ms

Drift is measured against the true room position, ignoring the stall itself and the 3 s after it (the time correction is allowed to take). It was run with 6 different random seeds (1, 3, 7, 42, 99, 1234), so these are **ranges across runs**, not one lucky run:

| Player type | p50 | p95 | p99 | max after correction | time over 500 ms |
|---|---|---|---|---|---|
| Normal video (rate nudging + seek) | 25–31 ms | 39–48 ms | 47–55 ms | **207–338 ms** | 0 % in every run |
| YouTube (seek only) | 140–150 ms | 281–289 ms | 297–304 ms | **403–461 ms** | 0 % in every run |

The worst cases for normal video are higher than the first version of this file claimed (74 ms). That figure came from a single seed and the older ±12 % speed cap. A gentler cap corrects more slowly, which is the trade-off for not hearing it.

What the simulation doesn't cover, to be upfront about it:
- For YouTube, the instant a corrective seek is still loading, the gap can briefly reach 741–854 ms (a seek of up to 450 ms on top of a 300 ms gap). Once the seek lands it's back under the limit.
- It models the drift controller, not the whole browser loop around it (the "let a seek finish first" guards in `player.js`), and it assumes seeks take at most 450 ms. A slow connection can take longer than that.

Raw numbers for every seed: `docs/results/drift-sim.json`.

```bash
npm run drift-sim
```

## 3. Concurrent actions

Two viewers seek at exactly the same moment, 40 times (part of `bench/latency.js`). Each request carries the playback version the sender last saw. The server handles everything in order, one action at a time. If a request is based on an old version, and a *different* person changed playback less than 300 ms ago, it's rejected as a clash and that person's UI says who won. After 300 ms, the most recent action wins as usual.

Result: in all 40 rounds one seek won and one was rejected, and **every viewer ended on the same version**. Versions only ever go up, so a late duplicate message can never roll anyone back.

## 4. Failure handling

| What goes wrong | What the app does | Where |
|---|---|---|
| Someone's Wi-Fi drops | Socket.IO reconnects with backoff (0.4 s → 4 s). The browser rejoins with the same tab ID, so it's the same person, not a duplicate, and gets a full snapshot. Tested: 5/5 and 10/10 came back with the right position. | `net.js`, `room.join` |
| Connection is "open" but silent | A watchdog: if nothing arrives for 9 s (pings go every 3 s), the socket is torn down and rebuilt. Idea taken from my Mirrorbound game's WebSocket client. | `net.js` |
| Host disconnects | They keep the host role for 10 s in case it was a blip. Then it passes to a connected co-host, otherwise the person with the lowest round-trip time (most stable connection). | `room.tick`, `_pickNextHost` |
| Someone buffers | If it lasts more than 1.2 s, the room pauses ("waiting for Asha"), then resumes when they're ready. If someone is stuck for more than 10 s, the room carries on and they catch up by seeking. The host can switch this off. | `room._checkBuffering` |
| Late join | Gets a snapshot: position, queue, polls, clips, chat, shared subtitles. Chat from before you arrived is blurred so nothing's spoiled. For their first 8 s their loading can't pause the room, and their player lets each seek finish before trying again (it used to re-seek every 250 ms and never catch up on a slow source). | `room.snapshot`, `player.js` |
| Two people hit buttons together | Version check plus a 300 ms clash window (above). The losing click is undone on that person's screen. | `room.control` |
| Button spam | Every socket gets a token bucket (20 events/s, bursts of 40). On top of that: 8 controls/s, 6 chat messages per 4 s, 6 reactions/s, 3 clips per 10 s, 2 polls per 30 s, 2 renames per 30 s, typing once per 1.5 s, and per-IP limits on room creation, source lookups and the subtitle proxy. | `index.js`, `room._rateOk` |
| Someone trolling | The host can remove a person. They're blocked from coming back in from that tab. | `room.kick` |
| Someone pretending to be the host | Your tab's id is a secret that never leaves your browser. Everyone else only sees a public id the server makes up, so copying it from the member list gets you nothing. | `index.js` join |
| A guest messing with playback | Only people with control can change the film's length or say it ended, and one guest can't trigger "missed that" on their own (it needs at least 2 people). | `room.reportDuration`, `room.ended`, `room.rewindThreshold` |
| Browser blocks autoplay | A "Join the show" button appears. The click counts as permission and playback starts exactly in step. | `player.js` |
| Video link is dead or unsupported | A message tells everyone what happened; the room stays usable. | `VideoAdapter` |
| TMDB down or no key | Falls back to the bundled catalog, so search and filters keep working. | `server/movies.js` |
| Internet Archive slow | 7 s timeout. The movie sheet still offers "own file" and "companion mode". | `server/sources.js` |
| Server restarts | Rooms live in memory, so they're lost. Clients reconnect, see "room not found" and are offered a new room. A known limitation; the fix would be Redis. | — |
| Empty rooms | Cleaned up after 30 min with nobody connected. | `index.js` |
