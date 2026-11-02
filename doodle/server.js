const express = require("express");
const { createServer } = require("node:http");
const { randomInt, randomBytes } = require("node:crypto");
const { Server } = require("socket.io");
const path = require("node:path");

const WORDS = [
  "airplane", "rainbow", "snowman", "volcano", "butterfly", "treehouse",
  "elephant", "skateboard", "lighthouse", "pineapple", "astronaut", "popcorn",
  "jellyfish", "sunflower", "robot", "campfire", "waterfall", "dinosaur",
  "umbrella", "octopus", "castle", "bicycle", "penguin", "guitar", "mermaid",
  "telescope", "hot air balloon", "treasure chest", "roller coaster", "birthday cake",
  "pirate ship", "ice cream", "flying saucer", "sandcastle", "fire truck",
  "dragon", "cactus", "helicopter", "windmill", "watermelon", "kangaroo",
  "snowflake", "toothbrush", "rocket", "scarecrow", "mushroom", "crocodile",
  "washing machine", "traffic light", "ferris wheel", "sleeping bag", "sunglasses",
  "beehive", "submarine", "pizza", "squirrel", "backpack", "diamond", "turtle"
];
const COLORS = ["#283047", "#ffffff", "#ef6461", "#f0ac43", "#f5d85b", "#59b68c", "#56a8dd", "#7c66db", "#d279b9"];

