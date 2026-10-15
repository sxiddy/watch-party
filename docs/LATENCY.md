# Latency, drift and failure handling

This is the "document latency measurements, test conditions and failure handling" part of the brief. Every number here comes from a script in `bench/` that you can re-run, and the raw output is in `docs/results/`.

## The targets

| Requirement | Target | Measured | Result |
|---|---|---|---|
| People per room | ≥ 10 | 15 and 30 bots tested (limit is set to 50) | ✅ |
| Play/pause/seek propagation, p95, local network | ≤ 250 ms | **1.7 ms** over the LAN interface, 15 viewers | ✅ |
| Drift after correction | ≤ 500 ms | **max 74 ms** for normal video, **max 416 ms** for YouTube | ✅ |

## Test conditions

- **Machine:** Windows 11 laptop, Intel i7-13645HX, 16 GB RAM, Node v24.19.0. Server and bots run on the same machine.
- **Network:** the "LAN" run connects through the machine's network address (`172.17.63.164`), not `localhost`, so traffic goes through the real network stack. Simulated Wi-Fi runs add an artificial random delay to every message a viewer receives.
- **Transport:** Socket.IO 4 over WebSocket.
- **Load:** one host and N viewers in one room. The host fires 300 play/pause/seek actions about 4–8 per second, faster than a real person clicks.
- **Date:** 15 Oct 2026.

## 1. Control propagation (`bench/latency.js`)

**How it's measured.** All bots live in one Node process, so the time the host *sends* an action and the time each viewer *receives* it are both read from the same `performance.now()` clock. There's no clock-sync error in these numbers. Each action is tagged with a value the server echoes back, so every delivery is matched to its exact send.

| Setup | Viewers | Deliveries | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| In-process (127.0.0.1) | 15 | 4500 / 4500 | 1.29 ms | 2.20 ms | 2.68 ms | 4.81 ms |
| In-process (127.0.0.1) | 30 | 9000 / 9000 | 1.81 ms | 2.71 ms | 3.20 ms | 4.12 ms |
| Over LAN address | 15 | 4500 / 4500 | 1.01 ms | **1.70 ms** | 2.22 ms | 3.58 ms |
| Simulated Wi-Fi (25 ± 20 ms per message) | 15 | 4500 / 4500 | 31.4 ms | 47.6 ms | 48.1 ms | 62.1 ms |
| Simulated bad Wi-Fi (90 ± 60 ms per message) | 15 | 4500 / 4500 | 94.8 ms | 155.7 ms | 157.8 ms | 159.8 ms |

Even with an awful connection added on top, p95 stays well under 250 ms. No delivery was lost in any run.

**Real browsers.** The app measures the same thing live. Every play/pause/seek carries the click time, converted to server time with the synced clock. Everyone else's browser computes "now − click time" when the change reaches their player, and the server shows the room's p50/p95 in the **Sync** tab. With two browser tabs on this laptop it showed **p95 ≈ 2 ms**, with drift between the tabs of 15–20 ms.

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
4. 40–400 ms → change `playbackRate` slightly (up to ±12 %) until it's back within 20 ms. You can't see or hear this.
5. > 400 ms → jump. The jump aims a little ahead, by the measured average time a seek takes on this device, so the video lands where the room *will* be.
6. YouTube can only change speed in 0.25× steps, so YouTube players skip step 4 and jump at 300 ms instead.

**The simulation.** It runs that exact controller code against 12 fake players for 20 minutes each. The players behave badly on purpose:
- their clocks run 0.5–3 % fast or slow
- they stall (buffer) for 0.3–2.5 s about every 3 minutes
- seeks take 80–450 ms to land
- their clock sync is off by up to ±15 ms
- the check loop jitters between 200 and 300 ms

Drift is measured against the true room position, ignoring the stall itself and the 3 s after it (the time correction is allowed to take).

| Player type | p50 | p95 | p99 | max after correction | time over 500 ms |
|---|---|---|---|---|---|
| Normal video (rate nudging + seek) | 28.7 ms | 45.9 ms | 51.0 ms | **74.2 ms** | 0 % |
| YouTube (seek only) | 141.6 ms | 283.0 ms | 298.6 ms | **415.5 ms** | 0 % |

To be upfront about it: for YouTube, the instant a corrective seek is still loading, the gap can briefly reach about 766 ms. That's a 450 ms seek on top of a 300 ms gap. Once the seek lands, it's back under the limit. In the simulation, normal video never needed a corrective seek outside of stalls, so it never saw that spike.

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
| Late join | Gets a snapshot: position, queue, polls, clips, chat. Chat from before you arrived is blurred so nothing's spoiled. | `room.snapshot` |
| Two people hit buttons together | Version check plus a 300 ms clash window (above). The losing click is undone on that person's screen. | `room.control` |
| Button spam | Rate limits: 8 controls/s, 6 chat messages per 4 s, 6 reactions/s, 20 room creations per minute per IP. | `room._rateOk`, `index.js` |
| Browser blocks autoplay | A "Join the show" button appears. The click counts as permission and playback starts exactly in step. | `player.js` |
| Video link is dead or unsupported | A message tells everyone what happened; the room stays usable. | `VideoAdapter` |
| TMDB down or no key | Falls back to the bundled catalog, so search and filters keep working. | `server/movies.js` |
| Internet Archive slow | 7 s timeout. The movie sheet still offers "own file" and "companion mode". | `server/sources.js` |
| Server restarts | Rooms live in memory, so they're lost. Clients reconnect, see "room not found" and are offered a new room. A known limitation; the fix would be Redis. | — |
| Empty rooms | Cleaned up after 30 min with nobody connected. | `index.js` |
