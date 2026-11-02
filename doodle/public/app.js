/* global io */
const $ = (id) => document.getElementById(id);
const socket = io({ autoConnect: false, path: new URL("./socket.io", window.location.href).pathname });
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const palette = ["#283047", "#ffffff", "#ef6461", "#f0ac43", "#f5d85b", "#59b68c", "#56a8dd", "#7c66db", "#d279b9"];
let state = null;
let secret = "";
let color = palette[0];
let brush = 6;
let erasing = false;
let pointerDown = false;
let lastPoint = null;
let strokes = [];
let revision = 0;
let clockOffset = 0;
let toastTimeout;
let pendingEntry = false;
let lastSent = 0;
let pendingPoint = null;
let frame = null;
let drawErrorShown = false;
const avatarColors = [["#eee6fb", "#8060be"], ["#fbe9d8", "#bb8752"], ["#e1f0e6", "#639477"], ["#e1edf9", "#608cb4"], ["#f8e3ed", "#b96e95"], ["#f4eed6", "#a6954d"], ["#e3eff0", "#5e9296"], ["#eae6e1", "#968574"]];

function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.remove("hidden");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("toast").classList.add("hidden"), 4000);
}
function request(event, data = {}) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error("Not connected. Please wait or refresh the page."));
    socket.timeout(6000).emit(event, data, (error, result) => {
      if (error) reject(new Error("The server didn't respond. Please try again."));
      else if (result?.error) reject(new Error(result.error));
      else resolve(result);
    });
  });
}
function isDrawer() {
  return state?.phase === "drawing" && state.drawerId === socket.id;
}
function canDraw() {
  return isDrawer() && socket.connected && Date.now() + clockOffset < state.endsAt;
}
function addMessage(message) {
  const row = document.createElement("div");
  row.className = `message ${message.kind}`;
  if (message.name) {
    const name = document.createElement("strong");
    name.textContent = message.name;
    row.append(name);
  }
  const text = document.createElement("span");
  text.textContent = message.text;
  row.append(text);
  $("messages").append(row);
  while ($("messages").children.length > 150) $("messages").firstChild.remove();
  $("messages").scrollTop = $("messages").scrollHeight;
}
function paint(point) {
  ctx.strokeStyle = point.color;
  ctx.fillStyle = point.color;
  ctx.lineWidth = point.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const x = point.x * canvas.width;
  const y = point.y * canvas.height;
  if (point.start || !lastPoint) {
    ctx.beginPath();
    ctx.arc(x, y, point.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(lastPoint.x * canvas.width, lastPoint.y * canvas.height);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  lastPoint = point;
}
function clearCanvas() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  lastPoint = null;
  strokes = [];
  pointerDown = false;
  pendingPoint = null;
  drawErrorShown = false;
}
function showOverlay(title, copy, icon = "✎") {
  $("stage-overlay").classList.remove("hidden");
  $("overlay-title").textContent = title;
  $("overlay-copy").textContent = copy;
  document.querySelector(".overlay-icon").textContent = icon;
}
function render() {
  if (!state) return;
  const me = state.players.find((p) => p.id === socket.id);
  const host = state.hostId === socket.id;
  const drawer = state.players.find((p) => p.id === state.drawerId);
  const phase = state.phase;
  $("welcome").classList.add("hidden");
  $("how-strip").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("code-label").textContent = state.code;
  $("player-count").textContent = `${state.players.length}/8`;
  $("players").replaceChildren();
  state.players.forEach((player, index) => {
    const row = document.createElement("li");
    row.className = `player${player.id === state.drawerId && phase === "drawing" ? " active" : ""}${player.guessed ? " correct" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = player.name.slice(0, 1).toUpperCase();
    avatar.style.setProperty("--avatar-bg", avatarColors[index][0]);
    avatar.style.setProperty("--avatar-color", avatarColors[index][1]);
    const info = document.createElement("div");
    info.className = "player-info";
    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.name + (player.id === socket.id ? " (you)" : "");
    const role = document.createElement("div");
    role.className = "player-role";
    role.textContent = player.id === state.drawerId && phase === "drawing" ? "Drawing now ✎" : player.guessed ? "Guessed it ✓" : player.id === state.hostId ? "Room host" : "Here for the doodles";
    info.append(name, role);
    const score = document.createElement("div");
    score.className = "player-score";
    score.textContent = player.score;
    const unit = document.createElement("small");
    unit.textContent = "pts";
    score.append(unit);
    row.append(avatar, info, score);
    $("players").append(row);
  });
  $("add-time").classList.toggle("hidden", !(host && phase === "drawing"));
  $("start-button").classList.toggle("hidden", !host || (phase !== "lobby" && phase !== "finished"));
  $("start-button").disabled = state.players.length < 2;
  $("start-button").firstChild.textContent = phase === "finished" ? "Play again " : "Start game ";
  $("waiting-host").classList.toggle("hidden", host || (phase !== "lobby" && phase !== "finished"));
  $("toolbar").querySelectorAll("button,input").forEach((el) => { el.disabled = !isDrawer(); });
  canvas.classList.toggle("drawing", isDrawer());
  $("guess-input").disabled = phase !== "drawing" || isDrawer() || Boolean(me?.guessed);
  $("guess-form").querySelector("button").disabled = $("guess-input").disabled;
  $("guess-input").placeholder = isDrawer() ? "Your canvas is calling…" : me?.guessed ? "You got it! Nicely done." : phase === "drawing" ? "Type your guess…" : "Waiting for the next word…";
  $("guess-note").textContent = isDrawer() ? "Keep your word a secret!" : me?.guessed ? "Give the others a chance to guess" : "Hit enter to send your guess";
  if (phase === "lobby") {
    $("turn-label").textContent = "WAITING ROOM";
    $("word-label").textContent = "Gather your favorite people";
    showOverlay("Better with friends.", `Share your room code and invite your crew.\n${state.players.length < 2 ? "You need at least 2 players to start." : "Your crew is here. Ready when you are!"}`);
    $("canvas-note").textContent = "Everyone gets a turn. Artistic talent is very optional.";
  } else if (phase === "drawing") {
    $("stage-overlay").classList.add("hidden");
    $("turn-label").textContent = `TURN ${state.turn} OF ${state.totalTurns} · ${isDrawer() ? "YOUR SECRET WORD" : `${drawer?.name || "Someone"} IS DRAWING`}`;
    $("word-label").textContent = isDrawer() || me?.guessed ? secret || "Your word is on its way…" : Array(state.wordLength).fill("_").join(" ");
    $("canvas-note").textContent = isDrawer() ? "Draw your word — no letters, no spelling, just your imagination." : "A masterpiece in progress. What could it be?";
  } else if (phase === "reveal") {
    $("turn-label").textContent = `TURN ${state.turn} OF ${state.totalTurns} · ${state.reason}`;
    $("word-label").textContent = `It was ${state.revealedWord}!`;
    $("stage-overlay").classList.add("hidden");
    $("canvas-note").textContent = "A quick breather. The next turn starts in a moment…";
  } else {
    const highest = Math.max(...state.players.map((p) => p.score));
    const winners = state.players.filter((p) => p.score === highest);
    $("turn-label").textContent = "THAT'S A WRAP";
    $("word-label").textContent = "Good doodles. Great company.";
    const title = highest === 0 ? "The canvas wins this one." : winners.length === 1 ? `${winners[0].name} takes the crown!` : "A shared victory!";
    const standings = [...state.players].sort((a, b) => b.score - a.score).map((p) => `${p.name}: ${p.score} points`).join("\n");
    showOverlay(title, standings, "✧");
    $("canvas-note").textContent = "Same crew, fresh canvas? The host can start another game.";
  }
  updateTimer();
}
function updateTimer() {
  if (!state) return;
  const remaining = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - Date.now() - clockOffset) / 1000)) : 60;
  $("timer").replaceChildren(document.createTextNode(state.phase === "finished" ? "✓" : remaining));
  if (state.phase !== "finished") {
    const unit = document.createElement("span");
    unit.textContent = "s";
    $("timer").append(unit);
  }
  $("timer").classList.toggle("urgent", state.phase === "drawing" && remaining <= 10);
}
setInterval(updateTimer, 200);

async function enterRoom(event) {
  if (pendingEntry) return;
  const name = $("player-name").value.trim();
  if (!name) {
    $("entry-error").textContent = "Every artist needs a name. Enter yours above.";
    $("player-name").focus();
    return;
  }
  const code = $("room-code").value.trim();
  if (event === "room:join" && !/^[a-f0-9]{6}$/i.test(code)) {
    $("entry-error").textContent = "Enter the 6-character room code from your host.";
    $("room-code").focus();
    return;
  }
  pendingEntry = true;
  $("entry-error").textContent = "";
  $("create-button").disabled = true;
  $("join-button").disabled = true;
  try {
    if (!socket.connected) {
      await new Promise((resolve, reject) => {
        const cleanup = () => { socket.off("connect", connected); socket.off("connect_error", failed); clearTimeout(timeout); };
        const connected = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("Can't reach the game server. Check your connection and try again.")); };
        const timeout = setTimeout(failed, 7000);
        socket.once("connect", connected);
        socket.once("connect_error", failed);
        socket.connect();
      });
    }
    await request(event, { name, code });
  } catch (error) {
    $("entry-error").textContent = error.message;
  } finally {
    pendingEntry = false;
    $("create-button").disabled = false;
    $("join-button").disabled = false;
  }
}
$("create-button").addEventListener("click", () => enterRoom("room:create"));
$("join-button").addEventListener("click", () => enterRoom("room:join"));
$("room-code").addEventListener("keydown", (e) => { if (e.key === "Enter") enterRoom("room:join"); });
$("player-name").addEventListener("keydown", (e) => { if (e.key === "Enter") enterRoom($("room-code").value ? "room:join" : "room:create"); });
$("start-button").addEventListener("click", async () => {
  try { await request("game:start"); } catch (error) { toast(error.message); }
});
$("add-time").addEventListener("click", async () => {
  try { await request("time:add"); } catch (error) { toast(error.message); }
});
$("leave-button").addEventListener("click", () => {
  if (window.confirm("Leave this room? Your score will be lost.")) window.location.assign("./");
});
$("copy-code").addEventListener("click", async () => {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", state.code);
  try {
    await navigator.clipboard.writeText(url.href);
    toast("Invite link copied. Send it to your crew!");
  } catch {
    toast(`Share this room code: ${state.code}`);
  }
});
$("guess-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("guess-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try { await request("guess", { text }); }
  catch (error) { toast(error.message); if (!input.value) input.value = text; }
});
palette.forEach((hex, i) => {
  const swatch = document.createElement("button");
  const names = ["Ink", "White", "Coral", "Orange", "Yellow", "Green", "Blue", "Purple", "Pink"];
  swatch.className = `swatch${i === 0 ? " selected" : ""}`;
  swatch.style.setProperty("--swatch", hex);
  swatch.title = names[i];
  swatch.setAttribute("aria-label", names[i]);
  swatch.setAttribute("aria-pressed", i === 0 ? "true" : "false");
  swatch.addEventListener("click", () => {
    color = hex;
    erasing = false;
    $("eraser-button").setAttribute("aria-pressed", "false");
    document.querySelectorAll(".swatch").forEach((el) => { el.classList.remove("selected"); el.setAttribute("aria-pressed", "false"); });
    swatch.classList.add("selected");
    swatch.setAttribute("aria-pressed", "true");
  });
  $("colors").append(swatch);
});
$("brush-size").addEventListener("input", (event) => { brush = Number(event.target.value); });
$("eraser-button").addEventListener("click", () => {
  erasing = !erasing;
  $("eraser-button").setAttribute("aria-pressed", String(erasing));
});
$("clear-button").addEventListener("click", async () => {
  try { await request("drawing:clear"); } catch (error) { toast(error.message); }
});
function pointAt(event, start = false) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    color: erasing ? "#ffffff" : color, size: erasing ? 30 : brush, start, revision
  };
}
function sendPoint(point) {
  if (!canDraw()) return;
  strokes.push(point);
  paint(point);
  socket.emit("draw", point, (result) => {
    if (result?.error && !drawErrorShown) { drawErrorShown = true; toast(result.error); }
  });
  lastSent = performance.now();
}
function flushPending() {
  frame = null;
  if (pendingPoint && performance.now() - lastSent >= 16) {
    sendPoint(pendingPoint);
    pendingPoint = null;
  }
  if (pendingPoint) frame = requestAnimationFrame(flushPending);
}
canvas.addEventListener("pointerdown", (event) => {
  if (!canDraw() || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pointerDown = true;
  pendingPoint = null;
  sendPoint(pointAt(event, true));
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointerDown || !canDraw()) return;
  pendingPoint = pointAt(event);
  if (!frame) frame = requestAnimationFrame(flushPending);
});
function endStroke(event) {
  if (!pointerDown) return;
  if (pendingPoint) { sendPoint(pendingPoint); pendingPoint = null; }
  pointerDown = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
canvas.addEventListener("lostpointercapture", () => { pointerDown = false; });
socket.on("state", (next) => {
  if (!state || next.phase !== "drawing" || state.drawerId !== next.drawerId || state.turn !== next.turn) secret = "";
  state = next;
  clockOffset = next.serverNow - Date.now();
  revision = next.drawingRevision;
  if (next.phase !== "drawing") { pointerDown = false; pendingPoint = null; }
  render();
});
socket.on("secret", (word) => { secret = word; render(); });
socket.on("message", addMessage);
socket.on("draw", (point) => { if (point.revision === revision) { strokes.push(point); paint(point); } });
socket.on("drawing:clear", (nextRevision) => { revision = nextRevision; clearCanvas(); });
socket.on("disconnect", () => {
  if (!state) return;
  socket.disconnect();
  state = null;
  secret = "";
  clearCanvas();
  $("messages").replaceChildren();
  $("game").classList.add("hidden");
  $("welcome").classList.remove("hidden");
  $("how-strip").classList.remove("hidden");
  $("entry-error").textContent = "You were disconnected and left the room. Rejoin using the room code when the game finishes.";
  toast("Connection lost. The host role passes to the next player.");
});
$("rules-button").addEventListener("click", () => $("rules-dialog").showModal());
$("close-rules").addEventListener("click", () => $("rules-dialog").close());
$("rules-dialog").addEventListener("click", (event) => { if (event.target === $("rules-dialog")) $("rules-dialog").close(); });
const inviteCode = new URLSearchParams(window.location.search).get("room");
if (inviteCode) $("room-code").value = inviteCode.slice(0, 6).toUpperCase();
clearCanvas();
