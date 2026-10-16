# Back Row

A watch-party site. Make a room, send your friends the link (or let them scan the QR), pick a movie, and everyone's video plays, pauses and seeks together.

Built for the Watch Party task: synced playback for 10+ people, movie discovery, reactions, chat, a shared queue, polls, host transfer, drift correction, and solid handling of late joins, reconnects and people clicking at the same time.

![status](https://img.shields.io/badge/tests-46%20passing-3fa796) ![p95](https://img.shields.io/badge/control%20p95-2%20ms%20same%20machine%20%C2%B7%2032%20ms%20sim.%20Wi--Fi-d9472b) ![drift](https://img.shields.io/badge/drift%20after%20correction-%E2%89%A4%20461%20ms-f2b33d)

**Try it live: https://watchpartyvinnovate.vercel.app**. Open it, make a room, then open the invite link on your phone or in a second tab. It's on free hosting that sleeps when nobody's using it, so the first visit can take up to a minute to wake the server (the page tells you when that's happening).

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open it in two browser tabs (or two devices on the same Wi-Fi via `http://<your-ip>:3000`) to see the sync.

**Optional:** copy `.env.example` to `.env` and add a free [TMDB](https://www.themoviedb.org/settings/api) key. You then get real posters, trending rows, "where is it streaming in India", trailers and smarter recommendations. Without a key it uses the ~60-movie catalog in `public/data/movies.json`, and everything still works.

```bash
npm test           # 46 tests: room rules, permissions, sync math, fuzzy search, a 12-person integration run
npm run bench      # propagation latency with 15 bot viewers
npm run drift-sim  # drift correction against misbehaving fake players
```

## Where do the movies come from?

The hard part of any watch party: Netflix and Prime lock their videos, so no website can just play them. Teleparty and similar apps get around it with a browser extension, and every viewer still needs their own subscription. Back Row splits the problem into **finding** a movie and **playing** it.

**Finding:** TMDB (or the bundled catalog), with categories, filters (genre, decade, length, rating, language, free-only) and typo-tolerant search. "intrstellar", "dark knigt" and "nolan" all work. The fuzzy matcher is in `public/js/fuzzy.js`. TMDB's own search isn't typo-tolerant, so when it comes back empty the server asks the fuzzy index what you probably meant and searches again.

**Playing:** when you open a movie, the server checks where it can actually be watched:

1. **Free films**: Blender's open movies (Big Buck Bunny, Sintel, Tears of Steel…), streamed straight away.
2. **Internet Archive**, for public-domain films only: ones our catalog marks as public domain, or anything from 1930 or earlier (US copyright runs 95 years). The server matches on title and year, only accepts files that are feature length, and skips dubbed copies, trailers and formats browsers can't play. It brings along subtitle files when there are any. It never searches the Archive for a modern studio film, because the copies there are usually clips or uploads nobody had the rights to.
3. **YouTube**: the official trailer (via TMDB), or any YouTube video. Paste a link into the YouTube box under the search (or straight into the search) and you get a preview with the real title and channel, then everyone watches it in sync. Links with a start time (`?t=90`) start everyone there. Guests can suggest a video, the host decides.
4. **Everyone uses their own file**: the host picks a file, everyone else picks their copy. Nothing is uploaded. The app checks that name and size match, then syncs it like any other video.
5. **Companion mode**: everyone plays it on their own Netflix, Prime or TV. Back Row runs the shared clock, the 3-2-1 start, chat and reactions, and has a "where's your screen at?" checker that tells you how many seconds to pause or skip. For paid films, the movie sheet and companion screen link to where it's legally streaming or for rent in your country (JustWatch, via TMDB when there's a key, a JustWatch search when there isn't).

So for something like *Ted 2*: it's on a streaming service, so the room uses companion mode, everyone opens it on their own account, and Back Row keeps you together.

## What's in it

**The brief**
- Rooms with a 6-letter code (no 0/O/1/I mix-ups), an invite link and a QR code
- Synced play, pause and seek. The server holds the official state and every client follows it
- Movie discovery with categories, filters and fuzzy search
- Emoji reactions, live chat, a shared queue with votes, polls and host transfer (plus co-hosts, and the host can remove someone or lock the room)
- Drift detection and correction: speed nudging, then a jump if needed
- Late joins get a full snapshot. Reconnects keep your identity and role. Clashing clicks are resolved the same way for everyone

**Extras**
- **3-2-1 countdown start**: everyone's video starts on the same frame
- **Spoiler-safe late join**: chat from before you arrived is blurred until you choose to read it; `/spoiler` hides a message for everyone
- **Missed that?**: when 30 % of the room (and at least 2 people) press it within 20 s, everyone goes back 10 s
- **Intermission**: a timed break with a "who's back" list. It restarts with a countdown when the timer ends or everyone's back
- **Group-taste picks**: a "Picked for this room" row built from what the whole room liked and queued (TMDB recommendations plus genre weighting)
- **Timestamped chat**: every message shows the video time, and clicking it jumps everyone there
- **Highlight clips**: save the last 15 s, replay them for the room (it stops at the end of the clip), or save a ticket-stub image to share
- **HD button**: when a sharper copy of the film exists, each person can switch to it on their own (it's about your connection, so it never changes anyone else's picture). You stay in sync while it switches, and if HD can't keep up within 15 s you're put back on the normal copy
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
  youtube.js   title + channel for a pasted YouTube link (oEmbed, no key)
public/
  js/sync-core.js   clock sync + drift controller (shared by browser, tests and sim)
  js/player.js      adapters for <video>, YouTube and companion mode + the sync loop
  js/ytlink.js      reads pasted YouTube links (id + start time), shared with the tests
  js/room.js        the room UI
  js/discover.js    rows, search, filters, movie sheet
  js/qr.js          QR maker, reused from my VIT CGPA calculator
bench/              latency benchmark + drift simulator
tests/              node:test suites
docs/               measurements + raw results
```

## Hosting

The site is split in two:
- **The pages** (everything in `public/`) are on **Vercel**: https://watchpartyvinnovate.vercel.app. Settings are in `vercel.json`.
- **The sync server** (`server/`) is on **Render**, because Vercel can't keep the always-open WebSocket connections that sync needs. Settings are in `render.yaml`. `public/js/config.js` tells the Vercel copy where the server is, and the server only accepts the Vercel address (`CORS_ORIGIN`).

The Render address serves the whole site on its own too, and so does `npm start` on your laptop.

A note on the live demo's numbers: the free Render server is in the US, so from India every message crosses the internet. In a two-tab test on the live site the round trip was about 276 ms and the room's click-to-arrival p95 was 284 ms, while the two players stayed about 20–30 ms apart. The brief's 250 ms target is for a local network. For that, run `npm start` on one laptop and have everyone join over the same Wi-Fi (see [docs/LATENCY.md](docs/LATENCY.md)).

## What changed after review

Before submitting, I had the project reviewed strictly against the brief. The main fixes that came out of it:
- **Anyone could become the host.** A guest could copy the host's id from the member list and rejoin as them. Now each tab's id is a secret that never leaves the browser, and everyone else only sees a public id the server makes up (`tests/identity.test.js`).
- **Guests could stop the film for everyone** by reporting a fake 5-second length, or end it early. Only people with control can do either now.
- **The Archive search labelled clips as "free and legal" movies.** For example, Inception matched a 77-second clip. It now only searches for public-domain films and only accepts feature-length files.
- **Shared subtitles didn't show** for the person sharing them or for anyone who joined later.
- **A late joiner on a slow video could get stuck** re-seeking for 20+ seconds, pausing the room for everyone meanwhile.
- **Spam:** added a general rate limit for every action, plus a way for the host to remove someone.
- **Overstated numbers in the docs:** drift is now reported as a range over 6 runs instead of the best one, the network simulation delays both directions, and the "same machine" test is described as what it is.

A second round of review found more ways one person could mess with a room, fixed in the next pass:
- **One tab could fill a room with "ghost" people** by rejoining under new ids without leaving, which also let it vote twice on rewinds. Now one connection is one person, joins are rate-limited, and new people per address are capped.
- **In companion mode a guest could set the film's length** and stop the shared clock. Only the host's side can set a length now, and companion rooms never get one.
- **A guest could set the room's p95** by reporting fake 5-second latencies, and **fake buffering could pause the room on a loop**. Both are capped now (see [docs/LATENCY.md](docs/LATENCY.md)).
- **A seek that never finished froze that viewer for good**, while the Sync tab said they were fine. It now retries, then reloads, and shows "loading" meanwhile.
- **Searching a director or actor** ("nolan", "tom hanks") on the live site found documentaries about them. It now finds their films.
- **Muddy sound on the free films.** Big Buck Bunny, Sintel and Elephants Dream were playing the Internet Archive's "512Kb" copies (240p, thin audio), and the public-domain finder preferred them too. They now use proper 480–720p copies, and the speed nudging that keeps people in step moves in fixed 2 % steps instead of a new speed every quarter second, which is gentler on the audio.
- Smaller things: subtitle files starting with a byte-order mark, old subtitles staying "on" after switching videos, and the 3·2·1 button showing with nothing loaded.

## Known limits

- Rooms live in memory, so a server restart ends them (Redis would fix this). On the free Render plan that also happens when the server goes to sleep.
- YouTube can only change speed in 0.25× steps, so YouTube rooms correct drift by seeking. Still under 500 ms after correction, but less smooth than normal video.
- Companion mode is synced by people, not by code. The site can't control the Netflix app.
- Removing someone blocks their tab and their internet address. Someone on another network (say, mobile data) could still come back, which is what the room lock is for. On your own laptop (`npm start`) the address check is off so you can test with many tabs.
- Not tested yet on two physical devices on the same Wi-Fi (the in-app Sync tab will show the numbers when you try it).

## Credits

Movie data from [TMDB](https://www.themoviedb.org) (this product uses the TMDB API but is not endorsed or certified by TMDB). Streaming availability via TMDB/JustWatch. Public-domain films from the [Internet Archive](https://archive.org). Open movies by the [Blender Foundation](https://studio.blender.org/films/) (CC-BY).
