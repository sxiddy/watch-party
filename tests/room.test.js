// Room rules, driven with a fake clock. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, CONFLICT_WINDOW_MS, HOST_GRACE_MS } = require('../server/room');

function setup(n = 3) {
  let now = 1_000_000;
  const events = [];
  const room = new Room('TEST01', { now: () => now, emit: (ev, data) => events.push({ ev, data }) });
  const ids = [];
  for (let i = 0; i < n; i++) { const id = 'user' + i + 'xxxxx'; room.join(id, 'P' + i, 's' + i); ids.push(id); }
  room.setMedia(ids[0], { kind: 'file', src: 'https://example.com/a.mp4', title: 'A', duration: 600 });
  return { room, ids, events, tick: ms => { now += ms; room.tick(); }, get now() { return now; } };
}

test('first person in is the host', () => {
  const { room, ids } = setup();
  assert.equal(room.hostId, ids[0]);
});

test('only the host controls playback by default', () => {
  const { room, ids } = setup();
  assert.equal(room.control(ids[1], { action: 'play' }).error, 'not-allowed');
  assert.ok(room.control(ids[0], { action: 'play' }).ok);
  room.updateSettings(ids[0], { controlMode: 'everyone' });
  assert.ok(room.control(ids[1], { action: 'pause' }).ok);
});

test('co-hosts can control', () => {
  const { room, ids } = setup();
  room.setCohost(ids[0], ids[2], true);
  assert.ok(room.control(ids[2], { action: 'play' }).ok);
});

test('position advances while playing and freezes on pause', () => {
  const t = setup();
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(10_000);
  assert.ok(Math.abs(t.room.position() - 10) < 0.001);
  t.room.control(t.ids[0], { action: 'pause' });
  t.tick(5000);
  assert.ok(Math.abs(t.room.position() - 10) < 0.001);
});

test('countdown start holds position until it fires', () => {
  const t = setup();
  t.room.control(t.ids[0], { action: 'play', countdown: true });
  t.tick(2000);
  assert.equal(t.room.position(), 0);
  t.tick(2000);
  assert.ok(Math.abs(t.room.position() - 1) < 0.001);
});

test('concurrent seeks: the first one wins inside the conflict window', () => {
  const t = setup();
  t.room.updateSettings(t.ids[0], { controlMode: 'everyone' });
  const v = t.room.playback.version;
  assert.ok(t.room.control(t.ids[1], { action: 'seek', position: 100, baseVersion: v }).ok);
  const clash = t.room.control(t.ids[2], { action: 'seek', position: 300, baseVersion: v });
  assert.equal(clash.error, 'conflict');
  assert.equal(clash.winner, 'P1');
  assert.equal(t.room.playback.basePos, 100);
  // after the window, a late (stale) request is accepted: last writer wins
  t.tick(CONFLICT_WINDOW_MS + 10);
  assert.ok(t.room.control(t.ids[2], { action: 'seek', position: 300, baseVersion: v }).ok);
  assert.equal(t.room.playback.basePos, 300);
});

test('versions only ever go up', () => {
  const t = setup();
  const seen = [];
  t.room.emit = (ev, d) => ev === 'playback' && seen.push(d.version);
  for (let i = 0; i < 20; i++) { t.room.control(t.ids[0], { action: i % 2 ? 'pause' : 'play' }); t.tick(150); }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
});

test('host drop: keeps the crown during the grace period, then the most stable member gets it', () => {
  const t = setup(3);
  t.room.status(t.ids[1], { rtt: 80 });
  t.room.status(t.ids[2], { rtt: 12 });
  t.room.detach(t.ids[0], 's0');
  t.tick(HOST_GRACE_MS - 1000);
  assert.equal(t.room.hostId, t.ids[0]);
  t.tick(2000);
  assert.equal(t.room.hostId, t.ids[2], 'lowest round-trip wins');
});

test('host comes back within grace and is still host', () => {
  const t = setup(2);
  t.room.detach(t.ids[0], 's0');
  t.tick(4000);
  t.room.join(t.ids[0], 'P0', 's0b');
  t.tick(HOST_GRACE_MS);
  assert.equal(t.room.hostId, t.ids[0]);
});

test('late joiner snapshot has the live position', () => {
  const t = setup(1);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(42_000);
  t.room.join('latecomer123', 'Late', 'sx');
  const snap = t.room.snapshot('latecomer123');
  assert.equal(snap.playback.playing, true);
  assert.ok(Math.abs(snap.joinVideoPos - 42) < 0.01);
  assert.equal(snap.members.length, 2);
});

