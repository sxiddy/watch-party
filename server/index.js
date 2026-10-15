// Watch party server: static files, a small JSON API, and the socket.io room hub.
try { process.loadEnvFile(); } catch { /* no .env, that's fine */ }

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./room');
const { roomCode, cleanText } = require('./util');
const movies = require('./movies');
const { findSources, captionsProxy } = require('./sources');

const PORT = +process.env.PORT || 3000;
const ROOM_IDLE_MS = 30 * 60_000;
const rooms = new Map();

function createRoom() {
  let code;
  do code = roomCode(); while (rooms.has(code));
  const room = new Room(code, { emit: (ev, data) => io.to(code).emit(ev, data) });
  rooms.set(code, room);
  return room;
}

// ---------- HTTP ----------

// The pages can be served from somewhere else (the Vercel copy), so those
// origins are allowed to call the API and open a socket. Comma-separated.
const ALLOWED = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy; needed for per-IP limits
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin) && req.path.startsWith('/api/')) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.sendStatus(204);
    }
  }
  next();
});

const createHits = new Map();
app.post('/api/rooms', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const hits = (createHits.get(ip) || []).filter(t => now - t < 60_000);
  if (hits.length >= 20) return res.status(429).json({ error: 'Too many rooms, give it a minute' });
  hits.push(now);
  createHits.set(ip, hits);
  if (rooms.size > 2000) return res.status(503).json({ error: 'Server is full' });
  res.json({ code: createRoom().code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    people: room.connectedMembers().length,
    nowShowing: room.playback.media ? room.playback.media.title : null,
    host: room.members.get(room.hostId)?.name || null,
  });
});

app.get('/api/rooms/:code/recap', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: 'no room' });
  res.json(room.recap());
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.warn('[api]', req.path, e.message);
  res.status(502).json({ error: 'Movie service is having a moment, try again' });
});

app.get('/api/movies/home', wrap(async (req, res) => res.json(await movies.home())));
app.get('/api/movies/search', wrap(async (req, res) => res.json({ results: await movies.search(req.query.q) })));
app.get('/api/movies/discover', wrap(async (req, res) => {
  const f = {};
  for (const k of ['genre', 'decade', 'minRating', 'maxRuntime', 'lang', 'sort']) if (req.query[k]) f[k] = cleanText(String(req.query[k]), 40);
  if (req.query.free === '1') f.free = true;
  res.json({ results: await movies.discover(f) });
}));
app.get('/api/movies/:id(\\d+)', wrap(async (req, res) => res.json(await movies.details(+req.params.id))));
app.get('/api/movies/:id(\\d+)/recommendations', wrap(async (req, res) => res.json({ results: await movies.recommendations(+req.params.id) })));

app.get('/api/sources', wrap(async (req, res) => {
  const q = req.query;
  const title = cleanText(String(q.title || ''), 200);
  if (!title) return res.status(400).json({ error: 'title needed' });
  res.json(await findSources({ title, year: +q.year || null, tmdbId: +q.tmdbId || null, catalogId: q.catalogId ? cleanText(String(q.catalogId), 80) : null }));
}));

app.get('/api/captions', wrap(async (req, res) => {
  const vtt = await captionsProxy(String(req.query.u || ''));
  res.type('text/vtt').set('Cache-Control', 'public, max-age=86400').send(vtt);
}));

app.get('/api/health', (req, res) => res.json({
  ok: true, rooms: rooms.size, tmdb: movies.enabled(),
  people: [...rooms.values()].reduce((n, r) => n + r.connectedMembers().length, 0),
  uptime: Math.round(process.uptime()),
}));

const pub = path.join(__dirname, '../public');
app.use(express.static(pub, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get(['/r/:code', '/r/:code/*'], (req, res) => res.sendFile(path.join(pub, 'index.html')));

// ---------- sockets ----------

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,
  pingTimeout: 6000,
  maxHttpBufferSize: 1e6,
  cors: { origin: ALLOWED.length ? ALLOWED : false },
});

