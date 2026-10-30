import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../server.js';

async function setup(t, count = 3, basePath = '') {
  const server = createGameServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}${basePath}`;
  async function request(action, data = {}, token, method = 'POST') {
    const res = await fetch(`${base}/api/${action}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
    });
    return { status: res.status, data: await res.json() };
  }
  const host = (await request('create', { name: 'Alex' })).data;
  const players = [host];
  for (let i = 1; i < count; i++) players.push((await request('join', { name: `Player ${i}`, code: host.state.code })).data);
  const state = p => request('state', {}, p.token, 'GET').then(r => r.data);
  const post = (p, action, data) => request(action, data, p.token);
  async function describe() {
    for (const p of players) {
      const current = await state(p);
      assert.equal(current.phase, 'describing');
      assert.equal(current.round, 1);
      assert.equal(current.turnId, p.state.selfId);
      assert.equal((await post(p, 'clue', { text: 'My only clue' })).status, 200);
    }
  }
  return { base, request, host, players, state, post, describe };
}

test('subpath hosting preserves assets, invite queries, live chat, and a complete game', async t => {
  const { base, host, players, state, post, describe } = await setup(t, 3, '/imposter');
  const origin = new URL(base).origin;
  const redirect = await fetch(`${base}?room=${host.state.code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), `/imposter/?room=${host.state.code}`);
  const page = await fetch(`${base}/?room=${host.state.code}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="\.\/style\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /class="brand" href="\.\/"/);
  for (const asset of ['app.js', 'style.css']) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(`${origin}/`)).status, 200);
  assert.equal((await fetch(`${origin}/imposter-other`)).status, 404);
  await post(host, 'start');
  const states = await Promise.all(players.map(state));
  const imposter = players[states.findIndex(s => s.isImposter)];
  assert.ok(imposter);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${imposter.token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
      } else {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  }
  assert.equal((await nextEvent()).word, null);
  assert.equal((await post(host, 'chat', { text: 'Subpath chat' })).status, 200);
  const update = await nextEvent();
  assert.equal(update.word, null);
  assert.equal(update.messages.at(-1).text, 'Subpath chat');
  controller.abort();
  await describe();
  for (let i = 0; i < players.length; i++) {
    assert.equal((await post(players[i], 'vote', {
      playerId: players[(i + 1) % players.length].state.selfId,
    })).status, 200);
  }
  assert.equal((await state(host)).phase, 'results');
  assert.equal((await post(host, 'reset')).status, 200);
  for (const player of players) assert.equal((await post(player, 'leave')).status, 200);
});

test('full caught game: private words, one clue each, secret immutable votes, restart', async t => {
  const { host, players, state, post, describe, request } = await setup(t);
  assert.equal((await post(players[1], 'start')).status, 403);
  assert.equal((await post(host, 'start')).status, 200);
  const states = await Promise.all(players.map(state));
  assert.equal(states.filter(s => s.isImposter).length, 1);
  const imposterIndex = states.findIndex(s => s.isImposter);
  const imposter = players[imposterIndex];
  const others = players.filter(p => p !== imposter);
  assert.equal(states[imposterIndex].word, null);
  assert.ok(states[imposterIndex].category);
  const words = states.filter(s => !s.isImposter).map(s => s.word);
  assert.ok(words[0]);
  assert.equal(words[0], words[1]);
  for (const s of states) {
    assert.equal(s.imposterId, undefined);
    assert.ok(s.players.every(p => !('token' in p)));
  }
  assert.equal((await post(host, 'vote', { playerId: others[0].state.selfId })).status, 400);
  assert.equal((await post(players[1], 'clue', { text: 'Out of turn' })).status, 400);
  assert.equal((await post(host, 'clue', { text: ' ' })).status, 400);
  await describe();
  const voting = await state(host);
  assert.equal(voting.clues.length, players.length);
  assert.equal(voting.phase, 'voting');
  assert.equal(voting.turnId, null);
  assert.equal(voting.round, 1);
  assert.deepEqual(voting.clues.map(clue => clue.playerId), players.map(p => p.state.selfId));
  assert.equal((await post(host, 'clue', { text: 'An unwanted second clue' })).status, 400);
  assert.equal((await post(others[0], 'vote', { playerId: others[0].state.selfId })).status, 400);
  await post(others[0], 'vote', { playerId: imposter.state.selfId });
  assert.equal((await post(others[0], 'vote', { playerId: others[1].state.selfId })).status, 400);
  const privateState = await state(others[1]);
  assert.equal(privateState.myVote, null);
  assert.equal(privateState.votes, undefined);
  assert.equal(privateState.votedIds.length, 1);
  await post(others[1], 'vote', { playerId: imposter.state.selfId });
  await post(imposter, 'vote', { playerId: others[0].state.selfId });
  for (const p of players) {
    const s = await state(p);
    assert.equal(s.phase, 'results');
    assert.equal(s.result.caught, true);
    assert.equal(s.result.imposterId, imposter.state.selfId);
    assert.equal(s.word, words[0]);
  }
  assert.equal((await post(players[1], 'reset')).status, 403);
  await post(host, 'reset');
  const lobby = await state(imposter);
  assert.equal(lobby.word, null);
  assert.equal(lobby.category, null);
  assert.equal(lobby.result, null);
  await post(host, 'start');
  const next = await Promise.all(players.map(state));
  assert.equal(next.filter(s => s.isImposter).length, 1);
  assert.notEqual(next.find(s => !s.isImposter).word, words[0]);
  assert.equal((await request('state', {}, 'invalid', 'GET')).status, 401);
});

