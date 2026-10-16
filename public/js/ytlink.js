/*
 * ytlink.js — reading a YouTube link someone pasted.
 * Loaded by the browser (window.YtLink) and by Node (tests), like sync-core.js.
 *
 *   parse("https://youtu.be/dQw4w9WgXcQ?t=1m30s") → { id: "dQw4w9WgXcQ", start: 90 }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YtLink = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/i;

  function parse(text) {
    const s = String(text || '').trim();
    const m = s.match(ID);
    if (!m) return null;
    // ?t=90, &t=1m30s, #t=90, ?start=90
    const t = (s.match(/[?&#](?:t|start)=([0-9hms]+)/i) || [])[1];
    let start = 0;
    if (t) {
      if (/^\d+$/.test(t)) start = +t;
      else {
        const p = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
        if (p) start = (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0);
      }
    }
    return { id: m[1], start: Math.min(start, 86400) };
  }

  const looksLikeYouTube = text => /(?:youtube\.com|youtu\.be)\//i.test(String(text || ''));

  return { parse, looksLikeYouTube };
});
