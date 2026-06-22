// =====================================================================
//  Multiplayer transport (PlayroomKit, lazy-loaded)
// ---------------------------------------------------------------------
//  This module is completely optional. Single-player never imports or
//  touches PlayroomKit, so if the CDN is unreachable the game still runs.
//  We only pull the library in when the player clicks "Play with friends".
// =====================================================================

const PLAYROOM_URL = 'https://esm.sh/playroomkit@0.0.96';

let pk = null;            // the PlayroomKit module
let ready = false;        // connected + lobby skipped
let players = [];         // every PlayerState we know about (incl. self)
let leaveCb = null;       // called with (id) when a remote player quits

// Connect to a room and start syncing. Resolves true on success.
export async function startMultiplayer({ onError } = {}) {
  if (ready) return true;
  try {
    pk = await import(/* @vite-ignore */ PLAYROOM_URL);
  } catch (e) {
    console.error('[mp] failed to load PlayroomKit', e);
    onError?.(e);
    return false;
  }
  try {
    await pk.insertCoin({ skipLobby: true, maxPlayersPerRoom: 8 });
  } catch (e) {
    console.error('[mp] insertCoin failed', e);
    onError?.(e);
    return false;
  }
  pk.onPlayerJoin((p) => {
    players.push(p);
    p.onQuit(() => {
      players = players.filter((x) => x !== p);
      leaveCb?.(p.id);
    });
  });
  ready = true;
  return true;
}

export function mpActive() {
  return ready;
}

// Is this client the room host (the authority that runs the horde sim)?
export function mpIsHost() {
  if (!ready || !pk?.isHost) return false;
  try {
    return pk.isHost();
  } catch {
    return false;
  }
}

export function mpMyId() {
  return ready && pk?.myPlayer ? pk.myPlayer().id : 'local';
}

// ---- room-level (global) shared state, owned by the host ----
export function setGlobal(key, value, reliable = false) {
  if (ready && pk?.setState) pk.setState(key, value, reliable);
}
export function getGlobal(key) {
  return ready && pk?.getState ? pk.getState(key) : undefined;
}

// ---- per-player channels (e.g. a client's outgoing hit/pickup events) ----
export function setMyState(key, value, reliable = false) {
  if (ready && pk?.myPlayer) pk.myPlayer().setState(key, value, reliable);
}

// Run cb(id, value) over every *remote* player's value at `key`.
export function eachRemoteState(key, cb) {
  if (!ready) return;
  const meId = pk.myPlayer().id;
  for (const p of players) {
    if (p.id === meId) continue;
    const v = p.getState(key);
    if (v !== undefined) cb(p.id, v);
  }
}

// Number of penguins in the room (including yourself).
export function mpPlayerCount() {
  return ready ? players.length : 1;
}

// Push the local penguin's networked state (sent unreliably, every frame).
export function setLocalState(state) {
  if (ready && pk?.myPlayer) pk.myPlayer().setState('s', state, false);
}

// Run cb(id, state) for every *remote* player that has published a state.
export function eachRemote(cb) {
  if (!ready) return;
  const meId = pk.myPlayer().id;
  for (const p of players) {
    if (p.id === meId) continue;
    const s = p.getState('s');
    if (s) cb(p.id, s);
  }
}

export function onRemoteLeave(fn) {
  leaveCb = fn;
}

// The short room code other players can use to join (also baked into the URL).
export function mpRoomCode() {
  if (!ready || !pk?.getRoomCode) return null;
  try {
    return pk.getRoomCode();
  } catch {
    return null;
  }
}

// A full URL a friend can open to join *this* room. PlayroomKit reads the
// `r` query param on load, so we guarantee it's present.
export function mpInviteUrl() {
  const code = mpRoomCode();
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('r', code);
  return url.toString();
}
