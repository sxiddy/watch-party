// Back Row Sync: the extension's background worker.
//
// Holds the one live connection to the Back Row server (the same socket.io
// protocol the website uses) and passes the room's playback state to the
// streaming tab. The tab itself (content.js) moves the video.
importScripts('lib/socket.io-4.8.min.js', 'lib/sync-core.js');
const { ClockSync } = self.SyncCore;

const SERVERS = {
  live: { api: 'https://watchpartyvinnovate-sync.onrender.com', site: 'https://watchpartyvinnovate.vercel.app' },
  local: { api: 'http://localhost:3000', site: 'http://localhost:3000' },
};

const S = {
  server: 'live', code: '', name: '', tabId: null, joined: false,
  you: null, hostId: null, settings: {}, playback: null, members: [],
  conn: 'idle', error: '', lastHeard: 0,
};
let socket = null;
let clock = new ClockSync({ maxSamples: 12 });
let pingTimer = null;
const ports = new Set();

// ---------- identity and saved session ----------

async function clientId() {
  const { brId } = await chrome.storage.local.get('brId');
  if (brId) return brId;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await chrome.storage.local.set({ brId: id });
  return id;
}
const save = () => chrome.storage.session.set({ session: { server: S.server, code: S.code, name: S.name, tabId: S.tabId, joined: S.joined } });

// ---------- talking to the tab and the popup ----------

function view() {
  return {
    server: S.server, code: S.code, name: S.name, tabId: S.tabId, joined: S.joined, conn: S.conn, error: S.error,
    you: S.you, isHost: S.you && S.you === S.hostId, settings: S.settings, members: S.members,
    title: S.playback && S.playback.media ? S.playback.media.title : '',
    invite: S.code ? SERVERS[S.server].site + '/r/' + S.code : '', rtt: Math.round(clock.rtt || 0),
  };
}
function toTab(msg) { for (const p of ports) if (p.sender?.tab?.id === S.tabId) p.postMessage(msg); }
function pushState() {
  toTab({ type: 'state', playback: S.playback, offset: clock.offset, canControl: canControl(), code: S.code, watching: S.members.filter(m => m.connected !== false).length, conn: S.conn });
  chrome.runtime.sendMessage({ type: 'view', view: view() }).catch(() => {}); // popup may be closed
}
function canControl() {
  if (!S.you) return false;
  if (S.you === S.hostId || S.settings.controlMode === 'everyone') return true;
  const me = S.members.find(m => m.id === S.you);
  return !!(me && me.cohost);
}

// ---------- the socket ----------

function request(ev, payload, timeout = 6000) {
  return new Promise(resolve => {
    if (!socket || !socket.connected) return resolve({ ok: false, error: 'offline' });
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeout);
    socket.emit(ev, payload, res => { clearTimeout(t); resolve(res || { ok: false }); });
  });
}

function ping() {
  if (!socket || !socket.connected) return;
  const t0 = Date.now();
  socket.emit('tp', ts => { S.lastHeard = Date.now(); clock.addSample(t0, ts, Date.now()); });
}

function connect() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); }
  clock = new ClockSync({ maxSamples: 12 });
  S.conn = 'connecting';
  // websocket only: a service worker has no XMLHttpRequest for polling
  socket = io(SERVERS[S.server].api, { transports: ['websocket'], reconnectionDelay: 400, reconnectionDelayMax: 4000 });
  socket.on('connect', async () => {
    S.conn = 'connected'; S.error = '';
    for (let i = 0; i < 6; i++) { ping(); await new Promise(r => setTimeout(r, 80)); }
    if (S.joined) await join(true);
    pushState();
  });
  socket.on('disconnect', () => { S.conn = 'reconnecting'; pushState(); });
  socket.on('connect_error', () => { S.conn = 'reconnecting'; S.error = 'Can’t reach the server yet (free hosting can take a minute to wake up)'; pushState(); });
  socket.onAny(() => { S.lastHeard = Date.now(); });
  socket.on('playback', pb => { S.playback = pb; pushState(); });
  socket.on('members', m => { S.members = m; pushState(); });
  socket.on('host', h => { S.hostId = h.hostId; pushState(); });
  socket.on('settings', s => { S.settings = s; pushState(); });
  socket.on('notice', n => toTab({ type: 'toast', text: n.text }));
  socket.on('kicked', () => { toTab({ type: 'stop' }); S.joined = false; S.error = 'The host removed you from the room'; save(); pushState(); });
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    ping();
    // a socket that's "open" but silent is dead: replace it (same watchdog as the website)
    if (socket && socket.connected && S.lastHeard && Date.now() - S.lastHeard > 9000) { socket.disconnect(); socket.connect(); }
  }, 3000);
}

