#!/usr/bin/env node
// Playback-control propagation benchmark.
//
//   node bench/latency.js                       # in-process server, 15 viewers, 300 actions
//   node bench/latency.js --viewers 30 --ops 500
//   node bench/latency.js --url http://192.168.1.20:3000   # a server elsewhere on your LAN
//   node bench/latency.js --delay 40 --jitter 30           # add fake network delay per message
//
// Every bot lives in this one process, so "sent" and "received" are measured
// on the same clock (performance.now) — no clock-sync error in the numbers.
// Latency = host emits a control → each viewer's handler runs.

const { io } = require('socket.io-client');
const { percentile } = require('../public/js/sync-core');

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  return {
    url: get('url', null), viewers: +get('viewers', 15), ops: +get('ops', 300),
    delay: +get('delay', 0), jitter: +get('jitter', 0), json: a.includes('--json'), quiet: a.includes('--quiet'),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const later = (cfg, fn) => {
  if (!cfg.delay && !cfg.jitter) return fn();
  setTimeout(fn, Math.max(0, cfg.delay + (Math.random() * 2 - 1) * cfg.jitter));
};

function connect(url, cfg) {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: true, reconnectionDelay: 200 });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
    s._cfg = cfg;
  });
}

const join = (s, code, id, name) => new Promise(r => s.emit('join', { code, clientId: id, name }, r));
const req = (s, ev, p) => new Promise(r => s.emit(ev, p, r));

async function run(cfg) {
  let server = null, url = cfg.url;
  if (!url) {
    const mod = require('../server/index');
    server = mod.server;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + server.address().port;
  }
  const { code } = await fetch(url + '/api/rooms', { method: 'POST' }).then(r => r.json());

  const host = await connect(url, cfg);
  await join(host, code, 'bench-host-000', 'Host');
  await req(host, 'media:set', { media: { kind: 'file', src: 'https://example.com/movie.mp4', title: 'Bench', duration: 7200 } });
  await req(host, 'settings', { controlMode: 'everyone' });

  const sent = new Map();        // issuedAt tag → performance.now() at emit
  const samples = [];            // ms
  const perViewer = [];
  const viewers = [];
  for (let i = 0; i < cfg.viewers; i++) {
    const s = await connect(url, cfg);
    const id = 'bench-viewer-' + String(i).padStart(3, '0');
    const snap = await join(s, code, id, 'Viewer ' + i);
    if (!snap.ok) throw new Error('join failed: ' + snap.error);
    s.data = { id, last: 0, versions: [] };
    perViewer[i] = [];
    s.on('playback', pb => later(cfg, () => {
      s.data.last = Math.max(s.data.last, pb.version);
      s.data.versions.push(pb.version);
      const t0 = sent.get(pb.issuedAt);
      if (t0 != null) { const ms = performance.now() - t0; samples.push(ms); perViewer[i].push(ms); }
    }));
    viewers.push(s);
  }
  await sleep(300);

  // 1) propagation: host fires play / pause / seek at random gaps
  const actions = ['play', 'pause', 'seek'];
  let pos = 0, lastTag = 0, rejected = 0;
  for (let k = 0; k < cfg.ops; k++) {
    const action = actions[k % 3];
    // the server echoes issuedAt back on the playback event, so it doubles as a tag
    const issuedAt = lastTag = Math.max(Date.now(), lastTag + 1);
    const op = { action, issuedAt };
    if (action === 'seek') op.position = (pos = (pos + 37) % 7000);
    sent.set(issuedAt, performance.now());
    host.emit('control', op, r => { if (!r || !r.ok) rejected++; });
    await sleep(130 + Math.random() * 120); // ~5 clicks a second, faster than any real person
  }
  await sleep(500);

  // 2) concurrent actions: two viewers seek at the exact same time, 40 rounds
  let conflicts = 0, accepted = 0;
  for (let r = 0; r < 40; r++) {
    const a = viewers[r % viewers.length], b = viewers[(r + 1) % viewers.length];
    const base = Math.max(...viewers.map(v => v.data.last));
    const [ra, rb] = await Promise.all([
      req(a, 'control', { action: 'seek', position: 100 + r, baseVersion: base }),
      req(b, 'control', { action: 'seek', position: 900 + r, baseVersion: base }),
    ]);
    [ra, rb].forEach(x => (x.ok ? accepted++ : x.error === 'conflict' && conflicts++));
    await sleep(350);
  }
  await sleep(400);
  const finals = new Set(viewers.map(v => v.data.last));

  // 3) reconnect: drop a third of the viewers, change state while they're gone, bring them back
  const dropped = viewers.slice(0, Math.max(1, Math.floor(viewers.length / 3)));
  dropped.forEach(s => s.disconnect());
  await sleep(300);
  await req(host, 'control', { action: 'seek', position: 4321 });
  await req(host, 'control', { action: 'pause' });
  const rejoin = await Promise.all(dropped.map(async s => {
    s.connect();
    await new Promise(r => s.once('connect', r));
    const res = await join(s, code, s.data.id, 'again');
    return res.ok && Math.abs(res.snapshot.playback.basePos - 4321) < 1 && res.snapshot.members.filter(m => m.id === s.data.id).length === 1;
  }));

  const result = {
    when: new Date().toISOString(),
    url: cfg.url ? cfg.url : 'in-process (127.0.0.1)',
    viewers: cfg.viewers,
    actions: cfg.ops,
    fakeDelayMs: cfg.delay, fakeJitterMs: cfg.jitter,
    samples: samples.length,
    expected: (cfg.ops - rejected) * cfg.viewers,
    hostActionsRejected: rejected,
    p50: +percentile(samples, 50).toFixed(2),
    p95: +percentile(samples, 95).toFixed(2),
    p99: +percentile(samples, 99).toFixed(2),
    max: +Math.max(...samples).toFixed(2),
    worstViewerP95: +Math.max(...perViewer.map(v => percentile(v, 95))).toFixed(2),
    concurrent: { rounds: 40, accepted, rejectedAsConflict: conflicts, allViewersAgreeOnFinalVersion: finals.size === 1 },
    reconnect: { dropped: dropped.length, cameBackWithCorrectState: rejoin.filter(Boolean).length },
    node: process.version,
  };

  [host, ...viewers].forEach(s => s.close());
  if (server) { server.close(); }
  return result;
}

async function main() {
  const cfg = args();
  const res = await run(cfg);
  if (cfg.json) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`\n${res.viewers} viewers, ${res.actions} actions, ${res.samples} deliveries (${res.url})`);
    if (res.fakeDelayMs || res.fakeJitterMs) console.log(`fake network delay ${res.fakeDelayMs} ± ${res.fakeJitterMs} ms`);
    console.log(`p50 ${res.p50} ms   p95 ${res.p95} ms   p99 ${res.p99} ms   max ${res.max} ms   (worst single viewer p95 ${res.worstViewerP95} ms)`);
    console.log(`concurrent seeks: ${res.concurrent.accepted} accepted, ${res.concurrent.rejectedAsConflict} rejected as conflicts, everyone agrees: ${res.concurrent.allViewersAgreeOnFinalVersion}`);
    console.log(`reconnect: ${res.reconnect.cameBackWithCorrectState}/${res.reconnect.dropped} came back with the right state`);
    console.log(res.p95 <= 250 ? 'PASS: p95 ≤ 250 ms' : 'FAIL: p95 > 250 ms');
  }
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { run };
