const $ = selector => document.querySelector(selector);
const baseUrl = new URL('./', import.meta.url);
let token = sessionStorage.getItem('imposter-token');
let state = null;
let streamController;
let reveal = false;
let selectedVote = null;
let submitting = false;
let sendingChat = false;
let toastTimer;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const playerName = id => state.players.find(p => p.id === id)?.name ?? state.participants.find(p => p.id === id)?.name ?? 'Player';
const initials = name => [...name].slice(0, 2).join('').toUpperCase();

function showError(message) {
  $('#error').textContent = message;
  $('#error').hidden = false;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
async function api(action, data = {}, method = 'POST') {
  const response = await fetch(new URL(`api/${action}`, baseUrl), {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'The request failed.');
    error.status = response.status;
    throw error;
  }
  return result;
}
function connection(connected) {
  $('#connection-label').textContent = connected ? 'ROOM IS LIVE' : 'RECONNECTING';
  $('#connection-label').classList.toggle('connection-lost', !connected);
}
function receive(next) {
  if (next.removed) {
    clearSession();
    history.replaceState(null, '', baseUrl);
    showError(next.message);
    return;
  }
  const chatOnly = state && JSON.stringify({ ...state, messages: undefined }) === JSON.stringify({ ...next, messages: undefined });
  if (state?.phase !== next.phase || state?.dealId !== next.dealId) {
    reveal = false;
    selectedVote = null;
    if ($('#clue-text')) $('#clue-text').value = '';
  }
  if (!next.players.some(p => p.id === selectedVote)) selectedVote = null;
  state = next;
  if (chatOnly && $('#room-chat')) updateChat(chatScrollPosition());
  else render();
}
async function listen() {
  streamController?.abort();
  const controller = new AbortController();
  streamController = controller;
  while (!controller.signal.aborted) {
    try {
      const response = await fetch(new URL('api/events', baseUrl), { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401) {
          clearSession();
          showError('Your room has expired. Create or join a new room.');
          return;
        }
        throw new Error('Could not reconnect to the room.');
      }
      connection(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (event.startsWith('data: ')) receive(JSON.parse(event.slice(6)));
        }
      }
      if (!controller.signal.aborted) connection(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('Room connection interrupted:', error);
      connection(false);
    }
    if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
function clearSession() {
  streamController?.abort();
  sessionStorage.removeItem('imposter-token');
  token = null;
  state = null;
  document.body.classList.remove('game-open');
  reveal = false;
  selectedVote = null;
  $('#game').replaceChildren();
  $('#home').hidden = false;
  $('#game').hidden = true;
  $('#breadcrumb-current').textContent = 'Game room';
  $('#connection-label').textContent = "LET'S PLAY";
  $('#connection-label').classList.remove('connection-lost');
}
function secretMarkup() {
  return `<div class="secret-card ${reveal && state.isImposter ? 'imposter' : ''}"><div class="secret-label">${reveal && state.isImposter ? 'YOUR MISSION: BLEND IN' : 'FOR YOUR EYES ONLY'}</div><div class="secret-word">${reveal ? state.isImposter ? "You're the imposter." : escape(state.word) : 'A little secret.'}</div>${reveal ? `<div class="category">CATEGORY &nbsp; / &nbsp; ${escape(state.category)}</div>` : ''}<button class="button ghost reveal-button" id="reveal-word" aria-pressed="${reveal}">${reveal ? 'Hide my card' : 'Reveal my card'}</button><p class="small-muted">${reveal && state.isImposter ? 'You only know the category. Listen closely. Make it convincing.' : "Keep it to yourself. Especially if you're sharing your screen."}</p></div>`;
}
function activityMarkup() {
  const clues = new Map(state.clues.map(clue => [clue.playerId, clue]));
  const currentIds = new Set(state.players.map(p => p.id));
  const finished = state.phase === 'results';
  return `<section class="round-activity" aria-labelledby="round-summary-heading"><div class="phase-heading"><h3 id="round-summary-heading">Clues &amp; votes</h3></div><div class="round-summary-list" role="list" aria-label="Player clues and votes">${state.participants.map(p => {
    const clue = clues.get(p.id);
    const left = !currentIds.has(p.id);
    const target = state.votes[p.id];
    const count = finished ? state.result.counts[p.id] : undefined;
    return `<article class="clue round-player" role="listitem"><div class="clue-top"><strong>${escape(p.name)}${finished && p.id === state.result.imposterId ? ' <span class="player-meta">IMPOSTER</span>' : ''}</strong><div class="round-player-status">${left ? '<span class="player-meta">LEFT ROOM</span>' : ''}${finished ? `<span class="round-vote-count">${count === undefined ? 'Not in final vote' : `${count} ${count === 1 ? 'vote' : 'votes'} received`}</span>` : ''}</div></div><p class="clue-text"><span class="round-label">Clue</span>${clue ? escape(clue.text) : `<span class="small-muted">${left ? 'Left before giving a clue.' : 'Waiting for their turn.'}</span>`}</p><p class="round-vote"><span class="round-label">Voted for</span>${target ? escape(playerName(target)) : `<span class="small-muted">${left ? 'No vote.' : state.phase === 'describing' ? 'Voting opens after clues.' : 'Not voted yet.'}</span>`}</p></article>`;
  }).join('')}</div></section>`;
}
function playersPanelMarkup(host) {
  return `<aside class="panel players-panel" aria-labelledby="players-heading"><div class="players-title"><h3 id="players-heading">TURN ORDER &amp; SCORECARD</h3><span>${state.players.length}/12</span></div><p class="small-muted">Numbers show speaking order, shuffled each game.</p><div class="player-list">${state.players.map((p, index) => `<div class="player player-score ${p.id === state.turnId ? 'current' : ''}"><span class="avatar">${index + 1}</span><span class="player-name">${escape(p.name)}${p.id === state.selfId ? ' <span class="player-meta">YOU</span>' : ''}<span class="player-meta">${p.id === state.hostId ? ' HOST' : ''}${state.votedIds.includes(p.id) ? ' VOTED' : ''}</span></span><strong class="score-points">${p.score}<span>${p.score === 1 ? 'point' : 'points'}</span></strong><span class="player-stats">Games: ${p.gamesPlayed} &middot; Correct votes: ${p.correctVotes} &middot; Successful bluffs: ${p.successfulBluffs}</span>${host && p.id !== state.selfId ? `<button class="kick-button" data-kick="${p.id}" aria-label="Kick ${escape(p.name)}">Kick</button>` : ''}</div>`).join('')}</div><p class="small-muted">Correct vote: 1 point. Imposter survives: 2 points, including ties.</p><p class="small-muted">Scores carry across games until you leave or are kicked. Cancelled games earn no points.</p></aside>`;
}
function chatPanel() {
  const panel = document.createElement('section');
  panel.id = 'room-chat';
  panel.className = 'panel chat-panel';
  panel.setAttribute('aria-labelledby', 'chat-heading');
  panel.innerHTML = `<div class="players-title"><h3 id="chat-heading">ROOM CHAT</h3><span class="status-dot"></span></div><p class="chat-hint">Banter welcome. Don't spill the secret.</p><div id="chat-messages" class="chat-messages" role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions" tabindex="0"><p class="chat-empty small-muted">Suspiciously quiet in here. Say hello!</p></div><form id="chat-form" class="chat-form"><label for="chat-text">MESSAGE YOUR TEAM</label><input id="chat-text" placeholder="Talk a little, suspect a lot..." maxlength="300" required autocomplete="off" aria-describedby="chat-limit"><div class="chat-compose-footer"><span id="chat-limit">Up to 300 characters</span><button class="button secondary" id="send-chat" type="submit">Send &#8594;</button></div><p id="chat-error" class="chat-error" role="alert" hidden></p></form>`;
  return panel;
}
function chatScrollPosition() {
  const log = $('#chat-messages');
  if (!log) return null;
  const anchor = [...log.children].find(element => element.offsetTop - log.offsetTop + element.offsetHeight > log.scrollTop);
  return {
    top: log.scrollTop,
    atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 32,
    anchorId: anchor?.dataset.messageId,
    anchorOffset: anchor ? anchor.offsetTop - log.offsetTop - log.scrollTop : 0,
  };
}
function updateChat(previousScroll) {
  const log = $('#chat-messages');
  const messages = state.messages;
  const retained = new Set(messages.map(message => message.id));
  for (const element of log.querySelectorAll('[data-message-id]')) {
    if (!retained.has(element.dataset.messageId)) element.remove();
  }
  const existing = new Set([...log.querySelectorAll('[data-message-id]')].map(element => element.dataset.messageId));
  const added = messages.filter(message => !existing.has(message.id));
  if (messages.length) log.querySelector('.chat-empty')?.remove();
  for (const message of added) {
    const time = new Date(message.sentAt);
    log.insertAdjacentHTML('beforeend', `<article class="chat-message ${message.playerId === state.selfId ? 'chat-mine' : ''}" data-message-id="${escape(message.id)}"><div class="chat-message-heading"><strong>${escape(message.name)}${message.playerId === state.selfId ? ' (you)' : ''}</strong><time datetime="${time.toISOString()}">${escape(time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></div><p>${escape(message.text)}</p></article>`);
  }
  if (!previousScroll || previousScroll.atBottom || added.some(message => message.playerId === state.selfId)) {
    log.scrollTop = log.scrollHeight;
  } else {
    const anchor = previousScroll.anchorId && [...log.children].find(element => element.dataset.messageId === previousScroll.anchorId);
    log.scrollTop = anchor ? anchor.offsetTop - log.offsetTop - previousScroll.anchorOffset : previousScroll.top;
  }
  $('#send-chat').disabled = sendingChat;
}
function render() {
  const game = $('#game');
  // Live updates must not discard a clue a player is still writing.
  const draft = $('#clue-text')?.value ?? '';
  const chat = $('#room-chat');
  const chatScroll = chatScrollPosition();
  const focused = document.activeElement?.id;
  const focusedInput = ['clue-text', 'chat-text'].includes(focused) ? document.activeElement : null;
  const selection = focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd] : null;
  $('#home').hidden = true;
  document.body.classList.remove('invite-entry');
  document.body.classList.add('game-open');
  game.hidden = false;
  $('#breadcrumb-current').textContent = `Room ${state.code}`;
  const host = state.selfId === state.hostId;
  const voted = state.votedIds.includes(state.selfId);
  let content;
  if (state.phase === 'lobby') {
    content = `<div class="empty-lobby"><div class="orbit">&#10035;</div><h3>The usual suspects are gathering.</h3><p class="small-muted">Share the room code or invite link with your team.<br>Everyone joins on their own device. One of you won't be so innocent.</p><div class="lobby-rules"><span>3-12 PLAYERS</span><span>1 CLUE ROUND</span><span>1 IMPOSTER</span></div></div>${host ? `<button id="start-game" class="button secondary start-button" ${state.players.length < 3 ? 'disabled' : ''}>${state.players.length < 3 ? `Waiting for ${3 - state.players.length} more ${state.players.length === 2 ? 'player' : 'players'}` : 'Everyone in? Deal the secrets'} <span>&#8594;</span></button>` : '<div class="waiting">You\'re in. The host will start when everyone is ready.</div>'}`;
  } else if (state.phase === 'results') {
    const r = state.result;
    content = `<div class="result"><div class="secret-label">THE TRUTH IS OUT</div><div class="result-icon">${r.caught ? '&#9678;' : '&#10035;'}</div><h2>${r.caught ? `Imposter ${escape(r.imposterName)} is caught!` : `Imposter ${escape(r.imposterName)} survived.`}</h2><p class="small-muted">${r.caught ? 'Good instincts, team. The word is safe.' : r.tied ? 'A tied vote. Just enough doubt to get away with it.' : 'Hiding in plain sight. That was a convincing bluff.'}</p><div class="secret-label">THE SECRET WORD WAS</div><div class="secret-word">${escape(state.word)}</div><p class="category">${escape(state.category)}</p></div>`;
  } else {
    content = secretMarkup();
    if (state.phase === 'describing') {
      const mine = state.turnId === state.selfId;
      content += `<div class="phase-heading"><span class="phase-badge">CLUE ROUND</span><h3>${mine ? "You're up. Play it cool." : `${escape(playerName(state.turnId))} is up.`}</h3></div>${mine ? `<form id="clue-form" class="clue-form"><label for="clue-text">DESCRIBE THE WORD WITHOUT SAYING IT</label><div class="input-row"><input id="clue-text" placeholder="A clue, not a confession..." maxlength="160" required autocomplete="off"><button class="button secondary" type="submit">Send clue &#8594;</button></div><p class="small-muted">One clue per player. Up to 160 characters.</p></form>` : '<div class="waiting">Listen closely. Every clue could give the imposter away.</div>'}`;
    } else {
      content += `<div class="phase-heading"><span class="phase-badge">THE VOTE</span><h3>Who's not one of us?</h3></div><p class="small-muted">Pick the player you suspect. Everyone can see your locked vote.<br>A tied vote lets the imposter survive.</p>${voted ? `<div class="waiting">Vote locked for <strong>${escape(playerName(state.myVote))}</strong>. Waiting for the others... (${state.votedIds.length}/${state.players.length})</div>` : `<div class="vote-grid">${state.players.filter(p => p.id !== state.selfId).map(p => `<button class="vote-option ${selectedVote === p.id ? 'selected' : ''}" data-vote="${p.id}" aria-pressed="${selectedVote === p.id}"><span class="avatar">${escape(initials(p.name))}</span>${escape(p.name)}<span>${selectedVote === p.id ? '&#10003;' : '&#9675;'}</span></button>`).join('')}</div><button id="lock-vote" class="button secondary start-button" ${selectedVote ? '' : 'disabled'}>Lock in my vote <span>&#8594;</span></button><p class="small-muted">${state.votedIds.length}/${state.players.length} votes locked</p>`}`;
    }
  }
  if (state.phase !== 'lobby') content += activityMarkup();
  if (state.phase === 'results') content += host ? '<button id="reset-game" class="button secondary start-button">Back to lobby <span>&#8594;</span></button>' : '<div class="waiting">The host can open the lobby for another game.</div>';
  chat?.remove();
  game.innerHTML = `<div class="room-header"><div><div class="eyebrow">YOUR PRIVATE HANGOUT</div><div class="room-code">${state.code}</div></div><div class="room-actions"><button class="button ghost" id="copy-invite">Copy invite &#8599;</button>${host && ['describing', 'voting'].includes(state.phase) ? '<button class="button ghost" id="refresh-word">Refresh word</button>' : ''}<button class="button ghost" id="leave-room">Leave room</button></div></div>${state.notice ? `<p class="notice room-notice" role="status">${escape(state.notice)}</p>` : ''}<div class="room-layout"><div class="panel game-panel">${content}</div><div class="room-sidebar">${playersPanelMarkup(host)}</div></div>`;
  $('.room-sidebar').append(chat ?? chatPanel());
  if ($('#clue-text')) {
    $('#clue-text').value = draft;
  }
  if (focused && document.getElementById(focused)) {
    const element = document.getElementById(focused);
    element.focus({ preventScroll: true });
    if (selection) element.setSelectionRange(...selection);
  }
  updateChat(chatScroll);
}
async function sendChat() {
  if (sendingChat) return;
  const input = $('#chat-text');
  const draft = input.value;
  const roomCode = state.code;
  const sessionToken = token;
  sendingChat = true;
  $('#send-chat').disabled = true;
  $('#chat-error').hidden = true;
  try {
    await api('chat', { text: draft });
    if (token === sessionToken && state?.code === roomCode && $('#chat-text')?.value === draft) {
      $('#chat-text').value = '';
    }
  } catch (error) {
    if (token === sessionToken && state?.code === roomCode) {
      $('#chat-error').textContent = error.message;
      $('#chat-error').hidden = false;
    }
  } finally {
    sendingChat = false;
    if ($('#send-chat')) $('#send-chat').disabled = false;
  }
}
async function act(action, data) {
  if (submitting) return;
  submitting = true;
  $('#error').hidden = true;
  try { await api(action, data); }
  catch (error) { showError(error.message); }
  finally { submitting = false; }
}
for (const mode of ['create', 'join']) {
  $(`#${mode}-form`).addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = event.target.querySelector('button');
    button.disabled = true;
    $('#error').hidden = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      const result = await api(mode, data);
      token = result.token;
      sessionStorage.setItem('imposter-token', token);
      receive(result.state);
      history.replaceState(null, '', new URL(`?room=${state.code}`, baseUrl));
      listen();
    } catch (error) { showError(error.message); }
    finally { submitting = false; button.disabled = false; }
  });
}
$('#game').addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.id === 'reveal-word') { reveal = !reveal; render(); }
  if (target.id === 'start-game') await act('start');
  if (target.id === 'reset-game') await act('reset');
  if (target.id === 'refresh-word' && confirm('Refresh the word? All clues and votes will be cleared. The imposter stays the same.')) await act('refresh');
  if (target.dataset.kick && confirm(`Remove ${playerName(target.dataset.kick)} from the room? The game returns to the lobby if the imposter leaves or fewer than three players remain.`)) {
    await act('kick', { playerId: target.dataset.kick });
  }
  if (target.dataset.vote) { selectedVote = target.dataset.vote; render(); }
  if (target.id === 'lock-vote' && selectedVote) await act('vote', { playerId: selectedVote });
  if (target.id === 'copy-invite') {
    const link = new URL(`?room=${state.code}`, baseUrl).href;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite copied. Send it to your usual suspects.');
    } catch {
      toast(`Copy this invite: ${link}`);
    }
  }
  if (target.id === 'leave-room') {
    if (submitting) return;
    if (state.phase !== 'lobby' && !confirm('Leave this room? The game returns to the lobby if you are the imposter or fewer than three players remain.')) return;
    submitting = true;
    try {
      await api('leave');
      clearSession();
      history.replaceState(null, '', baseUrl);
    } catch (error) { showError(error.message); }
    finally { submitting = false; }
  }
});
$('#game').addEventListener('submit', async event => {
  if (event.target.id === 'chat-form') {
    event.preventDefault();
    await sendChat();
    return;
  }
  if (event.target.id !== 'clue-form') return;
  event.preventDefault();
  await act('clue', { text: $('#clue-text').value });
});
$('#how-button').addEventListener('click', () => $('#how-dialog').showModal());
$('#mobile-how-button').addEventListener('click', () => $('#how-dialog').showModal());
$('#close-how').addEventListener('click', () => $('#how-dialog').close());
const roomParameter = new URLSearchParams(location.search).get('room');
const invitedRoom = /^[A-Fa-f0-9]{6}$/.test(roomParameter ?? '') ? roomParameter.toUpperCase() : null;
if (invitedRoom) {
  $('#room-code').value = invitedRoom;
  document.body.classList.add('invite-entry');
}
if (token) {
  try {
    const current = await api('state', {}, 'GET');
    if (!invitedRoom || current.code === invitedRoom) {
      receive(current);
      listen();
    }
  } catch (error) {
    if (error.status === 401) clearSession();
    showError(error.message);
  }
}
