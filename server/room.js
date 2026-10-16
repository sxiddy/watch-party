// One watch-party room. Pure state + rules, no sockets in here, so the tests
// can drive it directly with a fake clock. The server wires `room.emit` to
// socket.io; everything a client sees goes through it.

const { expectedPosition, percentile } = require('../public/js/sync-core');
const { shortId, cleanText, num, isHttpUrl, youtubeId } = require('./util');

const CONFLICT_WINDOW_MS = 300;   // two control actions this close together = a clash
const HOST_GRACE_MS = 10_000;     // host can drop and come back without losing the crown
const MEMBER_EXPIRE_MS = 5 * 60_000;
const COUNTDOWN_MS = 3000;
const BUFFER_TRIGGER_MS = 1200;   // buffering shorter than this doesn't pause the room
const BUFFER_GIVE_UP_MS = 10_000; // someone stuck longer than this: carry on without them
const REWIND_WINDOW_MS = 20_000;
const REWIND_COOLDOWN_MS = 20_000;
const REWIND_SECONDS = 10;
const JOIN_GRACE_MS = 8000;
const BUFFER_STRIKE_MS = 5 * 60_000;       // a late joiner's first seconds of loading don't pause everyone
const MAX_CHAT = 300;
const REACTION_BUCKET = 5;        // seconds per heatmap bucket

const EMOJIS = ['😂', '😮', '😍', '😭', '🔥', '👏', '💀', '🍿'];
const COLORS = ['#e4572e', '#29a19c', '#f3a712', '#6a8eae', '#c45ab3', '#5b8c5a', '#d1495b', '#3d5a80', '#ee964b', '#8e7dbe', '#00798c', '#b5651d'];

// Everyone in the room loads whatever image or video a queued item points at,
// so only a few known hosts are allowed for posters, and links to video files
// from anywhere else can only be added by someone with control.
const POSTER_HOSTS = ['image.tmdb.org', 'archive.org', 'wikimedia.org', 'i.ytimg.com'];
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const onHost = (u, hosts) => { const h = hostOf(u); return hosts.some(x => h === x || h.endsWith('.' + x)); };
const trustedVideo = u => onHost(u, ['archive.org']);

function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const kind = m.kind;
  const out = {
    kind,
    title: cleanText(m.title, 200) || 'Untitled',
    year: num(m.year, 1870, 2100),
    poster: isHttpUrl(m.poster) && onHost(m.poster, POSTER_HOSTS) ? m.poster : null,
    tmdbId: num(m.tmdbId, 1, 1e9),
    catalogId: cleanText(m.catalogId, 80) || null,
    sourceLabel: cleanText(m.sourceLabel, 60) || null,
    genres: Array.isArray(m.genres) ? m.genres.slice(0, 6).map(g => cleanText(g, 30)).filter(Boolean) : [],
    duration: num(m.duration, 0, 86400, 0),
    captions: [],
  };
  if (Array.isArray(m.captions)) {
    out.captions = m.captions.slice(0, 6).filter(c => c && /^\/api\/captions\?/.test(c.src || '')) // our proxy only, which is locked to archive.org
      .map(c => ({ src: c.src, lang: cleanText(c.lang, 10) || 'en', label: cleanText(c.label, 40) || 'Subtitles' }));
  }
  if (kind === 'file') {
    if (!isHttpUrl(m.src)) return null;
    out.src = m.src;
  } else if (kind === 'youtube') {
    out.ytId = youtubeId(m.ytId || m.src);
    if (!out.ytId) return null;
    // a link like youtu.be/…?t=90 starts everyone at 1:30
    out.startAt = num(m.startAt, 0, 86400, 0);
  } else if (kind === 'local') {
    const k = m.localKey || {};
    out.localKey = { name: cleanText(k.name, 200), size: num(k.size, 0, 1e13, 0) };
    if (!out.localKey.name) return null;
  } else if (kind === 'companion') {
    // everyone plays it in their own app; we only keep the shared clock
  } else {
    return null;
  }
  return out;
}