test('reconnect keeps the same identity (no duplicate member)', () => {
  const t = setup(2);
  t.room.detach(t.ids[1], 's1');
  t.room.join(t.ids[1], 'P1', 's1-new');
  assert.equal(t.room.members.size, 2);
  assert.ok(t.room.members.get(t.ids[1]).connected);
});

test('buffering pauses the room, and it resumes when they recover', () => {
  const t = setup(3);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(9000); // past the new-joiner grace period
  t.room.status(t.ids[1], { buffering: true });
  t.tick(600);
  assert.equal(t.room.playback.playing, true, 'short blips are ignored');
  t.tick(800);
  assert.equal(t.room.playback.playing, false);
  assert.equal(t.room.playback.reason, 'buffering');
  t.room.status(t.ids[1], { buffering: false });
  assert.equal(t.room.playback.playing, true);
  assert.equal(t.room.playback.reason, 'resume');
});

test('rewind requests: 30% of the room sends everyone back 10s', () => {
  const t = setup(10);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(60_000);
  t.room.rewindRequest(t.ids[1]);
  t.room.rewindRequest(t.ids[2]);
  assert.ok(t.room.position() > 59);
  t.room.rewindRequest(t.ids[3]);
  assert.equal(t.room.playback.reason, 'rewind');
  assert.ok(Math.abs(t.room.playback.basePos - 50) < 0.01);
});

test('intermission: ends early once everyone is back, with a countdown', () => {
  const t = setup(2);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(1000);
  t.room.intermissionStart(t.ids[0], 5);
  assert.equal(t.room.playback.playing, false);
  t.room.intermissionReady(t.ids[0], true);
  assert.ok(t.room.intermission);
  t.room.intermissionReady(t.ids[1], true);
  assert.equal(t.room.intermission, null);
  assert.equal(t.room.playback.playing, true);
  assert.ok(t.room.playback.baseTime > t.now, 'starts with a countdown');
});

test('polls: one vote each, can change it, queue poll moves the winner to the top', () => {
  const t = setup(3);
  t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://e.com/1.mp4', title: 'One' });
  t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://e.com/2.mp4', title: 'Two' });
  t.room.pollCreate(t.ids[1], { fromQueue: true, durationSec: 30 });
  const p = t.room.polls[0];
  t.room.pollVote(t.ids[0], p.id, p.options[0].id);
  t.room.pollVote(t.ids[0], p.id, p.options[1].id); // changed mind
  t.room.pollVote(t.ids[1], p.id, p.options[1].id);
  assert.equal(p.options[0].votes.size, 0);
  assert.equal(p.options[1].votes.size, 2);
  t.tick(31_000); // timer closes it
  assert.ok(p.closed);
  assert.equal(t.room.queue[0].media.title, 'Two');
});

test('highlight replay stops at the end of the clip', () => {
  const t = setup(1);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(30_000);
  t.room.highlightAdd(t.ids[0], { title: 'the jump' });
  const clip = t.room.highlights[0];
  assert.ok(Math.abs(clip.end - 30) < 0.01 && Math.abs(clip.start - 15) < 0.01);
  t.room.highlightPlay(t.ids[0], clip.id);
  t.tick(16_000);
  assert.equal(t.room.playback.playing, false);
  assert.ok(Math.abs(t.room.playback.basePos - 30) < 0.01);
});

test('chat: /spoiler hides, rate limit kicks in', () => {
  const t = setup(1);
  t.room.chatSend(t.ids[0], '/spoiler he was dead all along');
  const msg = t.room.chat.at(-1);
  assert.equal(msg.spoiler, true);
  assert.equal(msg.text, 'he was dead all along');
  let blocked = false;
  for (let i = 0; i < 10; i++) if (t.room.chatSend(t.ids[0], 'spam ' + i).error === 'slow-down') blocked = true;
  assert.ok(blocked);
});

test('bad media is rejected', () => {
  const t = setup(1);
  assert.equal(t.room.setMedia(t.ids[0], { kind: 'file', src: 'javascript:alert(1)', title: 'x' }).error, 'bad-media');
  assert.equal(t.room.setMedia(t.ids[0], { kind: 'nope' }).error, 'bad-media');
  assert.ok(t.room.setMedia(t.ids[0], { kind: 'youtube', ytId: 'https://youtu.be/dQw4w9WgXcQ', title: 'yt' }).ok);
  assert.equal(t.room.playback.media.ytId, 'dQw4w9WgXcQ');
});

