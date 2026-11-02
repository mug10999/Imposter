const { test } = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { setTimeout: delay } = require("node:timers/promises");

async function until(predicate, description = "expected state") {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
async function setup(t, count = 2, options = {}) {
  const game = createGameServer({ wordPicker: () => "hot air balloon", ...options });
  const clients = [];
  t.after(async () => { clients.forEach((s) => s.disconnect()); await game.close(); });
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${game.httpServer.address().port}`;
  async function connect() {
    const client = io(url, { transports: ["websocket"], forceNew: true });
    client.states = [];
    client.messages = [];
    client.secrets = [];
    client.draws = [];
    client.on("state", (state) => { client.state = state; client.states.push(state); });
    client.on("message", (message) => client.messages.push(message));
    client.on("secret", (word) => client.secrets.push(word));
    client.on("draw", (point) => client.draws.push(point));
    client.on("drawing:clear", (revision) => { client.revision = revision; });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    return client;
  }
  const host = await connect();
  const created = await send(host, "room:create", { name: "Host" });
  assert.equal(created.ok, true);
  const code = created.code;
  for (let i = 1; i < count; i++) {
    const client = await connect();
    assert.equal((await send(client, "room:join", { code, name: `Player ${i}` })).ok, true);
  }
  await until(() => host.state?.players.length === count);
  return { game, clients, host, code, connect, url };
}
function send(client, event, data = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(2000).emit(event, data, (error, result) => error ? reject(error) : resolve(result));
  });
}
async function start(host) {
  assert.equal((await send(host, "game:start")).ok, true);
  await until(() => host.state?.phase === "drawing");
}

test("serves the playable app and health endpoint", async (t) => {
  const { url } = await setup(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Draw Together/);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${url}/socket.io/socket.io.js`)).status, 200);
});

test("requires 2 players and caps rooms at 8 with unique names", async (t) => {
  const { host, code, connect } = await setup(t, 1);
  assert.match((await send(host, "game:start")).error, /at least 2/);
  const second = await connect();
  assert.match((await send(second, "room:join", { name: "HOST", code })).error, /taken/);
  assert.match((await send(second, "room:join", { name: " ", code })).error, /name/);
  assert.match((await send(second, "room:join", { name: "Bob", code: "NOPE" })).error, /not found/);
  for (let i = 1; i < 8; i++) {
    const player = i === 1 ? second : await connect();
    assert.equal((await send(player, "room:join", { name: `Guest ${i}`, code: code.toLowerCase() })).ok, true);
  }
  const ninth = await connect();
  assert.match((await send(ninth, "room:join", { name: "Ninth", code })).error, /full/);
});

test("private words, host-only controls, and default 60-second turns", async (t) => {
  const { host, clients, code, connect } = await setup(t);
  assert.match((await send(clients[1], "game:start")).error, /Only the host/);
  await start(host);
  await until(() => host.secrets.length === 1 && clients[1].state?.phase === "drawing");
  assert.ok(host.state.endsAt - Date.now() > 59000);
  assert.ok(host.state.endsAt - Date.now() <= 60000);
  assert.equal(host.secrets[0], "hot air balloon");
  assert.equal(clients[1].secrets.length, 0);
  assert.equal(host.state.revealedWord, null);
  assert.equal(Object.hasOwn(host.state, "word"), false);
  assert.match((await send(clients[1], "time:add")).error, /Only the host/);
  const oldEnd = host.state.endsAt;
  assert.equal((await send(host, "time:add")).ok, true);
  await until(() => host.state.endsAt === oldEnd + 15000);
  assert.match((await send(host, "game:start")).error, /already started/);
  const late = await connect();
  assert.match((await send(late, "room:join", { name: "Late", code })).error, /in progress/);
});

test("each guesser earns 10, drawer earns 10 once, and correct words aren't public", async (t) => {
  const { host, clients } = await setup(t, 3);
  await start(host);
  assert.match((await send(host, "guess", { text: "hot air balloon" })).error, /drawing/);
  assert.equal((await send(clients[1], "guess", { text: "HOT AIR BALLOON!" })).ok, true);
  await until(() => host.state.players[1].score === 10);
  assert.equal(host.state.phase, "drawing");
  assert.deepEqual(host.state.players.map((p) => p.score), [10, 10, 0]);
  assert.equal(clients[2].secrets.length, 0);
  assert.equal(clients[2].messages.some((m) => /hot air balloon/i.test(m.text)), false);
  assert.match((await send(clients[1], "guess", { text: "hot air balloon" })).error, /already guessed/);
  assert.equal((await send(clients[2], "guess", { text: "hot-air-balloon" })).ok, true);
  await until(() => host.state.phase === "reveal");
  assert.deepEqual(host.state.players.map((p) => p.score), [10, 10, 10]);
  assert.equal(host.state.reason, "Everyone guessed it!");
  assert.equal(host.state.revealedWord, "hot air balloon");
});

test("wrong guesses award no points and timer expiry reveals the word", async (t) => {
  const { host, clients } = await setup(t, 2, { turnSeconds: 0.15, tickMs: 5, revealMs: 1000 });
  await start(host);
  assert.equal((await send(clients[1], "guess", { text: "pizza" })).ok, true);
  await until(() => host.messages.some((m) => m.text === "pizza"));
  await until(() => host.state.phase === "reveal");
  assert.deepEqual(host.state.players.map((p) => p.score), [0, 0]);
  assert.equal(host.state.reason, "Time is up!");
});

