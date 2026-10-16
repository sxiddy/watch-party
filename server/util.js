// Small helpers shared by the server modules.
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function roomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

const shortId = () => crypto.randomBytes(6).toString('base64url');

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // drop control chars, collapse whitespace runs
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s{3,}/g, '  ').trim().slice(0, max);
}

function num(v, min, max, fallback = null) {
  if (v == null || v === '') return fallback; // Number(null) is 0, which isn't a value
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function youtubeId(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(url) ? url : null);
}

// SubRip → WebVTT. Good enough for the subtitle files people actually have.
function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{1,2}):(\d\d):(\d\d)[,.](\d{1,3})/g, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
    .trim();
  return body.startsWith('WEBVTT') ? body : 'WEBVTT\n\n' + body;
}

// rough title similarity in [0,1] — word overlap, used to rank Archive hits
function titleSimilarity(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && w !== 'the' && w !== 'a');
  const A = norm(a), B = new Set(norm(b));
  if (!A.length || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.length, B.size);
}

module.exports = { roomCode, shortId, cleanText, num, isHttpUrl, youtubeId, srtToVtt, titleSimilarity };