test('a tied vote lets the imposter survive', async t => {
  const { host, players, state, post, describe } = await setup(t);
  await post(host, 'start');
  await describe();
  for (let i = 0; i < players.length; i++) await post(players[i], 'vote', { playerId: players[(i + 1) % players.length].state.selfId });
  const result = (await state(host)).result;
  assert.equal(result.caught, false);
  assert.equal(result.tied, true);
});

test('accusing an innocent player lets the imposter survive', async t => {
  const { host, players, state, post, describe } = await setup(t);
  await post(host, 'start');
  const all = await Promise.all(players.map(state));
  const target = players[all.findIndex(s => !s.isImposter)];
  await describe();
  for (const p of players) await post(p, 'vote', { playerId: p === target ? players.find(x => x !== target).state.selfId : target.state.selfId });
  const result = (await state(host)).result;
  assert.equal(result.caught, false);
  assert.equal(result.tied, false);
});

test('lobby validation, host transfer and starting boundaries', async t => {
  const { host, players, state, post, request } = await setup(t, 2);
  assert.equal((await post(host, 'start')).status, 400);
  assert.equal((await request('join', { name: 'alex', code: host.state.code })).status, 400);
  assert.equal((await request('join', { name: 'Someone', code: 'ZZZZZZ' })).status, 404);
  assert.equal((await request('create', { name: ' '.repeat(3) })).status, 400);
  await post(host, 'leave');
  assert.equal((await state(players[1])).hostId, players[1].state.selfId);
  assert.equal((await request('state', {}, host.token, 'GET')).status, 401);
});