class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.now = opts.now || Date.now;
    this.emit = opts.emit || (() => {});
    this.createdAt = this.now();
    this.lastActiveAt = this.createdAt;

    this.members = new Map();
    this.hostId = null;
    this.settings = { controlMode: 'host', waitForBuffering: true, autoRewind: true, captionsForAll: false, locked: false };
    this.playback = {
      itemId: null, media: null, playing: false, issuedAt: null, basePos: 0, baseTime: this.now(), rate: 1,
      duration: 0, version: 0, changedAt: 0, changedBy: null, reason: null, stopAt: null,
    };
    this.queue = [];
    this.history = [];
    this.polls = [];
    this.chat = [];
    this.highlights = [];
    this.reactions = {};        // itemId -> { bucketIndex: { emoji: count } }
    this.rewindReqs = new Map();
    this.lastRewindAt = 0;
    this.intermission = null;
    this.sharedCaptions = null; // { name, vtt, by, itemId }
    this.taste = new Map();     // key -> { item, likes:Set, dislikes:Set }
    this.bufferPause = null;
    this.latency = [];
    this.stats = { reactions: {}, messages: {}, emoji: {} };
    this._membersDirty = false;
  }

  // ---------- members ----------

  join(id, name, socketId, opts = {}) {
    const t = this.now();
    let m = this.members.get(id);
    const isNew = !m;
    if (!m) {
      const used = new Set([...this.members.values()].map(x => x.color));
      m = {
        id, name: '', color: COLORS.find(c => !used.has(c)) || COLORS[this.members.size % COLORS.length],
        joinedAt: t, connected: false, sockets: new Set(), leftAt: null, cohost: false,
        joinVideoPos: expectedPosition(this.playback, t),
        status: { buffering: false, bufferingSince: 0, away: false, drift: 0, rtt: 0, mediaReady: true },
        _ops: [], _chats: [], _reacts: [], _bufferTriggeredAt: 0,
      };
      this.members.set(id, m);
    }
    if (opts.ip) m.ip = opts.ip;
    const wanted = cleanText(name, 24);
    // a returning tab with a new name goes through rename(), so everyone sees it
    if (isNew) m.name = wanted || 'Guest';
    else if (wanted && wanted !== m.name) this.rename(id, wanted);
    m.sockets.add(socketId);
    const wasOffline = !m.connected;
    m.connected = true;
    m.leftAt = null;
    m.lastJoinAt = t; // fresh joiners are still loading; see _checkBuffering
    this.lastActiveAt = t;

    if (!this.hostId || !this.members.has(this.hostId)) this._setHost(id, null);
    if (isNew) this._system(`${m.name} grabbed a seat`);
    else if (wasOffline) this._system(`${m.name} is back`);
    this._membersDirty = true;
    return { member: m, isNew };
  }

  detach(id, socketId) {
    const m = this.members.get(id);
    if (!m) return;
    m.sockets.delete(socketId);
    if (m.sockets.size === 0) {
      m.connected = false;
      m.leftAt = this.now();
      m.status.buffering = false;
      this._system(`${m.name} stepped out`);
      this._membersDirty = true;
      this._checkBufferResume();
      this._checkIntermissionReady();
    }
  }

  connectedMembers() { return [...this.members.values()].filter(m => m.connected); }

  canControl(id) {
    if (id === this.hostId) return true;
    const m = this.members.get(id);
    if (!m) return false;
    return this.settings.controlMode === 'everyone' || m.cohost;
  }

  _rateOk(m, key, max, windowMs) {
    const t = this.now();
    const arr = m[key] || (m[key] = []);
    while (arr.length && t - arr[0] > windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(t);
    return true;
  }

  // ---------- playback ----------

  _publishPlayback(patch, actorId, reason, issuedAt = null) {
    const t = this.now();
    Object.assign(this.playback, patch, {
      version: this.playback.version + 1, changedAt: t, changedBy: actorId, reason: reason || null, issuedAt,
    });
    this.lastActiveAt = t;
    this.emit('playback', this.playbackView());
  }

  playbackView() {
    const p = this.playback;
    const by = p.changedBy && this.members.get(p.changedBy);
    return { ...p, changedByName: by ? by.name : null, serverTs: this.now() };
  }

  position() { return expectedPosition(this.playback, this.now()); }

  control(id, op = {}) {
    const m = this.members.get(id);
    if (!m) return { ok: false, error: 'not-in-room' };
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    if (!this.playback.media) return { ok: false, error: 'nothing-playing' };
    if (!this._rateOk(m, '_ops', 8, 1000)) return { ok: false, error: 'slow-down' };

    const pb = this.playback;
    const t = this.now();
    // Concurrent actions: if someone else changed playback a moment ago and
    // this request was made without seeing that change, the earlier one wins.
    if (op.baseVersion != null && op.baseVersion < pb.version && pb.changedBy && pb.changedBy !== id && t - pb.changedAt < CONFLICT_WINDOW_MS) {
      const winner = this.members.get(pb.changedBy);
      return { ok: false, error: 'conflict', winner: winner ? winner.name : 'someone', state: this.playbackView() };
    }

    const max = pb.duration || 86400;
    const action = op.action;
    // when the click happened (in server time, from the client's synced clock):
    // receivers use it to measure true click-to-screen latency
    const issuedAt = num(op.issuedAt, t - 10_000, t + 1000);
    if (action === 'play') {
      if (pb.playing) return { ok: true, noop: true };
      if (this.intermission) { this.intermission = null; this.emit('intermission', null); }
      this.bufferPause = null;
      const delay = op.countdown ? COUNTDOWN_MS : 0;
      let pos = this.position();
      if (pb.duration && pos >= pb.duration - 0.5) pos = 0; // replay from start
      this._publishPlayback({ playing: true, basePos: pos, baseTime: t + delay, stopAt: null }, id, op.countdown ? 'countdown' : 'play', issuedAt);
    } else if (action === 'pause') {
      if (!pb.playing) return { ok: true, noop: true };
      this.bufferPause = null;
      this._publishPlayback({ playing: false, basePos: this.position(), baseTime: t, stopAt: null }, id, 'pause', issuedAt);
    } else if (action === 'seek') {
      const pos = num(op.position, 0, max);
      if (pos == null) return { ok: false, error: 'bad-position' };
      this._publishPlayback({ basePos: pos, baseTime: pb.playing ? Math.max(t, pb.baseTime) : t, stopAt: null }, id, 'seek', issuedAt);
    } else {
      return { ok: false, error: 'bad-action' };
    }
    return { ok: true, version: this.playback.version };
  }

  setMedia(id, rawMedia, opts = {}) {
    if (id && !this.canControl(id)) return { ok: false, error: 'not-allowed' };
    const media = cleanMedia(rawMedia);
    if (!media) return { ok: false, error: 'bad-media' };
    if (this.playback.media) this.history.unshift({ media: this.playback.media, at: this.now() });
    this.history = this.history.slice(0, 30);
    this.bufferPause = null;
    this.rewindReqs.clear();
    this.sharedCaptions = null;
    this.emit('captions', null);
    const t = this.now();
    this._publishPlayback({
      itemId: shortId(), media, playing: !!opts.autoplay, basePos: media.startAt || 0,
      baseTime: t + (opts.autoplay ? COUNTDOWN_MS : 0), duration: media.duration || 0, stopAt: null,
    }, id, opts.autoplay ? 'countdown' : 'media');
    this._noteTaste(media, id, 1);
    const who = id && this.members.get(id);
    this._system(`${who ? who.name : 'Up next'}: now showing “${media.title}”`);
    this.emit('reactions', { itemId: this.playback.itemId, buckets: {} });
    return { ok: true, itemId: this.playback.itemId };
  }

  reportDuration(id, itemId, duration) {
    const d = num(duration, 1, 86400);
    if (!d || itemId !== this.playback.itemId) return;
    // Only people with control may set the length, otherwise a guest could
    // shorten the film and stop it for everyone. Companion mode has no player
    // to measure, so its clock is never capped by a reported length.
    if (!this.canControl(id) || this.playback.media?.kind === 'companion') return;
    if (!this.playback.duration || Math.abs(this.playback.duration - d) > 2) {
      this.playback.duration = d; // not a version bump; just metadata
    }
  }

  ended(id, itemId) {
    const pb = this.playback;
    if (!this.members.has(id) || itemId !== pb.itemId || !pb.playing) return { ok: false };
    // whoever has control reports the end; if nobody with control is online, anyone can
    const controllerOnline = this.connectedMembers().some(x => this.canControl(x.id));
    if (!this.canControl(id) && controllerOnline) return { ok: false, error: 'not-allowed' };
    if (pb.duration && this.position() < pb.duration - 3) return { ok: false, error: 'not-at-end' };
    if (this.queue.length) {
      const next = this.queue.shift();
      this.emit('queue', this.queueView());
      this.setMedia(null, next.media, { autoplay: true });
    } else {
      this._publishPlayback({ playing: false, basePos: pb.duration || this.position(), baseTime: this.now() }, null, 'ended');
    }
    return { ok: true };
  }

  // ---------- queue (shared playlist) ----------

  queueView() {
    return this.queue.map(q => ({ ...q, votes: [...q.votes] }));
  }

  queueAdd(id, rawMedia) {
    const m = this.members.get(id);
    if (!m) return { ok: false };
    const media = cleanMedia(rawMedia);
    if (!media) return { ok: false, error: 'bad-media' };
    if (media.kind === 'file' && !trustedVideo(media.src) && !this.canControl(id)) return { ok: false, error: 'not-allowed' };
    if (!this._rateOk(m, '_ops', 8, 1000)) return { ok: false, error: 'slow-down' };
    if (this.queue.length >= 50) return { ok: false, error: 'queue-full' };
    const item = { id: shortId(), media, addedBy: id, addedByName: m.name, addedAt: this.now(), votes: new Set([id]) };
    this.queue.push(item);
    this._noteTaste(media, id, 1);
    this.emit('queue', this.queueView());
    this._system(`${m.name} added “${media.title}” to the queue`);
    return { ok: true, id: item.id };
  }

  queueRemove(id, qid) {
    const i = this.queue.findIndex(q => q.id === qid);
    if (i < 0) return { ok: false };
    if (this.queue[i].addedBy !== id && !this.canControl(id)) return { ok: false, error: 'not-allowed' };
    this.queue.splice(i, 1);
    this.emit('queue', this.queueView());
    return { ok: true };
  }

  queueVote(id, qid) {
    const q = this.queue.find(x => x.id === qid);
    if (!q || !this.members.has(id)) return { ok: false };
    if (q.votes.has(id)) q.votes.delete(id); else q.votes.add(id);
    this.emit('queue', this.queueView());
    return { ok: true };
  }

  queueMove(id, qid, dir) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    const i = this.queue.findIndex(q => q.id === qid);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.queue.length) return { ok: false };
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.emit('queue', this.queueView());
    return { ok: true };
  }

  queueSortByVotes(id) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    this.queue.sort((a, b) => b.votes.size - a.votes.size || a.addedAt - b.addedAt);
    this.emit('queue', this.queueView());
    return { ok: true };
  }

  queuePlay(id, qid) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    const i = this.queue.findIndex(q => q.id === qid);
    if (i < 0) return { ok: false };
    const [item] = this.queue.splice(i, 1);
    this.emit('queue', this.queueView());
    return this.setMedia(id, item.media, { autoplay: false });
  }

  // ---------- chat & reactions ----------

  _pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.emit('chat', msg);
  }

  _system(text) {
    this._pushChat({ id: shortId(), kind: 'system', text, ts: this.now(), videoTime: this.position(), itemId: this.playback.itemId });
  }

  chatSend(id, text, opts = {}) {
    const m = this.members.get(id);
    if (!m) return { ok: false };
    let clean = cleanText(text, 500);
    if (!clean) return { ok: false, error: 'empty' };
    if (!this._rateOk(m, '_chats', 6, 4000)) return { ok: false, error: 'slow-down' };
    let spoiler = !!opts.spoiler;
    if (/^\/spoiler\s+/i.test(clean)) { spoiler = true; clean = clean.replace(/^\/spoiler\s+/i, ''); }
    const msg = {
      id: shortId(), kind: 'user', by: id, name: m.name, color: m.color, text: clean, spoiler,
      ts: this.now(), videoTime: this.position(), itemId: this.playback.itemId,
    };
    this.stats.messages[id] = (this.stats.messages[id] || 0) + 1;
    this._pushChat(msg);
    return { ok: true };
  }

  react(id, emoji) {
    const m = this.members.get(id);
    if (!m || !EMOJIS.includes(emoji)) return { ok: false };
    if (!this._rateOk(m, '_reacts', 6, 1000)) return { ok: false, error: 'slow-down' };
    const videoTime = this.position();
    const itemId = this.playback.itemId;
    if (itemId) {
      const b = Math.floor(videoTime / REACTION_BUCKET);
      const buckets = this.reactions[itemId] || (this.reactions[itemId] = {});
      const cell = buckets[b] || (buckets[b] = {});
      cell[emoji] = (cell[emoji] || 0) + 1;
    }
    this.stats.reactions[id] = (this.stats.reactions[id] || 0) + 1;
    this.stats.emoji[emoji] = (this.stats.emoji[emoji] || 0) + 1;
    this.emit('reaction', { emoji, by: id, name: m.name, color: m.color, videoTime, itemId });
    return { ok: true };
  }

  // ---------- polls ----------

  pollsView() {
    return this.polls.slice(-8).map(p => ({ ...p, options: p.options.map(o => ({ ...o, votes: [...o.votes] })) }));
  }

  pollCreate(id, { question, options, durationSec, fromQueue } = {}) {
    const m = this.members.get(id);
    if (!m) return { ok: false };
    if (!this._rateOk(m, '_polls', 2, 30_000)) return { ok: false, error: 'slow-down' };
    if (this.polls.filter(p => !p.closed).length >= 3) return { ok: false, error: 'too-many-polls' };
    let opts;
    let kind = 'custom';
    if (fromQueue) {
      if (this.queue.length < 2) return { ok: false, error: 'need-two-in-queue' };
      kind = 'queue';
      question = 'What do we watch next?';
      opts = this.queue.slice(0, 6).map(q => ({ id: shortId(), text: q.media.title, ref: q.id, votes: new Set() }));
    } else {
      question = cleanText(question, 140);
      opts = (Array.isArray(options) ? options : []).map(o => cleanText(o, 80)).filter(Boolean).slice(0, 6)
        .map(text => ({ id: shortId(), text, votes: new Set() }));
      if (!question || opts.length < 2) return { ok: false, error: 'need-question-and-two-options' };
    }
    const dur = num(durationSec, 0, 600, 60);
    const poll = {
      id: shortId(), kind, question, options: opts, by: id, byName: m.name,
      createdAt: this.now(), closesAt: dur ? this.now() + dur * 1000 : null, closed: false, winner: null,
    };
    this.polls.push(poll);
    if (this.polls.length > 20) this.polls.shift();
    this.emit('polls', this.pollsView());
    this._system(`${m.name} started a poll: ${question}`);
    return { ok: true, id: poll.id };
  }

  pollVote(id, pollId, optionId) {
    const p = this.polls.find(x => x.id === pollId);
    if (!p || p.closed || !this.members.has(id)) return { ok: false };
    const opt = p.options.find(o => o.id === optionId);
    if (!opt) return { ok: false };
    const had = opt.votes.has(id);
    p.options.forEach(o => o.votes.delete(id)); // one vote each, can change it
    if (!had) opt.votes.add(id);
    this.emit('polls', this.pollsView());
    return { ok: true };
  }

  pollClose(id, pollId) {
    const p = this.polls.find(x => x.id === pollId);
    if (!p || p.closed) return { ok: false };
    if (id && p.by !== id && !this.canControl(id)) return { ok: false, error: 'not-allowed' };
    p.closed = true;
    const top = p.options.reduce((a, b) => (b.votes.size > a.votes.size ? b : a), p.options[0]);
    p.winner = top.votes.size ? top.id : null;
    if (p.kind === 'queue' && p.winner) {
      const i = this.queue.findIndex(q => q.id === top.ref);
      if (i > 0) { const [it] = this.queue.splice(i, 1); this.queue.unshift(it); this.emit('queue', this.queueView()); }
    }
    this.emit('polls', this.pollsView());
    this._system(p.winner ? `Poll closed — “${top.text}” won with ${top.votes.size} vote${top.votes.size === 1 ? '' : 's'}` : 'Poll closed with no votes');
    return { ok: true };
  }

  // ---------- host & settings ----------

  _setHost(id, reason) {
    const prev = this.hostId;
    this.hostId = id;
    this._membersDirty = true;
    const m = this.members.get(id);
    if (prev && prev !== id && m) {
      this._system(reason === 'auto' ? `Host left, so ${m.name} has the projector now` : `${m.name} is the host now`);
    }
    this.emit('host', { hostId: id });
  }

  transferHost(id, to) {
    if (id !== this.hostId) return { ok: false, error: 'not-host' };
    const target = this.members.get(to);
    if (!target || !target.connected) return { ok: false, error: 'not-here' };
    this._setHost(to, 'manual');
    return { ok: true };
  }

  setCohost(id, to, value) {
    if (id !== this.hostId) return { ok: false, error: 'not-host' };
    const target = this.members.get(to);
    if (!target) return { ok: false };
    target.cohost = !!value;
    this._membersDirty = true;
    return { ok: true };
  }

  // Host only. Takes them out of the room and keeps them out (by their id; the
  // server also remembers their address so a fresh tab doesn't walk back in).
  kick(id, to) {
    if (id !== this.hostId) return { ok: false, error: 'not-host' };
    const target = this.members.get(to);
    if (!target || to === id) return { ok: false };
    const sockets = [...target.sockets];
    this.members.delete(to);
    (this.banned || (this.banned = new Set())).add(to);
    // and their address, so a fresh tab can't walk straight back in
    if (target.ip) (this.bannedIps || (this.bannedIps = new Set())).add(target.ip);
    this.queue.forEach(q => q.votes.delete(to));
    this.rewindReqs.delete(to);
    if (this.intermission) this.intermission.ready = this.intermission.ready.filter(x => x !== to);
    this._membersDirty = true;
    this._system(`${target.name} was shown the door`);
    this._checkBufferResume();
    this._checkIntermissionReady();
    return { ok: true, sockets };
  }

  rename(id, name) {
    const m = this.members.get(id);
    const clean = cleanText(String(name || ''), 24);
    if (!m || !clean || clean === m.name) return { ok: false };
    if (!this._rateOk(m, '_renames', 2, 30_000)) return { ok: false, error: 'slow-down' };
    this._system(`${m.name} is now ${clean}`);
    m.name = clean;
    this._membersDirty = true;
    return { ok: true };
  }

  updateSettings(id, patch = {}) {
    if (id !== this.hostId) return { ok: false, error: 'not-host' };
    if (patch.controlMode === 'host' || patch.controlMode === 'everyone') this.settings.controlMode = patch.controlMode;
    for (const k of ['waitForBuffering', 'autoRewind', 'captionsForAll', 'locked']) if (typeof patch[k] === 'boolean') this.settings[k] = patch[k];
    this.emit('settings', this.settings);
    return { ok: true };
  }

  // the most stable connected member gets the crown when the host vanishes
  _pickNextHost() {
    const cands = this.connectedMembers();
    if (!cands.length) return null;
    cands.sort((a, b) => (b.cohost - a.cohost) || ((a.status.rtt || 999) - (b.status.rtt || 999)) || (a.joinedAt - b.joinedAt));
    return cands[0].id;
  }

  // ---------- status / buffering ----------

  status(id, s = {}) {
    const m = this.members.get(id);
    if (!m) return;
    const st = m.status;
    if (typeof s.away === 'boolean') st.away = s.away;
    if (typeof s.mediaReady === 'boolean') st.mediaReady = s.mediaReady;
    // loading: the player isn't showing the room's frame yet, so there's no drift to report
    if (typeof s.loading === 'boolean') st.loading = s.loading;
    if (s.drift === null) st.drift = null;
    const drift = num(s.drift, -3600, 3600);
    if (drift != null) st.drift = Math.round(drift * 1000) / 1000;
    const rtt = num(s.rtt, 0, 60000);
    if (rtt != null) st.rtt = Math.round(rtt);
    if (typeof s.buffering === 'boolean' && s.buffering !== st.buffering) {
      st.buffering = s.buffering;
      st.bufferingSince = s.buffering ? this.now() : 0;
      if (!s.buffering) this._checkBufferResume();
    }
    if (s.duration && s.itemId) this.reportDuration(id, s.itemId, s.duration);
    if (Array.isArray(s.latency) && s.latency.length && this._rateOk(m, '_latReports', 1, 1500)) {
      // A browser reports what it measured since its last report: a few values,
      // once every 2 s. Each person keeps only their last 20, so one tab can't
      // flood the room's numbers (it can still report its own badly, see LATENCY.md).
      const mine = m._latency || (m._latency = []);
      for (const v of s.latency.slice(0, 5)) { const n = num(v, 0, 2000); if (n != null) mine.push(n); }
      if (mine.length > 20) mine.splice(0, mine.length - 20);
    }
    this._membersDirty = true;
  }

  _checkBuffering() {
    if (!this.settings.waitForBuffering || !this.playback.playing || this.bufferPause) return;
    if (this.playback.baseTime > this.now()) return; // still counting down
    const t = this.now();
    const stuck = this.connectedMembers().filter(m => m.status.buffering && m.status.mediaReady
      && t - m.status.bufferingSince >= BUFFER_TRIGGER_MS && t - m.status.bufferingSince < BUFFER_GIVE_UP_MS
      && t - m._bufferTriggeredAt > 15_000
      && t - (m.lastJoinAt || 0) > JOIN_GRACE_MS
      && (m._bufPauses || []).filter(x => t - x < BUFFER_STRIKE_MS).length < 2);
    if (!stuck.length) return;
    // someone who has paused the room twice in 5 minutes gets left to catch up
    // on their own after that, so a flaky (or fake) connection can't loop it
    stuck.forEach(m => { m._bufferTriggeredAt = t; (m._bufPauses || (m._bufPauses = [])).push(t); });
    this._publishPlayback({ playing: false, basePos: this.position(), baseTime: t }, null, 'buffering');
    this.bufferPause = { ids: stuck.map(m => m.id), since: t, version: this.playback.version };
    this.emit('notice', { kind: 'buffering', text: `Hang on, waiting for ${stuck.map(m => m.name).join(', ')}` });
  }

  _checkBufferResume() {
    const bp = this.bufferPause;
    if (!bp || bp.version !== this.playback.version) { if (bp) this.bufferPause = null; return; }
    const t = this.now();
    const still = bp.ids.map(id => this.members.get(id)).filter(m => m && m.connected && m.status.buffering && t - m.status.bufferingSince < BUFFER_GIVE_UP_MS);
    if (still.length) return;
    this.bufferPause = null;
    this._publishPlayback({ playing: true, basePos: this.playback.basePos, baseTime: t + 600 }, null, 'resume');
  }

  // ---------- rewind requests ----------

  rewindRequest(id) {
    const m = this.members.get(id);
    if (!m || !this.playback.media || !this.playback.playing) return { ok: false, error: 'not-playing' };
    const t = this.now();
    for (const [k, ts] of this.rewindReqs) if (t - ts > REWIND_WINDOW_MS) this.rewindReqs.delete(k);
    // one vote per address too, so two tabs on one laptop don't count as two people
    for (const [k] of this.rewindReqs) if (k !== id && m.ip && this.members.get(k)?.ip === m.ip) return { ok: true, count: this.rewindReqs.size, need: this.rewindThreshold() };
    this.rewindReqs.set(id, t);
    const need = this.rewindThreshold();
    const count = this.rewindReqs.size;
    this.emit('rewind', { count, need, names: [...this.rewindReqs.keys()].map(k => this.members.get(k)?.name).filter(Boolean) });
    if (count >= need && this.settings.autoRewind && t - this.lastRewindAt > REWIND_COOLDOWN_MS) {
      this.lastRewindAt = t;
      this.rewindReqs.clear();
      const pos = Math.max(0, this.position() - REWIND_SECONDS);
      this._publishPlayback({ basePos: pos, baseTime: t + 400 }, null, 'rewind');
      this._system(`${count} ${count === 1 ? 'person' : 'people'} missed that, so we went back ${REWIND_SECONDS}s`);
      this.emit('rewind', { count: 0, need, names: [], fired: true });
    }
    return { ok: true, count, need };
  }

  rewindThreshold() {
    // at least two people, so one guest can't drag a small room back on their own
    const n = this.connectedMembers().length;
    return Math.min(n, Math.max(2, Math.ceil(n * 0.3))) || 1;
  }

  // ---------- intermission ----------

  intermissionStart(id, minutes) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    const mins = num(minutes, 1, 30, 5);
    const t = this.now();
    if (this.playback.playing) this._publishPlayback({ playing: false, basePos: this.position(), baseTime: t }, id, 'intermission');
    this.intermission = { startedAt: t, endsAt: t + mins * 60_000, by: id, ready: [] };
    this.emit('intermission', this.intermission);
    this._system(`Intermission! Back in ${mins} minute${mins === 1 ? '' : 's'}`);
    return { ok: true };
  }

  intermissionReady(id, ready) {
    if (!this.intermission || !this.members.has(id)) return { ok: false };
    const set = new Set(this.intermission.ready);
    if (ready) set.add(id); else set.delete(id);
    this.intermission.ready = [...set];
    this.emit('intermission', this.intermission);
    this._checkIntermissionReady();
    return { ok: true };
  }

  intermissionEnd(id) {
    if (!this.intermission) return { ok: false };
    if (id && !this.canControl(id)) return { ok: false, error: 'not-allowed' };
    this._endIntermission(id);
    return { ok: true };
  }

  _checkIntermissionReady() {
    const im = this.intermission;
    if (!im) return;
    const online = this.connectedMembers();
    if (online.length && online.every(m => im.ready.includes(m.id))) this._endIntermission(null);
  }

  _endIntermission(id) {
    this.intermission = null;
    this.emit('intermission', null);
    if (this.playback.media) {
      const t = this.now();
      this._publishPlayback({ playing: true, basePos: this.position(), baseTime: t + COUNTDOWN_MS }, id, 'countdown');
    }
    this._system('Lights down, we’re back');
  }

  // ---------- highlights ----------

  highlightAdd(id, { start, end, title } = {}) {
    const m = this.members.get(id);
    if (!m || !this.playback.media) return { ok: false };
    if (!this._rateOk(m, '_clips', 3, 10_000)) return { ok: false, error: 'slow-down' };
    const now = this.position();
    let e = num(end, 0, 86400, now);
    let s = num(start, 0, 86400, Math.max(0, e - 15));
    if (s > e) [s, e] = [e, s];
    if (e - s < 2) e = s + 2;
    if (e - s > 120) s = e - 120;
    const clip = {
      id: shortId(), by: id, name: m.name, color: m.color, itemId: this.playback.itemId,
      media: { title: this.playback.media.title, poster: this.playback.media.poster },
      start: s, end: e, title: cleanText(title, 80) || 'A moment', ts: this.now(),
    };
    this.highlights.push(clip);
    if (this.highlights.length > 100) this.highlights.shift();
    this.emit('highlights', this.highlights);
    this._system(`${m.name} clipped “${clip.title}”`);
    return { ok: true, id: clip.id };
  }

  highlightPlay(id, hid) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    const h = this.highlights.find(x => x.id === hid);
    if (!h) return { ok: false };
    if (h.itemId !== this.playback.itemId) return { ok: false, error: 'different-video' };
    const t = this.now();
    this._publishPlayback({ playing: true, basePos: h.start, baseTime: t + 500, stopAt: h.end }, id, 'highlight');
    return { ok: true };
  }

  highlightRemove(id, hid) {
    const i = this.highlights.findIndex(x => x.id === hid);
    if (i < 0) return { ok: false };
    if (this.highlights[i].by !== id && id !== this.hostId) return { ok: false, error: 'not-allowed' };
    this.highlights.splice(i, 1);
    this.emit('highlights', this.highlights);
    return { ok: true };
  }

  // ---------- captions shared with the room ----------

  captionsShare(id, { name, vtt } = {}) {
    if (!this.canControl(id)) return { ok: false, error: 'not-allowed' };
    if (typeof vtt === 'string') vtt = vtt.replace(/^\uFEFF/, '');
    if (typeof vtt !== 'string' || vtt.length > 800_000 || !/^WEBVTT/.test(vtt)) return { ok: false, error: 'bad-captions' };
    this.sharedCaptions = { name: cleanText(name, 80) || 'subtitles', vtt, by: id, itemId: this.playback.itemId };
    this.emit('captions', this.sharedCaptions);
    this._system(`${this.members.get(id).name} shared subtitles with everyone`);
    return { ok: true };
  }

  // ---------- group taste ----------

  _noteTaste(media, id, delta) {
    if (!media) return;
    const key = media.tmdbId ? 'tmdb:' + media.tmdbId : media.catalogId ? 'cat:' + media.catalogId : null;
    if (!key) return;
    const e = this.taste.get(key) || { item: { title: media.title, tmdbId: media.tmdbId, catalogId: media.catalogId, genres: media.genres, poster: media.poster, year: media.year }, likes: new Set(), dislikes: new Set() };
    if (id) { if (delta > 0) { e.likes.add(id); e.dislikes.delete(id); } else { e.dislikes.add(id); e.likes.delete(id); } }
    this.taste.set(key, e);
    this.emit('taste', this.tasteView());
  }

  tasteVote(id, item, like) {
    const m = this.members.get(id);
    if (!m || !item) return { ok: false };
    if (!this._rateOk(m, '_taste', 10, 5000)) return { ok: false, error: 'slow-down' };
    if (this.taste.size >= 200) return { ok: false, error: 'full' };
    const media = { kind: 'companion', title: cleanText(item.title, 200), tmdbId: num(item.tmdbId, 1, 1e9), catalogId: cleanText(item.catalogId, 80) || null,
      genres: Array.isArray(item.genres) ? item.genres.slice(0, 6).map(g => cleanText(g, 30)) : [], poster: isHttpUrl(item.poster) ? item.poster : null, year: num(item.year, 1870, 2100) };
    if (!media.title) return { ok: false };
    this._noteTaste(media, id, like ? 1 : -1);
    return { ok: true };
  }

  tasteView() {
    return [...this.taste.entries()].map(([key, e]) => ({
      key, item: e.item, likes: [...e.likes].map(id => this.members.get(id)?.name).filter(Boolean), likeIds: [...e.likes], dislikeIds: [...e.dislikes],
    }));
  }

  // ---------- periodic work (called every ~200 ms) ----------

  tick() {
    const t = this.now();
    const pb = this.playback;

    // host fell off and didn't come back in time
    const host = this.members.get(this.hostId);
    if (host && !host.connected && t - host.leftAt > HOST_GRACE_MS) {
      const next = this._pickNextHost();
      if (next) this._setHost(next, 'auto');
    }

    // timed polls
    for (const p of this.polls) if (!p.closed && p.closesAt && t >= p.closesAt) this.pollClose(null, p.id);

    // intermission timer
    if (this.intermission && t >= this.intermission.endsAt) this._endIntermission(null);

    // highlight clip reached its end
    if (pb.playing && pb.stopAt != null && this.position() >= pb.stopAt) {
      this._publishPlayback({ playing: false, basePos: pb.stopAt, baseTime: t, stopAt: null }, null, 'highlight-end');
    }

    this._checkBuffering();
    if (this.bufferPause) this._checkBufferResume();

    // forget people who left a while ago
    for (const [id, m] of this.members) {
      if (!m.connected && t - m.leftAt > MEMBER_EXPIRE_MS && id !== this.hostId) { this.members.delete(id); this._membersDirty = true; }
    }

    if (this._membersDirty) {
      this._membersDirty = false;
      this.emit('members', this.membersView());
    }
  }

  membersView() {
    return [...this.members.values()].map(m => ({
      id: m.id, name: m.name, color: m.color, connected: m.connected, cohost: m.cohost,
      host: m.id === this.hostId, joinedAt: m.joinedAt, status: { ...m.status },
    }));
  }

  latencyStats() {
    const v = this.connectedMembers().flatMap(m => m._latency || []);
    return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), p99: percentile(v, 99), max: v.length ? Math.max(...v) : 0 };
  }

  recap() {
    const name = id => this.members.get(id)?.name || 'someone';
    const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
    let hype = null;
    for (const [itemId, buckets] of Object.entries(this.reactions)) {
      for (const [b, cell] of Object.entries(buckets)) {
        const total = Object.values(cell).reduce((x, y) => x + y, 0);
        if (!hype || total > hype.total) hype = { itemId, time: b * REACTION_BUCKET, total, emoji: top(cell)[0] };
      }
    }
    const tr = top(this.stats.reactions), tm = top(this.stats.messages);
    return {
      minutes: Math.round((this.now() - this.createdAt) / 60000),
      people: this.members.size,
      topReactor: tr ? { name: name(tr[0]), count: tr[1] } : null,
      topChatter: tm ? { name: name(tm[0]), count: tm[1] } : null,
      emoji: Object.entries(this.stats.emoji).sort((a, b) => b[1] - a[1]).slice(0, 5),
      hype,
      clips: this.highlights.length,
      watched: [this.playback.media, ...this.history.map(h => h.media)].filter(Boolean).map(m => m.title).slice(0, 10),
    };
  }

  snapshot(forId) {
    const me = this.members.get(forId);
    return {
      code: this.code,
      you: forId,
      joinVideoPos: me ? me.joinVideoPos : 0,
      joinedAt: me ? me.joinedAt : this.now(),
      hostId: this.hostId,
      settings: this.settings,
      playback: this.playbackView(),
      members: this.membersView(),
      queue: this.queueView(),
      polls: this.pollsView(),
      chat: this.chat.slice(-150),
      highlights: this.highlights,
      reactions: { itemId: this.playback.itemId, buckets: this.reactions[this.playback.itemId] || {} },
      intermission: this.intermission,
      captions: this.sharedCaptions,
      taste: this.tasteView(),
      history: this.history.slice(0, 10),
      emojis: EMOJIS,
    };
  }
}

module.exports = { Room, cleanMedia, EMOJIS, CONFLICT_WINDOW_MS, HOST_GRACE_MS, COUNTDOWN_MS, REWIND_SECONDS };
