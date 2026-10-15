#!/usr/bin/env node
// Drift-correction simulator.
//
// Runs the exact DriftController the browser uses against fake players that
// misbehave the way real ones do:
//   * their clocks run 0.5–3 % fast or slow (cheap laptops, throttled tabs)
//   * they stall now and then (buffering for 0.3–2.5 s)
//   * seeks take 80–450 ms to land
//   * their idea of "server time" is off by up to ±15 ms (clock-sync error)
//   * the 250 ms check loop itself jitters
// Then measures how far each player is from the room, ignoring the stall
// itself and the 3 seconds after it (the time correction is allowed to take).
//
//   node bench/drift-sim.js [--players 12] [--minutes 20] [--seed 7]

const { DriftController, percentile } = require('../public/js/sync-core');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const PLAYERS = arg('players', 12), MINUTES = arg('minutes', 20);
let seed = arg('seed', 7);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const between = (a, b) => a + rnd() * (b - a);

function simulate(allowRate) {
  const dt = 0.05; // 50 ms physics step
  const players = Array.from({ length: PLAYERS }, () => ({
    pos: 0, clockErr: between(-0.03, 0.03), offsetErr: between(-0.015, 0.015),
    rate: 1, stallUntil: -1, seekLandsAt: -1, seekTarget: 0, seekStart: 0, nextCheck: between(0, 0.25),
    settleUntil: 0, ctl: new DriftController(), drift: [], raw: [],
  }));
  const T = MINUTES * 60;
  let worstSettled = 0;
  for (let t = 0; t < T; t += dt) {
    const truth = t; // room position (playing from 0 at t=0)
    for (const p of players) {
      // physics
      if (t < p.stallUntil) { /* frozen */ }
      else if (p.seekLandsAt > 0) {
        if (t >= p.seekLandsAt) { p.pos = p.seekTarget; p.ctl.recordSeekDuration(p.seekLandsAt - p.seekStart); p.seekLandsAt = -1; }
      } else p.pos += dt * p.rate * (1 + p.clockErr);

      // random stall: about once every 3 minutes per player
      if (t > p.stallUntil && rnd() < dt / 180) { p.stallUntil = t + between(0.3, 2.5); p.settleUntil = p.stallUntil + 3; }

      // the sync loop: every ~250 ms (with jitter), skip while seeking/stalled
      if (t >= p.nextCheck) {
        p.nextCheck = t + between(0.2, 0.3);
        if (t >= p.stallUntil && p.seekLandsAt < 0) {
          const expected = truth + p.offsetErr;
          const d = p.ctl.decide(p.pos, expected, true, allowRate);
          if (d.action === 'seek') {
            p.seekStart = t; p.seekLandsAt = t + between(0.08, 0.45);
            p.seekTarget = d.target;
            p.rate = 1;
          } else p.rate = d.rate;
        }
      }
      const err = Math.abs(p.pos - truth);
      if (t > 5 && t > p.settleUntil) {
        p.raw.push(err); // includes the moments a corrective seek is still landing
        if (p.seekLandsAt < 0) { p.drift.push(err); worstSettled = Math.max(worstSettled, err); }
      }
    }
  }
  const all = players.flatMap(p => p.drift);
  const raw = players.flatMap(p => p.raw);
  const over = all.filter(x => x > 0.5).length;
  return {
    mode: allowRate ? 'rate nudging + seek (HTML5 video)' : 'seek only (YouTube)',
    players: PLAYERS, minutes: MINUTES, samples: all.length,
    p50ms: +(percentile(all, 50) * 1000).toFixed(1), p95ms: +(percentile(all, 95) * 1000).toFixed(1),
    p99ms: +(percentile(all, 99) * 1000).toFixed(1), maxMs: +(worstSettled * 1000).toFixed(1),
    over500msPct: +(over / all.length * 100).toFixed(3),
    inFlight: { p99ms: +(percentile(raw, 99) * 1000).toFixed(1), maxMs: +(raw.reduce((m, x) => (x > m ? x : m), 0) * 1000).toFixed(1) },
  };
}

const a = simulate(true), b = simulate(false);
for (const r of [a, b]) {
  console.log(`\n${r.mode}: ${r.players} players × ${r.minutes} min`);
  console.log(`after correction: drift p50 ${r.p50ms} ms · p95 ${r.p95ms} ms · p99 ${r.p99ms} ms · max ${r.maxMs} ms · time over 500 ms: ${r.over500msPct}%`);
  console.log(`counting the instant a corrective seek is still landing: p99 ${r.inFlight.p99ms} ms · max ${r.inFlight.maxMs} ms`);
  console.log(r.maxMs <= 500 ? 'PASS: drift stays ≤ 500 ms after correction' : 'FAIL: drift went over 500 ms after correction');
}
if (process.argv.includes('--json')) console.log(JSON.stringify([a, b], null, 2));
module.exports = { simulate };
