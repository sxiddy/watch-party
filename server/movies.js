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

// ---------- Wikipedia: every film, no key ----------
// Without a TMDB key the bundled catalog only has ~60 films, so a search for
// "conjuring" found nothing. Wikipedia has a page (and usually the poster) for
// practically every released film and its API needs no key. Its search also
// suggests spellings, which keeps the typo tolerance.

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKI_GENRES = [
  [/horror/i, 'Horror'], [/comed/i, 'Comedy'], [/thriller/i, 'Thriller'], [/science fiction|sci-fi/i, 'Sci-Fi'],
  [/animat/i, 'Animation'], [/action/i, 'Action'], [/romant/i, 'Romance'], [/fantasy/i, 'Fantasy'],
  [/crime|gangster|heist/i, 'Crime'], [/mystery/i, 'Mystery'], [/adventure/i, 'Adventure'], [/musical/i, 'Musical'],
  [/biograph/i, 'Biography'], [/sports?\b/i, 'Sport'], [/historical|war film|period/i, 'History'], [/drama/i, 'Drama'],
];

async function wikiGet(params) {
  const url = WIKI + '?' + new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.data;
  // Wikimedia asks API clients to say who they are and how to reach them
  const res = await fetch(url, { headers: { 'user-agent': 'BackRow/1.0 (https://github.com/sxiddy/watch-party; student project)' }, signal: AbortSignal.timeout(6000) });
  if (res.status === 429) throw new Error('Wikipedia is rate limiting us, using the bundled catalog');
  if (!res.ok) throw new Error('Wikipedia ' + res.status);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return data;
}

function fromWiki(p) {
  const about = (p.description || '') + ' ' + (p.extract || '');
  const year = +((p.description || '').match(/\b(18[89]\d|19\d\d|20\d\d)\b/) || about.match(/\b(18[89]\d|19\d\d|20\d\d)\b/) || [])[1] || null;
  const head = (p.description || '') + ' ' + (p.extract || '').split('.')[0];
  const genres = WIKI_GENRES.filter(([re]) => re.test(head)).map(([, g]) => g).slice(0, 3);
  return {
    id: 'wiki:' + p.pageid,
    title: p.title.replace(/\s*\((?:\d{4} )?(?:[A-Za-z]+ )?film\)$/, ''),
    year, genres, rating: null, votes: 0,
    poster: p.thumbnail ? p.thumbnail.source.split('?')[0] : null,
    description: (p.extract || '').slice(0, 400),
    source: 'wiki',
  };
}

async function wikiSearch(q) {
  const run = async term => {
    const d = await wikiGet({
      generator: 'search', gsrsearch: term + ' film', gsrlimit: '15',
      prop: 'pageimages|description|extracts', piprop: 'thumbnail', pithumbsize: '342', pilicense: 'any',
      exintro: '1', explaintext: '1', exsentences: '2', exlimit: '15',
    });
    return (d.query?.pages || []).sort((a, b) => a.index - b.index)
      // only pages about one film: not franchises, soundtracks, books or people
      .filter(p => /\bfilm\b/i.test(p.description || '') && !/franchise|series|soundtrack|novel|character|actor|actress|director|list of/i.test(p.description || ''));
  };
  let pages = await run(q);
  if (!pages.length) {
    const s = await wikiGet({ list: 'search', srsearch: q + ' film', srinfo: 'suggestion', srlimit: '1' });
    const better = s.query?.searchinfo?.suggestion;
    if (better) pages = await run(better.replace(/\s*film$/i, ''));
  }
  // a real film has a year; "Open-source film" and other topic pages don't
  return pages.map(fromWiki).filter(m => m.year);
}

