// Sync math + fuzzy search.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClockSync, DriftController, expectedPosition, percentile } = require('../public/js/sync-core');
const Fuzzy = require('../public/js/fuzzy');
const { srtToVtt, youtubeId } = require('../server/util');

test('clock sync trusts the lowest round trip', () => {
  const c = new ClockSync({ now: () => 0 });
  c.addSample(0, 1050, 100);   // rtt 100, offset 1000
  c.addSample(200, 1210, 220); // rtt 20, offset 1000
  c.addSample(300, 1500, 500); // rtt 200, offset 1100 (noisy)
  assert.equal(c.offset, 1000);
});

test('expected position with a future start', () => {
  const pb = { playing: true, basePos: 10, baseTime: 5000, rate: 1 };
  assert.equal(expectedPosition(pb, 4000), 10);
  assert.equal(expectedPosition(pb, 7000), 12);
  assert.equal(expectedPosition({ ...pb, duration: 11 }, 7000), 11);
});

test('drift controller: ignore tiny, nudge medium, jump big', () => {
  const d = new DriftController();
  assert.equal(d.decide(10.02, 10, true).action, 'none');
  const nudge = d.decide(10.2, 10, true);
  assert.equal(nudge.action, 'rate');
  assert.ok(nudge.rate < 1, 'ahead → slow down');
  assert.ok(d.decide(9.8, 10, true).rate > 1, 'behind → speed up');
  assert.equal(d.decide(11, 10, true).action, 'seek');
  assert.equal(d.decide(10.35, 10, true, false).action, 'seek', 'seek-only players jump at 300ms');
  assert.equal(d.decide(10.2, 10, true, false).action, 'none');
});

test('percentile', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 95);
  assert.equal(percentile(v, 50), 50);
});

const catalog = require('../public/data/movies.json').movies;
const idx = Fuzzy.buildIndex(catalog);
const top = q => Fuzzy.search(idx, q)[0]?.item.title;

test('fuzzy search handles typos and partial words', () => {
  assert.equal(top('intrstellar'), 'Interstellar');
  assert.equal(top('interstelar'), 'Interstellar');
  assert.equal(top('dark knigt'), 'The Dark Knight');
  assert.equal(top('parsite'), 'Parasite');
  assert.equal(top('spirted away'), 'Spirited Away');
  assert.equal(top('budapest'), 'The Grand Budapest Hotel');
});

test('fuzzy search finds people and genres', () => {
  const nolan = Fuzzy.search(idx, 'nolan').map(r => r.item.title);
  assert.ok(nolan.includes('Inception') && nolan.includes('Oppenheimer'));
  assert.equal(top('keanu'), 'The Matrix');
  assert.ok(Fuzzy.search(idx, 'zombies').some(r => r.item.title === 'Train to Busan'));
});

test('srt → vtt', () => {
  const v = srtToVtt('1\r\n0:00:01,5 --> 00:00:02,250\r\nHello\r\n');
  assert.match(v, /^WEBVTT/);
  assert.match(v, /00:00:01\.500 --> 00:00:02\.250/);
});

test('youtube id parsing', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://evil.com/x'), null);
});