test('live events filter the imposter word and reject joining an active game', async t => {
  const { base, host, players, state, post, request } = await setup(t);
  await post(host, 'start');
  const all = await Promise.all(players.map(state));
  const imposter = players[all.findIndex(s => s.isImposter)];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${imposter.token}` }, signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const chunk = await reader.read();
  const event = JSON.parse(new TextDecoder().decode(chunk.value).trim().slice(6));
  assert.equal(event.word, null);
  assert.equal(event.isImposter, true);
  assert.equal(event.imposterId, undefined);
  assert.equal((await request('join', { name: 'Late', code: host.state.code })).status, 400);
  assert.equal((await post(host, 'leave')).status, 400);
  controller.abort();
});

test('room chat works in every phase without using turns or changing votes', async t => {
  const { host, players, state, post, describe } = await setup(t);
  for (const phase of ['lobby', 'describing', 'voting', 'results']) {
    if (phase === 'describing') await post(host, 'start');
    if (phase === 'voting') await describe();
    if (phase === 'results') {
      for (let i = 0; i < players.length; i++) {
        await post(players[i], 'vote', { playerId: players[(i + 1) % players.length].state.selfId });
      }
    }
    // Different senders avoid throttling until the results message.
    const sender = players[['lobby', 'describing', 'voting'].indexOf(phase)] ?? host;
    if (phase === 'results') {
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 1000);
    }
    const before = await state(host);
    assert.equal(before.phase, phase);
    const sent = await post(sender, 'chat', { text: `  Hello from ${phase}!  `, name: 'Fake name', playerId: 'fake-id' });
    assert.equal(sent.status, 200);
    const after = await state(host);
    const { messages: beforeMessages, ...beforeGame } = before;
    const { messages: afterMessages, ...afterGame } = after;
    assert.deepEqual(afterGame, beforeGame);
    assert.equal(afterMessages.length, beforeMessages.length + 1);
    const message = afterMessages.at(-1);
    assert.equal(message.text, `Hello from ${phase}!`);
    assert.equal(message.playerId, sender.state.selfId);
    assert.equal(message.name, sender.state.players.find(p => p.id === sender.state.selfId).name);
    assert.ok(message.id);
    assert.equal(typeof message.sentAt, 'number');
    assert.deepEqual(Object.keys(message).sort(), ['id', 'name', 'playerId', 'sentAt', 'text']);
    for (const p of players) assert.deepEqual((await state(p)).messages, afterMessages);
  }
  const history = (await state(host)).messages;
  await post(host, 'reset');
  assert.deepEqual((await state(host)).messages, history);
  await post(host, 'start');
  assert.deepEqual((await state(players[1])).messages, history);
});

test('chat validates text, throttles per sender, and requires a room session', async t => {
  const { host, players, post, state, request } = await setup(t);
  for (const text of ['', ' \n ', 'x'.repeat(301), 42, null, { text: 'not a string' }]) {
    assert.equal((await post(host, 'chat', { text })).status, 400);
  }
  assert.deepEqual((await state(host)).messages, []);
  assert.equal((await request('chat', { text: 'No session' })).status, 401);
  assert.equal((await request('chat', { text: 'Invalid session' }, 'invalid')).status, 401);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal((await post(host, 'chat', { text: 'x'.repeat(300) })).status, 200);
  const limited = await post(host, 'chat', { text: 'Too soon' });
  assert.equal(limited.status, 429);
  assert.match(limited.data.error, /one message per second/);
  assert.equal((await post(players[1], 'chat', { text: 'Another player can still talk' })).status, 200);
  t.mock.method(Date, 'now', () => now + 1000);
  assert.equal((await post(host, 'chat', { text: 'One second later' })).status, 200);
  assert.equal((await state(host)).messages.length, 3);
});

test('chat is isolated by room and preserves the names of departed players', async t => {
  const { host, players, post, state, request } = await setup(t);
  const otherHost = (await request('create', { name: 'Other host' })).data;
  const text = '<img src=x onerror=alert(1)> & "hello"';
  await post(players[1], 'chat', { text });
  await post(players[1], 'leave');
  const local = await state(host);
  assert.equal(local.messages[0].name, 'Player 1');
  assert.equal(local.messages[0].text, text);
  assert.deepEqual((await state(otherHost)).messages, []);
  const joined = (await request('join', { name: 'New teammate', code: host.state.code })).data;
  assert.deepEqual(joined.state.messages, local.messages);
  assert.equal((await post(players[1], 'chat', { text: 'I left' })).status, 401);
});

test('chat retains only the latest 100 messages in order', async t => {
  const { host, state, post } = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 105; i++) {
    now += 1000;
    assert.equal((await post(host, 'chat', { text: `Message ${i}` })).status, 200);
  }
  const messages = (await state(host)).messages;
  assert.equal(messages.length, 100);
  assert.equal(messages[0].text, 'Message 5');
  assert.equal(messages.at(-1).text, 'Message 104');
  assert.equal(new Set(messages.map(message => message.id)).size, 100);
});

test('chat reaches live streams without exposing the imposter word', async t => {
  const { base, host, players, state, post } = await setup(t);
  await post(host, 'start');
  const states = await Promise.all(players.map(state));
  const imposter = players[states.findIndex(s => s.isImposter)];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${imposter.token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
      } else {
        const { done, value } = await reader.read();
        assert.equal(done, false);
        buffer += decoder.decode(value, { stream: true });
      }
    }
  }
  const before = await nextEvent();
  assert.deepEqual(before.messages, []);
  assert.equal((await post(host, 'chat', { text: 'Who is looking suspicious?' })).status, 200);
  const after = await nextEvent();
  assert.equal(after.messages[0].text, 'Who is looking suspicious?');
  assert.equal(after.word, null);
  assert.equal(after.isImposter, true);
  assert.equal(after.imposterId, undefined);
  assert.deepEqual(after.clues, before.clues);
  assert.equal(after.turnId, before.turnId);
  controller.abort();
});
