# Draw Together

A real-time Pictionary-style game for 2–8 friends. Each player joins from their own
phone or computer using a shared room code or invite link.

## Run locally

This copy is integrated into the Imposter host. From the repository root, use
Node.js 22 or newer and run:

```powershell
npm ci
npm start
```

Open `http://localhost:3000/doodle/`. To play on the same Wi-Fi, other players should open
the host computer's LAN address, for example `http://192.168.1.20:3000`. Allow
inbound traffic on that port through your firewall. `localhost` links only work
on the host computer, so copy the invite from the LAN URL for other devices.

For players on different networks, deploy this Node.js application to a host
supporting persistent HTTP/WebSocket connections, with HTTPS. Set `PORT` if needed.
This is not a static-only site. The app binds to all network interfaces.

## How to play

1. Enter a nickname, create a room, and share the code or invite link.
2. With 2–8 players in the room, the host starts the game.
3. Each player gets one drawing turn per game, in join order, with a private word
   and a 60-second timer. Only the drawer sees the word until a correct guess.
4. The host can add 15 seconds at a time during an active turn.
5. Every correct guesser earns **10 points**, once per turn. The drawer earns
   **10 points total** if at least one person guesses correctly. No correct
   guesses means no points for anyone. Case, spaces, and punctuation are ignored.
6. A turn ends when time runs out or everyone has guessed. After a short reveal,
   the next player draws. After everyone has drawn, the highest score wins;
   ties share the win. The host can start a new game with scores reset.

Drawing supports mouse, pen, and touch, nine colors, adjustable brush width,
an eraser, and clearing the canvas. Guesses and drawings are validated by the
server. Guessers cannot draw, award points, change the timer, or see the
secret word in room state. Correct answers aren't broadcast into the chat.

## Room lifecycle

- Rooms are held in memory in one server process. Restarting the server clears
  all rooms. Multi-instance deployment requires shared room state and routing;
  it is not supported by this starter.
- Players can join in the lobby or after a game finishes, not during a game.
- Leaving/disconnecting removes the player and their score. There is no session
  recovery. If the host leaves, the next connected player becomes host.
- If the drawer leaves, their turn ends. Disconnected players' later turns
  are skipped. With fewer than two players, the game returns to the lobby.
- Empty rooms are removed. A new game always resets all scores.
- Invite links use the address you're currently visiting. Clipboard access
  requires HTTPS or localhost; when unavailable, the room code is shown instead.

## Development

Run `npm test` from the repository root for both games and the shared-host tests.

The UI is plain HTML/CSS/JavaScript served by Express. Socket.IO synchronizes
room state, drawing strokes, guesses, and authoritative server timers. Tests
start real ephemeral servers and connect independent Socket.IO clients.

This is a casual private-room game, not a hardened public service: it has no
accounts, persistent storage, moderation, or public-service abuse protection.
Fonts are loaded from Google Fonts, with local sans-serif fallbacks.
