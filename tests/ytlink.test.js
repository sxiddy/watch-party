// Reading the YouTube links people paste. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, looksLikeYouTube } = require('../public/js/ytlink');

test('every kind of YouTube link gives the video id', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
    '  youtube.com/watch?v=dQw4w9WgXcQ  ',
  ]) assert.equal(parse(u)?.id, 'dQw4w9WgXcQ', u);
  assert.equal(parse('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parse('interstellar'), null);
});

test('start times in links', () => {
  assert.equal(parse('https://youtu.be/dQw4w9WgXcQ?t=90').start, 90);
  assert.equal(parse('https://youtu.be/dQw4w9WgXcQ?si=x&t=1m30s').start, 90);
  assert.equal(parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1h2m3s').start, 3723);
  assert.equal(parse('https://www.youtube.com/embed/dQw4w9WgXcQ?start=45').start, 45);
  assert.equal(parse('https://youtu.be/dQw4w9WgXcQ').start, 0);
  assert.equal(parse('https://youtu.be/dQw4w9WgXcQ?t=9999999').start, 86400);
});

test('spotting a YouTube link in the movie search', () => {
  assert.ok(looksLikeYouTube('https://youtu.be/dQw4w9WgXcQ'));
  assert.ok(!looksLikeYouTube('youtube rewind'));
});
