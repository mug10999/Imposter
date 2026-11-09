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
    const order = (await state(host)).players;
    for (const seat of order) {
      const p = players.find(p => p.state.selfId === seat.id);
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

test('full caught game: private words, one clue each, public immutable votes, restart', async t => {
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
  const first = players.find(p => p.state.selfId === states[0].turnId);
  assert.equal((await post(players.find(p => p !== first), 'clue', { text: 'Out of turn' })).status, 400);
  assert.equal((await post(first, 'clue', { text: ' ' })).status, 400);
  await describe();
  const voting = await state(host);
  assert.equal(voting.clues.length, players.length);
  assert.equal(voting.phase, 'voting');
  assert.equal(voting.turnId, null);
  assert.equal(voting.round, 1);
  assert.deepEqual(voting.clues.map(clue => clue.playerId), voting.players.map(p => p.id));
  assert.equal((await post(host, 'clue', { text: 'An unwanted second clue' })).status, 400);
  assert.equal((await post(others[0], 'vote', { playerId: others[0].state.selfId })).status, 400);
  await post(others[0], 'vote', { playerId: imposter.state.selfId });
  assert.equal((await post(others[0], 'vote', { playerId: others[1].state.selfId })).status, 400);
  const privateState = await state(others[1]);
  assert.equal(privateState.myVote, null);
  assert.deepEqual(privateState.votes, { [others[0].state.selfId]: imposter.state.selfId });
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
  assert.equal((await post(host, 'leave')).status, 200);
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

test('host refresh restarts clues and votes with a different word and the same imposter', async t => {
  const { host, players, state, post, describe } = await setup(t, 5);
  assert.equal((await post(host, 'refresh')).status, 400);
  await post(host, 'start');
  await post(host, 'chat', { text: 'Keep our chat' });
  const original = await Promise.all(players.map(state));
  assert.equal((await post(players[1], 'refresh')).status, 403);
  await describe();
  await post(players[0], 'vote', { playerId: players[1].state.selfId });
  assert.equal((await post(host, 'refresh')).status, 200);
  const refreshed = await Promise.all(players.map(state));
  for (let i = 0; i < players.length; i++) {
    const s = refreshed[i];
    assert.equal(s.phase, 'describing');
    assert.equal(s.isImposter, original[i].isImposter);
    assert.equal(s.dealId, original[i].dealId + 1);
    assert.deepEqual(s.clues, []);
    assert.deepEqual(s.votes, {});
    assert.equal(s.myVote, null);
    assert.equal(s.result, null);
    assert.equal(s.turnId, s.players[0].id);
    assert.deepEqual(s.messages, original[i].messages);
    assert.equal(s.hostId, host.state.selfId);
    assert.notDeepEqual(s.players, original[i].players);
    if (s.isImposter) assert.equal(s.word, null);
    else assert.notEqual(s.word, original[i].word);
  }
  await post(players.find(p => p.state.selfId === refreshed[0].turnId), 'clue', { text: 'Discard this clue' });
  assert.equal((await post(host, 'refresh')).status, 200);
  assert.deepEqual((await state(host)).clues, []);
  await describe();
  for (let i = 0; i < players.length; i++) {
    await post(players[i], 'vote', { playerId: players[(i + 1) % players.length].state.selfId });
  }
  assert.equal((await post(host, 'refresh')).status, 400);
});

test('every deal changes turn order and uses a broad category', async t => {
  const { host, players, state, post, describe } = await setup(t);
  let order = (await state(host)).players;
  for (let round = 0; round < 5; round++) {
    await post(host, 'start');
    const s = await state(host);
    assert.notDeepEqual(s.players, order);
    assert.equal(s.hostId, host.state.selfId);
    assert.ok(['Food & drink', 'Animals', 'Places', 'Objects', 'Nature', 'Activities', 'Jobs', 'Games & sports'].includes(s.category));
    order = s.players;
    await describe();
    for (let i = 0; i < players.length; i++) {
      await post(players[i], 'vote', { playerId: players[(i + 1) % players.length].state.selfId });
    }
    await post(host, 'reset');
  }
});

test('only the host can kick another room member and removed sessions lose access', async t => {
  const { host, players, state, post, request } = await setup(t, 4);
  const outsider = (await request('create', { name: 'Another room' })).data;
  assert.equal((await post(players[1], 'kick', { playerId: players[2].state.selfId })).status, 403);
  assert.equal((await post(host, 'kick', { playerId: host.state.selfId })).status, 400);
  assert.equal((await post(host, 'kick', { playerId: outsider.state.selfId })).status, 400);
  assert.equal((await post(host, 'kick', { playerId: 'missing' })).status, 400);
  assert.equal((await post(host, 'kick', { playerId: players[1].state.selfId })).status, 200);
  assert.equal((await state(host)).players.length, 3);
  assert.equal((await state(host)).hostId, host.state.selfId);
  assert.equal((await request('state', {}, players[1].token, 'GET')).status, 401);
  assert.equal((await post(players[1], 'chat', { text: 'No longer allowed' })).status, 401);
  assert.equal((await post(players[1], 'start')).status, 401);
});

for (const position of ['before', 'current', 'after']) {
  test(`removing a player ${position === 'current' ? 'on' : position} the current turn preserves clue progress`, async t => {
    const { host, players, state, post } = await setup(t, 5);
    await post(host, 'start');
    const states = await Promise.all(players.map(state));
    const imposterId = players[states.findIndex(s => s.isImposter)].state.selfId;
    const order = states[0].players;
    const index = order.findIndex((p, i) => i > 0 && i < order.length - 1 && p.id !== imposterId && p.id !== host.state.selfId);
    assert.ok(index > 0);
    const target = players.find(p => p.state.selfId === order[index].id);
    const turn = index + (position === 'before' ? 1 : position === 'after' ? -1 : 0);
    for (let i = 0; i < turn; i++) {
      await post(players.find(p => p.state.selfId === order[i].id), 'clue', { text: `Clue ${i}` });
    }
    assert.equal((await post(host, 'kick', { playerId: target.state.selfId })).status, 200);
    let s = await state(host);
    assert.equal(s.phase, 'describing');
    assert.equal(s.turnId, order[turn + (position === 'current' ? 1 : 0)].id);
    assert.equal(s.clues.length, turn);
    if (position === 'before') assert.equal(s.clues.find(c => c.playerId === target.state.selfId).name, target.state.players.find(p => p.id === target.state.selfId).name);
    while (s.phase === 'describing') {
      const current = players.find(p => p.state.selfId === s.turnId);
      assert.equal((await post(current, 'clue', { text: 'Remaining clue' })).status, 200);
      s = await state(host);
    }
    assert.equal(s.phase, 'voting');
    assert.equal(new Set(s.clues.map(c => c.playerId)).size, s.clues.length);
  });
}

test('leaving during voting removes invalid ballots and lets remaining players finish', async t => {
  const { host, players, state, post, describe, request } = await setup(t, 5);
  await post(host, 'start');
  const states = await Promise.all(players.map(state));
  const target = players.find((p, i) => p !== host && !states[i].isImposter);
  const remaining = players.filter(p => p !== target);
  await describe();
  await post(remaining[0], 'vote', { playerId: target.state.selfId });
  await post(target, 'vote', { playerId: remaining[1].state.selfId });
  await post(remaining[1], 'vote', { playerId: remaining[2].state.selfId });
  assert.equal((await post(target, 'leave')).status, 200);
  const after = await state(host);
  assert.equal(after.phase, 'voting');
  assert.equal(after.hostId, host.state.selfId);
  assert.deepEqual(after.votes, { [remaining[1].state.selfId]: remaining[2].state.selfId });
  assert.equal(after.myVote, null);
  assert.equal(after.clues.length, 5);
  assert.equal((await request('state', {}, target.token, 'GET')).status, 401);
  for (let i = 0; i < remaining.length; i++) {
    if (i !== 1) assert.equal((await post(remaining[i], 'vote', { playerId: remaining[(i + 1) % remaining.length].state.selfId })).status, 200);
  }
  const finished = await state(host);
  assert.equal(finished.phase, 'results');
  assert.equal(Object.keys(finished.result.counts).length, remaining.length);
});

test('removing the only missing voter completes voting immediately', async t => {
  const { host, players, state, post, describe } = await setup(t, 5);
  await post(host, 'start');
  const states = await Promise.all(players.map(state));
  const target = players.find((p, i) => p !== host && !states[i].isImposter);
  const remaining = players.filter(p => p !== target);
  await describe();
  for (let i = 0; i < remaining.length; i++) {
    await post(remaining[i], 'vote', { playerId: remaining[(i + 1) % remaining.length].state.selfId });
  }
  assert.equal((await post(host, 'kick', { playerId: target.state.selfId })).status, 200);
  assert.equal((await state(host)).phase, 'results');
});

test('host departure transfers ownership and imposter departure or too few players cancels the game', async t => {
  for (const reason of ['host', 'imposter', 'minimum']) {
    await t.test(reason, async t => {
      const { host, players, state, post } = await setup(t, reason === 'minimum' ? 3 : 5);
      await post(host, 'start');
      const states = await Promise.all(players.map(state));
      const target = reason === 'host' ? host : players[states.findIndex(s => reason === 'imposter' ? s.isImposter : !s.isImposter)];
      const remaining = players.filter(p => p !== target);
      await post(target, 'leave');
      const s = await state(remaining[0]);
      assert.equal(s.hostId, target === host ? s.players[0].id : host.state.selfId);
      assert.equal(s.phase, reason === 'host' && !states[0].isImposter ? 'describing' : 'lobby');
      if (s.phase === 'lobby') {
        assert.deepEqual(s.clues, []);
        assert.deepEqual(s.votes, {});
        assert.equal(s.word, null);
        assert.equal(s.isImposter, null);
        assert.match(s.notice, /returned to the lobby/);
      }
    });
  }
});

test('leaving results preserves the outcome, clues and public vote history', async t => {
  const { host, players, state, post, describe } = await setup(t);
  await post(host, 'start');
  await describe();
  for (let i = 0; i < players.length; i++) {
    await post(players[i], 'vote', { playerId: players[(i + 1) % players.length].state.selfId });
  }
  const before = await state(host);
  await post(players[1], 'leave');
  const after = await state(host);
  assert.equal(after.phase, 'results');
  assert.deepEqual(after.result, before.result);
  assert.deepEqual(after.clues, before.clues);
  assert.deepEqual(after.votes, before.votes);
  assert.deepEqual(after.participants, before.participants);
});

test('kicking closes all removed player streams with a clear message', async t => {
  const { base, host, players, post, request } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const responses = await Promise.all([0, 1].map(() => fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${players[1].token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })));
  const readers = responses.map(response => response.body.getReader());
  for (const reader of readers) await reader.read();
  await post(host, 'kick', { playerId: players[1].state.selfId });
  for (const reader of readers) {
    let data = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      data += new TextDecoder().decode(value);
    }
    const event = JSON.parse(data.trim().slice(6));
    assert.equal(event.removed, true);
    assert.match(event.message, /removed.*host/);
  }
  assert.equal((await request('state', {}, players[1].token, 'GET')).status, 401);
});

test('scorecard awards correct votes and surviving imposters once per completed game', async t => {
  const { host, players, state, post, describe } = await setup(t, 4);
  const expected = Object.fromEntries(players.map(p => [p.state.selfId, {
    score: 0, gamesPlayed: 0, correctVotes: 0, successfulBluffs: 0,
  }]));
  const scores = s => Object.fromEntries(s.players.map(({ id, score, gamesPlayed, correctVotes, successfulBluffs }) => [
    id, { score, gamesPlayed, correctVotes, successfulBluffs },
  ]));
  assert.deepEqual(scores(await state(host)), expected);
  for (const outcome of ['caught', 'tied', 'innocent']) {
    await post(host, 'start');
    const states = await Promise.all(players.map(state));
    const imposter = players[states.findIndex(s => s.isImposter)];
    const others = players.filter(p => p !== imposter);
    await describe();
    const ballots = new Map(players.map((p, i) => [
      p.state.selfId,
      outcome === 'tied' ? players[(i + 1) % players.length].state.selfId
        : outcome === 'caught' ? (p === imposter ? others[0] : imposter).state.selfId
          : (p === others[0] ? imposter : others[0]).state.selfId,
    ]));
    for (let i = 0; i < players.length; i++) {
      assert.deepEqual(scores(await state(host)), expected, 'Scores change only after all votes are locked');
      assert.equal((await post(players[i], 'vote', { playerId: ballots.get(players[i].state.selfId) })).status, 200);
    }
    const finished = await state(host);
    assert.equal(finished.result.caught, outcome === 'caught');
    assert.equal(finished.result.tied, outcome === 'tied');
    for (const player of players) {
      const total = expected[player.state.selfId];
      total.gamesPlayed++;
      if (player === imposter && outcome !== 'caught') {
        total.score += 2;
        total.successfulBluffs++;
      } else if (ballots.get(player.state.selfId) === imposter.state.selfId) {
        total.score++;
        total.correctVotes++;
      }
    }
    for (const p of players) assert.deepEqual(scores(await state(p)), expected);
    assert.equal((await post(host, 'vote', { playerId: others[0].state.selfId })).status, 400);
    assert.deepEqual(scores(await state(host)), expected, 'Repeated requests must not award points again');
    await post(host, 'reset');
    assert.deepEqual(scores(await state(host)), expected, 'Returning to lobby retains every score');
  }
  await post(host, 'start');
  const before = scores(await state(host));
  await describe();
  await post(host, 'vote', { playerId: players[1].state.selfId });
  await post(host, 'refresh');
  assert.deepEqual(scores(await state(host)), before, 'Refreshing an unfinished game awards nothing');
  const current = await Promise.all(players.map(state));
  const imposter = players[current.findIndex(s => s.isImposter)];
  await post(imposter, 'leave');
  const remaining = players.find(p => p !== imposter);
  const cancelled = await state(remaining);
  assert.equal(cancelled.phase, 'lobby');
  for (const p of cancelled.players) {
    assert.deepEqual(scores(cancelled)[p.id], before[p.id], 'Cancellation preserves other players without awarding points');
  }
});

for (const action of ['leave', 'kick']) {
  test(`scores are removed on ${action} and rejoining starts at zero`, async t => {
    const { host, players, state, post, describe, request } = await setup(t, 4);
    await post(host, 'start');
    const states = await Promise.all(players.map(state));
    const imposter = players[states.findIndex(s => s.isImposter)];
    const others = players.filter(p => p !== imposter);
    await describe();
    for (const p of players) {
      await post(p, 'vote', { playerId: (p === imposter ? others[0] : imposter).state.selfId });
    }
    const departed = others.find(p => p !== host);
    const before = await state(host);
    assert.equal(before.players.find(p => p.id === departed.state.selfId).score, 1);
    if (action === 'leave') await post(departed, 'leave');
    else await post(host, 'kick', { playerId: departed.state.selfId });
    const after = await state(host);
    assert.ok(!after.players.some(p => p.id === departed.state.selfId));
    for (const p of after.players) assert.deepEqual(p, before.players.find(previous => previous.id === p.id));
    await post(host, 'reset');
    const name = before.players.find(p => p.id === departed.state.selfId).name;
    const rejoined = (await request('join', {
      name, code: host.state.code, score: 999, gamesPlayed: 99, correctVotes: 99, successfulBluffs: 99,
    })).data;
    const fresh = rejoined.state.players.find(p => p.id === rejoined.state.selfId);
    assert.notEqual(fresh.id, departed.state.selfId);
    assert.equal(fresh.score, 0);
    assert.equal(fresh.gamesPlayed, 0);
    assert.equal(fresh.correctVotes, 0);
    assert.equal(fresh.successfulBluffs, 0);
    const newRoom = (await request('create', { name: 'Fresh host', score: 999 })).data;
    assert.equal(newRoom.state.players[0].score, 0);
  });
}

test('finishing voting by removing a missing voter awards scores to remaining players only', async t => {
  const { host, players, state, post, describe } = await setup(t, 5);
  await post(host, 'start');
  const states = await Promise.all(players.map(state));
  const imposter = players[states.findIndex(s => s.isImposter)];
  const departed = players.find((p, i) => p !== host && !states[i].isImposter);
  const remaining = players.filter(p => p !== departed);
  await describe();
  for (const p of remaining) {
    await post(p, 'vote', { playerId: (p === imposter ? remaining.find(p => p !== imposter) : imposter).state.selfId });
  }
  assert.ok((await state(host)).players.every(p => p.score === 0 && p.gamesPlayed === 0));
  await post(host, 'kick', { playerId: departed.state.selfId });
  const finished = await state(host);
  assert.equal(finished.phase, 'results');
  assert.ok(!finished.players.some(p => p.id === departed.state.selfId));
  for (const p of finished.players) {
    assert.equal(p.score, p.id === imposter.state.selfId ? 0 : 1);
    assert.equal(p.gamesPlayed, 1);
    assert.equal(p.correctVotes, p.id === imposter.state.selfId ? 0 : 1);
    assert.equal(p.successfulBluffs, 0);
  }
  await post(host, 'chat', { text: 'Scores stay the same' });
  assert.deepEqual((await state(host)).players, finished.players);
  await post(host, 'leave');
  const newHost = remaining.find(p => p !== host);
  const transferred = await state(newHost);
  for (const p of transferred.players) assert.deepEqual(p, finished.players.find(previous => previous.id === p.id));
});