test("rejects guesses, drawing and extra time after the deadline before the next timer tick", async (t) => {
  const { host, clients } = await setup(t, 2, { turnSeconds: 0.03, tickMs: 10000 });
  await start(host);
  await delay(60);
  assert.match((await send(clients[1], "guess", { text: "hot air balloon" })).error, /next turn/);
  assert.match((await send(host, "time:add")).error, /active turn/);
  assert.match((await send(host, "draw", { x: 0.2, y: 0.2, color: "#283047", size: 6, start: true, revision: host.state.drawingRevision })).error, /active drawer/);
  assert.deepEqual(host.state.players.map((p) => p.score), [0, 0]);
});

test("only the drawer can draw or clear; coordinates and canvas revisions are validated", async (t) => {
  const { host, clients } = await setup(t);
  await start(host);
  const point = { x: 0.2, y: 0.4, color: "#283047", size: 6, start: true, revision: host.state.drawingRevision };
  assert.match((await send(clients[1], "draw", point)).error, /active drawer/);
  assert.match((await send(clients[1], "drawing:clear")).error, /active drawer/);
  assert.match((await send(host, "draw", { ...point, x: -1 })).error, /Invalid/);
  assert.match((await send(host, "draw", { ...point, color: "red" })).error, /Invalid/);
  assert.equal((await send(host, "draw", point)).ok, true);
  await until(() => clients[1].draws.length === 1);
  assert.deepEqual(clients[1].draws[0], point);
  assert.equal((await send(host, "drawing:clear")).ok, true);
  await until(() => clients[1].revision === point.revision + 1);
  assert.match((await send(host, "draw", point)).error, /canvas changed/);
});

test("every player draws exactly once, then the host can reset scores for another game", async (t) => {
  const { host, clients } = await setup(t, 2, { revealMs: 20, tickMs: 5 });
  await start(host);
  await send(clients[1], "guess", { text: "hot air balloon" });
  await until(() => host.state.phase === "drawing" && host.state.drawerId === clients[1].id);
  await until(() => clients[1].secrets.length === 2);
  assert.equal(host.state.turn, 2);
  await send(host, "guess", { text: "hot air balloon" });
  await until(() => host.state.phase === "finished");
  assert.deepEqual(host.state.players.map((p) => p.score), [20, 20]);
  assert.match((await send(clients[1], "game:start")).error, /Only the host/);
  assert.equal((await send(host, "game:start")).ok, true);
  await until(() => host.state.phase === "drawing");
  assert.equal(host.state.drawerId, host.id);
  assert.deepEqual(host.state.players.map((p) => p.score), [0, 0]);
});

test("8-player game rotates all 8 turns and awards exact totals", async (t) => {
  const { host, clients } = await setup(t, 8, { revealMs: 10, tickMs: 5 });
  await start(host);
  for (let turn = 0; turn < 8; turn++) {
    await until(() => host.state.phase === "drawing" && host.state.turn === turn + 1);
    assert.equal(host.state.drawerId, clients[turn].id);
    for (let i = 0; i < clients.length; i++) {
      if (i !== turn) {
        assert.equal((await send(clients[i], "guess", { text: "hot air balloon" })).ok, true);
      }
    }
  }
  await until(() => host.state.phase === "finished");
  assert.deepEqual(host.state.players.map((p) => p.score), Array(8).fill(80));
});

test("host disconnect transfers ownership and skips the disconnected drawer", async (t) => {
  const { host, clients } = await setup(t, 3, { revealMs: 50, tickMs: 5 });
  await start(host);
  host.disconnect();
  await until(() => clients[1].state?.hostId === clients[1].id && clients[1].state?.phase === "reveal");
  assert.equal(clients[1].state.reason, "The drawer left the room.");
  await until(() => clients[1].state?.phase === "drawing");
  assert.equal(clients[1].state.drawerId, clients[1].id);
  assert.equal((await send(clients[1], "time:add")).ok, true);
});

test("dropping below 2 players returns to lobby and empty rooms are removed", async (t) => {
  const { host, clients, game, code } = await setup(t);
  await start(host);
  clients[1].disconnect();
  await until(() => host.state.phase === "lobby");
  assert.equal(host.state.players.length, 1);
  assert.equal(host.state.endsAt, null);
  assert.match((await send(host, "game:start")).error, /at least 2/);
  host.disconnect();
  await until(() => !game.rooms.has(code));
});

test("untrusted and malformed inputs produce explicit errors without changing room state", async (t) => {
  const { host, clients } = await setup(t);
  await start(host);
  assert.match((await send(clients[1], "guess", null)).error, /Type a guess/);
  assert.match((await send(host, "draw", null)).error, /canvas changed/);
  assert.equal((await send(clients[1], "guess", { text: "<img src=x onerror=alert(1)>" })).ok, true);
  await until(() => host.messages.some((m) => m.text === "<img src=x onerror=alert(1)>"));
  assert.deepEqual(host.state.players.map((p) => p.score), [0, 0]);
});
