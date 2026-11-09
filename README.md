# IMPOSTER

A real-time, browser-based social deduction game for 3-12 teammates, with
Draw Together Pictionary hosted separately at `/doodle/`. No accounts or build
step required. Requires Node.js 22 or newer.

## Run

```sh
npm ci
npm start
```

Open `http://localhost:3000`. On Windows with PowerShell script restrictions, use
`npm.cmd start`. Change the port using the `PORT` environment variable.

The game also works at `/imposter/`, including room invites, assets, APIs, and
live chat. Opening `/imposter` redirects to `/imposter/` while preserving invite
parameters. The original root address remains supported.

## Draw Together

Open https://anveda.azurewebsites.net/doodle/ (or `http://localhost:3000/doodle/`)
for the separate 2-8 player drawing and guessing game. `/doodle` redirects to
`/doodle/`, preserving invite parameters. Create a room and share its invite link;
each player gets a 60-second drawing turn, correct guesses earn 10 points, and
the host can add 15 seconds during a turn. The drawer earns 10 points once when
anyone guesses correctly. Highest total wins after everyone has drawn.

The source is imported from `mug10999/doodle` commit
`05c3bdc59a2c9ff12915bfb1a8f096c4b7e1f816`. Its CommonJS server and original
game tests live in `doodle/`; the root server mounts its Express handler on the
same HTTP server with Socket.IO isolated at `/doodle/socket.io`. Assets, home and
leave links, invite URLs, and `/doodle/health` stay within that prefix. Imposter
retains its own root and `/imposter/` assets, APIs, SSE connections and rooms.
Run installation and tests from the repository root, not from `doodle/`.

Both games use in-memory rooms. Deploying or restarting clears active games.
Draw Together disconnects a leaving/refreshing player rather than retaining
their seat, transfers host ownership when needed, and removes empty rooms.
Use one server instance; multiple instances cannot share either game's rooms.

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
   A valid invite link opens only **Slip into a room**, with the code prefilled,
   instead of showing the create-room option. The normal home page offers both.
2. Teammates enter their names and join. The host starts once at least three
   players are present.
3. Exactly one randomly selected player is the imposter and only sees the
   category. Everyone else can privately reveal the same word, with its category
   underneath. Categories are broad (such as "Objects", "Animals", or "Nature")
   rather than hints that nearly identify the word. All role cards, including
   the imposter's, start hidden and can be revealed or hidden with the same
   button. Hidden cards do not disclose the role or category.
4. Turn order is shuffled each game and shown in the player list. Each player
   submits one description in turn order. Voting opens immediately
   after every player has submitted their clue.
5. Everyone votes for another player. One **Clues & votes** summary shows each
   player's clue and locked vote together, then adds their final votes received
   at results. It stays expanded throughout clues, voting, and results, and
   preserves departed players' clues and any completed vote history.
   Votes cannot be changed unless their target leaves the active game. Once
   everyone votes, the imposter is caught only if they alone receive the most
   votes. A tie or a different winner means the imposter survives.
6. Everyone sees the imposter's name, the outcome, the word, and vote totals.
   The host can return to the lobby, admit new players, and start another game
   with a fresh word and randomly selected imposter.

Refreshing reconnects to the same seat in that browser tab. Use separate browser
profiles or devices for multiple players. Seats are not removed on a temporary
disconnect. Players can leave in any phase, and the host can kick anyone else
using the player list. Removed players lose access immediately. Host ownership
transfers only when the host leaves. During clues or voting, the game continues
with the remaining players, skipping a departed player's turn and clearing votes
by or for them. If the imposter leaves or fewer than three players remain, the
game returns to the lobby instead. Completed results stay available if players
leave after voting.

During clues or voting, the host can **Refresh word**. This chooses a different
word with its broad category, keeps the same imposter, shuffles turn order, hides
everyone's card again, and clears all clues and votes to restart the clue round.
Room chat is preserved.

Each room draws from 200 familiar words across eight broad categories without
repeating a word until the entire pool has been used. Refreshing the word counts
as using it, and returning to the lobby or cancelling a game does not clear
the room's word history. After all 200 words, a new cycle begins without
repeating the immediately previous word. History is private to the server and
independent for each room; room expiry or a server restart clears it.

## Room scorecard

The combined turn-order and scorecard panel shows each player's total points,
games played, correct votes, and successful bluffs next to their speaking-order
number. Rows stay in turn order, not score order, and the current speaker is
highlighted. A non-imposter earns **1 point for voting for the imposter**,
even if the imposter survives. The imposter earns **2 points for surviving**,
including tied votes, and zero when caught. Incorrect votes earn zero; there
are no penalties.

Scores are awarded once, only when voting finishes. A word refresh or cancelled
game awards no points or games played. Scores carry across games and returning
to the lobby, and browser refreshes or temporary disconnects retain them.
Leaving or being kicked removes that player's score; rejoining starts at zero.
Other players keep their scores, including when a departure cancels a game.
Like rooms, scores live in server memory and are lost on server restart or room
expiry. The scorecard is visible during every phase.

## Mobile play

Open the same game link in your phone's browser; no separate app is needed.
On small screens, the room opens directly on the game card and current action,
with the combined turn-order/scorecard panel and chat below. The unified clues
and votes summary stays expanded without nested scrolling. Forms use phone-sized
text and touch targets, and **How to play**
stays available in the header. The layout supports portrait and landscape,
safe-area insets, and long player names without horizontal scrolling.

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

The existing Azure app uses manual ZIP deployment (OneDeploy), not a connected
source-control branch. The checked-in GitHub Actions workflow is an unconfigured
template and is not the production deployment path. Deployment commits use
`[skip ci]` to avoid invoking that template. Persist changes on the deployment
branch before publishing a ZIP of that exact commit with production dependencies
installed using `npm ci --omit=dev`. Publish to the existing `anveda` app in
`imposter-game-rg` using the signed-in Azure CLI identity; no publish profile or
new Azure resources are needed. Do not include `.git`, `.env`, or credentials.

Room state lives in server memory and expires after 12 hours without room
activity (including chat). Restarting the process loses all rooms. Run a single
server instance; multiple independent instances do not share rooms. This lightweight version is
for trusted teams, not a hardened public service: it does not include public
traffic rate limiting, moderation, persistent storage, or account recovery.

Private roles and words are filtered on the server for each player, including
live event streams. Player credentials stay in browser session storage, and
other players' credentials are never sent to clients. Individual ballots are
intentionally public to everyone in the room as soon as they are locked.
Protect the host machine and use HTTPS outside a trusted local network.
