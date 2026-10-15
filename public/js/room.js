// Everything that happens once you're inside a room.
(function () {
  const { $, $$, h, toast, posterEl, initials, parseClock, copy, openDialog, fmt } = window.UI;
  const { VideoAdapter, YouTubeAdapter, CompanionAdapter, PlaybackSync, parseVtt, cueAt } = window.Players;
  const { percentile } = window.SyncCore;

  let net, sync;
  const S = {
    code: '', me: '', hostId: null, settings: {}, playback: null, members: [], queue: [], polls: [],
    chat: [], highlights: [], reactions: { itemId: null, buckets: {} }, intermission: null,
    sharedCaptions: null, taste: [], joinedAt: 0, emojis: [], latency: [], stats: null,
    mountedItem: null, localFile: null, cues: [], ccTrack: 'off', ccChosen: false, revealBefore: false,
  };
  const pendingLatency = [];

  const me = () => S.members.find(m => m.id === S.me);
  const nameOf = id => (S.members.find(m => m.id === id) || {}).name || 'someone';
  const isHost = () => S.hostId === S.me;
  function canControl() {
    if (isHost()) return true;
    const m = me();
    return S.settings.controlMode === 'everyone' || !!(m && m.cohost);
  }

  // ---------- entering ----------

  function enter(netRef, snap) {
    net = netRef;
    if (!sync) {
      sync = new PlaybackSync(net, { onBlocked: b => { $('#blocked').hidden = !b; } });
      bindControls();
      bindPanels();
      bindNet();
      Discover.init({
        canControl, play: playMedia, queue: queueMedia, startLocal, taste: () => S.taste,
        tasteVote: (m, like) => net.request('taste', { item: { title: m.title, tmdbId: m.tmdbId, catalogId: m.source === 'local' ? m.id : null, genres: m.genres, poster: m.poster, year: m.year }, like }),
      });
      requestAnimationFrame(frame);
      setInterval(reportStatus, 2000);
      setInterval(renderSync, 1000);
      document.addEventListener('visibilitychange', () => net.request('status', { away: document.hidden }));
    }
    applySnapshot(snap, true);
    document.body.classList.add('in-room');
  }

  function applySnapshot(snap, first) {
    Object.assign(S, {
      code: snap.code, me: snap.you, hostId: snap.hostId, settings: snap.settings, members: snap.members,
      queue: snap.queue, polls: snap.polls, highlights: snap.highlights, reactions: snap.reactions,
      intermission: snap.intermission, sharedCaptions: snap.captions, taste: snap.taste, emojis: snap.emojis,
    });
    if (first) S.joinedAt = snap.joinedAt;
    S.chat = snap.chat;
    $('#room-code').textContent = snap.code;
    history.replaceState(null, '', '/r/' + snap.code);
    document.title = `Room ${snap.code} · Back Row`;
    renderReactBar();
    onPlayback(snap.playback, true);
    renderAll();
    if (S.sharedCaptions) loadCaptionsText(S.sharedCaptions.vtt);
  }

  function renderAll() {
    renderRole();
    renderPeople();
    renderChatAll();
    renderQueue();
    renderPolls();
    renderClips();
    renderIntermission();
    renderHeat();
    Discover.refreshRecs();
  }

  // ---------- playback ----------

  function onPlayback(pb, silent) {
    const prev = S.playback;
    if (!silent && prev && pb.version <= prev.version) return; // late duplicate, we already have newer
    S.playback = pb;
    if (pb.issuedAt && pb.changedBy && pb.changedBy !== S.me) {
      const e2e = net.serverNow() - pb.issuedAt;
      if (e2e >= 0 && e2e < 10000) { pendingLatency.push(Math.round(e2e)); S.latency.push(e2e); if (S.latency.length > 300) S.latency.shift(); }
    }
    if (pb.itemId !== S.mountedItem) mountMedia(pb);
    sync.setState(pb);
    renderNowShowing();
    if (!silent && prev && pb.changedBy !== S.me) announce(pb, prev);
    if (pb.reason === 'resume') hideNotice();
    if (pb.reason === 'buffering') showNotice('Someone’s buffering, hang on a sec…');
  }

  function announce(pb, prev) {
    const who = pb.changedByName || 'Back Row';
    const r = pb.reason;
    if (r === 'pause') toast(`${who} paused`);
    else if (r === 'play' && !prev.playing) toast(`${who} pressed play`);
    else if (r === 'seek') toast(`${who} jumped to ${fmt(pb.basePos)}`);
    else if (r === 'countdown') toast(`${who} is starting it, 3… 2… 1…`);
    else if (r === 'highlight') toast(`${who} is playing a clip`);
  }

  function mountMedia(pb) {
    S.mountedItem = pb.itemId;
    const host = $('#player-host');
    $('#empty-screen').hidden = !!pb.media;
    $('#companion').hidden = true;
    $('#local-pick').hidden = true;
    $('#blocked').hidden = true;
    S.cues = [];
    S.ccChosen = false;
    $('#captions').textContent = '';
    sync.setAdapter(null);
    host.replaceChildren();
    document.body.dataset.kind = pb.media ? pb.media.kind : 'none';
    if (!pb.media) return;
    const m = pb.media;
    const events = {
      onMeta: d => net.request('status', { duration: d, itemId: pb.itemId }),
      onBuffer: b => net.request('status', { buffering: b }),
      onEnded: () => net.request('media:ended', { itemId: S.playback.itemId }),
      onSeekTime: s => sync.ctl.recordSeekDuration(s),
      onError: msg => { toast(msg, 'bad'); },
    };
    if (m.kind === 'file') sync.setAdapter(new VideoAdapter(host, m.src, events));
    else if (m.kind === 'youtube') sync.setAdapter(new YouTubeAdapter(host, m.ytId, events));
    else if (m.kind === 'companion') { sync.setAdapter(new CompanionAdapter(sync)); showCompanion(m); }
    else if (m.kind === 'local') mountLocal(m, events);
    applyVolume();
    autoCaptions();
  }

  // --- your own file ---
  function mountLocal(m, events) {
    const f = S.localFile;
    if (f && f.name === m.localKey.name && (!m.localKey.size || f.size === m.localKey.size)) {
      sync.setAdapter(new VideoAdapter($('#player-host'), f.url, events));
      net.request('status', { mediaReady: true });
      return;
    }
    $('#local-pick').hidden = false;
    $('#local-name').textContent = `${m.title} (${m.localKey.name}${m.localKey.size ? ', ' + (m.localKey.size / 1e9).toFixed(2) + ' GB' : ''})`;
    $('#local-warn').textContent = '';
    net.request('status', { mediaReady: false });
    $('#local-input').onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      if (S.localFile) URL.revokeObjectURL(S.localFile.url);
      S.localFile = { name: file.name, size: file.size, url: URL.createObjectURL(file) };
      if (file.size !== m.localKey.size && m.localKey.size) {
        toast('That file isn’t the exact same size as the host’s. It’ll still sync, but scenes may be offset if it’s a different cut.', 'warn');
      }
      $('#local-pick').hidden = true;
      sync.setAdapter(new VideoAdapter($('#player-host'), S.localFile.url, events));
      applyVolume();
      net.request('status', { mediaReady: true });
    };
  }

  function startLocal(movie) {
    const input = h('input', { type: 'file', accept: 'video/*,.mkv' });
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      if (S.localFile) URL.revokeObjectURL(S.localFile.url);
      S.localFile = { name: file.name, size: file.size, url: URL.createObjectURL(file) };
      const probe = h('video', { preload: 'metadata', src: S.localFile.url });
      const go = duration => {
        const media = movie ? Discover.mediaFrom(movie, { kind: 'local' }) : { kind: 'local', title: file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ') };
        media.localKey = { name: file.name, size: file.size };
        media.duration = duration || 0;
        media.sourceLabel = 'Own files';
        playMedia(media);
        toast('Everyone else will be asked to pick their copy');
      };
      probe.onloadedmetadata = () => go(probe.duration);
      probe.onerror = () => go(0);
    };
    input.click();
  }

  // --- companion mode ---
  async function showCompanion(m) {
    $('#companion').hidden = false;
    $('#comp-title').textContent = m.title;
    $('#comp-result').textContent = '';
    const pv = $('#comp-providers');
    pv.replaceChildren();
    if (m.tmdbId) {
      try {
        const d = await fetch('/api/movies/' + m.tmdbId).then(r => r.json());
        const list = d.providers ? (d.providers.stream.length ? d.providers.stream : d.providers.rent) : [];
        if (list.length) pv.replaceChildren(h('span.k', d.providers.stream.length ? 'Streaming on' : 'Rent it on'), ...list.slice(0, 6).map(p => h('img', { src: p.logo, alt: p.name, title: p.name })));
      } catch (e) { /* fine without */ }
    }
  }

  // ---------- sending commands ----------

  async function control(action, extra = {}) {
    if (!S.playback || !S.playback.media) return toast('Pick something to watch first');
    if (!canControl()) return toast('Only the host and co-hosts can do that. The host can change it in room settings.');
    const pb = S.playback;
    const payload = { action, baseVersion: pb.version, issuedAt: Math.round(net.serverNow()), ...extra };
    // optimistic: move our own player straight away, the server will confirm
    const now = net.serverNow();
    const pos = sync.expected();
    const guess = { ...pb };
    if (action === 'pause') Object.assign(guess, { playing: false, basePos: pos, baseTime: now });
    if (action === 'play') Object.assign(guess, { playing: true, basePos: pos, baseTime: now + (extra.countdown ? 3000 : 0) });
    if (action === 'seek') Object.assign(guess, { basePos: extra.position, baseTime: pb.playing ? Math.max(now, pb.baseTime) : now });
    sync.setState(guess);
    const res = await net.request('control', payload);
    if (!res.ok) {
      sync.setState(S.playback); // undo our guess
      if (res.error === 'conflict') toast(`${res.winner} got there first, going with theirs`, 'warn');
      else if (res.error === 'slow-down') toast('Easy on the buttons');
      else if (res.error !== 'offline') toast('That didn’t go through (' + res.error + ')', 'bad');
      else toast('You’re offline, reconnecting…', 'bad');
    }
  }

  async function playMedia(media) {
    const res = await net.request('media:set', { media, autoplay: false });
    if (!res.ok) toast(res.error === 'not-allowed' ? 'Only the host can change what’s on. Add it to the queue instead.' : 'Couldn’t load that (' + res.error + ')', 'bad');
  }
  async function queueMedia(media) {
    const res = await net.request('queue:add', { media });
    if (!res.ok) toast('Couldn’t add that (' + res.error + ')', 'bad');
  }

  function reportStatus() {
    if (!net || !sync) return;
    const a = sync.adapter;
    const lat = pendingLatency.splice(0, pendingLatency.length);
    net.request('status', {
      drift: a && a.kind !== 'companion' && S.playback?.playing ? sync.drift : 0,
      rtt: net.clock.rtt,
      latency: lat,
    });
  }

  // ---------- controls ----------

  function bindControls() {
    $('#btn-play').onclick = () => control(S.playback && S.playback.playing ? 'pause' : 'play');
    $('#btn-countdown').onclick = () => {
      if (S.playback?.playing) return toast('It’s already playing');
      control('play', { countdown: true });
    };
    $('#btn-missed').onclick = async () => {
      const r = await net.request('rewind');
      if (!r.ok) toast(r.error === 'not-playing' ? 'Nothing’s playing right now' : 'Couldn’t send that');
      else if (r.count < r.need) toast(`Noted. ${r.need - r.count} more and we go back 10s`);
    };
    $('#btn-clip').onclick = async () => {
      if (!S.playback?.media) return toast('Nothing to clip yet');
      const end = sync.expected();
      // name it after what the room was reacting to, if anything
      const cell = S.reactions.itemId === S.playback.itemId ? S.reactions.buckets[Math.floor(end / 5)] || S.reactions.buckets[Math.floor(end / 5) - 1] : null;
      const top = cell ? Object.entries(cell).sort((a, b) => b[1] - a[1])[0][0] + ' ' : '';
      const title = `${top}${me()?.name || 'Someone'}’s pick at ${fmt(end)}`;
      const r = await net.request('clip:add', { start: Math.max(0, end - 15), end, title });
      if (r.ok) toast('Clipped! It’s in the Clips tab');
    };
    $('#btn-cc').onclick = () => { renderCcList(); openDialog('#dlg-cc'); };
    $('#btn-full').onclick = () => {
      const st = $('#stage');
      if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen && st.requestFullscreen();
    };
    $('#volume').oninput = applyVolume;
    $('#btn-unblock').onclick = () => sync.unblock();

    // seek bar
    const seek = $('#seek');
    let dragging = false;
    const posFrom = e => {
      const r = seek.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      return x * (duration() || 0);
    };
    seek.addEventListener('pointerdown', e => {
      if (!duration()) return;
      if (!canControl()) return toast('Only the host and co-hosts can seek');
      dragging = true; seek.setPointerCapture(e.pointerId); S.dragPos = posFrom(e);
    });
    seek.addEventListener('pointermove', e => {
      if (dragging) S.dragPos = posFrom(e);
      showSeekTip(e, posFrom(e));
    });
    seek.addEventListener('pointerleave', () => { $('#seek-tip').hidden = true; });
    seek.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      const p = posFrom(e);
      S.dragPos = null;
      control('seek', { position: p });
    });
    seek.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); nudge(e.key === 'ArrowRight' ? 5 : -5); }
    });

    // keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (!document.body.classList.contains('in-room')) return;
      if (e.target.closest('input, textarea, select, dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') { e.preventDefault(); $('#btn-play').click(); }
      else if (k === 'arrowright') nudge(5);
      else if (k === 'arrowleft') nudge(-5);
      else if (k === 'f') $('#btn-full').click();
      else if (k === 'c') $('#btn-clip').click();
      else if (k === 'r') $('#btn-missed').click();
      else if (k === 'm') { const v = $('#volume'); v.value = +v.value ? 0 : 1; applyVolume(); }
      else if (/^[1-8]$/.test(k)) sendReaction(S.emojis[+k - 1]);
    });

    $('#comp-check').onsubmit = e => {
      e.preventDefault();
      const mine = parseClock($('#comp-where').value);
      if (mine == null) { $('#comp-result').textContent = 'Type it like 1:02:15'; return; }
      const diff = mine - sync.expected();
      const out = $('#comp-result');
      if (Math.abs(diff) < 2) out.textContent = 'You’re bang on. Enjoy.';
      else if (diff > 0) out.textContent = `You’re ${Math.round(diff)}s ahead. Pause for ${Math.round(diff)} seconds, then play.`;
      else out.textContent = `You’re ${Math.round(-diff)}s behind. Skip forward ${Math.round(-diff)} seconds.`;
    };

    $('#ticket').onclick = () => {
      copy(location.origin + '/r/' + S.code).then(() => {
        $('#ticket-hint').textContent = 'copied!';
        setTimeout(() => { $('#ticket-hint').textContent = 'copy link'; }, 1600);
      });
    };
    $('#btn-qr').onclick = showQr;
    $('#btn-settings').onclick = () => { renderSettings(); openDialog('#dlg-settings'); };
    $('#btn-recap').onclick = showRecap;
    $('#btn-im-ready').onclick = () => {
      const ready = S.intermission && S.intermission.ready.includes(S.me);
      net.request('intermission:ready', { ready: !ready });
    };
    $('#btn-im-end').onclick = () => net.request('intermission:end');
    $('#btn-link').onclick = () => { $('#link-error').textContent = ''; $('#link-play').hidden = !canControl(); openDialog('#dlg-link'); };
    $('#btn-ownfile').onclick = () => startLocal(null);

    $('#link-form').onsubmit = e => {
      e.preventDefault();
      const url = $('#link-url').value.trim();
      const title = $('#link-title').value.trim();
      const yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
      let media;
      if (yt) media = { kind: 'youtube', ytId: yt[1], title: title || 'YouTube video', sourceLabel: 'YouTube' };
      else if (/^https?:\/\/\S+$/i.test(url)) media = { kind: 'file', src: url, title: title || decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/\.[a-z0-9]+$/i, '') || 'Video', sourceLabel: 'Link' };
      else { $('#link-error').textContent = 'That doesn’t look like a link'; return; }
      const how = e.submitter ? e.submitter.value : 'queue';
      (how === 'play' ? playMedia : queueMedia)(media);
      $('#dlg-link').close();
      $('#link-url').value = ''; $('#link-title').value = '';
    };

    // settings dialog
    $('#set-control').onchange = e => net.request('settings', { controlMode: e.target.value });
    $('#set-buffer').onchange = e => net.request('settings', { waitForBuffering: e.target.checked });
    $('#set-rewind').onchange = e => net.request('settings', { autoRewind: e.target.checked });
    $('#set-cc').onchange = e => net.request('settings', { captionsForAll: e.target.checked });
    $$('[data-im]').forEach(b => { b.onclick = () => { net.request('intermission:start', { minutes: +b.dataset.im }); $('#dlg-settings').close(); }; });

    // captions dialog
    $('#cc-file').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      let text = await f.text();
      if (!/^﻿?WEBVTT/.test(text)) text = srtToVtt(text);
      loadCaptionsText(text);
      S.ccTrack = 'mine'; S.ccChosen = true;
      if (canControl()) {
        const r = await net.request('captions:share', { name: f.name, vtt: text });
        if (r.ok) toast('Shared with the room');
      } else toast('Subtitles on (just for you)');
      $('#dlg-cc').close();
      e.target.value = '';
    };
    $('#cc-size').onchange = e => { $('#captions').dataset.size = e.target.value; };
  }

  function srtToVtt(srt) {
    return 'WEBVTT\n\n' + srt.replace(/^﻿/, '').replace(/\r+/g, '')
      .replace(/(\d{1,2}):(\d\d):(\d\d)[,.](\d{1,3})/g, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`);
  }

  function nudge(sec) {
    if (!duration()) return;
    control('seek', { position: Math.max(0, Math.min(duration(), sync.expected() + sec)) });
  }

  function duration() {
    const a = sync && sync.adapter;
    return (S.playback && S.playback.duration) || (a && a.duration) || 0;
  }

  function applyVolume() {
    const v = +$('#volume').value;
    const a = sync && sync.adapter;
    if (a && a.kind !== 'companion') { try { a.volume = v; a.muted = v === 0; } catch (e) { /* not ready yet */ } }
  }

  // ---------- reactions ----------

  function renderReactBar() {
    $('#react-bar').replaceChildren(...S.emojis.map((e, i) => h('button.react', { title: `Key ${i + 1}`, onclick: () => sendReaction(e) }, e)));
  }

  function sendReaction(e) {
    if (!e) return;
    net.request('react', { emoji: e }).then(r => { if (r && r.error === 'slow-down') toast('Whoa, slow down'); });
  }

  const recentReacts = [];
  function onReaction(r) {
    floatEmoji(r.emoji, r.name, r.color);
    if (r.itemId && r.itemId === S.reactions.itemId) {
      const b = Math.floor(r.videoTime / 5);
      const cell = S.reactions.buckets[b] || (S.reactions.buckets[b] = {});
      cell[r.emoji] = (cell[r.emoji] || 0) + 1;
      renderHeat();
    }
    // combo: lots of people hitting the same emoji at once
    const t = performance.now();
    recentReacts.push({ t, e: r.emoji, by: r.by });
    while (recentReacts.length && t - recentReacts[0].t > 2500) recentReacts.shift();
    const same = recentReacts.filter(x => x.e === r.emoji);
    const people = new Set(same.map(x => x.by)).size;
    if (people >= 3 && same.length >= 4 && (!S._comboAt || t - S._comboAt > 4000)) {
      S._comboAt = t;
      const big = h('div.combo', r.emoji, h('span', `${people} of you at once`));
      $('#reactions-layer').append(big);
      setTimeout(() => big.remove(), 1800);
    }
  }

  function floatEmoji(e, name, color) {
    const layer = $('#reactions-layer');
    if (layer.childElementCount > 40) return;
    const el = h('div.float', { style: { left: 62 + Math.random() * 32 + '%', '--drift': (Math.random() * 40 - 20) + 'px' } },
      h('span.fe', e), h('span.fn', { style: { color } }, name));
    layer.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- heatmap on the seek bar ----------

  function renderHeat() {
    const c = $('#heat');
    const d = duration();
    const w = c.clientWidth, hgt = c.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = hgt * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hgt);
    if (!d || S.reactions.itemId !== S.playback?.itemId) return;
    const buckets = Object.entries(S.reactions.buckets).map(([b, cell]) => [+b, Object.values(cell).reduce((a, x) => a + x, 0)]);
    if (!buckets.length) return;
    const max = Math.max(...buckets.map(x => x[1]));
    const bw = Math.max(2, (5 / d) * w);
    for (const [b, n] of buckets) {
      const x = (b * 5 / d) * w;
      const bh = Math.max(3, (n / max) * hgt);
      g.fillStyle = n === max ? '#f2b33d' : 'rgba(242,179,61,' + (0.35 + 0.5 * n / max) + ')';
      g.fillRect(x, hgt - bh, bw, bh);
    }
    renderClipMarks();
  }

  function renderClipMarks() {
    const d = duration();
    const host = $('#seek-clips');
    host.replaceChildren();
    if (!d) return;
    S.highlights.filter(c => c.itemId === S.playback?.itemId).forEach(c => {
      host.append(h('span.clip-mark', { title: c.title, style: { left: (c.start / d * 100) + '%', width: Math.max(0.4, (c.end - c.start) / d * 100) + '%' } }));
    });
  }

  function showSeekTip(e, pos) {
    const tip = $('#seek-tip');
    const r = $('#seek').getBoundingClientRect();
    if (!duration()) { tip.hidden = true; return; }
    const cell = S.reactions.itemId === S.playback?.itemId ? S.reactions.buckets[Math.floor(pos / 5)] : null;
    const top = cell ? Object.entries(cell).sort((a, b) => b[1] - a[1])[0] : null;
    tip.textContent = fmt(pos) + (top ? `  ${top[0]} ×${top[1]}` : '');
    tip.style.left = Math.min(r.width - 40, Math.max(0, e.clientX - r.left)) + 'px';
    tip.hidden = false;
  }

  // ---------- the per-frame stuff: time, seek bar, countdown, captions ----------

  function frame() {
    requestAnimationFrame(frame);
    if (!S.playback) return;
    const d = duration();
    const a = sync.adapter;
    const pos = S.dragPos != null ? S.dragPos : (a && a.kind !== 'companion' && a.ready ? a.currentTime : sync.expected());
    $('#time').textContent = `${fmt(pos)} / ${fmt(d)}`;
    $('#seek-fill').style.width = d ? Math.min(100, pos / d * 100) + '%' : '0';
    $('#seek-thumb').style.left = d ? Math.min(100, pos / d * 100) + '%' : '0';
    if (a && a.el && a.el.buffered && a.el.buffered.length && d) {
      $('#seek-buffer').style.width = Math.min(100, a.el.buffered.end(a.el.buffered.length - 1) / d * 100) + '%';
    } else $('#seek-buffer').style.width = '0';
    const playing = S.playback.playing;
    $('#btn-play').classList.toggle('is-playing', playing);
    $('#btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');

    const cd = sync.countdown();
    const cdEl = $('#countdown');
    if (cd > 0 && S.playback.media) {
      cdEl.hidden = false;
      const n = String(Math.ceil(cd / 1000));
      if (cdEl.firstChild.textContent !== n) { cdEl.firstChild.textContent = n; cdEl.classList.remove('tick'); void cdEl.offsetWidth; cdEl.classList.add('tick'); }
    } else cdEl.hidden = true;

    if (S.playback.media && S.playback.media.kind === 'companion') {
      $('#comp-clock').textContent = longClock(sync.expected());
      $('#comp-state').textContent = cd > 0 ? `press play in ${Math.ceil(cd / 1000)}…` : playing ? 'playing' : 'paused';
      $('#comp-state').className = 'comp-state ' + (cd > 0 ? 'soon' : playing ? 'on' : '');
    }

    if (S.cues.length && S.ccTrack !== 'off') {
      const txt = cueAt(S.cues, pos);
      const box = $('#captions');
      if (box.textContent !== txt) box.textContent = txt;
    }

    if (S.intermission) {
      const left = Math.max(0, S.intermission.endsAt - net.serverNow());
      $('#im-clock').textContent = fmt(left / 1000);
    }
  }

  function longClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  // ---------- captions ----------

  function captionTracks() {
    const list = [];
    if (S.sharedCaptions && S.sharedCaptions.itemId === S.playback?.itemId) list.push({ id: 'room', label: `Shared by ${nameOf(S.sharedCaptions.by)} (${S.sharedCaptions.name})` });
    (S.playback?.media?.captions || []).forEach((c, i) => list.push({ id: 'm' + i, label: c.label + ' · ' + c.lang, src: c.src }));
    if (S._mineVtt) list.push({ id: 'mine', label: 'My file' });
    return list;
  }

  function renderCcList() {
    const list = captionTracks();
    const forced = S.settings.captionsForAll;
    $('#cc-list').replaceChildren(
      h('label.row-opt.chk', h('input', { type: 'radio', name: 'cc', checked: S.ccTrack === 'off', onchange: () => chooseTrack('off') }), ' Off'),
      ...list.map(t => h('label.row-opt.chk', h('input', { type: 'radio', name: 'cc', checked: S.ccTrack === t.id, onchange: () => chooseTrack(t.id) }), ' ' + t.label)),
      forced ? h('p.fine', 'The host has turned subtitles on for everyone. You can still switch them off for yourself.') : null,
      list.length ? null : h('p.fine', 'No subtitles came with this video. Load your own below.'));
  }

  async function chooseTrack(id) {
    S.ccTrack = id; S.ccChosen = true;
    $('#captions').textContent = '';
    if (id === 'off') { S.cues = []; return; }
    if (id === 'room') { S.cues = parseVtt(S.sharedCaptions.vtt); return; }
    if (id === 'mine') { S.cues = parseVtt(S._mineVtt); return; }
    const t = captionTracks().find(x => x.id === id);
    try {
      const text = await fetch(t.src).then(r => { if (!r.ok) throw new Error(); return r.text(); });
      if (S.ccTrack === id) S.cues = parseVtt(text);
    } catch (e) { toast('Couldn’t load those subtitles', 'bad'); }
  }

  function loadCaptionsText(text) {
    S._mineVtt = text;
    S.cues = parseVtt(text);
    autoCaptions();
  }

  // "captions together": host can force them on; shared files win
  function autoCaptions() {
    if (S.ccChosen) return;
    const tracks = captionTracks();
    if (S.settings.captionsForAll && tracks.length) chooseTrack(tracks[0].id).then(() => { S.ccChosen = false; });
    else if (!S.settings.captionsForAll) { S.ccTrack = 'off'; S.cues = []; $('#captions').textContent = ''; }
    $('#btn-cc').classList.toggle('on', S.ccTrack !== 'off');
  }

  // ---------- people ----------

  function renderRole() {
    document.body.classList.toggle('can-control', canControl());
    document.body.classList.toggle('is-host', isHost());
    $('#btn-settings').hidden = !isHost();
  }

  function statusOf(m) {
    if (!m.connected) return ['off', 'stepped out'];
    if (m.status.buffering) return ['buf', 'buffering'];
    if (!m.status.mediaReady) return ['wait', 'picking their file'];
    if (m.status.away) return ['away', 'tab in background'];
    return ['ok', 'watching'];
  }

  function renderPeople() {
    const box = $('#people');
    const list = [...S.members].sort((a, b) => (b.host - a.host) || (b.connected - a.connected) || a.joinedAt - b.joinedAt);
    const online = list.filter(m => m.connected).length;
    box.replaceChildren(
      h('span.people-count', `${online} here`),
      h('div.avatars', list.map(m => {
        const [cls, label] = statusOf(m);
        return h('button.avatar.st-' + cls, {
          style: { '--c': m.color }, title: `${m.name}${m.host ? ' (host)' : m.cohost ? ' (co-host)' : ''}: ${label}`,
          onclick: e => personMenu(m, e.currentTarget),
        }, initials(m.name), m.host ? h('span.crown', '♛') : m.cohost ? h('span.co', 'co') : null, m.id === S.me ? h('span.you', 'you') : null);
      })));
  }

  function personMenu(m, anchor) {
    const menu = $('#person-menu');
    const items = [];
    if (m.id === S.me) {
      items.push(h('button', { onclick: () => { const n = prompt('Your name', m.name); if (n) { net.request('rename', { name: n }); Identity.saveName(n); } close(); } }, 'Change my name'));
    } else if (isHost()) {
      if (m.connected) items.push(h('button', { onclick: () => { net.request('host:transfer', { to: m.id }); close(); } }, `Make ${m.name} the host`));
      items.push(h('button', { onclick: () => { net.request('host:cohost', { to: m.id, value: !m.cohost }); close(); } }, m.cohost ? 'Remove co-host' : 'Make co-host (can control playback)'));
    } else {
      items.push(h('p', `${m.name}${m.host ? ' is the host' : ''}`));
    }
    const r = anchor.getBoundingClientRect();
    menu.replaceChildren(...items);
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.left = Math.min(window.innerWidth - 240, r.left) + 'px';
    menu.hidden = false;
    function close() { menu.hidden = true; document.removeEventListener('pointerdown', outside, true); }
    function outside(e) { if (!menu.contains(e.target)) close(); }
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }

  function renderNowShowing() {
    const m = S.playback?.media;
    const el = $('#now-showing');
    if (!m) { el.replaceChildren(h('span.ns-label', 'Nothing on yet')); return; }
    el.replaceChildren(h('span.ns-label', 'Now showing'), h('span.ns-title', m.title), m.sourceLabel ? h('span.ns-src', m.sourceLabel) : null);
  }

  // ---------- chat ----------

  function msgEl(m) {
    if (m.kind === 'system') return h('div.msg.sys', m.text);
    const before = m.ts < S.joinedAt && !S.revealBefore;
    const sameItem = m.itemId && m.itemId === S.playback?.itemId;
    const time = m.itemId ? h('button.stamp', {
      title: sameItem ? 'Jump everyone to this moment' : 'From an earlier video',
      disabled: !sameItem,
      onclick: () => control('seek', { position: m.videoTime }),
    }, fmt(m.videoTime)) : null;
    const text = h('span.text' + (m.spoiler ? '.spoiler' : ''), { title: m.spoiler ? 'Spoiler, click to show' : null, onclick: e => e.currentTarget.classList.remove('spoiler') }, m.text);
    return h('div.msg' + (before ? '.before' : '') + (m.by === S.me ? '.mine' : ''),
      time, h('b.who', { style: { color: m.color } }, m.name), ' ', text);
  }

  function renderChatAll() {
    const log = $('#chat-log');
    log.replaceChildren(...S.chat.map(msgEl));
    log.scrollTop = log.scrollHeight;
    const before = S.chat.filter(m => m.kind === 'user' && m.ts < S.joinedAt).length;
    const cu = $('#catchup');
    cu.hidden = !before || S.revealBefore;
    cu.replaceChildren(
      h('span', `${before} message${before === 1 ? '' : 's'} from before you got here are blurred so nothing gets spoiled.`),
      h('button.link-btn', { onclick: () => { S.revealBefore = true; renderChatAll(); } }, 'Show them'));
  }

  function onChat(m) {
    S.chat.push(m);
    if (S.chat.length > 300) S.chat.shift();
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(msgEl(m));
    while (log.childElementCount > 300) log.firstChild.remove();
    if (atBottom || m.by === S.me) log.scrollTop = log.scrollHeight;
    if (m.kind === 'user' && m.by !== S.me && !$('[data-panel="chat"]').classList.contains('active')) $('[data-tab="chat"]').classList.add('ping');
  }

  // ---------- queue ----------

  function renderQueue() {
    const ol = $('#queue');
    $('#queue-count').textContent = S.queue.length || '';
    $('#queue-empty').hidden = !!S.queue.length;
    const ctl = canControl();
    ol.replaceChildren(...S.queue.map((q, i) => {
      const voted = q.votes.includes(S.me);
      return h('li.q-item',
        posterEl(q.media, 'q-poster'),
        h('div.q-text', h('b', q.media.title), h('span', `${q.media.sourceLabel || q.media.kind} · added by ${q.addedByName}`)),
        h('div.q-btns',
          h('button.vote' + (voted ? '.on' : ''), { title: voted ? 'Take back your vote' : 'I want this one', onclick: () => net.request('queue:vote', { id: q.id }) }, '▲ ' + q.votes.length),
          ctl ? h('button.mini', { title: 'Show it now', onclick: () => net.request('queue:play', { id: q.id }) }, '▶') : null,
          ctl && i > 0 ? h('button.mini', { title: 'Move up', onclick: () => net.request('queue:move', { id: q.id, dir: -1 }) }, '↑') : null,
          ctl && i < S.queue.length - 1 ? h('button.mini', { title: 'Move down', onclick: () => net.request('queue:move', { id: q.id, dir: 1 }) }, '↓') : null,
          ctl || q.addedBy === S.me ? h('button.mini', { title: 'Remove', onclick: () => net.request('queue:remove', { id: q.id }) }, '✕') : null));
    }));
  }

  // ---------- polls ----------

  function renderPolls() {
    const open = S.polls.filter(p => !p.closed).length;
    $('#poll-count').textContent = open || '';
    const box = $('#polls');
    box.replaceChildren(...[...S.polls].reverse().map(p => {
      const total = p.options.reduce((a, o) => a + o.votes.length, 0);
      const mine = p.options.find(o => o.votes.includes(S.me));
      const left = p.closesAt && !p.closed ? Math.max(0, Math.round((p.closesAt - net.serverNow()) / 1000)) : null;
      return h('div.poll' + (p.closed ? '.closed' : ''),
        h('div.poll-head', h('b', p.question), h('span.fine', p.closed ? 'closed' : left != null ? `${left}s left` : 'open')),
        h('div.poll-opts', p.options.map(o => {
          const pct = total ? Math.round(o.votes.length / total * 100) : 0;
          return h('button.p-opt' + (mine === o ? '.mine' : '') + (p.winner === o.id ? '.won' : ''), {
            disabled: p.closed, onclick: () => net.request('poll:vote', { pollId: p.id, optionId: o.id }),
          }, h('span.p-bar', { style: { width: pct + '%' } }), h('span.p-txt', o.text), h('span.p-n', `${o.votes.length} · ${pct}%`));
        })),
        h('div.poll-foot', h('span.fine', `by ${p.byName} · ${total} vote${total === 1 ? '' : 's'}`),
          !p.closed && (p.by === S.me || canControl()) ? h('button.link-btn', { onclick: () => net.request('poll:close', { pollId: p.id }) }, 'close it') : null));
    }));
  }

  // ---------- clips ----------

  function renderClips() {
    const box = $('#clips');
    if (!S.highlights.length) { box.replaceChildren(h('p.empty', 'No clips yet.')); renderClipMarks(); return; }
    box.replaceChildren(...[...S.highlights].reverse().map(c => {
      const here = c.itemId === S.playback?.itemId;
      return h('div.clip',
        h('div.clip-head', h('b', c.title), h('span.fine', `${fmt(c.start)}–${fmt(c.end)}`)),
        h('div.fine', `${c.media.title} · clipped by `, h('span', { style: { color: c.color } }, c.name)),
        h('div.clip-btns',
          here && canControl() ? h('button.btn.btn-small', { onclick: () => net.request('clip:play', { id: c.id }) }, 'Replay for everyone') : null,
          h('button.btn.btn-small.btn-ghost', { onclick: () => clipCard(c) }, 'Save as image'),
          c.by === S.me || isHost() ? h('button.link-btn', { onclick: () => net.request('clip:remove', { id: c.id }) }, 'delete') : null));
    }));
    renderClipMarks();
  }

  // a printable ticket-stub card for a clip (same idea as the share card in my CGPA site)
  function clipCard(c) {
    const W = 1080, H = 1350;
    const cv = h('canvas', { width: W, height: H });
    const g = cv.getContext('2d');
    g.fillStyle = '#f1e9db'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d9472b'; g.fillRect(0, 0, W, 210);
    g.fillStyle = '#f1e9db'; g.font = '110px Anton'; g.textBaseline = 'middle';
    g.fillText('BACK ROW', 70, 110);
    g.font = '600 34px "IBM Plex Mono"'; g.textAlign = 'right';
    g.fillText('ROOM ' + S.code, W - 70, 110);
    g.textAlign = 'left'; g.fillStyle = '#1b1817';
    g.font = '600 34px "IBM Plex Mono"'; g.fillText('A MOMENT FROM', 70, 330);
    wrapText(g, c.media.title.toUpperCase(), 70, 420, W - 140, 96, '96px Anton');
    g.strokeStyle = '#1b1817'; g.setLineDash([18, 14]); g.lineWidth = 4;
    g.beginPath(); g.moveTo(40, 760); g.lineTo(W - 40, 760); g.stroke(); g.setLineDash([]);
    g.font = '500 64px "Work Sans"';
    wrapText(g, '“' + c.title + '”', 70, 880, W - 140, 78, '500 64px "Work Sans"');
    g.font = '600 48px "IBM Plex Mono"'; g.fillStyle = '#d9472b';
    g.fillText(`${fmt(c.start)} → ${fmt(c.end)}`, 70, 1110);
    g.fillStyle = '#1b1817'; g.font = '400 36px "Work Sans"';
    g.fillText(`clipped by ${c.name} · ${new Date(c.ts).toLocaleDateString()}`, 70, 1200);
    const a = h('a', { download: `backrow-${c.title.replace(/\W+/g, '-').toLowerCase() || 'clip'}.png`, href: cv.toDataURL('image/png') });
    document.body.append(a); a.click(); a.remove();
  }

  function wrapText(g, text, x, y, maxW, lineH, font) {
    g.font = font;
    const words = text.split(' ');
    let line = '', lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y + lines * lineH); line = w; lines++; if (lines > 3) return; }
      else line = test;
    }
    g.fillText(line, x, y + lines * lineH);
  }

  // ---------- intermission ----------

  function renderIntermission() {
    const im = S.intermission;
    $('#intermission').hidden = !im;
    if (!im) return;
    const ready = im.ready.includes(S.me);
    $('#btn-im-ready').textContent = ready ? 'Wait, not yet' : 'I’m back';
    const online = S.members.filter(m => m.connected);
    $('#im-ready').replaceChildren(...online.map(m => h('span.avatar.sm' + (im.ready.includes(m.id) ? '.st-ok' : '.st-away'), { style: { '--c': m.color }, title: m.name }, initials(m.name))));
    $('#im-ready-line').textContent = `${im.ready.length} of ${online.length} back. We start again when the timer runs out or everyone’s here.`;
  }

  // ---------- sync health ----------

  function renderSync() {
    if (!sync) return;
    const lat = S.stats?.latency;
    $('#s-drift').textContent = S.playback?.playing && sync.adapter?.kind !== 'companion' ? Math.round(sync.drift * 1000) + ' ms' : '-';
    $('#s-rtt').textContent = net.clock.ready ? Math.round(net.clock.rtt) + ' ms' : '…';
    $('#s-p95').textContent = lat && lat.n ? Math.round(lat.p95) + ' ms' : (S.latency.length ? Math.round(percentile(S.latency, 95)) + ' ms' : '-');
    $('#s-p50').textContent = lat && lat.n ? Math.round(lat.p50) + ' ms' : '-';
    $('#s-p95').className = lat && lat.p95 > 250 ? 'bad' : '';
    $('#s-fixes').textContent = `Corrections on your side so far: ${sync.corrections.nudges} speed nudges, ${sync.corrections.seeks} jumps. Clock offset ${Math.round(net.clock.offset)} ms. ${lat && lat.n ? lat.n + ' latency samples.' : ''}`;
    $('#net-dot').className = 'net-dot ' + (net.state === 'connected' ? 'ok' : 'bad');
    $('#net-dot').title = net.state === 'connected' ? `Connected · ${Math.round(net.clock.rtt)} ms` : 'Reconnecting…';

    $('#sync-rows').replaceChildren(...S.members.filter(m => m.connected).map(m => {
      const [cls, label] = statusOf(m);
      const dms = Math.round((m.status.drift || 0) * 1000);
      return h('tr', h('td', { style: { color: m.color } }, m.name), h('td', m.status.rtt ? m.status.rtt + ' ms' : '-'),
        h('td' + (Math.abs(dms) > 500 ? '.bad' : ''), S.playback?.playing ? dms + ' ms' : '-'), h('td.fine', label));
    }));

    // drift chart, last 60 s
    const c = $('#drift-chart');
    if (!c.offsetParent) return;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = '#3a3330'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.fillStyle = 'rgba(217,71,43,0.12)';
    const lim = 0.5; // ±500 ms band = the requirement
    g.fillRect(0, 0, W, 2); g.fillRect(0, H - 2, W, 2);
    const log = sync.driftLog;
    if (log.length < 2) return;
    const t0 = performance.now() - 60_000;
    g.strokeStyle = '#3fa796'; g.lineWidth = 1.5;
    g.beginPath();
    log.forEach((p, i) => {
      const x = (p.t - t0) / 60_000 * W;
      const y = H / 2 - Math.max(-lim, Math.min(lim, p.d)) / lim * (H / 2 - 3);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
  }

  // ---------- notices, dialogs ----------

  let noticeTimer;
  function showNotice(text) {
    const n = $('#notice');
    n.textContent = text; n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 8000);
  }
  function hideNotice() { $('#notice').hidden = true; }

  function renderSettings() {
    $('#set-control').value = S.settings.controlMode;
    $('#set-buffer').checked = S.settings.waitForBuffering;
    $('#set-rewind').checked = S.settings.autoRewind;
    $('#set-cc').checked = S.settings.captionsForAll;
  }

  function showQr() {
    const link = location.origin + '/r/' + S.code;
    const q = VCQR.make(link);
    const c = $('#qr-canvas');
    const g = c.getContext('2d');
    const quiet = 3, cell = Math.floor(c.width / (q.size + quiet * 2));
    const off = Math.floor((c.width - cell * q.size) / 2);
    g.fillStyle = '#f1e9db'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1b1817';
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) g.fillRect(off + x * cell, off + y * cell, cell, cell);
    $('#qr-link').textContent = link.replace(/^https?:\/\//, '');
    openDialog('#dlg-qr');
  }

  async function showRecap() {
    const body = $('#recap-body');
    body.replaceChildren(h('p', 'Counting…'));
    openDialog('#dlg-recap');
    try {
      const r = await fetch(`/api/rooms/${S.code}/recap`).then(x => x.json());
      body.replaceChildren(
        h('h3', 'Tonight so far'),
        h('ul.recap',
          h('li', h('b', r.minutes + ' min'), ' together, ', h('b', r.people + ''), ' people'),
          r.watched.length ? h('li', 'Watched: ', r.watched.join(', ')) : null,
          r.hype ? h('li', 'Loudest moment: ', h('b', fmt(r.hype.time)), ` (${r.hype.total} reactions, mostly ${r.hype.emoji})`) : null,
          r.topReactor ? h('li', 'Most reactions: ', h('b', r.topReactor.name), ` (${r.topReactor.count})`) : null,
          r.topChatter ? h('li', 'Talked the most: ', h('b', r.topChatter.name), ` (${r.topChatter.count} messages)`) : null,
          r.emoji.length ? h('li', 'Top reactions: ', r.emoji.map(([e, n]) => `${e} ${n}`).join('  ')) : null,
          h('li', `${r.clips} clip${r.clips === 1 ? '' : 's'} saved`)));
    } catch (e) { body.replaceChildren(h('p', 'Couldn’t load the recap.')); }
  }

  // ---------- side panel tabs & forms ----------

  function bindPanels() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.toggle('active', x === t));
      $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === t.dataset.tab));
      t.classList.remove('ping');
      if (t.dataset.tab === 'chat') { const log = $('#chat-log'); log.scrollTop = log.scrollHeight; }
    }));

    let lastTyping = 0;
    $('#chat-input').addEventListener('input', () => {
      if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); net.send('typing'); }
    });
    $('#chat-form').onsubmit = async e => {
      e.preventDefault();
      const inp = $('#chat-input');
      const text = inp.value.trim();
      if (!text) return;
      if (/^\/poll\s+/i.test(text)) {
        const [q, ...opts] = text.replace(/^\/poll\s+/i, '').split('|').map(s => s.trim());
        const r = await net.request('poll:create', { question: q, options: opts, durationSec: 60 });
        if (!r.ok) toast('Try: /poll Question | option 1 | option 2');
        inp.value = '';
        return;
      }
      inp.value = '';
      const r = await net.request('chat', { text });
      if (!r.ok) { inp.value = text; toast(r.error === 'slow-down' ? 'Slow down a little' : 'Message didn’t send', 'bad'); }
    };

    $('#poll-add').onclick = () => {
      const n = $$('.poll-opt').length;
      if (n >= 6) return;
      $('#poll-opts').append(h('input.poll-opt', { maxlength: 80, placeholder: 'Option ' + (n + 1) }));
    };
    $('#poll-form').onsubmit = async e => {
      e.preventDefault();
      const r = await net.request('poll:create', {
        question: $('#poll-q').value, options: $$('.poll-opt').map(i => i.value), durationSec: +$('#poll-dur').value,
      });
      if (!r.ok) return toast(r.error === 'too-many-polls' ? 'Close a poll first, three at a time max' : 'Needs a question and two options');
      $('#poll-q').value = '';
      $$('.poll-opt').forEach((i, k) => { if (k > 1) i.remove(); else i.value = ''; });
    };
    $('#btn-queue-poll').onclick = async () => {
      const r = await net.request('poll:create', { fromQueue: true, durationSec: 60 });
      if (!r.ok) toast(r.error === 'need-two-in-queue' ? 'Put at least two things in the queue first' : 'Couldn’t start a vote');
      else $('[data-tab="polls"]').click();
    };
    $('#btn-queue-sort').onclick = () => net.request('queue:sort');

    setInterval(() => { if (S.polls.some(p => !p.closed && p.closesAt)) renderPolls(); }, 1000);
    window.addEventListener('resize', renderHeat);
  }

  // ---------- server events ----------

  function bindNet() {
    net.on('playback', pb => onPlayback(pb, false));
    net.on('members', list => {
      const wasCtl = canControl();
      S.members = list;
      renderPeople();
      renderIntermission();
      if (wasCtl !== canControl()) { renderRole(); renderQueue(); renderClips(); }
    });
    net.on('host', ({ hostId }) => {
      const had = isHost();
      S.hostId = hostId;
      renderRole(); renderQueue(); renderClips();
      if (!had && isHost()) toast('You’re the host now. You’ve got the remote.', 'good');
    });
    net.on('settings', s => {
      const ccChanged = s.captionsForAll !== S.settings.captionsForAll;
      S.settings = s;
      renderRole(); renderQueue(); renderClips();
      if (ccChanged) { S.ccChosen = false; autoCaptions(); toast(s.captionsForAll ? 'Subtitles are on for everyone' : 'Subtitles are up to you again'); }
    });
    net.on('queue', q => { S.queue = q; renderQueue(); });
    net.on('polls', p => { S.polls = p; renderPolls(); });
    net.on('chat', onChat);
    net.on('typing', ({ name }) => {
      const t = $('#typing');
      t.textContent = `${name} is typing…`;
      clearTimeout(S._typingT);
      S._typingT = setTimeout(() => { t.textContent = ''; }, 2500);
    });
    net.on('reaction', onReaction);
    net.on('reactions', r => { S.reactions = r; renderHeat(); });
    net.on('highlights', list => { S.highlights = list; renderClips(); });
    net.on('captions', c => {
      S.sharedCaptions = c;
      if (c && c.by !== S.me) { S.ccChosen = false; S.ccTrack = 'room'; S.cues = parseVtt(c.vtt); toast(`${nameOf(c.by)} turned on subtitles for everyone`); }
    });
    net.on('intermission', im => { const was = !!S.intermission; S.intermission = im; renderIntermission(); if (was && !im) toast('Intermission’s over'); });
    net.on('rewind', r => {
      const el = $('#rewind-meter');
      if (r.fired) { el.textContent = ''; return; }
      el.textContent = r.count ? `${r.names.join(', ')} missed that (${r.count}/${r.need} to rewind)` : '';
      clearTimeout(S._rwT);
      S._rwT = setTimeout(() => { el.textContent = ''; }, 20000);
    });
    net.on('notice', n => showNotice(n.text));
    net.on('taste', t => { S.taste = t; Discover.refreshRecs(); });
    net.on('stats', s => { S.stats = s; });
    net.on('rejoined', snap => { applySnapshot(snap, false); toast('Back in, everything’s caught up', 'good'); });
    net.on('net', st => {
      if (st === 'reconnecting') showNotice('Lost the connection, trying again…');
      else hideNotice();
    });
  }

  window.Room = { enter, canControl };
})();
