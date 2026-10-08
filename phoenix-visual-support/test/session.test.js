const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { io } = require('socket.io-client');
const { server } = require('../server');

let base;
const clients = [];

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

function client() {
  const socket = io(base, { reconnection: false, transports: ['websocket'] });
  clients.push(socket);
  return socket;
}

function event(socket, name, timeout = 2000) {
  return Promise.race([
    new Promise((resolve) => socket.once(name, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), timeout)),
  ]);
}

test('customer link cannot join as technician; PHXQ technician link joins the same session', async () => {
  const response = await fetch(`${base}/api/create-session`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json();
  assert.match(session.sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(session.link, `/join/${session.sessionId}`);
  const tech = new URL(session.technicianUrl, base);
  assert.equal(tech.searchParams.get('session'), session.sessionId);
  assert.equal(new URLSearchParams(tech.hash.slice(1)).get('techToken'), session.technicianToken);
  assert.equal((await fetch(`${base}${session.link}`)).status, 200);

  const stranger = client();
  await event(stranger, 'connect');
  const denied = event(stranger, 'join-error');
  stranger.emit('join-session', { sessionId: session.sessionId, role: 'technician', technicianToken: 'wrong' });
  assert.match((await denied).message, /denied/);

  const customer = client();
  await event(customer, 'connect');
  const customerJoined = event(customer, 'session-joined');
  customer.emit('join-session', { sessionId: session.sessionId, role: 'customer' });
  await customerJoined;

  const technician = client();
  await event(technician, 'connect');
  const joined = event(customer, 'peer-joined');
  technician.emit('join-session', {
    sessionId: session.sessionId,
    role: 'technician',
    technicianToken: session.technicianToken,
  });
  assert.equal((await joined).role, 'technician');

  let unauthorizedPointer = false;
  customer.once('pointer-show', () => { unauthorizedPointer = true; });
  stranger.emit('pointer-show', { sessionId: session.sessionId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(unauthorizedPointer, false);

  const pointer = event(customer, 'pointer-show');
  technician.emit('pointer-show', { sessionId: session.sessionId });
  await pointer;

  const offer = event(technician, 'offer');
  customer.emit('offer', { sessionId: session.sessionId, offer: { type: 'offer', sdp: 'test' } });
  assert.equal((await offer).offer.sdp, 'test');
});
