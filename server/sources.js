// "Where can we actually watch this?" — the source finder.
//
// For a picked movie we look, in order, for:
//   1. a free film bundled in our catalog (Blender open movies etc.)
//   2. a full public-domain copy on the Internet Archive (no key needed)
//   3. the official trailer on YouTube (via TMDB)
// The client always adds "everyone uses their own file" and "companion mode"
// on top, so a paid movie like Ted 2 still has a way to be watched together.

const { titleSimilarity, srtToVtt } = require('./util');
const movies = require('./movies');

const cache = new Map(); // small LRU: Map keeps insertion order
const CACHE_MAX = 500;
// In the US a film's copyright runs 95 years, so anything from 1930 or
// earlier is public domain as of 2026. Newer films only get an Archive
// lookup when our own catalog says that particular film is public domain.
const PD_CUTOFF_YEAR = new Date().getFullYear() - 96;

// archive.org gives lengths as "5400.12" or "1:30:00"
function seconds(len) {
  if (!len) return 0;
  const s = String(len);
  if (s.includes(':')) return s.split(':').reduce((t, x) => t * 60 + (parseFloat(x) || 0), 0);
  return parseFloat(s) || 0;
}
const BAD_WORDS = /\b(trailer|dub|dubbed|doblada|doblado|español|espanol|latino|subtitulado|teaser|clip|scene|review|colorized|reaction)\b/i;

async function getJson(url, ms = 7000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'watch-party/1.0 (student project)' } });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.json();
}

async function archiveLookup(title, year, runtimeMin, note) {
  const words = title.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  if (!words) return null;
  const q = `title:(${words}) AND mediatype:movies AND collection:(feature_films OR moviesandfilms OR silent_films OR film_noir OR animationandcartoons)`;
  const url = 'https://archive.org/advancedsearch.php?' + new URLSearchParams({
    q, 'fl[]': 'identifier', rows: '15', output: 'json', 'sort[]': 'downloads desc',
  }) + '&fl[]=title&fl[]=year&fl[]=downloads&fl[]=language';
  const d = await getJson(url);
  const docs = d.response?.docs || [];
  const cands = [];
  for (const doc of docs) {
    const t = Array.isArray(doc.title) ? doc.title[0] : doc.title;
    let score = titleSimilarity(title, t);
    if (score < 0.6) continue;
    if (BAD_WORDS.test(t)) score -= 0.5;
    const y = parseInt(doc.year, 10);
    if (year && y) { if (Math.abs(y - year) > 2) continue; if (y === year) score += 0.2; }
    const lang = [].concat(doc.language || []).join(' ').toLowerCase();
    if (lang && !/en|english/.test(lang)) score -= 0.3;
    score += Math.min(0.3, Math.log10((doc.downloads || 1) + 1) / 20);
    if (score >= 0.6) cands.push({ score, id: doc.identifier, title: t, year: y });
  }
  cands.sort((a, b) => b.score - a.score);
  // feature films only: skip 3-minute clips that happen to share the title
  const minLen = runtimeMin ? Math.min(runtimeMin * 0.6, 40) * 60 : 25 * 60;
  for (const best of cands.slice(0, 4)) {
    best.note = note || `Public domain (${best.year || year}), free on the Internet Archive`;
    const r = await archiveFiles(best, minLen);
    if (r) return r;
  }
  return null;
}

async function archiveFiles(best, minLen) {
  const meta = await getJson('https://archive.org/metadata/' + encodeURIComponent(best.id));
  const files = meta.files || [];
  const mp4s = files.filter(f => /\.mp4$/i.test(f.name) && !/sample|trailer|x265|hevc|10bit/i.test(f.name)
    && (!f.length || seconds(f.length) >= minLen)); // no length listed: let the size check below decide
  if (!mp4s.length) return null;
  // prefer the browser-friendly h.264 derivative, then the smallest reasonable file
  mp4s.sort((a, b) => (/h\.264|512kb/i.test(b.format || b.name) - /h\.264|512kb/i.test(a.format || a.name)) || ((+a.size || 0) - (+b.size || 0)));
  const file = mp4s.find(f => seconds(f.length) >= minLen || (!f.length && (+f.size || 0) > 100e6));
  if (!file) return null;
  const dl = name => `https://archive.org/download/${encodeURIComponent(best.id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  const captions = files.filter(f => /\.(srt|vtt)$/i.test(f.name) && !/\.asr\./i.test(f.name)).slice(0, 4).map(f => ({
    src: '/api/captions?u=' + encodeURIComponent(dl(f.name)),
    lang: /\.(es|spa)\b/i.test(f.name) ? 'es' : 'en',
    label: f.name.replace(/^.*\//, '').replace(/\.(srt|vtt)$/i, '').slice(0, 40),
  }));
  return {
    kind: 'file', src: dl(file.name), sourceLabel: 'Internet Archive', archiveId: best.id,
    duration: seconds(file.length), captions,
    note: best.note,
    page: 'https://archive.org/details/' + best.id,
  };
}

async function findSources({ title, year, tmdbId, catalogId }) {
  const ck = [title, year, tmdbId, catalogId].join('|');
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 60 * 60_000) { cache.delete(ck); cache.set(ck, hit); return hit.data; }

  const out = { options: [], providers: null, trailer: null, region: movies.REGION };
  const bundled = movies.localMovies.find(m => (catalogId && m.id === catalogId) || (m.src && titleSimilarity(title, m.title) > 0.9));
  if (bundled && bundled.src) {
    out.options.push({ kind: 'file', src: bundled.src, sourceLabel: 'Free film', note: 'Openly licensed, streams instantly', captions: bundled.captions || [] });
  }

  const jobs = [];
  const knownPd = !!bundled?.archive;
  const oldEnough = year && year <= PD_CUTOFF_YEAR;
  if (!bundled?.src && (knownPd || oldEnough)) {
    const q = bundled?.archive?.query || title;
    const note = knownPd ? 'Public domain, free on the Internet Archive' : null;
    jobs.push(archiveLookup(q, bundled?.archive?.year || year, bundled?.runtime, note).then(a => { if (a) out.options.push(a); }).catch(e => console.warn('[archive]', e.message)));
  }
  if (tmdbId && movies.enabled()) {
    jobs.push(movies.details(tmdbId).then(d => {
      out.providers = d.providers;
      if (d.trailer) out.trailer = { kind: 'youtube', ytId: d.trailer.ytId, sourceLabel: 'YouTube', note: 'Official trailer' };
    }).catch(e => console.warn('[tmdb details]', e.message)));
  }
  await Promise.all(jobs);
  if (out.trailer) out.options.push(out.trailer);
  cache.set(ck, { at: Date.now(), data: out });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

// Subtitle proxy: fetch .srt/.vtt from the Archive, hand it back as WebVTT
// with CORS-friendly same-origin headers. Locked to archive.org on purpose.
async function captionsProxy(u) {
  const url = new URL(u);
  if (url.hostname !== 'archive.org' && !url.hostname.endsWith('.archive.org')) throw new Error('host not allowed');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!res.ok) throw new Error('captions ' + res.status);
  // read it in chunks and stop at 2 MB, rather than trusting the size header
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) { reader.cancel(); throw new Error('too big'); }
    chunks.push(value);
  }
  return srtToVtt(Buffer.concat(chunks).toString('utf8'));
}

module.exports = { findSources, archiveLookup, captionsProxy };
