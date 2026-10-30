# IMPOSTER

A real-time, browser-based social deduction game for 3-12 teammates. No accounts,
dependencies, or build step required. Requires Node.js 22 or newer.

## Run

```sh
npm start
```

Open `http://localhost:3000`. On Windows with PowerShell script restrictions, use
`npm.cmd start`. Change the port using the `PORT` environment variable.

The game also works at `/imposter/`, including room invites, assets, APIs, and
live chat. Opening `/imposter` redirects to `/imposter/` while preserving invite
parameters. The original root address remains supported.

The Azure deployment is available at
https://anveda.azurewebsites.net/imposter/. It uses the existing Basic B1 App
Service plan in West US 3 with HTTPS and Always On. The Azure hostname has no
separate domain registration charge; the B1 hosting plan still incurs charges.

For teammates on the same network, share the host machine's reachable network
address (for example `http://192.168.1.20:3000`), not `localhost`. The host's
firewall must allow that port. Remote teammates need this Node server hosted on a
reachable service with HTTPS and support for streaming HTTP responses (SSE).
The app is not a static-only website; all players must reach the same server.

## Play

1. Enter your name, create a room, and share its invite link or six-character code.
2. Teammates enter their names and join. The host starts once at least three
   players are present.
3. Exactly one randomly selected player is the imposter and only sees the
   category. Everyone else can privately reveal the same word, with its category
   underneath. Categories give descriptive context (such as "Weather & outdoor
   gear") without naming the word. Word cards start hidden to reduce accidental
   screen sharing.
4. Each player submits one description in turn order. Voting opens immediately
   after every player has submitted their clue.
5. Everyone secretly votes for another player. Votes cannot be changed. Once
   everyone votes, the imposter is caught only if they alone receive the most
   votes. A tie or a different winner means the imposter survives.
6. Everyone sees the imposter's name, the outcome, the word, and vote totals.
   The host can return to the lobby, admit new players, and start another game
   with a fresh word and randomly selected imposter.

Refreshing reconnects to the same seat in that browser tab. Use separate browser
profiles or devices for multiple players. Seats are not removed on a temporary
disconnect. Players may leave only in the lobby; host ownership then transfers
to the next player. There is no mid-game kick/skip mechanism, so every player
must finish their turns and vote.

## Room chat

Use **Room chat** to talk with everyone in your room during the lobby, clue
round, voting, and results. Chat is separate from clues and never uses your turn
or casts a vote. Messages show the sender's name and time and arrive live.
Keep the secret word out of chat!

Each message can contain up to 300 characters, with one message per player per
second. The latest 100 messages stay available when you refresh or play another
game in the same room. Chat is room-wide, not private messaging. It lives in
server memory with the room and disappears when the room expires or the server
restarts.

## Tests

```sh
npm test
```

On restricted Windows PowerShell, use `npm.cmd test`.

## Hosting notes

Room state lives in server memory and expires after 12 hours without room
activity (including chat). Restarting the process loses all rooms. Run a single
server instance; multiple independent instances do not share rooms. This lightweight version is
for trusted teams, not a hardened public service: it does not include public
traffic rate limiting, moderation, persistent storage, or account recovery.

Private roles and words are filtered on the server for each player, including
live event streams. Player credentials stay in browser session storage, and
other players' credentials and individual ballots are never sent to clients.
Protect the host machine and use HTTPS outside a trusted local network.
