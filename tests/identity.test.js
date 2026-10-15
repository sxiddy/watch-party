// Knowing someone's public id (it's in every member list) must not let you
// rejoin as them. Real server, real sockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { server, createRoom } = require('../server/index');

test('rejoining with a public id does not take over that person', async () => {
  await new Promise(r => server.listen(0, r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const code = createRoom().code;
  const sockets = [];
  const join = async (secret, name) => {
    const s = ioc(url, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise(r => s.once('connect', r));
    return new Promise(r => s.emit('join', { code, clientId: secret, name }, r));
  };
  try {
    const host = await join('host-secret-0123456789', 'Host');
    assert.ok(host.ok);
    assert.notEqual(host.snapshot.you, 'host-secret-0123456789', 'secret is never shown');
    const hostPublicId = host.snapshot.you;
    const guest = await join('guest-secret-0123456789', 'Guest');
    assert.equal(guest.snapshot.hostId, hostPublicId);

    const fake = await join(hostPublicId.padEnd(16, 'x'), 'Impostor');
    assert.ok(fake.ok);
    assert.notEqual(fake.snapshot.you, hostPublicId, 'got a new identity, not the host');

    const again = await join('host-secret-0123456789', 'Host');
    assert.equal(again.snapshot.you, hostPublicId, 'the real host still gets back in as themselves');
    assert.equal((await join('short', 'x')).error, 'bad-id');
  } finally {
    sockets.forEach(s => s.close());
    await new Promise(r => server.close(r));
  }
});

test('one socket cannot pile up ghost members by switching identity', async () => {
  await new Promise(r => server.listen(0, r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const room = createRoom();
  const s = ioc(url, { transports: ['websocket'], forceNew: true });
  try {
    await new Promise(r => s.once('connect', r));
    const join = secret => new Promise(r => s.emit('join', { code: room.code, clientId: secret, name: 'x' }, r));
    assert.ok((await join('first-secret-0123456789')).ok);
    assert.equal((await join('second-secret-012345678')).error, 'already-joined');
    assert.ok((await join('first-secret-0123456789')).ok, 'rejoining as yourself is fine');
    let last;
    for (let i = 0; i < 6; i++) last = await join('first-secret-0123456789');
    assert.equal(last.error, 'slow-down', 'join itself is rate limited');
    assert.equal(room.connectedMembers().length, 1);
    s.close();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(room.connectedMembers().length, 0, 'nobody left behind');
  } finally {
    s.close();
    await new Promise(r => server.close(r));
  }
});
