# Back Row

A watch-party site. Make a room, send your friends the link (or let them scan the QR), pick a movie, and everyone's video plays, pauses and seeks together.

Built for the Watch Party task: synced playback for 10+ people, movie discovery, reactions, chat, a shared queue, polls, host transfer, drift correction, and solid handling of late joins, reconnects and people clicking at the same time.

![status](https://img.shields.io/badge/tests-28%20passing-3fa796) ![p95](https://img.shields.io/badge/control%20p95-1.7%20ms%20LAN-d9472b) ![drift](https://img.shields.io/badge/drift%20max-74%20ms-f2b33d)

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open it in two browser tabs (or two devices on the same Wi-Fi via `http://<your-ip>:3000`) to see the sync.

**Optional:** copy `.env.example` to `.env` and add a free [TMDB](https://www.themoviedb.org/settings/api) key. You then get real posters, trending rows, "where is it streaming in India", trailers and smarter recommendations. Without a key it uses the ~60-movie catalog in `public/data/movies.json`, and everything still works.

```bash
npm test           # 28 tests: room rules, sync math, fuzzy search, a 12-person integration run
npm run bench      # propagation latency with 15 bot viewers
npm run drift-sim  # drift correction against misbehaving fake players
```

## Where do the movies come from?

The hard part of any watch party: Netflix and Prime lock their videos, so no website can just play them. Teleparty and similar apps get around it with a browser extension, and every viewer still needs their own subscription. Back Row splits the problem into **finding** a movie and **playing** it.

**Finding:** TMDB (or the bundled catalog), with categories, filters (genre, decade, length, rating, language, free-only) and typo-tolerant search. "intrstellar", "dark knigt" and "nolan" all work. The fuzzy matcher is in `public/js/fuzzy.js`. TMDB's own search isn't typo-tolerant, so when it comes back empty the server asks the fuzzy index what you probably meant and searches again.

**Playing:** when you open a movie, the server checks where it can actually be watched:

1. **Free films**: Blender's open movies (Big Buck Bunny, Sintel, Tears of Steel…), streamed straight away.
2. **Internet Archive**: about 28,000 public-domain feature films. The server matches on title and year, skips dubbed copies, trailers, short clips and formats browsers can't play, and brings along subtitle files when there are any.
3. **YouTube**: the official trailer (via TMDB), or any YouTube link you paste.
4. **Everyone uses their own file**: the host picks a file, everyone else picks their copy. Nothing is uploaded. The app checks name and size match, then syncs it like any other video. This is how you'd watch something like *Ted 2* properly.
5. **Companion mode**: everyone plays it on their own Netflix, Prime or TV. Back Row runs the shared clock, the 3-2-1 start, chat and reactions, and has a "where's your screen at?" checker that tells you how many seconds to pause or skip.

## What's in it

**The brief**
- Rooms with a 6-letter code (no 0/O/1/I mix-ups), an invite link and a QR code
- Synced play, pause and seek. The server holds the official state and every client follows it
- Movie discovery with categories, filters and fuzzy search
- Emoji reactions, live chat, a shared queue with votes, polls and host transfer (plus co-hosts)
- Drift detection and correction: speed nudging, then a jump if needed
- Late joins get a full snapshot. Reconnects keep your identity and role. Clashing clicks are resolved the same way for everyone

**Extras**
- **3-2-1 countdown start**: everyone's video starts on the same frame
- **Spoiler-safe late join**: chat from before you arrived is blurred until you choose to read it; `/spoiler` hides a message for everyone
- **Missed that?**: when 30 % of the room presses it within 20 s, everyone goes back 10 s
- **Intermission**: a timed break with a "who's back" list. It restarts with a countdown when the timer ends or everyone's back
- **Group-taste picks**: a "Picked for this room" row built from what the whole room liked and queued (TMDB recommendations plus genre weighting)
- **Timestamped chat**: every message shows the video time, and clicking it jumps everyone there
- **Highlight clips**: save the last 15 s, replay them for the room (it stops at the end of the clip), or save a ticket-stub image to share
- **Subtitles together**: the host can turn subtitles on for everyone or drop in a `.srt` that the whole room gets; everyone else can choose their own. One caption renderer works for every player, including YouTube and companion mode
- **Reaction heatmap** on the seek bar, so you can see where the room lost it, plus a big "3 of you at once" burst when everyone hits the same emoji
- **Wait for buffering**: the room pauses while someone is buffering instead of leaving them behind
- **Sync tab**: your drift, ping, the room's p50/p95 click-to-screen latency, a live drift graph and everyone's numbers
- **Party recap**: loudest moment, most reactions, who talked most

Ideas taken from existing apps: no-account instant rooms and the playlist from Watch2Gether, the slim side chat from Teleparty, voting on what's next from Rave, the people strip above the chat from Scener, quiet reaction buttons from Disney+ GroupWatch, and live presence from Discord.

## How the sync works (short version)

Playback is stored as an anchor: *"at server time T the video was at P seconds, playing at speed 1"*. From that, any browser can work out where the video should be right now. Clocks are matched NTP-style: ping the server a few times and trust the ping with the shortest round trip. A 250 ms loop compares the real video with where it should be, ignores tiny gaps, speeds up or slows down slightly for medium ones, and jumps for big ones. Every change has a version number, so a late or duplicate message can't roll anyone back.

Full numbers, the test setup and a table of what happens when things break are in **[docs/LATENCY.md](docs/LATENCY.md)**.

## Project layout

```
server/
  index.js     HTTP API + socket.io hub
  room.js      all the room rules (no sockets inside, so it can be tested with a fake clock)
  movies.js    TMDB + bundled catalog, fuzzy re-ranking
  sources.js   "where can we watch this": Archive lookup, trailers, subtitle proxy
public/
  js/sync-core.js   clock sync + drift controller (shared by browser, tests and sim)
  js/player.js      adapters for <video>, YouTube and companion mode + the sync loop
  js/room.js        the room UI
  js/discover.js    rows, search, filters, movie sheet
  js/qr.js          QR maker, reused from my VIT CGPA calculator
bench/              latency benchmark + drift simulator
tests/              node:test suites
docs/               measurements + raw results
```

## Known limits

- Rooms live in memory, so a server restart ends them (Redis would fix this).
- YouTube can only change speed in 0.25× steps, so YouTube rooms correct drift by seeking. Still under 500 ms after correction, but less smooth than normal video.
- Companion mode is synced by people, not by code. The site can't control the Netflix app.
- Hosting needs something that keeps WebSockets open (Render, Railway, Fly). Vercel's serverless functions won't work for the socket server.

## Credits

Movie data from [TMDB](https://www.themoviedb.org) (this product uses the TMDB API but is not endorsed or certified by TMDB). Streaming availability via TMDB/JustWatch. Public-domain films from the [Internet Archive](https://archive.org). Open movies by the [Blender Foundation](https://studio.blender.org/films/) (CC-BY).
