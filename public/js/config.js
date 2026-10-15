// Where the sync server lives. Empty means "the same place this page came from",
// which is the case when you run `npm start` or open the Render copy directly.
// The Vercel copy only serves the pages, so it talks to the server on Render.
(function () {
  var onVercel = /\.vercel\.app$/.test(location.hostname);
  window.BR_SERVER = onVercel ? 'https://watchpartyvinnovate-sync.onrender.com' : '';
  window.apiUrl = function (p) { return p.charAt(0) === '/' ? window.BR_SERVER + p : p; };
})();