async function join(rejoin = false) {
  const res = await request('join', { code: S.code, name: S.name, clientId: await clientId() });
  if (!res.ok) {
    toTab({ type: 'stop' });
    S.joined = false;
    S.error = { 'not-found': 'No room with that code', 'room-full': 'That room is full', locked: 'The host locked that room', removed: 'You were removed from that room', 'slow-down': 'Too many tries, wait a moment' }[res.error] || 'Couldn’t join (' + res.error + ')';
    save(); pushState();
    return res;
  }
  const snap = res.snapshot;
  Object.assign(S, { joined: true, error: '', you: snap.you, hostId: snap.hostId, settings: snap.settings, playback: snap.playback, members: snap.members });
  save(); pushState();
  if (!rejoin) injectInto(S.tabId);
  return res;
}

// ---------- the streaming tab ----------

async function injectInto(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (/netflix\.com/.test(tab.url || '')) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page-netflix.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/sync-core.js', 'content.js'] });
  } catch (e) { S.error = 'Can’t run on this page: ' + e.message; pushState(); }
}

// the tab reloaded or moved to the next episode: put the sync back in
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === S.tabId && S.joined && info.status === 'complete') injectInto(tabId); });
chrome.tabs.onRemoved.addListener(tabId => { if (tabId === S.tabId) { S.tabId = null; save(); } });

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'br-tab') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async msg => {
    await ready;
    if (port.sender?.tab?.id !== S.tabId) return;
    if (msg.type === 'hello') pushState();
    else if (msg.type === 'control') {
      const res = await request('control', { ...msg.op, baseVersion: S.playback ? S.playback.version : 0, issuedAt: Date.now() + clock.offset });
      if (!res.ok) port.postMessage({ type: 'toast', text: res.error === 'not-allowed' ? 'Only the host can control playback in this room' : res.error === 'conflict' ? res.winner + ' got there first' : '' });
    } else if (msg.type === 'status') {
      request('status', { buffering: !!msg.buffering, drift: msg.drift });
    }
  });
});

// ---------- the popup ----------

async function apiCreateRoom() {
  const r = await fetch(SERVERS[S.server].api + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
  return (await r.json()).code;
}

// where the tab's film is right now (read before joining, so the room's state can't move it first)
async function readVideo(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const v = [...document.querySelectorAll('video')].filter(v => v.readyState > 0).sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
      return v ? { t: v.currentTime, paused: v.paused } : null;
    } });
    return r && r.result;
  } catch (e) { return null; }
}

function waitConnected(ms = 70000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    (function check() { if (socket && socket.connected) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(check, 200); })();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    if (msg.type === 'get') return reply(view());
    if (msg.type === 'start' || msg.type === 'join') {
      if (S.tabId != null && S.tabId !== msg.tabId) toTab({ type: 'stop' }); // the old tab stops syncing
      Object.assign(S, { server: msg.server, name: msg.name, tabId: msg.tabId, error: '' });
      if (!socket || socket.io.uri !== SERVERS[S.server].api) connect();
      try {
        if (msg.type === 'start') S.code = await apiCreateRoom();
        else S.code = String(msg.code || '').toUpperCase().trim();
      } catch (e) { S.error = 'Couldn’t make a room: ' + e.message; pushState(); return reply(view()); }
      if (!(await waitConnected())) { S.error = 'The server didn’t answer. Try again in a minute.'; pushState(); return reply(view()); }
      const here = msg.type === 'start' ? await readVideo(S.tabId) : null;
      const res = await join();
      if (res.ok && msg.type === 'start') {
        // the room shows this film in companion mode on the website too
        await request('media:set', { media: { kind: 'companion', title: msg.title || 'Movie night', sourceLabel: msg.site || 'Streaming app' } });
        if (msg.everyone) await request('settings', { controlMode: 'everyone' });
        // the room starts where the host's video already was
        if (here) { await request('control', { action: 'seek', position: here.t, baseVersion: S.playback ? S.playback.version : 0 }); if (!here.paused) await request('control', { action: 'play', baseVersion: S.playback ? S.playback.version : 0 }); }
      }
      return reply(view());
    }
    if (msg.type === 'everyone') { await request('settings', { controlMode: msg.value ? 'everyone' : 'host' }); return reply(view()); }
    if (msg.type === 'leave') {
      toTab({ type: 'stop' });
      clearInterval(pingTimer);
      Object.assign(S, { joined: false, code: '', playback: null, members: [], you: null, hostId: null });
      if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
      S.conn = 'idle'; save();
      return reply(view());
    }
  })();
  return true; // reply comes later
});

// ---------- waking back up ----------

// Chrome may stop an idle worker; an alarm brings it back and the saved
// session reconnects it to the same room as the same person.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (S.joined && (!socket || !socket.connected)) connect(); });
const ready = (async () => {
  const { session } = await chrome.storage.session.get('session');
  if (session && session.joined) { Object.assign(S, session); connect(); }
})();
