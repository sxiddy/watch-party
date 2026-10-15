// Players + the sync loop.
//
// Every source (mp4 file, YouTube, your own local file, companion mode) is
// wrapped in an adapter with the same small interface, so the sync loop
// doesn't care what it's driving:
//   ready, paused, seeking, buffering, currentTime, duration, canRate
//   play() → Promise, pause(), seek(t), setRate(r), destroy()
(function () {
  const { expectedPosition, countdownRemaining, DriftController } = window.SyncCore;

  // ---------- <video> (files, Internet Archive, local copies) ----------
  class VideoAdapter {
    constructor(host, src, events) {
      this.kind = 'video';
      this.canRate = true;
      this.events = events;
      const v = this.el = document.createElement('video');
      v.playsInline = true;
      v.preload = 'auto';
      v.src = src; // no crossOrigin: captions are drawn by us, so we never need to read pixels
      this.buffering = false;
      this.seeking = false;
      this._seekStart = 0;
      v.addEventListener('loadedmetadata', () => events.onMeta && events.onMeta(v.duration));
      v.addEventListener('waiting', () => { this.buffering = true; events.onBuffer && events.onBuffer(true); });
      const unbuffer = () => { if (this.buffering) { this.buffering = false; events.onBuffer && events.onBuffer(false); } };
      v.addEventListener('playing', unbuffer);
      v.addEventListener('canplay', unbuffer);
      v.addEventListener('seeking', () => { this.seeking = true; this._seekStart = performance.now(); });
      v.addEventListener('seeked', () => {
        this.seeking = false;
        events.onSeekTime && events.onSeekTime((performance.now() - this._seekStart) / 1000);
        unbuffer();
      });
      v.addEventListener('ended', () => events.onEnded && events.onEnded());
      v.addEventListener('error', () => {
        events.onError && events.onError('This video wouldn’t load. The link may be down or the format isn’t supported by your browser.');
      });
      host.appendChild(v);
    }
    get ready() { return this.el.readyState >= 1; }
    get paused() { return this.el.paused; }
    get currentTime() { return this.el.currentTime; }
    get duration() { return this.el.duration || 0; }
    play() { return this.el.play(); }
    pause() { this.el.pause(); }
    seek(t) { try { this.el.currentTime = Math.max(0, t); } catch (e) { /* not seekable yet */ } }
    setRate(r) { if (Math.abs(this.el.playbackRate - r) > 0.001) this.el.playbackRate = r; }
    set volume(v) { this.el.volume = v; }
    set muted(m) { this.el.muted = m; }
    destroy() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.el.remove(); }
  }

  // ---------- YouTube iframe ----------
  let ytReady = null;
  function loadYouTubeApi() {
    if (ytReady) return ytReady;
    ytReady = new Promise(resolve => {
      if (window.YT && window.YT.Player) return resolve();
      window.onYouTubeIframeAPIReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return ytReady;
  }

  class YouTubeAdapter {
    constructor(host, ytId, events) {
      this.kind = 'youtube';
      this.canRate = false; // only 0.25 steps, too coarse for drift nudging
      this.events = events;
      this.p = null;
      this._ready = false;
      this.buffering = false;
      this.seeking = false;
      this._state = -1;
      const div = document.createElement('div');
      div.className = 'yt-host';
      host.appendChild(div);
      this.el = div;
      loadYouTubeApi().then(() => {
        this.p = new YT.Player(div, {
          videoId: ytId,
          playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
          events: {
            onReady: () => { this._ready = true; events.onMeta && events.onMeta(this.p.getDuration()); },
            onStateChange: e => {
              this._state = e.data;
              const buf = e.data === YT.PlayerState.BUFFERING;
              if (buf !== this.buffering) { this.buffering = buf; events.onBuffer && events.onBuffer(buf); }
              if (e.data === YT.PlayerState.ENDED) events.onEnded && events.onEnded();
              if (e.data === YT.PlayerState.PLAYING && this._wantPause) this.p.pauseVideo();
            },
            onError: () => events.onError && events.onError('YouTube won’t play this one here (the owner may have blocked embedding).'),
          },
        });
      });
    }
    get ready() { return this._ready; }
    get paused() { return this._state !== 1 && this._state !== 3; }
    get currentTime() { return this._ready ? this.p.getCurrentTime() : 0; }
    get duration() { return this._ready ? this.p.getDuration() : 0; }
    play() { this._wantPause = false; if (this._ready) this.p.playVideo(); return Promise.resolve(); }
    pause() { this._wantPause = true; if (this._ready) this.p.pauseVideo(); }
    seek(t) { if (this._ready) this.p.seekTo(Math.max(0, t), true); }
    setRate() {}
    set volume(v) { this._ready && this.p.setVolume(Math.round(v * 100)); }
    set muted(m) { this._ready && (m ? this.p.mute() : this.p.unMute()); }
    destroy() { try { this.p && this.p.destroy(); } catch (e) {} this.el.remove(); }
  }

  // ---------- companion mode: no video, just the shared clock ----------
  class CompanionAdapter {
    constructor(sync) {
      this.kind = 'companion';
      this.canRate = true;
      this.sync = sync;
      this.buffering = false;
      this.seeking = false;
    }
    get ready() { return true; }
    get paused() { return !this.sync.shouldPlay(); }
    get currentTime() { return this.sync.expected(); }
    get duration() { return this.sync.state?.duration || 0; }
    play() { return Promise.resolve(); }
    pause() {}
    seek() {}
    setRate() {}
    destroy() {}
  }

  // ---------- the loop that keeps us in step with the room ----------
  class PlaybackSync {
    constructor(net, hooks = {}) {
      this.net = net;
      this.hooks = hooks;
      this.adapter = null;
      this.state = null;
      this.ctl = new DriftController();
      this.drift = 0;
      this.driftLog = [];
      this.lastSeekAt = 0;
      this.blocked = false;
      this.corrections = { seeks: 0, nudges: 0 };
      this._timer = setInterval(() => this.tick(), 250);
    }

    setAdapter(a) {
      if (this.adapter && this.adapter !== a) this.adapter.destroy();
      this.adapter = a;
      this.blocked = false;
      this.tick();
    }

    setState(pb) {
      this.state = pb;
      this.tick();
    }

    expected() { return this.state ? expectedPosition(this.state, this.net.serverNow()) : 0; }
    countdown() { return this.state ? countdownRemaining(this.state, this.net.serverNow()) : 0; }
    shouldPlay() {
      const s = this.state;
      if (!s || !s.playing || this.countdown() > 0) return false;
      return !(s.duration && this.expected() >= s.duration - 0.05);
    }

    tick() {
      const a = this.adapter, s = this.state;
      if (!a || !s || !a.ready) return;
      const exp = this.expected();
      const cd = this.countdown();
      // fire exactly when a countdown ends instead of waiting for the next tick
      if (cd > 0 && cd < 260 && !this._cdTimer) {
        this._cdTimer = setTimeout(() => { this._cdTimer = null; this.tick(); }, cd);
      }
      if (a.kind === 'companion') { this.drift = 0; return; }

      if (!this.shouldPlay()) {
        if (!a.paused) a.pause();
        a.setRate(1);
        // park on the right frame so a countdown start is instant
        if (!a.seeking && Math.abs(a.currentTime - exp) > 0.25) this._seek(exp, false);
        this.drift = a.currentTime - exp;
        return;
      }

      if (a.paused) {
        // A late joiner's first seek can take seconds on a slow source. Seeking
        // again every tick (the target keeps moving) restarts the load each time
        // and it never catches up, so let a seek finish first.
        if (a.seeking) return;
        const settling = performance.now() - this.lastSeekAt < 1500;
        if (!settling && Math.abs(a.currentTime - exp) > 0.3) this._seek(exp + this.ctl.seekLead, true);
        const p = a.play();
        if (p && p.catch) p.then(() => { if (this.blocked) { this.blocked = false; this.hooks.onBlocked && this.hooks.onBlocked(false); } })
          .catch(err => {
            if (err && err.name === 'NotAllowedError' && !this.blocked) { this.blocked = true; this.hooks.onBlocked && this.hooks.onBlocked(true); }
          });
        return;
      }
      if (a.seeking || a.buffering) return;

      const d = this.ctl.decide(a.currentTime, exp, true, a.canRate);
      this.drift = d.drift;
      const now = performance.now();
      this.driftLog.push({ t: now, d: d.drift });
      while (this.driftLog.length && now - this.driftLog[0].t > 60_000) this.driftLog.shift();

      if (d.action === 'seek') {
        // don't thrash: give a seek a second to land unless we're way off
        if (now - this.lastSeekAt > 1000 || Math.abs(d.drift) > 2) this._seek(d.target, true);
      } else if (d.action === 'rate') {
        a.setRate(d.rate);
        this.corrections.nudges++;
      } else {
        a.setRate(1);
      }
    }

    _seek(t, count) {
      this.adapter.seek(t);
      this.lastSeekAt = performance.now();
      if (count) this.corrections.seeks++;
    }

    // user tapped "join the show" after autoplay was blocked
    unblock() {
      this.blocked = false;
      const a = this.adapter;
      if (a && this.shouldPlay()) a.play().catch(() => {});
      this.hooks.onBlocked && this.hooks.onBlocked(false);
    }
  }

  // ---------- captions: one renderer for every player type ----------
  function parseVtt(text) {
    const cues = [];
    const toSec = ts => {
      const p = ts.trim().split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
    for (const b of blocks) {
      const lines = b.split('\n');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const [a, z] = lines[i].split('-->');
      const start = toSec(a.replace(',', '.')), end = toSec(z.trim().split(/\s+/)[0].replace(',', '.'));
      const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (body && isFinite(start) && isFinite(end)) cues.push({ start, end, text: body });
    }
    cues.sort((x, y) => x.start - y.start);
    return cues;
  }

  function cueAt(cues, t) {
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // overlapping cues: walk back a little
    const out = [];
    for (let i = found; i >= 0 && i > found - 4; i--) if (cues[i].end > t) out.unshift(cues[i].text);
    return out.join('\n');
  }

  window.Players = { VideoAdapter, YouTubeAdapter, CompanionAdapter, PlaybackSync, parseVtt, cueAt, loadYouTubeApi };
})();
