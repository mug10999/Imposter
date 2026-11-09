import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import doodle from './doodle/server.js';

const WORDS = [
  ['Espresso', 'Food & drink'], ['Pancake', 'Food & drink'],
  ['Avocado', 'Food & drink'], ['Popcorn', 'Food & drink'],
  ['Penguin', 'Animals'], ['Octopus', 'Animals'], ['Giraffe', 'Animals'],
  ['Airport', 'Places'], ['Library', 'Places'], ['Museum', 'Places'],
  ['Umbrella', 'Objects'], ['Headphones', 'Objects'],
  ['Telescope', 'Objects'], ['Hammock', 'Objects'],
  ['Volcano', 'Nature'], ['Rainbow', 'Nature'], ['Waterfall', 'Nature'],
  ['Surfing', 'Activities'], ['Camping', 'Activities'], ['Karaoke', 'Activities'],
  ['Astronaut', 'Jobs'], ['Detective', 'Jobs'], ['Magician', 'Jobs'],
  ['Chess', 'Games & sports'], ['Bowling', 'Games & sports'],
  ['Basketball', 'Games & sports'],
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
      players: room.players.map(p => ({
        id: p.id, name: p.name, score: p.score, gamesPlayed: p.gamesPlayed,
        correctVotes: p.correctVotes, successfulBluffs: p.successfulBluffs,
      })),
      participants: room.participants ?? [],
      round: room.round,
      dealId: room.dealId ?? 0,
      notice: room.notice ?? null,
      turnId: room.phase === 'describing' ? room.players[room.turn].id : null,
      clues: room.clues,
      messages: room.messages,
      category: active ? room.category : null,
      word: active && (player.id !== room.imposterId || finished) ? room.word : null,
      isImposter: active ? player.id === room.imposterId : null,
      votedIds: Object.keys(room.votes),
      votes: room.votes,
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
  function reset(room) {
    room.phase = 'lobby';
    room.round = 0;
    room.turn = 0;
    room.clues = [];
    room.votes = {};
    room.result = null;
    room.participants = [];
  }
  function start(room, keepImposter = false) {
    const choices = WORDS.filter(([word]) => word !== room.word);
    [room.word, room.category] = choices[randomInt(choices.length)];
    if (!keepImposter) room.imposterId = room.players[randomInt(room.players.length)].id;
    const previousOrder = room.players.map(p => p.id);
    for (let i = room.players.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
    }
    if (room.players.every((p, i) => p.id === previousOrder[i])) {
      room.players.push(room.players.shift());
    }
    room.phase = 'describing';
    room.round = 1;
    room.dealId = (room.dealId ?? 0) + 1;
    room.participants = room.players.map(p => ({ id: p.id, name: p.name }));
    room.turn = 0;
    room.clues = [];
    room.votes = {};
    room.result = null;
    room.notice = keepImposter ? 'The host refreshed the word. Same imposter, new clues and turn order.' : null;
  }
  function finishVoting(room) {
    if (room.phase !== 'voting' || Object.keys(room.votes).length !== room.players.length) return;
    const counts = Object.fromEntries(room.players.map(p => [p.id, 0]));
    for (const id of Object.values(room.votes)) counts[id]++;
    const highest = Math.max(...Object.values(counts));
    const leaders = room.players.filter(p => counts[p.id] === highest);
    const caught = leaders.length === 1 && leaders[0].id === room.imposterId;
    const imposter = room.players.find(p => p.id === room.imposterId);
    for (const player of room.players) {
      player.gamesPlayed++;
      if (player.id === room.imposterId) {
        if (!caught) {
          player.score += 2;
          player.successfulBluffs++;
        }
      } else if (room.votes[player.id] === room.imposterId) {
        player.score++;
        player.correctVotes++;
      }
    }
    room.result = { caught, imposterId: imposter.id, imposterName: imposter.name, counts, tied: leaders.length > 1 };
    room.phase = 'results';
  }
  function removePlayer(room, player, kicked = false) {
    const active = ['describing', 'voting'].includes(room.phase);
    const removedIndex = room.players.indexOf(player);
    room.players.splice(removedIndex, 1);
    const message = kicked ? 'You were removed from the room by the host.' : 'You left the room.';
    for (const connection of streams.get(player.token) ?? []) {
      connection.end(`data: ${JSON.stringify({ removed: true, message })}\n\n`);
    }
    streams.delete(player.token);
    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) room.hostId = room.players[0].id;
    room.notice = `${player.name} ${kicked ? 'was removed by the host' : 'left the room'}.`;
    if (!active) return;
    if (player.id === room.imposterId || room.players.length < 3) {
      reset(room);
      room.notice += ' The game returned to the lobby because the imposter left or fewer than three players remain.';
      return;
    }
    delete room.votes[player.id];
    for (const [voter, target] of Object.entries(room.votes)) {
      if (target === player.id) delete room.votes[voter];
    }
    if (room.phase === 'describing') {
      if (removedIndex < room.turn) room.turn--;
      if (room.turn === room.players.length) {
        room.turn = 0;
        room.phase = 'voting';
      }
    }
    if (room.phase === 'voting') {
      room.notice += ' Votes for the departed player were cleared; choose again if needed.';
      finishVoting(room);
    }
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
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/doodle' || pathname.startsWith('/doodle/')) {
      return drawingGame.app(req, res);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/imposter') {
        res.writeHead(308, { Location: `/imposter/${url.search}` });
        return res.end();
      }
      if (url.pathname.startsWith('/imposter/')) {
        url.pathname = url.pathname.slice('/imposter'.length);
      }
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
        player = {
          id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('hex'), name,
          score: 0, gamesPlayed: 0, correctVotes: 0, successfulBluffs: 0,
        };
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
        case '/api/refresh':
          fail(player.id !== room.hostId, 'Only the host can refresh the word.', 403);
          fail(!['describing', 'voting'].includes(room.phase), 'Refresh the word during clues or voting.');
          start(room, true);
          break;
        case '/api/kick': {
          fail(player.id !== room.hostId, 'Only the host can remove players.', 403);
          fail(input.playerId === player.id, 'Use Leave room to leave your own room.');
          const target = room.players.find(p => p.id === input.playerId);
          fail(!target, 'Choose a player in this room.');
          removePlayer(room, target, true);
          break;
        }
        case '/api/clue': {
          fail(room.phase !== 'describing', 'It is not time for descriptions.');
          fail(room.players[room.turn].id !== player.id, 'Wait for your turn.');
          const text = typeof input.text === 'string' ? input.text.trim() : '';
          fail(!text || text.length > 160, 'Write a description between 1 and 160 characters.');
          room.clues.push({ playerId: player.id, name: player.name, round: room.round, text });
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
          finishVoting(room);
          break;
        }
        case '/api/reset':
          fail(player.id !== room.hostId, 'Only the host can open the next game.', 403);
          fail(room.phase !== 'results', 'Finish this game first.');
          reset(room);
          room.notice = null;
          break;
        case '/api/leave':
          removePlayer(room, player);
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
  const drawingGame = doodle.createGameServer({ httpServer: server, basePath: '/doodle' });
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
