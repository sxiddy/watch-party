// Connection to the room server: socket.io + clock sync + a watchdog.
// The reconnect/watchdog idea comes from Mirrorbound's WebSocketClient:
// a socket that's "open" but silent is treated as dead and replaced.
(function () {
  const { ClockSync } = window.SyncCore;

  const SILENCE_MS = 9000;

  function storage(kind) {
    try { const s = window[kind]; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch { return null; }
  }
  const tabStore = storage('sessionStorage');
  const longStore = storage('localStorage');

  // One identity per tab, so two tabs = two people (handy for testing),
  // and a refresh keeps you as the same person.
  function clientId() {
    let id = tabStore && tabStore.getItem('br.id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 20);
      tabStore && tabStore.setItem('br.id', id);
    }
    return id;
  }
  const savedName = () => (longStore && longStore.getItem('br.name')) || '';
  const saveName = n => longStore && longStore.setItem('br.name', n);

  class Net {
    constructor() {
      this.clock = new ClockSync({ maxSamples: 12 });
      this.handlers = {};
      this.id = clientId();
      this.state = 'idle';
      this.lastHeard = 0;
      this.joinInfo = null;
    }

    on(ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); return this; }
    fire(ev, data) { (this.handlers[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(ev, e); } }); }

    connect() {
      if (this.socket) return;
      this.socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 4000 });
      const s = this.socket;
      s.on('connect', () => {
        this.setState('connected');
        this.lastHeard = Date.now();
        this.burstSync();
        if (this.joined && this.joinInfo) this.join(this.joinInfo.code, this.joinInfo.name, true);
      });
      s.on('disconnect', () => this.setState('reconnecting'));
      s.io.on('reconnect_attempt', () => this.setState('reconnecting'));
      s.onAny((ev, data) => {
        this.lastHeard = Date.now();
        this.fire(ev, data);
      });
      clearInterval(this._ping);
      this._ping = setInterval(() => this.ping(), 3000);
      clearInterval(this._dog);
      this._dog = setInterval(() => {
        if (s.connected && Date.now() - this.lastHeard > SILENCE_MS) {
          console.warn('socket went quiet, reconnecting');
          s.disconnect();
          s.connect();
        }
      }, 2000);
    }

    setState(st) { if (st !== this.state) { this.state = st; this.fire('net', st); } }

    ping() {
      if (!this.socket || !this.socket.connected) return Promise.resolve();
      return new Promise(resolve => {
        const t0 = Date.now();
        const timer = setTimeout(resolve, 3000);
        this.socket.emit('tp', serverTs => {
          clearTimeout(timer);
          this.lastHeard = Date.now();
          this.clock.addSample(t0, serverTs, Date.now());
          resolve();
        });
      });
    }

    // a handful of quick pings right after connecting gives a good offset fast
    async burstSync() {
      for (let i = 0; i < 6; i++) { await this.ping(); await new Promise(r => setTimeout(r, 80)); }
      this.fire('clock', this.clock);
    }

    request(ev, payload, timeout = 6000) {
      return new Promise(resolve => {
        if (!this.socket || !this.socket.connected) return resolve({ ok: false, error: 'offline' });
        const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeout);
        this.socket.emit(ev, payload, res => { clearTimeout(timer); resolve(res || { ok: false }); });
      });
    }

    send(ev, payload) { if (this.socket && this.socket.connected) this.socket.emit(ev, payload); }

    async join(code, name, rejoin = false) {
      this.joinInfo = { code, name };
      const res = await this.request('join', { code, name, clientId: this.id });
      if (res.ok) { this.joined = true; this.fire(rejoin ? 'rejoined' : 'joined', res.snapshot); }
      else this.fire('join-failed', res.error);
      return res;
    }

    serverNow() { return this.clock.serverNow(); }
  }

  window.Net = Net;
  window.Identity = { savedName, saveName, clientId };
})();
