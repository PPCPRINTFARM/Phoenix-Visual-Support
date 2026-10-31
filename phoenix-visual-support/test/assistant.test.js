const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: clientIO } = require('socket.io-client');
const { installAssistant, readResources } = require('../assistant');

const app = express(), server = http.createServer(app), io = new Server(server);
const sessions = new Map();
const env = { PHOENIX_ASSISTANT_ENABLED: 'true', RETELL_PUBLIC_KEY: 'public-key', RETELL_AGENT_ID: 'test-agent',
  RETELL_TOOL_SECRET: 'tool-secret', GEMINI_API_KEY: 'google-secret', GEMINI_MODEL: 'test-model',
  PHOENIX_SUPPORT_RESOURCES: JSON.stringify([{id:'manual',type:'pdf',title:'Manual',url:'https://example.com/manual.pdf'}]) };
let upstream = [];
installAssistant({ app, io, activeSession: id => sessions.get(id), env, fetchImpl: async (url, options) => {
  upstream.push({ url, options });
  return { ok: true, json: async () => ({ candidates: [{content:{parts:[{text:'Nameplate reads 230 V. HP unreadable.'}]}}] }) };
} });
io.on('connection', socket => {
  socket.on('join', ({ id, role }, ack) => {
    socket.sessionId = id; socket.role = role;
    if (role === 'customer') sessions.get(id).customerSocketId = socket.id;
    ack({ ok: true });
  });
});
let base;
const clients = [];
before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { clients.forEach(socket => socket.disconnect()); await new Promise(resolve => io.close(resolve)); });
const emit = (socket, name, data = {}) => new Promise((resolve, reject) => socket.timeout(2000).emit(name, data, (err, result) => err ? reject(err) : resolve(result)));
async function customer(id, role = 'customer') {
  sessions.set(id, {});
  const socket = clientIO(base, { transports: ['websocket'], reconnection: false }); clients.push(socket);
  await new Promise(resolve => socket.once('connect', resolve));
  await emit(socket, 'join', { id, role });
  return socket;
}
async function tool(config, name, args = {}, secret = 'tool-secret') {
  return fetch(`${base}/api/assistant/tool`, { method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${secret}` },
    body: JSON.stringify({ name, args, call:{ metadata:{visual_session_id:config.sessionId, visual_token:config.token} } }) });
}

test('resource catalogue rejects executable URLs, duplicate IDs and unsupported media', () => {
  assert.throws(() => readResources('[{"id":"x","title":"x","type":"pdf","url":"javascript:alert(1)"}]'));
  assert.throws(() => readResources('[{"id":"x","title":"x","type":"iframe","url":"https://example.com"}]'));
  const item = {id:'x',title:'x',type:'pdf',url:'https://example.com'};
  assert.throws(() => readResources(JSON.stringify([item,item])));
});
test('only a joined customer can enable; disabled configuration fails closed', async () => {
  const tech = await customer('tech', 'technician');
  assert.match((await emit(tech,'assistant-enable')).error,/Join/);
  const socket = await customer('disabled');
  env.PHOENIX_ASSISTANT_ENABLED = 'false';
  assert.match((await emit(socket,'assistant-enable')).error,/not configured/);
  env.PHOENIX_ASSISTANT_ENABLED = 'true';
});
test('tool secret and session token are both required; server keys never reach the customer', async () => {
  const socket = await customer('auth'); const config = await emit(socket,'assistant-enable');
  assert.equal(config.publicKey,'public-key');
  assert.ok(!JSON.stringify(config).includes('google-secret'));
  assert.ok(!JSON.stringify(config).includes('tool-secret'));
  assert.equal((await tool(config,'list_resources',{},'wrong')).status,401);
  assert.equal((await tool({...config,token:'wrong'},'list_resources')).status,403);
  assert.equal((await tool({...config,sessionId:'unknown'},'list_resources')).status,403);
  assert.equal((await tool(config,'list_resources')).status,200);
});
test('only approved resources are displayed, and display failures are reported', async () => {
  const socket = await customer('media'); const config = await emit(socket,'assistant-enable');
  let payload;
  socket.on('assistant-resource',(data,ack)=>{payload=data;ack({ok:true});});
  assert.equal((await tool(config,'open_resource',{resource_id:'unknown'})).status,400);
  const result = await (await tool(config,'open_resource',{resource_id:'manual',page:7,seconds:20})).json();
  assert.equal(result.opened,true); assert.equal(payload.page,7); assert.equal(payload.url,'https://example.com/manual.pdf');
  socket.removeAllListeners('assistant-resource');socket.on('assistant-resource',(_,ack)=>ack({ok:false}));
  assert.match((await (await tool(config,'open_resource',{resource_id:'manual'})).json()).error,/did not open/);
});
test('camera denial never contacts Google', async () => {
  const socket = await customer('denied');const config = await emit(socket,'assistant-enable');
  socket.on('assistant-frame-request',(_,ack)=>ack({ok:false}));
  upstream=[];
  assert.match((await (await tool(config,'inspect_camera')).json()).error,/sharing is off/);
  assert.equal(upstream.length,0);
});
test('camera observations use one validated current frame and enforce per-session throttling', async () => {
  const socket = await customer('vision'); const config = await emit(socket,'assistant-enable');
  socket.on('assistant-frame-request',(_,ack)=>ack({ok:true,data:Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64')}));
  upstream=[];
  const result=await (await tool(config,'inspect_camera',{question:'Read the nameplate'})).json();
  assert.match(result.observation,/230 V/);assert.match(result.note,/not continuous/);assert.equal(upstream.length,1);
  const input=JSON.parse(upstream[0].options.body);assert.equal(input.contents[0].parts[0].text,'Read the nameplate');
  assert.equal(upstream[0].options.headers['x-goog-api-key'],'google-secret');
  assert.equal((await tool(config,'inspect_camera')).status,429);
  assert.equal(sessions.get('vision').visionCount,1);
});
test('disabling AI revokes access and fresh enable rotates its token without resetting quota', async () => {
  const socket = await customer('revoke');const config=await emit(socket,'assistant-enable');
  socket.emit('assistant-disable');await emit(socket,'join',{id:'revoke',role:'customer'});
  assert.equal((await tool(config,'list_resources')).status,403);
  sessions.get('revoke').visionCount=60;
  const fresh=await emit(socket,'assistant-enable'); assert.notEqual(fresh.token,config.token);
  assert.equal((await tool(config,'list_resources')).status,403);
  assert.equal((await tool(fresh,'inspect_camera')).status,429);
});
test('malformed images never contact Google', async () => {
  const socket = await customer('malformed');const config=await emit(socket,'assistant-enable');
  socket.on('assistant-frame-request',(_,ack)=>ack({ok:true,data:Buffer.from('not jpeg').toString('base64')}));upstream=[];
  assert.equal((await tool(config,'inspect_camera')).status,400);assert.equal(upstream.length,0);
});
