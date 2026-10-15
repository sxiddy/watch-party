// Real server, real sockets: 12 people in one room. Slower (~15 s).
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../bench/latency');

test('12 viewers: propagation p95 ≤ 250 ms, clashes resolve the same for everyone, reconnects recover', { timeout: 120_000 }, async () => {
  const r = await run({ viewers: 12, ops: 60, delay: 0, jitter: 0 });
  assert.equal(r.samples, r.expected, 'every viewer got every change');
  assert.ok(r.p95 <= 250, `p95 was ${r.p95} ms`);
  assert.ok(r.concurrent.allViewersAgreeOnFinalVersion);
  assert.ok(r.concurrent.rejectedAsConflict > 0, 'simultaneous seeks were detected');
  assert.equal(r.reconnect.cameBackWithCorrectState, r.reconnect.dropped);
});
