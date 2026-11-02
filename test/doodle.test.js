import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';

async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function setup(t) {
  if (process.env.GAME_TEST_ORIGIN) return process.env.GAME_TEST_ORIGIN.replace(/\/$/, '');
  const server = createGameServer();
  const connections = new Set();
  server.on('connection', connection => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const connection of connections) connection.destroy();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function send(socket, event, data = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, data, (error, result) => error ? reject(error) : resolve(result));
  });
}

async function connect(t, origin, transport) {
  const client = io(origin, {
    path: '/doodle/socket.io',
    transports: [transport],
    forceNew: true,
    reconnection: false,
    timeout: 10000,
    autoConnect: false,
  });
  client.states = [];
  client.secrets = [];
  client.draws = [];
  client.on('state', state => { client.state = state; client.states.push(state); });
  client.on('secret', word => client.secrets.push(word));
  client.on('draw', point => client.draws.push(point));
  client.on('drawing:clear', revision => { client.revision = revision; });
  t.after(() => client.disconnect());
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
  return client;
}

test('shared hosting keeps both apps, assets, redirects, invites and socket paths isolated', async t => {
  const origin = await setup(t);
  const redirect = await fetch(`${origin}/doodle?room=ABC123`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/doodle/?room=ABC123');
  const page = await fetch(`${origin}/doodle/?room=ABC123`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Draw Together/);
  assert.match(html, /href="\.\/style\.css"/);
  assert.match(html, /class="brand" href="\.\/"/);
  assert.match(html, /src="\.\/socket\.io\/socket\.io\.js"/);
  for (const [asset, type] of [['app.js', /javascript/], ['style.css', /text\/css/], ['socket.io/socket.io.js', /javascript/]]) {
    const response = await fetch(`${origin}/doodle/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), type);
    const text = await response.text();
    assert.ok(text.length > 100);
    if (asset === 'app.js') {
      assert.match(text, /new URL\("\.\/socket.io", window.location.href\).pathname/);
      assert.match(text, /window.location.assign\("\.\/"\)/);
      assert.match(text, /url.searchParams.set\("room", state.code\)/);
    }
  }
  assert.deepEqual(await (await fetch(`${origin}/doodle/health`)).json(), { ok: true });
  for (const prefix of ['', '/imposter']) {
    const response = await fetch(`${origin}${prefix}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /IMPOSTER/);
    const script = await (await fetch(`${origin}${prefix}/app.js`)).text();
    assert.match(script, /api\//);
    assert.doesNotMatch(script, /const socket = io/);
  }
  for (const route of ['/doodle-other', '/socket.io/socket.io.js', '/doodle/api/state', '/doodle/imposter/']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 404, route);
  }
});

test('shared hosting supports complete multiplayer over WebSocket and polling without affecting Imposter', async t => {
  const origin = await setup(t);
  async function imposter(action, input, token, method = 'POST') {
    const response = await fetch(`${origin}/api/${action}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
    });
    assert.equal(response.status, 200, `Imposter ${action}`);
    return response.json();
  }
  const original = await imposter('create', { name: 'Hosting verification' });
  if (process.env.GAME_TEST_ORIGIN) t.after(() => imposter('leave', {}, original.token));
  const host = await connect(t, origin, 'websocket');
  const guest = await connect(t, origin, 'polling');
  const isolated = await connect(t, origin, 'websocket');
  const created = await send(host, 'room:create', { name: 'Draw host' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-F0-9]{6}$/);
  assert.equal((await send(guest, 'room:join', { code: created.code, name: 'Draw guest' })).ok, true);
  const other = await send(isolated, 'room:create', { name: 'Separate room' });
  assert.equal(other.ok, true);
  await until(() => host.state?.players.length === 2 && isolated.state?.players.length === 1, 'separate lobbies');
  assert.equal((await send(host, 'game:start')).ok, true);
  await until(() => host.state?.phase === 'drawing' && host.secrets.length === 1 && guest.state?.phase === 'drawing', 'first private word');
  assert.equal(guest.secrets.length, 0);
  assert.equal(guest.state.revealedWord, null);
  assert.equal(host.io.engine.transport.name, 'websocket');
  assert.equal(guest.io.engine.transport.name, 'polling');
  const initialEnd = host.state.endsAt;
  assert.equal((await send(host, 'time:add')).ok, true);
  await until(() => guest.state.endsAt === initialEnd + 15000, 'host timer extension');
  const point = { x: 0.2, y: 0.4, color: '#283047', size: 6, start: true, revision: host.state.drawingRevision };
  assert.equal((await send(host, 'draw', point)).ok, true);
  await until(() => guest.draws.length === 1, 'live canvas propagation');
  assert.deepEqual(guest.draws[0], point);
  assert.equal(isolated.draws.length, 0);
  assert.equal(isolated.state.phase, 'lobby');
  assert.equal((await send(host, 'drawing:clear')).ok, true);
  await until(() => guest.revision === point.revision + 1, 'canvas clear propagation');
  assert.equal((await send(guest, 'guess', { text: host.secrets[0] })).ok, true);
  await until(() => host.state.phase === 'reveal', 'first turn reveal');
  assert.deepEqual(host.state.players.map(player => player.score), [10, 10]);
  await until(() => host.state.phase === 'drawing' && host.state.drawerId === guest.id && guest.secrets.length === 2, 'second drawing turn');
  assert.equal((await send(host, 'guess', { text: guest.secrets.at(-1) })).ok, true);
  await until(() => host.state.phase === 'finished' && guest.state.phase === 'finished', 'complete game');
  assert.deepEqual(host.state.players.map(player => player.score), [20, 20]);
  assert.equal((await send(host, 'game:start')).ok, true);
  await until(() => host.state.phase === 'drawing' && host.state.players.every(player => player.score === 0), 'replay');
  const unchanged = await imposter('state', {}, original.token, 'GET');
  assert.equal(unchanged.code, original.state.code);
  assert.equal(unchanged.phase, 'lobby');
  assert.equal(unchanged.players.length, 1);
  host.disconnect();
  await until(() => guest.state.hostId === guest.id && guest.state.phase === 'lobby', 'disconnect host transfer');
});