async function search(q) {
  q = String(q || '').slice(0, 80);
  if (!q.trim()) return [];
  const localHits = Fuzzy.search(Fuzzy.buildIndex(localMovies), q, { limit: 12 }).map(h => h.item);
  if (!enabled()) {
    let wiki = [];
    try { wiki = await wikiSearch(q); } catch (e) { console.warn('[wiki]', e.message); }
    // Strong matches from our own catalog go first (they may stream free and
    // have more detail). Then Wikipedia in its own order, which is good at
    // "what people usually mean", then our weak matches ("ted 2" is not
    // Paddington 2, but it's not wrong to show it at the bottom).
    const scored = Fuzzy.search(Fuzzy.buildIndex(localMovies), q, { limit: 12 });
    // our catalog has no posters for studio films; borrow Wikipedia's for the same film
    const wikiPoster = new Map(wiki.filter(w => w.poster).map(w => [Fuzzy.normalize(w.title) + w.year, w.poster]));
    const withPoster = m => (m.poster ? m : { ...m, poster: wikiPoster.get(Fuzzy.normalize(m.title) + m.year) || null });
    const strong = scored.filter(h => h.score >= 0.65).map(h => withPoster(h.item));
    const weak = scored.filter(h => h.score < 0.65).map(h => h.item);
    const seen = new Set();
    return [...strong, ...wiki, ...weak].filter(m => {
      const k = (m.title + m.year).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 30);
  }

  let results = [];
  const [titles, byPerson] = await Promise.all([
    tmdb('/search/movie', { query: q, include_adult: false }).catch(() => null),
    personFilms(q),
  ]);
  if (titles) results = titles.results.map(fromTmdb);
  const goodTitle = q => results.some(m => Fuzzy.search(Fuzzy.buildIndex([m]), q, { threshold: 0.7 }).length);

  // TMDB search isn't typo tolerant ("intrstellar" finds nothing), so when
  // nothing it found really matches we ask our own fuzzy index what they
  // probably meant. Not when the query was a person's name.
  if (!byPerson.length && !goodTitle(q)) {
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
  // Match quality plus a small popularity bonus, so "conjuring" puts The
  // Conjuring (2013, 11k votes) above an 1896 short whose title is exactly
  // "Conjuring", while "ted 2" still puts Ted 2 above the more popular Ted.
  // Anything that doesn't match the query at all (a bad typo guess) is dropped.
  const ranked = Fuzzy.search(Fuzzy.buildIndex(merged), q, { threshold: 0.2 });
  const score = new Map(ranked.map(h => [h.item, h.score + Math.log10((h.item.votes || 0) + 1) * 0.12]));
  const titled = merged.filter(m => score.has(m)).sort((a, b) => score.get(b) - score.get(a));
  // "nolan", "tom hanks": their films first, then titles that mention them.
  // A film called exactly what they typed still wins ("ted" is Ted, not Ted Danson).
  const exact = titled.filter(m => Fuzzy.normalize(m.title) === Fuzzy.normalize(q));
  const out = [...exact, ...byPerson.filter(m => !exact.some(x => x.tmdbId === m.tmdbId))];
  for (const m of titled) if (!out.some(x => x.tmdbId === m.tmdbId)) out.push(m);
  return out.slice(0, 30);
}

// If the query is clearly a director or actor, their best-known films.
async function personFilms(q) {
  try {
    const d = await tmdb('/search/person', { query: q, include_adult: false });
    const p = (d.results || []).find(x => ['Directing', 'Acting', 'Writing'].includes(x.known_for_department) && (x.popularity || 0) >= 2);
    if (!p) return [];
    // the name has to really be what they typed: "nolan" → Christopher Nolan, "inception" → nobody
    const hit = Fuzzy.search(Fuzzy.buildIndex([{ title: p.name }]), q, { threshold: 0.75 });
    if (!hit.length) return [];
    const role = p.known_for_department === 'Acting' ? 'with_cast' : 'with_crew';
    const f = await tmdb('/discover/movie', { [role]: p.id, sort_by: 'vote_count.desc', include_adult: false });
    return (f.results || []).slice(0, 12).map(r => ({ ...fromTmdb(r), why: p.name }));
  } catch (e) { return []; }
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
    region: REGION,
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

module.exports = { REGION, enabled, home, search, discover, details, recommendations, warmUp, localMovies, GENRE_IDS };
