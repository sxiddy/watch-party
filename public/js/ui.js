// Little DOM helpers used everywhere.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // h('div.card', { onclick }, 'text', child) — tiny element builder, text is always escaped
  function h(tag, attrs, ...kids) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function toast(text, kind = '') {
    const t = h('div.toast' + (kind ? '.' + kind : ''), text);
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), 3600);
    setTimeout(() => t.remove(), 4200);
  }

  // A poster for movies we don't have artwork for: plain type on a flat
  // colour, like a cheap printed one-sheet. Colour comes from the title.
  const POSTER_COLORS = [['#d9472b', '#f1e9db'], ['#1f3a5f', '#f2b33d'], ['#2e5e4e', '#f1e9db'], ['#f2b33d', '#1b1817'], ['#6b2d5c', '#f1e9db'], ['#e8dcc5', '#a3301c'], ['#24211f', '#f2b33d'], ['#3f6c8c', '#f1e9db']];
  function hash(s) { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x); }
  function fakePoster(movie) {
    const [bg, fg] = POSTER_COLORS[hash(movie.title) % POSTER_COLORS.length];
    const shape = hash(movie.title + 'x') % 3;
    return h('div.fake-poster', { style: { background: bg, color: fg } },
      h('span.fp-shape.s' + shape, { style: { borderColor: fg } }),
      h('span.fp-title', movie.title),
      h('span.fp-meta', [movie.year, movie.director].filter(Boolean).join(' · ')));
  }

  function posterEl(movie, cls = 'poster') {
    const wrap = h('div.' + cls);
    if (movie.poster) {
      const img = h('img', { src: movie.poster, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => { img.remove(); wrap.append(fakePoster(movie)); });
      wrap.append(img);
    } else {
      wrap.append(fakePoster(movie));
    }
    return wrap;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }

  function parseClock(str) {
    const parts = String(str).trim().split(':').map(Number);
    if (!parts.length || parts.some(n => !isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  function openDialog(id) {
    const d = typeof id === 'string' ? $(id) : id;
    if (!d.open) d.showModal();
    return d;
  }

  document.addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) x.closest('dialog').close();
    // click on the backdrop closes too
    if (e.target.tagName === 'DIALOG' && e.target.id !== 'dlg-name') {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  window.UI = { $, $$, h, toast, posterEl, fakePoster, initials, parseClock, copy, openDialog, fmt: window.SyncCore.formatTime };
})();
