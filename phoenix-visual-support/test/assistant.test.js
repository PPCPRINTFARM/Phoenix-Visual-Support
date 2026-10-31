const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { io } = require('socket.io-client');

process.env.RETELL_AGENT_ID = 'agent_test';
process.env.RETELL_TOOL_SECRET = 'tool-secret';
process.env.MEDIA_ALLOWED_HOSTS = 'phoenixphaseconverters.com, youtube.com';
const { server, assistantOptions } = require('../server');

let base;
const clients = [];
const seen = [];

before(async () => {
  assistantOptions.createWebCall = async (body) => ({ call_id: `call_${seen.length}`, access_token: 'tok', body });
  assistantOptions.describeImage = async (b64, question) => { seen.push({ b64, question }); return 'A rotary phase converter with a tripped breaker.'; };
  assistantOptions.mediaLibrary = [
    { id: 'wiring', title: 'Wiring diagram', url: 'https://example.com/wiring.png' },
    { id: 'local', title: 'Local diagram', url: '/media/diagrams/pl-ph-connection.jpg' },
  ];
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

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const tool = (name, callId, args) => post(`/api/retell/tools/${name}`, { call: { call_id: callId }, name, args }, { 'x-phoenix-tool-secret': 'tool-secret' });

test('Retell agent can look through the customer camera and show media', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/retell/status`)).json(), { enabled: true });
  const session = await (await fetch(`${base}/api/create-session`)).json();

  // No web call until the customer is actually on the page.
  assert.equal((await post('/api/retell/web-call', { sessionId: session.sessionId })).status, 404);

  const customer = client();
  await event(customer, 'connect');
  const joined = event(customer, 'session-joined');
  customer.emit('join-session', { sessionId: session.sessionId, role: 'customer' });
  await joined;
  customer.on('ai-capture-frame', (ack) => ack({ data: 'data:image/jpeg;base64,QUJD' }));

  const res = await post('/api/retell/web-call', { sessionId: session.sessionId });
  assert.equal(res.status, 200);
  const { accessToken, callId } = await res.json();
  assert.equal(accessToken, 'tok');

  // Unsigned tool calls are refused.
  const unsigned = await post('/api/retell/tools/look', { call: { call_id: callId }, args: {} });
  assert.equal(unsigned.status, 401);

  // Unknown calls cannot reach any session.
  const stray = await (await tool('look', 'call_unknown', {})).json();
  assert.match(stray.result, /not linked/);
  assert.equal(seen.length, 0);

  const look = await (await tool('look', callId, { question: 'Is the breaker tripped?' })).json();
  assert.match(look.result, /tripped breaker/);
  assert.deepEqual(seen[0], { b64: 'QUJD', question: 'Is the breaker tripped?' });

  const shown = event(customer, 'show-media');
  await tool('show', callId, { media_id: 'wiring' });
  assert.deepEqual(await shown, { kind: 'image', url: 'https://example.com/wiring.png', embedUrl: null, title: 'Wiring diagram', caption: '' });

  const localShown = event(customer, 'show-media');
  await tool('show', callId, { media_id: 'local' });
  assert.equal((await localShown).url, '/media/diagrams/pl-ph-connection.jpg');
  assert.equal((await fetch(`${base}/media/diagrams/pl-ph-connection.jpg`)).status, 200);

  const relative = await (await tool('show', callId, { url: '/media/diagrams/pl-ph-connection.jpg' })).json();
  assert.match(relative.result, /not valid/);

  const blocked = await (await tool('show', callId, { url: 'https://evil.example/x' })).json();
  assert.match(blocked.result, /approved list/);

  const video = event(customer, 'show-media');
  await tool('show', callId, { url: 'https://www.youtube.com/watch?v=abc123', title: 'Start-up' });
  const shownVideo = await video;
  assert.equal(shownVideo.kind, 'video');
  assert.equal(shownVideo.embedUrl, 'https://www.youtube-nocookie.com/embed/abc123?autoplay=1&playsinline=1');

  const cleared = event(customer, 'hide-media');
  await tool('clear', callId, {});
  await cleared;
});
