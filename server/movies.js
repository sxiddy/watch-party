// Movie discovery. Uses TMDB when a key is configured, and falls back to the
// bundled catalog (public/data/movies.json) when it isn't, so the app always works.

const path = require('path');
const fs = require('fs');
const Fuzzy = require('../public/js/fuzzy');

const IMG = 'https://image.tmdb.org/t/p/';
const REGION = process.env.TMDB_REGION || 'IN';

const local = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/movies.json'), 'utf8'));
const localMovies = local.movies.map(m => ({ ...m, source: 'local' }));

const cache = new Map();
const pool = new Map();      // every movie we've seen, for typo correction
let poolIndex = null;
let genreNames = {};

function key() { return process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || ''; }
const enabled = () => !!key();

async function tmdb(p, params = {}) {
  const k = key();
  const url = new URL('https://api.themoviedb.org/3' + p);
  for (const [a, b] of Object.entries(params)) if (b !== undefined && b !== null && b !== '') url.searchParams.set(a, b);
  const headers = { accept: 'application/json' };
  if (k.startsWith('eyJ')) headers.authorization = 'Bearer ' + k; else url.searchParams.set('api_key', k);
  const ck = url.toString();
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.data;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error('TMDB ' + res.status);
  const data = await res.json();
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return data;
}

function fromTmdb(r) {
  const m = {
    id: 'tmdb:' + r.id,
    tmdbId: r.id,
    title: r.title || r.name,
    year: r.release_date ? +r.release_date.slice(0, 4) : null,
    genres: (r.genre_ids || (r.genres || []).map(g => g.id)).map(id => genreNames[id]).filter(Boolean),
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count || 0,
    poster: r.poster_path ? IMG + 'w342' + r.poster_path : null,
    backdrop: r.backdrop_path ? IMG + 'w780' + r.backdrop_path : null,
    description: r.overview || '',
    lang: r.original_language,
    runtime: r.runtime || null,
    source: 'tmdb',
  };
  if (m.title && !pool.has(m.id)) { pool.set(m.id, m); poolIndex = null; }
  return m;
}

async function loadGenres() {
  if (!enabled()) return;
  try {
    const g = await tmdb('/genre/movie/list', { language: 'en' });
    genreNames = Object.fromEntries(g.genres.map(x => [x.id, x.name === 'Science Fiction' ? 'Sci-Fi' : x.name]));
  } catch (e) {
    console.warn('[tmdb] genre list failed:', e.message);
  }
}

const GENRE_IDS = { Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18, Family: 10751, Fantasy: 14, History: 36, Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749, 'Sci-Fi': 878, Thriller: 53, War: 10752 };

// ---------- local catalog helpers ----------

function localFilter(list, f = {}) {
  return list.filter(m => {
    if (f.genre && !m.genres.includes(f.genre)) return false;
    if (f.decade && !(m.year >= +f.decade && m.year < +f.decade + 10)) return false;
    if (f.minRating && !((m.rating || 0) >= +f.minRating)) return false;
    if (f.maxRuntime && !((m.runtime || 999) <= +f.maxRuntime)) return false;
    if (f.free && !(m.src || m.archive)) return false;
    return true;
  });
}

function localRows() {
  return local.categories.map(c => {
    const r = c.rule;
    const items = localMovies.filter(m =>
      (r.playable ? !!(m.src || m.archive) : true) &&
      (r.tag ? (m.tags || []).includes(r.tag) : true) &&
      (r.genre ? m.genres.includes(r.genre) : true) &&
      (r.maxRuntime ? (m.runtime || 999) <= r.maxRuntime : true));
    return { id: c.id, label: c.label, items };
  }).filter(r => r.items.length);
}

// ---------- public API ----------

async function home() {
  const free = { id: 'free', label: 'Free to watch right now', items: localMovies.filter(m => m.src || m.archive) };
  if (!enabled()) return { tmdb: false, rows: [free, ...localRows().filter(r => r.id !== 'free')] };
  const defs = [
    ['trending', 'Everyone’s watching this week', '/trending/movie/week', {}],
    ['crowd', 'Good with a big group', '/discover/movie', { with_genres: '35|12', 'vote_count.gte': 2000, sort_by: 'popularity.desc' }],
    ['india', 'Big on Indian screens', '/discover/movie', { with_original_language: 'hi|ta|te|ml', 'vote_count.gte': 150, sort_by: 'popularity.desc' }],
    ['scary', 'Lights off, volume up', '/discover/movie', { with_genres: GENRE_IDS.Horror, 'vote_count.gte': 800, sort_by: 'popularity.desc' }],
    ['mind', 'Argue about it after', '/discover/movie', { with_genres: `${GENRE_IDS['Sci-Fi']},${GENRE_IDS.Mystery}`, 'vote_average.gte': 7, 'vote_count.gte': 1500 }],
    ['animated', 'Animated, not just for kids', '/discover/movie', { with_genres: GENRE_IDS.Animation, 'vote_average.gte': 7.3, 'vote_count.gte': 1000 }],
    ['classics', 'All-time greats', '/movie/top_rated', {}],
  ];
  const rows = await Promise.all(defs.map(async ([id, label, p, params]) => {
    try {
      const d = await tmdb(p, { region: REGION, ...params });
      return { id, label, items: d.results.filter(r => r.poster_path).slice(0, 18).map(fromTmdb) };
    } catch (e) { return null; }
  }));
  return { tmdb: true, rows: [free, ...rows.filter(r => r && r.items.length)] };
}