io.on('connection', socket => {
  // clock sync: client sends nothing, we answer with our clock. Kept tiny on purpose.
  socket.on('tp', ack => typeof ack === 'function' && ack(Date.now()));

  socket.on('join', (p = {}, ack) => {
    if (typeof ack !== 'function') return;
    const code = String(p.code || '').toUpperCase().slice(0, 8);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'not-found' });
    const id = cleanText(String(p.clientId || ''), 40);
    if (id.length < 8) return ack({ ok: false, error: 'bad-id' });
    if (!room.members.has(id) && room.connectedMembers().length >= 50) return ack({ ok: false, error: 'room-full' });

    // leaving a previous room on the same socket
    if (socket.data.code && socket.data.code !== code) leave(socket);
    socket.data.code = code;
    socket.data.id = id;
    socket.join(code);
    room.join(id, p.name, socket.id);
    ack({ ok: true, snapshot: room.snapshot(id), serverTs: Date.now() });
    room.tick(); // push the member list right away
  });

  // every room action goes through here: (room, memberId, payload) → result
  const on = (event, fn) => socket.on(event, (payload, ack) => {
    const room = rooms.get(socket.data.code);
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!room || !room.members.has(socket.data.id)) return reply({ ok: false, error: 'not-in-room' });
    try {
      reply(fn(room, socket.data.id, payload || {}) || { ok: true });
    } catch (e) {
      console.error('[socket]', event, e);
      reply({ ok: false, error: 'server-error' });
    }
  });

  on('control', (r, id, p) => r.control(id, p));
  on('media:set', (r, id, p) => r.setMedia(id, p.media, { autoplay: !!p.autoplay }));
  on('media:ended', (r, id, p) => r.ended(id, p.itemId));
  on('queue:add', (r, id, p) => r.queueAdd(id, p.media));
  on('queue:remove', (r, id, p) => r.queueRemove(id, p.id));
  on('queue:vote', (r, id, p) => r.queueVote(id, p.id));
  on('queue:move', (r, id, p) => r.queueMove(id, p.id, p.dir));
  on('queue:sort', (r, id) => r.queueSortByVotes(id));
  on('queue:play', (r, id, p) => r.queuePlay(id, p.id));
  on('chat', (r, id, p) => r.chatSend(id, p.text, { spoiler: p.spoiler }));
  on('typing', (r, id) => { socket.to(r.code).emit('typing', { id, name: r.members.get(id).name }); });
  on('react', (r, id, p) => r.react(id, p.emoji));
  on('poll:create', (r, id, p) => r.pollCreate(id, p));
  on('poll:vote', (r, id, p) => r.pollVote(id, p.pollId, p.optionId));
  on('poll:close', (r, id, p) => r.pollClose(id, p.pollId));
  on('host:transfer', (r, id, p) => r.transferHost(id, p.to));
  on('host:cohost', (r, id, p) => r.setCohost(id, p.to, p.value));
  on('settings', (r, id, p) => r.updateSettings(id, p));
  on('status', (r, id, p) => { r.status(id, p); return { ok: true }; });
  on('rewind', (r, id) => r.rewindRequest(id));
  on('intermission:start', (r, id, p) => r.intermissionStart(id, p.minutes));
  on('intermission:ready', (r, id, p) => r.intermissionReady(id, !!p.ready));
  on('intermission:end', (r, id) => r.intermissionEnd(id));
  on('clip:add', (r, id, p) => r.highlightAdd(id, p));
  on('clip:play', (r, id, p) => r.highlightPlay(id, p.id));
  on('clip:remove', (r, id, p) => r.highlightRemove(id, p.id));
  on('captions:share', (r, id, p) => r.captionsShare(id, p));
  on('taste', (r, id, p) => r.tasteVote(id, p.item, p.like));
  on('rename', (r, id, p) => {
    const m = r.members.get(id);
    const name = cleanText(String(p.name || ''), 24);
    if (name) { m.name = name; r._membersDirty = true; }
    return { ok: !!name };
  });

  socket.on('disconnect', () => leave(socket));
});

function leave(socket) {
  const room = rooms.get(socket.data.code);
  if (room) room.detach(socket.data.id, socket.id);
  socket.leave(socket.data.code);
  socket.data.code = null;
}

// ---------- timers ----------

setInterval(() => {
  for (const room of rooms.values()) room.tick();
}, 200).unref();

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = room.connectedMembers().length;
    if (!online && now - room.lastActiveAt > ROOM_IDLE_MS) { rooms.delete(code); continue; }
    if (online) io.to(code).emit('stats', { latency: room.latencyStats(), serverTs: now });
  }
}, 2000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`watch party running on http://localhost:${PORT}`);
    movies.warmUp().catch(e => console.warn('[movies] warm-up failed:', e.message));
  });
}

module.exports = { server, io, rooms, createRoom };
