import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORDS = [
  ['Espresso', 'Food & drink'], ['Pancake', 'Food & drink'],
  ['Avocado', 'Food & drink'], ['Popcorn', 'Food & drink'],
  ['Penguin', 'Animals'], ['Octopus', 'Animals'], ['Giraffe', 'Animals'],
  ['Airport', 'Places'], ['Library', 'Places'], ['Museum', 'Places'],
  ['Umbrella', 'Everyday things'], ['Headphones', 'Everyday things'],
  ['Telescope', 'Everyday things'], ['Hammock', 'Everyday things'],
  ['Volcano', 'Nature'], ['Rainbow', 'Nature'], ['Waterfall', 'Nature'],
  ['Surfing', 'Activities'], ['Camping', 'Activities'], ['Karaoke', 'Activities'],
  ['Astronaut', 'Jobs'], ['Detective', 'Jobs'], ['Magician', 'Jobs'],
  ['Chess', 'Games'], ['Bowling', 'Games'], ['Basketball', 'Sports'],
];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const MAX_PLAYERS = 12;
const ROOM_TTL = 12 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGES = 100;
const CHAT_COOLDOWN = 1000;

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createGameServer() {
  const rooms = new Map();
  const streams = new Map();
  const fail = (condition, message, status) => {
    if (condition) throw new GameError(message, status);
  };
  function snapshot(room, player) {
    const active = room.phase !== 'lobby';
    const finished = room.phase === 'results';
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      selfId: player.id,
      players: room.players.map(p => ({ id: p.id, name: p.name })),
      round: room.round,
      turnId: room.phase === 'describing' ? room.players[room.turn].id : null,
      clues: room.clues,
      messages: room.messages,
      category: active ? room.category : null,
      word: active && (player.id !== room.imposterId || finished) ? room.word : null,
      isImposter: active ? player.id === room.imposterId : null,
      votedIds: Object.keys(room.votes),
      myVote: room.votes[player.id] ?? null,
      result: finished ? room.result : null,
    };
  }
  function broadcast(room) {
    room.updatedAt = Date.now();
    for (const player of room.players) {
      const clients = streams.get(player.token);
      if (clients) {
        const event = `data: ${JSON.stringify(snapshot(room, player))}\n\n`;
        for (const res of clients) res.write(event);
      }
    }
  }
  function authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.token === token);
      if (player) return { room, player };
    }
    throw new GameError('Your room session has expired. Please join again.', 401);
  }
  function start(room) {
    const choices = WORDS.filter(([word]) => word !== room.word);
    [room.word, room.category] = choices[randomInt(choices.length)];
    room.imposterId = room.players[randomInt(room.players.length)].id;
    room.phase = 'describing';
    room.round = 1;
    room.turn = 0;
    room.clues = [];
    room.votes = {};
    room.result = null;
  }
  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      fail(Buffer.byteLength(data) > 4096, 'Request is too large.', 413);
    }
    try { return JSON.parse(data || '{}'); }
    catch { throw new GameError('Please send a valid JSON request.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        return res.end(await readFile(path.join(ROOT, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const { room, player } = authenticate(req);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(snapshot(room, player)));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const { room, player } = authenticate(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (!streams.has(player.token)) streams.set(player.token, new Set());
        streams.get(player.token).add(res);
        res.write(`data: ${JSON.stringify(snapshot(room, player))}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
        res.on('close', () => {
          clearInterval(heartbeat);
          const clients = streams.get(player.token);
          clients?.delete(res);
          if (!clients?.size) streams.delete(player.token);
        });
        return;
      }
      fail(req.method !== 'POST' || !url.pathname.startsWith('/api/'), 'Not found.', 404);
      if (req.headers.origin) {
        fail(new URL(req.headers.origin).host !== req.headers.host, 'This request is not allowed.', 403);
      }
      const input = await body(req);
      fail(!input || typeof input !== 'object' || Array.isArray(input), 'Invalid request.');
      let room, player;
      if (url.pathname === '/api/create' || url.pathname === '/api/join') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        fail(!name || name.length > 24, 'Enter a name between 1 and 24 characters.');
        if (url.pathname === '/api/create') {
          fail(rooms.size >= 1000, 'The server is full. Please try again later.', 503);
          let code;
          do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
          room = { code, phase: 'lobby', players: [], clues: [], messages: [], votes: {}, round: 0, updatedAt: Date.now() };
          rooms.set(code, room);
        } else {
          room = rooms.get(String(input.code ?? '').trim().toUpperCase());
          fail(!room, 'Room not found. Check the code and try again.', 404);
          fail(room.phase !== 'lobby', 'This game has already started. Join the next game.');
          fail(room.players.length >= MAX_PLAYERS, 'This room is full (12 players maximum).');
          fail(room.players.some(p => p.name.toLowerCase() === name.toLowerCase()), 'That name is already in this room.');
        }
        player = { id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('hex'), name };
        room.players.push(player);
        room.hostId ??= player.id;
        broadcast(room);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ token: player.token, state: snapshot(room, player) }));
      }
      ({ room, player } = authenticate(req));
      switch (url.pathname) {
        case '/api/chat': {
          const text = typeof input.text === 'string' ? input.text.trim() : '';
          fail(!text || text.length > 300, 'Write a chat message between 1 and 300 characters.');
          const now = Date.now();
          fail(player.lastChatAt !== undefined && now - player.lastChatAt < CHAT_COOLDOWN, 'Give everyone a moment. Send one message per second.', 429);
          player.lastChatAt = now;
          room.messages.push({
            id: randomBytes(8).toString('hex'),
            playerId: player.id,
            name: player.name,
            text,
            sentAt: now,
          });
          if (room.messages.length > MAX_CHAT_MESSAGES) room.messages.shift();
          break;
        }
        case '/api/start':
          fail(player.id !== room.hostId, 'Only the host can start the game.', 403);
          fail(room.phase !== 'lobby', 'The game is already in progress.');
          fail(room.players.length < 3, 'You need at least 3 players to start.');
          start(room);
          break;
        case '/api/clue': {
          fail(room.phase !== 'describing', 'It is not time for descriptions.');
          fail(room.players[room.turn].id !== player.id, 'Wait for your turn.');
          const text = typeof input.text === 'string' ? input.text.trim() : '';
          fail(!text || text.length > 160, 'Write a description between 1 and 160 characters.');
          room.clues.push({ playerId: player.id, round: room.round, text });
          room.turn++;
          if (room.turn === room.players.length) {
            room.turn = 0;
            room.phase = 'voting';
          }
          break;
        }
        case '/api/vote': {
          fail(room.phase !== 'voting', 'Voting is not open.');
          fail(Boolean(room.votes[player.id]), 'Your vote is already locked in.');
          fail(input.playerId === player.id, 'You cannot vote for yourself.');
          fail(!room.players.some(p => p.id === input.playerId), 'Choose a player in this room.');
          room.votes[player.id] = input.playerId;
          if (Object.keys(room.votes).length === room.players.length) {
            const counts = Object.fromEntries(room.players.map(p => [p.id, 0]));
            for (const id of Object.values(room.votes)) counts[id]++;
            const highest = Math.max(...Object.values(counts));
            const leaders = room.players.filter(p => counts[p.id] === highest);
            const caught = leaders.length === 1 && leaders[0].id === room.imposterId;
            const imposter = room.players.find(p => p.id === room.imposterId);
            room.result = { caught, imposterId: imposter.id, imposterName: imposter.name, counts, tied: leaders.length > 1 };
            room.phase = 'results';
          }
          break;
        }
        case '/api/reset':
          fail(player.id !== room.hostId, 'Only the host can open the next game.', 403);
          fail(room.phase !== 'results', 'Finish this game first.');
          room.phase = 'lobby';
          room.round = 0;
          room.clues = [];
          room.votes = {};
          room.result = null;
          break;
        case '/api/leave':
          fail(room.phase !== 'lobby', 'Players cannot leave during a game. You can reconnect by refreshing.');
          room.players = room.players.filter(p => p.id !== player.id);
          for (const connection of streams.get(player.token) ?? []) connection.end();
          streams.delete(player.token);
          if (!room.players.length) rooms.delete(room.code);
          else room.hostId = room.players[0].id;
          break;
        default:
          throw new GameError('Not found.', 404);
      }
      broadcast(room);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const expected = error instanceof GameError;
      if (!expected) console.error('Request failed:', error);
      if (!res.headersSent) {
        res.writeHead(expected ? error.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: expected ? error.message : 'Something went wrong on the server. Please try again.' }));
      } else res.end();
    }
  });
  const cleanup = setInterval(() => {
    for (const [code, room] of rooms) {
      if (Date.now() - room.updatedAt > ROOM_TTL) {
        for (const p of room.players) {
          for (const stream of streams.get(p.token) ?? []) stream.end();
          streams.delete(p.token);
        }
        rooms.delete(code);
      }
    }
  }, 60000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createGameServer().listen(port, '0.0.0.0', () => console.log(`Imposter is ready at http://localhost:${port}`));
}
