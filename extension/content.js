// Back Row Sync: runs inside the streaming tab (Netflix, Prime Video,
// Hotstar, YouTube, or any page with a <video>).
//
// It finds the page's video and keeps it where the room says it should be,
// using the same sync maths as the Back Row website (sync-core.js):
//   expected = basePos + (serverNow − baseTime) × rate
// Small drift is fixed by playing up to 6 % faster or slower, big drift by a
// seek. When the person here presses play, pause or seeks, it's sent to the room.
(function () {
  if (window.__brSync) { window.__brSync.restart(); return; }
  const { expectedPosition, DriftController } = window.SyncCore;

  const TICK_MS = 250;
  const OURS_MS = 3000;         // how long we wait for the video event a change of ours causes
  const isNetflix = /netflix\.com$/.test(location.hostname);

  let port = null, pb = null, offset = 0, canControl = false, code = '', watching = 0, conn = '';
  let video = null, timer = null, statusTimer = null, stopped = false;
  let seekSend = null, holdUntil = 0, seekStarted = 0, lastDrift = null;
  const ctl = new DriftController();

  const serverNow = () => Date.now() + offset;
  const active = () => pb && pb.media && !stopped;

  // ---------- the page's video ----------

  // the biggest visible video is the film (sites also have previews and ads in small players)
  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && v.readyState > 0) { best = v; bestArea = area; }
    }
    return best;
  }

  function attach(v) {
    if (video === v) return;
    if (video) for (const [ev, fn] of Object.entries(listeners)) video.removeEventListener(ev, fn);
    video = v;
    if (video) for (const [ev, fn] of Object.entries(listeners)) video.addEventListener(ev, fn);
  }

  // Every play, pause or seek we cause fires a video event. We note each one
  // we're expecting, so the matching event is skipped and any other is the viewer.
  const pending = { play: 0, pause: 0, seeking: 0 };
  function expect(ev) { pending[ev] = Date.now() + OURS_MS; }
  function mine(ev) { if (pending[ev] && Date.now() < pending[ev]) { pending[ev] = 0; return true; } return false; }

  // Netflix's player breaks if a page sets currentTime itself, so seeks go
  // through Netflix's own player API (page-netflix.js runs in the page for that).
  function seekTo(t) {
    expect('seeking');
    seekStarted = Date.now();
    if (isNetflix) window.postMessage({ source: 'br-sync', type: 'seek', ms: Math.round(t * 1000) }, '*');
    else video.currentTime = t;
  }
  function play() { expect('play'); const p = video.play(); if (p && p.catch) p.catch(() => toast('Click play once on this page so the browser lets Back Row start the video')); }
  function pause() { expect('pause'); video.pause(); }

  // ---------- the viewer's own clicks go to the room ----------

  const listeners = {
    play: () => { if (!mine('play') && active()) userAction({ action: 'play' }); },
    pause: () => { if (!mine('pause') && active() && !video.ended) userAction({ action: 'pause' }); },
    // 'seeking' fires the moment the position changes, before our loop could move it back
    // dragging the seek bar fires many 'seeking' events: hold the room off at once, send only the last position
    seeking: () => {
      if (mine('seeking') || !active()) return;
      holdUntil = Date.now() + 1500;
      clearTimeout(seekSend); seekSend = setTimeout(() => userAction({ action: 'seek', position: video.currentTime }), 250);
    },
    seeked: () => { if (seekStarted) { ctl.recordSeekDuration((Date.now() - seekStarted) / 1000); seekStarted = 0; } },
  };

  // ---------- the sync loop ----------

  function tick() {
    if (!video || !video.isConnected) attach(findVideo());
    if (!video || !active()) return;
    if (seekStarted && Date.now() - seekStarted < 3000) return; // let a seek land before judging again
    seekStarted = 0;
    if (Date.now() < holdUntil) return;
    const now = serverNow();
    const expected = expectedPosition(pb, now);
    const shouldPlay = pb.playing && now >= pb.baseTime; // a future baseTime is the 3-2-1 countdown

    if (shouldPlay && video.paused) play();
    if (!shouldPlay && !video.paused) pause();

    const d = ctl.decide(video.currentTime, expected, shouldPlay, true);
    lastDrift = d.drift;
    if (d.action === 'seek') { video.playbackRate = 1; seekTo(d.target); }
    else if (d.action === 'rate') { video.playbackRate = d.rate; }
    else if (video.playbackRate !== 1) { video.playbackRate = 1; }
    badge();
  }

  // ---------- talking to the extension ----------

  // the viewer just clicked: give the room a moment to answer before enforcing its state again
  function userAction(op) { holdUntil = Date.now() + 1500; send({ type: 'control', op }); }

  function send(msg) { try { port && port.postMessage(msg); } catch (e) { /* reconnecting */ } }

  function connectPort() {
    try { port = chrome.runtime.connect({ name: 'br-tab' }); } catch (e) { return; } // extension reloaded: this copy is orphaned
    port.onMessage.addListener(msg => {
      if (msg.type === 'state') {
        const changed = !pb || !msg.playback || pb.version !== msg.playback.version;
        pb = msg.playback; offset = msg.offset; canControl = msg.canControl; code = msg.code; watching = msg.watching; conn = msg.conn;
        if (changed && pb && pb.reason && pb.changedByName && pb.reason !== 'media') toast(pb.changedByName + ' ' + ({ play: 'pressed play', pause: 'paused', seek: 'jumped to ' + fmt(pb.basePos), countdown: 'started the countdown' }[pb.reason] || ''));
        if (changed) { holdUntil = 0; tick(); }
        badge();
      } else if (msg.type === 'take-over') {
        // the person who started the party: the room starts where this video is
        const v = video || findVideo();
        if (v) {
          send({ type: 'control', op: { action: 'seek', position: v.currentTime } });
          if (!v.paused) setTimeout(() => send({ type: 'control', op: { action: 'play' } }), 300);
        }
      } else if (msg.type === 'toast') { if (msg.text) toast(msg.text); }
      else if (msg.type === 'stop') stop();
    });
    port.onDisconnect.addListener(() => { port = null; if (!stopped) setTimeout(connectPort, 1000); });
    send({ type: 'hello' });
  }

  // ---------- a small badge on the page, so you can see it's working ----------

  let badgeEl = null, toastEl = null;
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  function ui() {
    if (badgeEl && badgeEl.isConnected) return;
    const host = document.createElement('div');
    host.id = 'br-sync-ui';
    host.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;pointer-events:none;font:600 12px/1.3 system-ui,sans-serif';
    const root = host.attachShadow({ mode: 'open' }); // page styles can't touch it
    root.innerHTML = `<style>
      .b{display:flex;gap:8px;align-items:center;background:rgba(17,12,10,.86);color:#f1e9db;border:1px solid rgba(217,71,43,.7);border-radius:999px;padding:6px 12px;backdrop-filter:blur(6px)}
      .dot{width:8px;height:8px;border-radius:50%;background:#3fa796}.dot.off{background:#f2b33d}
      .t{margin-top:8px;background:#d9472b;color:#fff;border-radius:10px;padding:8px 12px;max-width:320px;opacity:0;transition:opacity .2s}.t.on{opacity:1}
    </style><div class="b"><span class="dot"></span><span class="txt"></span></div><div class="t"></div>`;
    (document.fullscreenElement || document.body || document.documentElement).appendChild(host);
    badgeEl = root.querySelector('.b'); toastEl = root.querySelector('.t');
  }
  function badge() {
    ui();
    const fs = document.fullscreenElement; // keep it visible in fullscreen too
    const host = document.getElementById('br-sync-ui');
    if (fs && host && host.parentNode !== fs) fs.appendChild(host);
    if (!fs && host && host.parentNode !== document.body && document.body) document.body.appendChild(host);
    const ok = conn === 'connected' && video;
    badgeEl.querySelector('.dot').className = 'dot' + (ok ? '' : ' off');
    const drift = lastDrift == null || !pb || !pb.playing ? '' : ' · ' + Math.round(Math.abs(lastDrift) * 1000) + ' ms';
    badgeEl.querySelector('.txt').textContent = !video ? 'Back Row · looking for the video…'
      : conn !== 'connected' ? 'Back Row · reconnecting…'
      : `Back Row ${code} · ${watching} watching${drift}${canControl ? '' : ' · host controls'}`;
  }
  let toastTimer = null;
  function toast(text) {
    ui(); toastEl.textContent = text; toastEl.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3500);
  }

  // ---------- start and stop ----------

  function start() {
    stopped = false;
    connectPort();
    clearInterval(timer); timer = setInterval(tick, TICK_MS);
    // drift and buffering go to the room, so the Sync tab and buffering pauses work for extension viewers too
    clearInterval(statusTimer); statusTimer = setInterval(() => {
      if (!active()) return;
      // buffering = the room wants it playing but the video has no frames to show yet.
      // Read fresh every time, so once the room pauses to wait for us we still report when we're ready.
      const now = serverNow();
      const wantPlay = pb.playing && now >= pb.baseTime;
      const buffering = !!video && wantPlay && video.readyState < 3;
      send({ type: 'status', buffering, drift: video && wantPlay ? lastDrift : null });
    }, 2000);
    tick();
  }
  function stop() {
    stopped = true;
    clearInterval(timer); clearInterval(statusTimer);
    if (video) video.playbackRate = 1;
    attach(null);
    const host = document.getElementById('br-sync-ui'); if (host) host.remove();
    badgeEl = null;
    try { port && port.disconnect(); } catch (e) { /* gone */ }
  }

  window.__brSync = { restart: () => { stop(); start(); } };
  start();
})();