test('queue end: next item autoplays with a countdown', () => {
  const t = setup(1);
  t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://e.com/next.mp4', title: 'Next' });
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(600_000);
  assert.ok(t.room.ended(t.ids[0], t.room.playback.itemId).ok);
  assert.equal(t.room.playback.media.title, 'Next');
  assert.equal(t.room.playback.playing, true);
  // a second "ended" for the old item is ignored (several clients report it)
  assert.equal(t.room.queue.length, 0);
});

// ---- things the review found ----

test('a guest cannot shorten the film or end it while the host is here', () => {
  const t = setup(2);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(5000);
  t.room.status(t.ids[1], { duration: 5, itemId: t.room.playback.itemId });
  assert.equal(t.room.playback.duration, 600);
  assert.equal(t.room.ended(t.ids[1], t.room.playback.itemId).error, 'not-allowed');
});

test('one guest cannot rewind a small room alone', () => {
  const t = setup(2);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(60_000);
  t.room.rewindRequest(t.ids[1]);
  assert.notEqual(t.room.playback.reason, 'rewind');
  t.room.rewindRequest(t.ids[0]);
  assert.equal(t.room.playback.reason, 'rewind');
});

test('a click right after an automatic change is not a clash', () => {
  const t = setup(3);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(9000);
  t.room.status(t.ids[1], { buffering: true });
  t.tick(1400); // room pauses for buffering (changedBy null)
  assert.equal(t.room.playback.reason, 'buffering');
  const v = t.room.playback.version - 1; // host hadn't seen the buffer pause yet
  t.tick(50);
  assert.ok(t.room.control(t.ids[0], { action: 'seek', position: 20, baseVersion: v }).ok);
});

