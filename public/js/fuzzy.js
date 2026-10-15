/*
 * fuzzy.js — typo-tolerant movie search (no dependencies).
 *
 * Each query token is matched against every token of the weighted fields
 * (title, director, cast, genres, tags). A token match is scored as:
 *   exact 1.0 · prefix 0.9 · substring 0.75 · edit-distance similarity ×0.85
 *   · in-order subsequence 0.5
 * The item score is the weighted mean over query tokens, plus a bonus when
 * the whole query appears in the title. Works in Node and the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fuzzy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELDS = [
    ['title', 1.0],
    ['director', 0.7],
    ['cast', 0.65],
    ['genres', 0.6],
    ['tags', 0.55],
  ];

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const tokenize = s => normalize(s).split(' ').filter(Boolean);

  // Optimal-string-alignment Damerau–Levenshtein (handles swapped letters).
  function editDistance(a, b) {
    const n = a.length, m = b.length;
    if (!n) return m; if (!m) return n;
    let prev2 = null, prev = new Array(m + 1), cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
      }
      prev2 = prev.slice(); [prev, cur] = [cur, prev];
    }
    return prev[m];
  }

  function isSubsequence(q, t) {
    let i = 0;
    for (let j = 0; j < t.length && i < q.length; j++) if (q[i] === t[j]) i++;
    return i === q.length;
  }

  function tokenScore(q, t) {
    if (q === t) return 1;
    if (t.startsWith(q)) return q.length >= 2 ? 0.9 : 0.6;
    if (q.length >= 3 && t.includes(q)) return 0.75;
    if (q.length >= 3) {
      // compare against the same-length prefix too, so "intersell" ≈ "interstellar"
      const d = Math.min(editDistance(q, t), editDistance(q, t.slice(0, q.length + 1)) + 0.5);
      const sim = 1 - d / Math.max(q.length, Math.min(t.length, q.length + 1));
      const allowed = q.length <= 4 ? 1 : q.length <= 7 ? 2 : 3;
      if (d <= allowed && sim > 0) return 0.85 * sim + 0.05;
    }
    if (q.length >= 3 && isSubsequence(q, t)) return 0.45;
    return 0;
  }

  /** Pre-compute token lists once per catalog. */
  function buildIndex(items) {
    return items.map(item => ({
      item,
      titleNorm: normalize(item.title),
      fields: FIELDS.map(([key, w]) => {
        const v = item[key];
        const text = Array.isArray(v) ? v.join(' ') : v;
        return { w, tokens: tokenize(text) };
      }),
    }));
  }

  function scoreEntry(entry, qTokens, qNorm) {
    let total = 0;
    for (const q of qTokens) {
      let best = 0;
      for (const f of entry.fields) {
        for (const t of f.tokens) {
          const s = tokenScore(q, t) * f.w;
          if (s > best) best = s;
          if (best >= f.w) break;
        }
      }
      total += best;
    }
    let score = total / qTokens.length;
    if (qNorm.length >= 2 && entry.titleNorm.includes(qNorm)) score += 0.35;
    if (entry.titleNorm === qNorm) score += 0.25;
    return score;
  }

  /** search(index, "intrstellar") → [{ item, score }] best first */
  function search(index, query, opts = {}) {
    const qNorm = normalize(query);
    const qTokens = tokenize(query);
    if (!qTokens.length) return index.map(e => ({ item: e.item, score: 0 }));
    const threshold = opts.threshold != null ? opts.threshold : 0.42;
    const out = [];
    for (const e of index) {
      const score = scoreEntry(e, qTokens, qNorm);
      if (score >= threshold) out.push({ item: e.item, score });
    }
    out.sort((a, b) => b.score - a.score || (b.item.rating || 0) - (a.item.rating || 0));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  return { normalize, tokenize, editDistance, tokenScore, buildIndex, search };
});