function poolSearch(q, limit = 20) {
  if (!poolIndex) poolIndex = Fuzzy.buildIndex([...pool.values(), ...localMovies]);
  return Fuzzy.search(poolIndex, q, { limit });
}

async function search(q) {
  q = String(q || '').slice(0, 80);
  if (!q.trim()) return [];
  const localHits = Fuzzy.search(Fuzzy.buildIndex(localMovies), q, { limit: 12 }).map(h => h.item);
  if (!enabled()) return localHits;

  let results = [];
  try {
    const d = await tmdb('/search/movie', { query: q, include_adult: false });
    results = d.results.map(fromTmdb);
  } catch (e) { /* fall through to fuzzy */ }

  // TMDB search isn't typo tolerant ("intrstellar" finds nothing), so when it
  // comes back thin we ask our own fuzzy index what they probably meant.
  if (results.length < 3) {
    const guess = poolSearch(q, 3).map(h => h.item.title);
    for (const t of guess) {
      try {
        const d = await tmdb('/search/movie', { query: t, include_adult: false });
        results.push(...d.results.slice(0, 5).map(fromTmdb));
      } catch (e) { /* ignore */ }
    }
  }
  // merge, then rank everything with the fuzzy scorer so the order makes sense
  const seen = new Set();
  const merged = [...localHits.filter(m => m.src || m.archive), ...results].filter(m => {
    const k = (m.title + m.year).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const ranked = Fuzzy.search(Fuzzy.buildIndex(merged), q, { threshold: 0.2 });
  const order = new Map(ranked.map((h, i) => [h.item, i]));
  merged.sort((a, b) => (order.has(a) ? order.get(a) : 999) - (order.has(b) ? order.get(b) : 999) || (b.votes || 0) - (a.votes || 0));
  return merged.slice(0, 30);
}

async function discover(f = {}) {
  if (!enabled()) return localFilter(localMovies, f).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  if (f.free) return localFilter(localMovies, f);
  const params = { sort_by: f.sort || 'popularity.desc', 'vote_count.gte': 100, include_adult: false, region: REGION };
  if (f.genre && GENRE_IDS[f.genre]) params.with_genres = GENRE_IDS[f.genre];
  if (f.decade) { params['primary_release_date.gte'] = `${f.decade}-01-01`; params['primary_release_date.lte'] = `${+f.decade + 9}-12-31`; }
  if (f.minRating) params['vote_average.gte'] = f.minRating;
  if (f.maxRuntime) params['with_runtime.lte'] = f.maxRuntime;
  if (f.lang) params.with_original_language = f.lang;
  const pages = await Promise.all([1, 2].map(page => tmdb('/discover/movie', { ...params, page }).catch(() => ({ results: [] }))));
  return pages.flatMap(p => p.results).map(fromTmdb);
}

async function details(tmdbId) {
  const d = await tmdb('/movie/' + tmdbId, { append_to_response: 'videos,watch/providers,recommendations,credits' });
  const m = fromTmdb(d);
  m.genres = (d.genres || []).map(g => (g.name === 'Science Fiction' ? 'Sci-Fi' : g.name));
  m.runtime = d.runtime;
  m.cast = (d.credits?.cast || []).slice(0, 5).map(c => c.name);
  m.director = (d.credits?.crew || []).find(c => c.job === 'Director')?.name || null;
  const vids = (d.videos?.results || []).filter(v => v.site === 'YouTube');
  const trailer = vids.find(v => v.type === 'Trailer' && v.official) || vids.find(v => v.type === 'Trailer') || vids[0];
  m.trailer = trailer ? { ytId: trailer.key, name: trailer.name } : null;
  const prov = d['watch/providers']?.results?.[REGION];
  m.providers = prov ? {
    link: prov.link,
    stream: (prov.flatrate || []).map(p => ({ name: p.provider_name, logo: IMG + 'w92' + p.logo_path })),
    rent: (prov.rent || []).map(p => ({ name: p.provider_name, logo: IMG + 'w92' + p.logo_path })),
    buy: (prov.buy || []).map(p => ({ name: p.provider_name, logo: IMG + 'w92' + p.logo_path })),
  } : null;
  m.recommendations = (d.recommendations?.results || []).slice(0, 12).map(fromTmdb);
  return m;
}

async function recommendations(tmdbId) {
  const d = await tmdb(`/movie/${tmdbId}/recommendations`);
  return d.results.slice(0, 20).map(fromTmdb);
}

async function warmUp() {
  if (!enabled()) { console.log('[movies] no TMDB key, using the bundled catalog'); return; }
  await loadGenres();
  // fill the typo-correction pool with a few hundred well-known titles
  const jobs = [];
  for (let page = 1; page <= 5; page++) {
    jobs.push(tmdb('/movie/popular', { page }), tmdb('/movie/top_rated', { page }));
  }
  const res = await Promise.allSettled(jobs);
  res.forEach(r => r.status === 'fulfilled' && r.value.results.forEach(fromTmdb));
  console.log(`[movies] TMDB on, ${pool.size} titles warmed for fuzzy search`);
}

module.exports = { enabled, home, search, discover, details, recommendations, warmUp, localMovies, GENRE_IDS };
