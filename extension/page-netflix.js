// Runs in Netflix's own page (not the extension's isolated copy), because
// Netflix's player API lives on the page's window. Setting a Netflix video's
// currentTime directly makes the player throw an error, so content.js asks
// this script to seek through the player instead.
(function () {
  if (window.__brNetflix) return;
  window.__brNetflix = true;
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
    } catch (e) { return null; }
  }
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'br-sync') return;
    const p = player();
    if (!p) return;
    if (e.data.type === 'seek' && Number.isFinite(e.data.ms)) p.seek(e.data.ms);
  });
})();
