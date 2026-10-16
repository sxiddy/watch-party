// Front door + routing. "/" is the landing page, "/r/CODE" is a room.
(function () {
  const { $, toast, openDialog } = window.UI;
  const net = new Net();
  let entering = false;

  // The free server sleeps when nobody's around and takes up to a minute to wake.
  // Poke it as soon as the page opens, and say so if it's slow, instead of
  // letting the first click look broken.
  if (window.BR_SERVER) {
    let awake = false;
    const slow = setTimeout(() => { if (!awake) toast('Waking the server up. Free hosting naps, give it up to a minute.'); }, 2500);
    fetch(apiUrl('/api/health')).then(() => { awake = true; clearTimeout(slow); }).catch(() => {});
  }

  function codeFromPath() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})/);
    return m ? m[1].toUpperCase() : null;
  }

  function showLanding(err) {
    $('#landing').hidden = false;
    $('#room').hidden = true;
    document.body.classList.remove('in-room');
    $('#land-name').value = Identity.savedName();
    $('#land-error').textContent = err || '';
    Discover.landingStrip($('#land-posters'));
  }

  async function goToRoom(code, name) {
    if (entering) return;
    entering = true;
    Identity.saveName(name);
    net.connect();
    if (net.state !== 'connected') await new Promise(r => net.on('net', st => st === 'connected' && r()));
    const res = await net.join(code, name);
    entering = false;
    if (!res.ok) {
      history.replaceState(null, '', '/');
      const why = { 'not-found': 'That room doesn’t exist, or everyone left a while ago. Start a new one?', 'room-full': 'That room is full (50 people).', removed: 'The host removed you from that room.', locked: 'The host has locked that room.', 'slow-down': 'Too many tries, give it a minute.', offline: 'Can’t reach the server right now.' }[res.error] || 'Couldn’t join (' + res.error + ')';
      showLanding(why);
      return;
    }
    try { sessionStorage.setItem('br.room', code); } catch (e) { /* private mode */ }
    $('#landing').hidden = true;
    $('#room').hidden = false;
    Room.enter(net, res.snapshot);
  }

  function askName(code) {
    return new Promise(resolve => {
      const d = openDialog('#dlg-name');
      const input = $('#name-input');
      input.value = Identity.savedName();
      fetch(apiUrl('/api/rooms/' + code)).then(r => r.json()).then(info => {
        $('#name-room-line').textContent = info.exists
          ? `${info.host || 'Someone'} invited you to room ${code}${info.nowShowing ? `, now showing ${info.nowShowing}` : ''}. ${info.people} here so far.`
          : `Room ${code} doesn’t seem to exist any more.`;
      }).catch(() => {});
      $('#name-form').onsubmit = e => {
        e.preventDefault();
        const n = input.value.trim();
        if (!n) return;
        d.close();
        resolve(n);
      };
      d.addEventListener('cancel', e => e.preventDefault(), { once: true });
      setTimeout(() => input.focus(), 50);
    });
  }

  // landing page buttons
  $('#btn-create').onclick = async () => {
    const name = $('#land-name').value.trim();
    if (!name) { $('#land-name').focus(); $('#land-error').textContent = 'Put a name in first, so your friends know who you are.'; return; }
    $('#btn-create').disabled = true;
    try {
      const r = await fetch(apiUrl('/api/rooms'), { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      history.pushState(null, '', '/r/' + data.code);
      await goToRoom(data.code, name);
    } catch (e) {
      $('#land-error').textContent = 'Couldn’t make a room: ' + e.message;
    } finally {
      $('#btn-create').disabled = false;
    }
  };

  $('#join-form').onsubmit = async e => {
    e.preventDefault();
    const code = $('#land-code').value.trim().toUpperCase();
    const name = $('#land-name').value.trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) { $('#land-error').textContent = 'Room codes are 6 letters/numbers.'; return; }
    if (!name) { $('#land-name').focus(); $('#land-error').textContent = 'Put a name in first.'; return; }
    history.pushState(null, '', '/r/' + code);
    goToRoom(code, name);
  };
  $('#land-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  window.addEventListener('popstate', () => { if (!codeFromPath()) location.reload(); });

  net.on('join-failed', err => {
    if ($('#room').hidden || !['not-found', 'removed', 'locked'].includes(err)) return; // other errors: the next reconnect tries again
    try { sessionStorage.removeItem('br.room'); } catch (e) { /* fine */ }
    location.replace(err === 'not-found' ? '/?ended' : '/?removed');
  });

  net.on('kicked', () => {
    try { sessionStorage.removeItem('br.room'); } catch (e) { /* fine */ }
    location.replace('/?removed');
  });

  // boot
  const code = codeFromPath();
  let lastRoom = null;
  try { lastRoom = sessionStorage.getItem('br.room'); } catch (e) { /* fine */ }
  if (code && code === lastRoom && Identity.savedName()) {
    // a refresh: you already said who you are in this tab
    goToRoom(code, Identity.savedName());
  } else if (code) {
    // the click on "Take me in" also counts as the gesture browsers need before playing sound
    askName(code).then(name => goToRoom(code, name));
  } else {
    showLanding(/[?&]removed/.test(location.search) ? 'The host removed you from that room.' : /[?&]ended/.test(location.search) ? 'That room ended (the server restarted). Start a new one?' : '');
    if (location.search) history.replaceState(null, '', '/');
  }
})();
