// Movie discovery: rows, search, filters, the movie sheet and the source picker.
(function () {
  const { $, h, toast, posterEl, openDialog, fmt } = window.UI;

  let ctx = null;          // set by room.js: { canControl, play(media), queue(media), tasteVote, startLocal, taste() }
  let home = null;
  let tmdbOn = false;
  let lastQuery = '';
  const detailsCache = new Map();

  const api = (url) => fetch(apiUrl(url)).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

  const isFree = m => !!(m.src || m.archive);
  const metaLine = m => [m.year, m.runtime ? `${Math.floor(m.runtime / 60) ? Math.floor(m.runtime / 60) + 'h ' : ''}${m.runtime % 60}m` : null, m.rating ? '★ ' + m.rating : null].filter(Boolean).join(' · ');

  function card(m, reason) {
    const el = h('button.card', { type: 'button', title: m.title, onclick: () => openMovie(m) },
      posterEl(m),
      isFree(m) ? h('span.badge', m.src ? 'free' : 'public domain') : null,
      h('span.card-title', m.title),
      h('span.card-meta', reason || metaLine(m)));
    return el;
  }

  function row(label, items, opts = {}) {
    if (!items.length) return null;
    return h('section.row' + (opts.cls ? '.' + opts.cls : ''),
      h('h3.row-title', label, opts.note ? h('span.row-note', opts.note) : null),
      h('div.row-scroll', items.map(x => (x.movie ? card(x.movie, x.reason) : card(x)))));
  }

  // ---------- rows ----------

  async function loadHome() {
    try {
      home = await api('/api/movies/home');
      tmdbOn = home.tmdb;
      $('#f-lang').hidden = !tmdbOn;
    } catch (e) {
      home = { rows: [] };
    }
    fillFilters();
    render();
  }

  function fillFilters() {
    const genres = new Set();
    (home.rows || []).forEach(r => r.items.forEach(m => (m.genres || []).forEach(g => genres.add(g))));
    ['Action', 'Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Romance', 'Thriller', 'Animation', 'Mystery', 'Family', 'Fantasy', 'Crime', 'Adventure', 'Documentary', 'Music'].forEach(g => genres.add(g));
    const sel = $('#f-genre');
    if (sel.options.length > 1) return;
    [...genres].sort().forEach(g => sel.append(h('option', { value: g }, g)));
    const dec = $('#f-decade');
    for (let d = 2020; d >= 1920; d -= 10) dec.append(h('option', { value: d }, d + 's'));
  }

  function filtersActive() {
    return ['#f-genre', '#f-decade', '#f-runtime', '#f-rating', '#f-lang'].some(s => $(s).value) || $('#f-free').checked;
  }

  async function render() {
    const out = $('#disc-results');
    const q = $('#search').value.trim();
    // a YouTube link pasted into the movie search goes to the YouTube box
    if (window.YtLink.looksLikeYouTube(q)) {
      $('#search').value = '';
      showYouTube(q);
      return render();
    }
    $('#f-clear').hidden = !filtersActive();
    if (q) return renderSearch(q);
    if (filtersActive()) return renderFiltered();
    out.replaceChildren(
      recsRow() || h('span'),
      ...(home?.rows || []).map(r => row(r.label, r.items)).filter(Boolean),
    );
  }

  async function renderSearch(q) {
    lastQuery = q;
    const out = $('#disc-results');
    out.replaceChildren(h('p.loading', 'Looking…'));
    let res;
    try { res = (await api('/api/movies/search?q=' + encodeURIComponent(q))).results; } catch (e) { res = []; }
    if (q !== lastQuery) return; // a newer search is on its way
    if (!res.length) {
      out.replaceChildren(h('p.empty', `Nothing for “${q}”. Try fewer words, or paste a link instead.`));
      return;
    }
    out.replaceChildren(h('div.grid', res.map(m => card(m))));
  }

  async function renderFiltered() {
    const out = $('#disc-results');
    const p = new URLSearchParams();
    if ($('#f-genre').value) p.set('genre', $('#f-genre').value);
    if ($('#f-decade').value) p.set('decade', $('#f-decade').value);
    if ($('#f-runtime').value) p.set('maxRuntime', $('#f-runtime').value);
    if ($('#f-rating').value) p.set('minRating', $('#f-rating').value);
    if ($('#f-lang').value) p.set('lang', $('#f-lang').value);
    if ($('#f-free').checked) p.set('free', '1');
    out.replaceChildren(h('p.loading', 'Filtering…'));
    let res = [];
    try { res = (await api('/api/movies/discover?' + p)).results; } catch (e) { /* show empty */ }
    out.replaceChildren(res.length ? h('div.grid', res.map(m => card(m))) : h('p.empty', 'Nothing matches all of that. Loosen a filter or two.'));
  }

  // ---------- group taste ("picked for this room") ----------

  let recsCache = { key: '', items: [] };

  function recsRow() {
    if (!ctx) return null;
    const taste = ctx.taste().filter(t => t.likeIds.length);
    if (!taste.length || !recsCache.items.length) return null;
    return row('Picked for this room', recsCache.items, { cls: 'recs', note: 'based on what you’ve all liked and queued' });
  }

  async function refreshRecs() {
    if (!ctx) return;
    const taste = ctx.taste();
    const liked = taste.filter(t => t.likeIds.length).sort((a, b) => b.likeIds.length - a.likeIds.length);
    const key = liked.map(t => t.key + t.likeIds.length).join('|');
    if (key === recsCache.key) return;
    recsCache.key = key;
    const seen = new Set(taste.map(t => (t.item.title || '').toLowerCase()));
    const disliked = new Set(taste.filter(t => t.dislikeIds.length > t.likeIds.length).map(t => (t.item.title || '').toLowerCase()));
    const score = new Map();
    const add = (m, pts, because) => {
      const k = m.title.toLowerCase();
      if (seen.has(k) || disliked.has(k)) return;
      const cur = score.get(k) || { movie: m, pts: 0, because: new Set() };
      cur.pts += pts; because && cur.because.add(because);
      score.set(k, cur);
    };

    // 1) TMDB "people who liked X also liked" for the room's top picks
    const top = liked.filter(t => t.item.tmdbId).slice(0, 3);
    if (tmdbOn && top.length) {
      const lists = await Promise.all(top.map(t => api(`/api/movies/${t.item.tmdbId}/recommendations`).then(r => ({ t, r: r.results })).catch(() => null)));
      lists.filter(Boolean).forEach(({ t, r }) => r.forEach((m, i) => add(m, (t.likeIds.length + 1) * (1 - i / 25), t.item.title)));
    }
    // 2) genre overlap against everything we know about, weighted by votes
    const weights = {};
    liked.forEach(t => (t.item.genres || []).forEach(g => { weights[g] = (weights[g] || 0) + t.likeIds.length; }));
    const pool = (home?.rows || []).flatMap(r => r.items);
    const topGenre = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
    pool.forEach(m => {
      const pts = (m.genres || []).reduce((s, g) => s + (weights[g] || 0), 0);
      if (pts) add(m, pts * 0.35 + (m.rating || 6) / 20, topGenre && (m.genres || []).includes(topGenre[0]) ? topGenre[0].toLowerCase() + ' fans' : null);
    });

    recsCache.items = [...score.values()].sort((a, b) => b.pts - a.pts).slice(0, 14).map(x => {
      const b = [...x.because];
      return { movie: x.movie, reason: b.length ? (b[0].endsWith('fans') ? 'for the ' + b[0] : 'because you liked ' + b[0]) : metaLine(x.movie) };
    });
    if (!$('#search').value.trim() && !filtersActive()) render();
  }

  // ---------- the movie sheet ----------

  // Paid films: point people at the legal places to watch, so companion mode
  // ("everyone presses play on their own Netflix") has somewhere to send them.
  // Works without a TMDB key too, via a JustWatch search for the title.
  let region = 'IN';
  function whereToWatch(movie, prov) {
    const r = (prov && prov.region) || region;
    let place = r;
    try { place = new Intl.DisplayNames(['en'], { type: 'region' }).of(r); } catch (e) { /* keep the code */ }
    const search = `https://www.justwatch.com/${r.toLowerCase()}/search?q=${encodeURIComponent(movie.title)}`;
    const logos = list => list.slice(0, 6).map(p => h('img', { src: p.logo, alt: p.name, title: p.name }));
    const has = prov && (prov.stream.length || prov.rent.length || prov.buy.length);
    return h('div.providers',
      has && prov.stream.length ? [h('span.k', `Streaming in ${place} on`), logos(prov.stream)] : null,
      has && !prov.stream.length && prov.rent.length ? [h('span.k', `Rent it in ${place} on`), logos(prov.rent)] : null,
      has && !prov.stream.length && !prov.rent.length ? [h('span.k', 'Buy it on'), logos(prov.buy)] : null,
      h('a.link-btn', { href: has && prov.link ? prov.link : search, target: '_blank', rel: 'noopener' },
        has ? 'All the ways to watch it legally ↗' : `Where to watch it legally in ${place} ↗`),
      h('span.fine.tmdb-credit', has ? 'via JustWatch / TMDB' : 'opens JustWatch'));
  }

  async function openMovie(m) {
    const body = $('#movie-body');
    const dlg = openDialog('#dlg-movie');
    dlg.scrollTop = 0;
    let movie = { ...m };
    body.replaceChildren(sheet(movie, null));
    if (movie.tmdbId && tmdbOn) {
      try {
        const d = detailsCache.get(movie.tmdbId) || await api('/api/movies/' + movie.tmdbId);
        detailsCache.set(movie.tmdbId, d);
        movie = { ...movie, ...d };
        body.replaceChildren(sheet(movie, null));
      } catch (e) { /* the basics are already showing */ }
    }
    const p = new URLSearchParams({ title: movie.title });
    if (movie.year) p.set('year', movie.year);
    if (movie.tmdbId) p.set('tmdbId', movie.tmdbId);
    if (movie.source === 'local') p.set('catalogId', movie.id);
    let sources = { options: [] };
    try { sources = await api('/api/sources?' + p); } catch (e) { /* only the always-on options */ }
    if (dlg.open) body.replaceChildren(sheet(movie, sources));
  }

  function mediaFrom(movie, opt) {
    return {
      kind: opt.kind, src: opt.src, hd: opt.hd, ytId: opt.ytId,
      title: opt.note === 'Official trailer' ? movie.title + ' (trailer)' : movie.title,
      year: movie.year, poster: movie.poster, tmdbId: movie.tmdbId || null,
      catalogId: movie.source === 'local' ? movie.id : null, genres: movie.genres || [],
      duration: opt.duration || (opt.kind === 'companion' && movie.runtime ? movie.runtime * 60 : 0),
      captions: opt.captions || [], sourceLabel: opt.sourceLabel,
    };
  }

  function sheet(movie, sources) {
    const canCtl = ctx && ctx.canControl();
    const opts = [];
    const actions = (media) => h('div.src-actions',
      canCtl ? h('button.btn.btn-small', { onclick: () => { ctx.play(media); $('#dlg-movie').close(); } }, 'Show it now') : null,
      h('button.btn.btn-small.btn-ghost', { onclick: () => { ctx.queue(media); toast('Added to the queue'); } }, 'Add to queue'));

    if (!sources) {
      opts.push(h('li.src.loading', 'Checking where we can watch this…'));
    } else {
      for (const o of sources.options) {
        const media = mediaFrom(movie, o);
        opts.push(h('li.src',
          h('div.src-text', h('b', o.sourceLabel === 'YouTube' ? 'Trailer on YouTube' : o.sourceLabel === 'Free film' ? 'Stream it here, free' : 'Full movie, free (Internet Archive)'),
            h('span', o.note + (o.duration ? ` · ${fmt(o.duration)}` : '') + (o.captions && o.captions.length ? ' · has subtitles' : ''))),
          actions(media)));
      }
      if (!sources.options.some(o => o.kind === 'file')) {
        opts.push(h('li.src.src-none', h('div.src-text', h('b', 'No free copy we can stream'), h('span', 'That’s normal for newer movies. Use one of the options below.'))));
      }
      opts.push(h('li.src',
        h('div.src-text', h('b', 'Everyone uses their own file'), h('span', 'Each person picks their copy from their own device. Fully synced, nothing is uploaded.')),
        h('div.src-actions', canCtl ? h('button.btn.btn-small.btn-ghost', { onclick: () => { $('#dlg-movie').close(); ctx.startLocal(movie); } }, 'Pick my file') : h('span.fine', 'host starts this'))));
      const comp = mediaFrom(movie, { kind: 'companion', sourceLabel: 'Companion' });
      opts.push(h('li.src',
        h('div.src-text', h('b', 'We’ll each play it on our own app'), h('span', 'Netflix, Prime, a TV… Back Row runs the shared clock, the 3-2-1, chat and reactions.')),
        actions(comp)));
    }

    const free = sources && sources.options.some(o => o.kind === 'file');
    if (sources && sources.region) region = sources.region;
    const provLine = free ? null : whereToWatch(movie, movie.providers);

    const vote = like => h('button.btn.btn-small.btn-ghost', {
      onclick: (e) => { ctx && ctx.tasteVote(movie, like); e.target.textContent = like ? 'Noted 👍' : 'Noted'; },
    }, like ? 'We’d watch this' : 'Not for us');

    return h('div.sheet',
      movie.backdrop ? h('div.sheet-back', { style: { backgroundImage: `url("${movie.backdrop}")` } }) : null,
      h('div.sheet-main',
        posterEl(movie, 'poster sheet-poster'),
        h('div.sheet-info',
          h('h2', movie.title, movie.year ? h('span.year', ' (' + movie.year + ')') : null),
          h('p.meta', [metaLine({ ...movie, year: null }), (movie.genres || []).join(', ')].filter(Boolean).join(' · ')),
          movie.director ? h('p.credit', 'Directed by ' + movie.director) : null,
          movie.cast && movie.cast.length ? h('p.credit', movie.cast.slice(0, 4).join(', ')) : null,
          movie.description ? h('p.desc', movie.description) : null,
          provLine,
          ctx ? h('div.taste-btns', vote(true), vote(false)) : null)),
      ctx ? h('div.sources', h('h3', 'How do we watch it?'), h('ul.src-list', opts)) : null,
      tmdbOn && movie.source === 'tmdb' ? h('p.fine.tmdb-credit', 'Movie data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.') : null);
  }

  // ---------- YouTube: paste a link, everyone watches it together ----------

  let ytKey = null; // the video (and start time) being previewed right now

  function clearYouTube() {
    ytKey = null;
    $('#yt-url').value = '';
    $('#yt-error').textContent = '';
    $('#yt-preview').hidden = true;
  }

  function showYouTube(text) {
    $('#yt-url').value = text;
    $('#yt-url').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    previewYouTube(text);
  }

  async function previewYouTube(text) {
    const box = $('#yt-preview'), err = $('#yt-error');
    const link = window.YtLink.parse(text);
    err.textContent = '';
    if (!link) {
      ytKey = null;
      box.hidden = true;
      if (text.trim().length > 8) err.textContent = 'That doesn’t look like a YouTube link.';
      return;
    }
    const key = link.id + '@' + link.start;
    if (key === ytKey) return;
    ytKey = key;
    box.hidden = false;
    box.replaceChildren(h('p.loading', 'Looking it up…'));
    let info;
    try { info = await api('/api/youtube/' + link.id); }
    catch (e) { info = { ok: true, title: 'YouTube video', channel: '', thumb: 'https://i.ytimg.com/vi/' + link.id + '/hqdefault.jpg' }; } // lookup failed, it may still play
    if (ytKey !== key) return; // they pasted something else meanwhile
    if (!info.ok) {
      box.hidden = true;
      err.textContent = info.error === 'no-embed'
        ? 'Whoever uploaded this doesn’t let it play on other sites, so it can’t be watched here. Try another upload.'
        : 'Couldn’t find that video. It may be private or deleted.';
      return;
    }
    const media = { kind: 'youtube', ytId: link.id, title: info.title, poster: info.thumb, sourceLabel: info.channel ? 'YouTube · ' + info.channel : 'YouTube', startAt: link.start };
    const ctl = ctx.canControl();
    box.replaceChildren(
      h('img.yt-thumb', { src: info.thumb, alt: '' }),
      h('div.yt-info',
        h('b', info.title),
        h('span', [info.channel, link.start ? 'starts at ' + fmt(link.start) : null].filter(Boolean).join(' · ')),
        h('div.yt-btns',
          ctl ? h('button.btn.btn-small', { type: 'button', onclick: () => { ctx.play(media); clearYouTube(); } }, 'Watch it now') : null,
          h('button.btn.btn-small' + (ctl ? '.btn-ghost' : ''), { type: 'button', onclick: () => { ctx.queue(media); clearYouTube(); toast(ctl ? 'Added to the queue' : 'Suggested. It’s in the queue for the host to play'); } },
            ctl ? 'Add to queue' : 'Suggest it'),
          h('button.link-btn', { type: 'button', onclick: clearYouTube }, 'cancel'))));
  }

  // ---------- wiring ----------

  function init(roomCtx) {
    ctx = roomCtx;
    let t;
    $('#search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 220); });
    let yt;
    $('#yt-url').addEventListener('input', e => { clearTimeout(yt); yt = setTimeout(() => previewYouTube(e.target.value), 250); });
    $('#yt-form').addEventListener('submit', e => { e.preventDefault(); clearTimeout(yt); previewYouTube($('#yt-url').value); });
    ['#f-genre', '#f-decade', '#f-runtime', '#f-rating', '#f-lang', '#f-free'].forEach(s => $(s).addEventListener('change', render));
    $('#f-clear').addEventListener('click', () => {
      ['#f-genre', '#f-decade', '#f-runtime', '#f-rating', '#f-lang'].forEach(s => { $(s).value = ''; });
      $('#f-free').checked = false;
      render();
    });
    loadHome();
  }

  async function landingStrip(el) {
    try {
      const d = await api('/api/movies/home');
      const free = (d.rows.find(r => r.id === 'free') || { items: [] }).items.filter(m => m.runtime >= 5 || m.archive).slice(0, 10);
      el.replaceChildren(...free.map(m => h('div.strip-item', posterEl(m), h('span', m.title))));
    } catch (e) { el.remove(); }
  }

  window.Discover = { init, render, refreshRecs, openMovie, landingStrip, mediaFrom, whereToWatch, showYouTube };
})();