test('guests can only queue video links from known free sources', () => {
  const t = setup(2);
  assert.equal(t.room.queueAdd(t.ids[1], { kind: 'file', src: 'http://169.254.169.254/x.mp4', title: 'x' }).error, 'not-allowed');
  assert.ok(t.room.queueAdd(t.ids[1], { kind: 'file', src: 'https://archive.org/download/a/b.mp4', title: 'ok' }).ok);
  assert.ok(t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://example.com/mine.mp4', title: 'host link' }).ok);
});

test('host can remove someone and they stay out', () => {
  const t = setup(3);
  assert.equal(t.room.kick(t.ids[1], t.ids[2]).error, 'not-host');
  const r = t.room.kick(t.ids[0], t.ids[2]);
  assert.ok(r.ok);
  assert.deepEqual(r.sockets, ['s2']);
  assert.equal(t.room.members.has(t.ids[2]), false);
  assert.ok(t.room.banned.has(t.ids[2]));
});

// ---------- round-2 review ----------

test('nobody can cap a companion room with a fake length', () => {
  const t = setup(2);
  const r = t.room.setMedia(t.ids[0], { kind: 'companion', title: 'Ted 2', duration: 0 });
  t.room.status(t.ids[1], { duration: 5, itemId: r.itemId });
  t.room.status(t.ids[0], { duration: 5, itemId: r.itemId });
  assert.equal(t.room.playback.duration, 0);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(60_000);
  assert.ok(t.room.position() > 50, 'the shared clock keeps running');
});

test('a guest cannot fill in a missing length either', () => {
  const t = setup(2);
  const r = t.room.setMedia(t.ids[0], { kind: 'file', src: 'https://archive.org/download/a/b.mp4', title: 'B' });
  t.room.status(t.ids[1], { duration: 5, itemId: r.itemId });
  assert.equal(t.room.playback.duration, 0);
  t.room.status(t.ids[0], { duration: 5400, itemId: r.itemId });
  assert.equal(t.room.playback.duration, 5400);
});

test('one tab cannot flood the room latency numbers', () => {
  const t = setup(3);
  t.room.status(t.ids[0], { latency: [20, 25, 30] });
  t.room.status(t.ids[1], { latency: [22, 28] });
  for (let i = 0; i < 300; i++) { t.room.status(t.ids[2], { latency: Array(10).fill(4999) }); t.tick(100); }
  const st = t.room.latencyStats();
  assert.ok(st.max <= 2000, 'values are capped');
  assert.equal(t.room.members.get(t.ids[2])._latency.length, 20, 'each person keeps only their last 20');
  assert.equal(st.n, 25);
});

test('fake buffering can pause the room twice, not forever', () => {
  const t = setup(3);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(9000);
  let pauses = 0;
  for (let i = 0; i < 5; i++) {
    t.room.status(t.ids[1], { buffering: true });
    t.tick(1400);
    if (t.room.playback.reason === 'buffering') pauses++;
    t.room.status(t.ids[1], { buffering: false });
    t.tick(16_000);
  }
  assert.equal(pauses, 2);
  assert.equal(t.room.playback.playing, true);
});

test('subtitles with a byte-order mark can be shared', () => {
  const t = setup(2);
  assert.ok(t.room.captionsShare(t.ids[0], { name: 'a.vtt', vtt: '﻿WEBVTT\n\n00:01.000 --> 00:02.000\nhi' }).ok);
  assert.ok(t.room.sharedCaptions.vtt.startsWith('WEBVTT'));
});

test('coming back with a new name is announced', () => {
  const t = setup(2);
  t.room.join(t.ids[1], 'Host', 's9');
  assert.equal(t.room.members.get(t.ids[1]).name, 'Host');
  assert.ok(t.events.some(e => e.ev === 'chat' && /P1 is now Host/.test(e.data.text)));
});

test('kicking also remembers the address; two tabs on one address are one rewind vote', () => {
  const t = setup(0);
  t.room.join('aaaaaaaaaaaaaaaa', 'Host', 's0', { ip: 'ip-a' });
  for (let i = 1; i <= 5; i++) t.room.join('member' + i + 'xxxxxxxxx', 'P' + i, 's' + i, { ip: i <= 2 ? 'ip-b' : 'ip-' + i });
  t.room.setMedia('aaaaaaaaaaaaaaaa', { kind: 'file', src: 'https://archive.org/download/a/b.mp4', title: 'A', duration: 600 });
  t.room.control('aaaaaaaaaaaaaaaa', { action: 'play' });
  t.tick(30_000);
  t.room.rewindRequest('member1xxxxxxxxx');
  const r = t.room.rewindRequest('member2xxxxxxxxx');
  assert.equal(r.count, 1, 'same address counted once');
  assert.ok(t.room.kick('aaaaaaaaaaaaaaaa', 'member1xxxxxxxxx').ok);
  assert.ok(t.room.bannedIps.has('ip-b'));
});

test('a YouTube link with a start time starts everyone there', () => {
  const t = setup(2);
  assert.ok(t.room.setMedia(t.ids[0], { kind: 'youtube', ytId: 'dQw4w9WgXcQ', title: 'R', startAt: 30, poster: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }).ok);
  assert.equal(t.room.position(), 30);
  assert.equal(t.room.playback.media.poster, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(t.room.setMedia(t.ids[0], { kind: 'youtube', ytId: 'not an id!', title: 'x' }).error, 'bad-media');
});

// ---- things the feature audit found ----

test('catalog films without a TMDB id stay separate (no tmdbId 1)', () => {
  const t = setup(1);
  t.room.setMedia(t.ids[0], { kind: 'file', src: 'https://e.com/s.mp4', title: 'Sintel', tmdbId: null });
  assert.equal(t.room.playback.media.tmdbId, null);
});

test('the most-voted queue item plays next', () => {
  const t = setup(3);
  t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://e.com/1.mp4', title: 'One' });
  t.room.queueAdd(t.ids[0], { kind: 'file', src: 'https://e.com/2.mp4', title: 'Two' });
  const two = t.room.queue[1].id;
  t.room.queueVote(t.ids[1], two);
  t.room.queueVote(t.ids[2], two);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(600_000);
  assert.ok(t.room.ended(t.ids[0], t.room.playback.itemId).ok);
  assert.equal(t.room.playback.media.title, 'Two');
  assert.equal(t.room.queue[0].media.title, 'One');
});

test('a seek while waiting for someone to buffer still resumes', () => {
  const t = setup(3);
  t.room.control(t.ids[0], { action: 'play' });
  t.tick(9000);
  t.room.status(t.ids[1], { buffering: true });
  t.tick(1500);
  assert.equal(t.room.playback.reason, 'buffering');
  t.room.control(t.ids[0], { action: 'seek', position: 120 });
  t.room.status(t.ids[1], { buffering: false });
  assert.equal(t.room.playback.playing, true);
  assert.ok(Math.abs(t.room.playback.basePos - 120) < 0.001);
});
