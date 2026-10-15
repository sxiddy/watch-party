/*
 * sync-core.js — the shared synchronization math.
 *
 * Loaded by the browser (window.SyncCore) AND by Node (require) so that the
 * server, the unit tests, the drift simulator and the real client all run the
 * exact same algorithm.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tunables. Documented in docs/LATENCY.md.
  const DRIFT = {
    DEADBAND: 0.04,      // |drift| below 40 ms → do nothing
    SOFT_MAX: 0.40,      // 40–400 ms → nudge playbackRate
    GAIN: 0.9,           // rate correction per second of drift
    MAX_RATE_DELTA: 0.06,// at most 6 % faster/slower; past ~5 % voices start to sound off
    HYSTERESIS: 0.02,    // stop nudging once within 20 ms
  };

  /**
   * Where should the video be right now?
   * Playback state is stored as an anchor: "at serverTime baseTime the
   * position was basePos, moving at `rate` if playing". baseTime may be in
   * the future (countdown start) — then we hold at basePos.
   */
  function expectedPosition(pb, serverNow) {
    if (!pb) return 0;
    let pos = pb.basePos || 0;
    if (pb.playing) {
      const elapsed = Math.max(0, serverNow - pb.baseTime) / 1000;
      pos += elapsed * (pb.rate || 1);
    }
    if (pb.duration && pb.duration > 0) pos = Math.min(pos, pb.duration);
    return Math.max(0, pos);
  }

  /** ms until a scheduled (countdown) start, or 0. */
  function countdownRemaining(pb, serverNow) {
    if (!pb || !pb.playing) return 0;
    return Math.max(0, pb.baseTime - serverNow);
  }

  /**
   * NTP-style clock sync. Keeps the last N samples and trusts the one with
   * the smallest round-trip time (least queueing noise).
   */
  class ClockSync {
    constructor(opts = {}) {
      this.maxSamples = opts.maxSamples || 10;
      this.samples = [];
      this.offset = 0;   // serverTime - localTime (ms)
      this.rtt = 0;
      this.now = opts.now || (() => Date.now());
    }
    addSample(t0, serverTs, t1) {
      const rtt = t1 - t0;
      if (!(rtt >= 0) || !isFinite(serverTs)) return;
      const offset = serverTs - (t0 + t1) / 2;
      this.samples.push({ rtt, offset });
      if (this.samples.length > this.maxSamples) this.samples.shift();
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.offset = best.offset;
      // Report the median RTT (more honest than the best one)
      const sorted = this.samples.map(s => s.rtt).sort((a, b) => a - b);
      this.rtt = sorted[Math.floor(sorted.length / 2)];
    }
    serverNow() { return this.now() + this.offset; }
    get ready() { return this.samples.length >= 3; }
  }

  /**
   * Decides how to correct a player that is `drift` seconds off
   * (positive = ahead of where it should be).
   * Returns { action: 'none' | 'rate' | 'seek', rate, target }.
   */
  class DriftController {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, DRIFT, opts);
      this.correcting = false;
      this.seekLead = 0; // learned seek latency (s), added to seek targets
    }
    decide(actual, expected, playing, allowRate = true) {
      const drift = actual - expected;
      const abs = Math.abs(drift);
      const c = this.cfg;
      if (!playing) {
        this.correcting = false;
        return abs > 0.15 ? { action: 'seek', rate: 1, target: expected, drift } : { action: 'none', rate: 1, drift };
      }
      // players that can't do fine speed changes (YouTube only has 0.25 steps): seek-only
      if (!allowRate) {
        return abs > 0.3 ? { action: 'seek', rate: 1, target: expected + this.seekLead, drift } : { action: 'none', rate: 1, drift };
      }
      if (abs > c.SOFT_MAX) {
        this.correcting = false;
        return { action: 'seek', rate: 1, target: expected + this.seekLead, drift };
      }
      const threshold = this.correcting ? c.HYSTERESIS : c.DEADBAND;
      if (abs <= threshold) {
        this.correcting = false;
        return { action: 'none', rate: 1, drift };
      }
      this.correcting = true;
      const delta = Math.max(-c.MAX_RATE_DELTA, Math.min(c.MAX_RATE_DELTA, drift * c.GAIN));
      return { action: 'rate', rate: +(1 - delta).toFixed(3), drift };
    }
    /** Learn how long seeks take so we can aim ahead (EMA). */
    recordSeekDuration(seconds) {
      if (!(seconds >= 0) || seconds > 3) return;
      this.seekLead = this.seekLead * 0.6 + seconds * 0.4;
    }
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  return { DRIFT, expectedPosition, countdownRemaining, ClockSync, DriftController, percentile, formatTime };
});