function createGameServer({ turnSeconds = 60, revealMs = 4500, tickMs = 250, wordPicker, httpServer: sharedServer, basePath = "" } = {}) {
  const app = express();
  const httpServer = sharedServer || createServer(app);
  const io = new Server(httpServer, { path: `${basePath}/socket.io`, maxHttpBufferSize: 64 * 1024 });
  const rooms = new Map();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  if (basePath) {
    app.get(basePath, (req, res, next) => {
      if (req.path.endsWith("/")) return next();
      res.redirect(308, `${basePath}/${req.url.slice(req.path.length)}`);
    });
  }
  app.use(`${basePath}/`, express.static(path.join(__dirname, "public")));
  app.get(`${basePath}/health`, (_req, res) => res.json({ ok: true }));

  const normalized = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const playerName = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 20) : "";
  const roomFor = (socket) => rooms.get(socket.data.roomCode);
  const drawerFor = (room) => room.players.find((p) => p.id === room.order[room.turn]);
  function snapshot(room) {
    return {
      code: room.code, hostId: room.hostId, phase: room.phase,
      players: room.players.map(({ id, name, score, guessed }) => ({ id, name, score, guessed })),
      drawerId: room.order[room.turn] || null,
      turn: room.turn + 1, totalTurns: room.order.length,
      endsAt: room.endsAt, serverNow: Date.now(),
      wordLength: room.phase === "drawing" ? room.word.length : 0,
      revealedWord: room.phase === "reveal" || room.phase === "finished" ? room.word : null,
      reason: room.reason,
      drawingRevision: room.drawingRevision
    };
  }
  function publish(room) {
    io.to(room.code).emit("state", snapshot(room));
  }
  function message(room, text, kind = "system") {
    io.to(room.code).emit("message", { text, kind });
  }
  function finishTurn(room, reason) {
    if (room.phase !== "drawing") return;
    room.phase = "reveal";
    room.reason = reason;
    room.endsAt = Date.now() + revealMs;
    publish(room);
    message(room, `The word was "${room.word}".`, "reveal");
  }
  function nextTurn(room) {
    room.turn += 1;
    if (room.turn >= room.order.length) {
      room.phase = "finished";
      room.endsAt = null;
      publish(room);
      return;
    }
    if (!drawerFor(room)) return nextTurn(room);
    room.phase = "drawing";
    const remaining = WORDS.filter((word) => !room.usedWords.has(word));
    room.word = wordPicker ? wordPicker() : remaining[randomInt(remaining.length)];
    room.usedWords.add(room.word);
    room.reason = "";
    room.endsAt = Date.now() + turnSeconds * 1000;
    room.players.forEach((p) => {
      p.guessed = false;
      const connection = io.sockets.sockets.get(p.id);
      if (connection) connection.data.lastGuess = 0;
    });
    room.strokes = [];
    room.drawingRevision += 1;
    io.to(room.code).emit("drawing:clear", room.drawingRevision);
    publish(room);
    io.to(room.order[room.turn]).emit("secret", room.word);
    message(room, `${drawerFor(room).name} is drawing. Take a guess!`);
  }
  const ticker = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.endsAt || Date.now() < room.endsAt) continue;
      if (room.phase === "drawing") finishTurn(room, "Time is up!");
      else if (room.phase === "reveal") nextTurn(room);
    }
  }, tickMs);
  ticker.unref();
  httpServer.on("close", () => clearInterval(ticker));

  io.on("connection", (socket) => {
    function handle(event, fn) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          fn(payload, reply);
        } catch (error) {
          console.error(`Failed to handle ${event}:`, error);
          reply({ error: "Something went wrong. Please try again." });
        }
      });
    }
    function join(room, name, reply) {
      room.players.push({ id: socket.id, name, score: 0, guessed: false });
      socket.data.roomCode = room.code;
      socket.join(room.code);
      reply({ ok: true, code: room.code });
      publish(room);
      message(room, `${name} joined the room.`);
    }
    handle("room:create", (payload, reply) => {
      if (roomFor(socket)) return reply({ error: "Leave your current room first." });
      const name = playerName(payload?.name);
      if (!name) return reply({ error: "Enter your name to create a room." });
      let code;
      do { code = randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(code));
      const room = {
        code, hostId: socket.id, players: [], phase: "lobby",
        order: [], turn: -1, endsAt: null, word: "", reason: "",
        strokes: [], drawingRevision: 0, usedWords: new Set()
      };
      rooms.set(code, room);
      join(room, name, reply);
    });
    handle("room:join", (payload, reply) => {
      if (roomFor(socket)) return reply({ error: "Leave your current room first." });
      const name = playerName(payload?.name);
      const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!name) return reply({ error: "Enter your name to join." });
      if (!room) return reply({ error: "Room not found. Check the code and try again." });
      if (room.players.length >= 8) return reply({ error: "This room is full (8 players maximum)." });
      if (room.phase !== "lobby" && room.phase !== "finished") return reply({ error: "This game is in progress. Join after it finishes." });
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return reply({ error: "That name is taken. Pick another name." });
      join(room, name, reply);
    });
    handle("game:start", (_payload, reply) => {
      const room = roomFor(socket);
      if (!room || room.hostId !== socket.id) return reply({ error: "Only the host can start the game." });
      if (room.phase !== "lobby" && room.phase !== "finished") return reply({ error: "The game has already started." });
      if (room.players.length < 2) return reply({ error: "You need at least 2 players to start." });
      room.players.forEach((p) => { p.score = 0; p.guessed = false; });
      room.order = room.players.map((p) => p.id);
      room.turn = -1;
      room.usedWords.clear();
      nextTurn(room);
      reply({ ok: true });
    });
    handle("time:add", (_payload, reply) => {
      const room = roomFor(socket);
      if (!room || room.hostId !== socket.id) return reply({ error: "Only the host can add time." });
      if (room.phase !== "drawing" || Date.now() >= room.endsAt) return reply({ error: "You can only add time during an active turn." });
      room.endsAt += 15000;
      publish(room);
      message(room, "The host added 15 seconds.", "time");
      reply({ ok: true });
    });
    handle("guess", (payload, reply) => {
      const room = roomFor(socket);
      if (!room || room.phase !== "drawing" || Date.now() >= room.endsAt) return reply({ error: "Wait for the next turn to guess." });
      const player = room.players.find((p) => p.id === socket.id);
      if (socket.id === room.order[room.turn]) return reply({ error: "You are drawing this turn!" });
      if (player.guessed) return reply({ error: "You already guessed it! Let the others try." });
      const text = typeof payload?.text === "string" ? payload.text.trim().slice(0, 80) : "";
      if (!text) return reply({ error: "Type a guess first." });
      if (Date.now() - (socket.data.lastGuess || 0) < 400) return reply({ error: "Give it a moment before guessing again." });
      socket.data.lastGuess = Date.now();
      if (normalized(text) === normalized(room.word)) {
        player.guessed = true;
        player.score += 10;
        if (room.players.filter((p) => p.guessed).length === 1) drawerFor(room).score += 10;
        socket.emit("secret", room.word);
        message(room, `${player.name} guessed it! +10 points`, "correct");
        publish(room);
        if (room.players.every((p) => p.id === room.order[room.turn] || p.guessed)) finishTurn(room, "Everyone guessed it!");
      } else {
        io.to(room.code).emit("message", { name: player.name, text, kind: "guess" });
      }
      reply({ ok: true });
    });
    handle("draw", (payload, reply) => {
      const room = roomFor(socket);
      if (!room || room.phase !== "drawing" || room.order[room.turn] !== socket.id || Date.now() >= room.endsAt) return reply({ error: "Only the active drawer can draw." });
      if (payload?.revision !== room.drawingRevision) return reply({ error: "The canvas changed. Try drawing again." });
      const { x, y, color, size, start } = payload || {};
      if (![x, y, size].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || size < 1 || size > 40 || !COLORS.includes(color)) return reply({ error: "Invalid drawing data." });
      if (room.strokes.length >= 20000) return reply({ error: "The canvas is full. Clear it to keep drawing." });
      const point = { x, y, color, size, start: Boolean(start), revision: room.drawingRevision };
      room.strokes.push(point);
      socket.to(room.code).emit("draw", point);
      reply({ ok: true });
    });
    handle("drawing:clear", (_payload, reply) => {
      const room = roomFor(socket);
      if (!room || room.phase !== "drawing" || room.order[room.turn] !== socket.id || Date.now() >= room.endsAt) return reply({ error: "Only the active drawer can clear the canvas." });
      room.strokes = [];
      room.drawingRevision += 1;
      io.to(room.code).emit("drawing:clear", room.drawingRevision);
      reply({ ok: true });
    });
    socket.on("disconnect", () => {
      const room = roomFor(socket);
      if (!room) return;
      const player = room.players.find((p) => p.id === socket.id);
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (!room.players.length) {
        rooms.delete(room.code);
        return;
      }
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      message(room, `${player.name} left the room.`);
      if (room.phase === "drawing" || room.phase === "reveal") {
        if (room.players.length < 2) {
          room.phase = "lobby";
          room.endsAt = null;
          room.order = [];
          room.turn = -1;
          room.players.forEach((p) => { p.guessed = false; });
          message(room, "Game paused: invite another player, then start a new game.");
        } else if (room.phase === "drawing" && room.order[room.turn] === socket.id) {
          finishTurn(room, "The drawer left the room.");
        } else if (room.phase === "drawing" && room.players.every((p) => p.id === room.order[room.turn] || p.guessed)) {
          finishTurn(room, "Everyone remaining guessed it!");
        }
      }
      publish(room);
    });
  });
  return {
    app, httpServer, io, rooms,
    close: () => { clearInterval(ticker); return new Promise((resolve) => io.close(resolve)); }
  };
}

if (require.main === module) {
  const { httpServer } = createGameServer();
  const port = process.env.PORT || 3000;
  httpServer.listen(port, "0.0.0.0", () => console.log(`Draw Together is running on http://localhost:${port}`));
}
module.exports = { createGameServer };
