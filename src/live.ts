// PvP EN VIVO: emparejamiento y reenvio de mensajes entre dos clientes por WebSocket (/live).
//
// El servidor NO simula el combate: cada cliente parcheado (BALive en el APK) ejecuta el motor original con
// su jugador y un espejo del rival; aqui solo se emparejan jugadores en cola y se reenvia todo lo que se
// dicen (comandos, resultados de golpes, sincronizacion de asaltos). Ver apk-lab/LIVE-PVP.md.
//
// Protocolo (JSON de texto, campo "t"):
//   cliente -> servidor:  hello{session}  queue  cancel  ready{r}  result{win}   (el resto se reenvia al rival)
//                         challenge{tag}  accept{id}  decline{id,busy?}  cancel_challenge   (retos directos)
//   servidor -> cliente:  welcome{name}  lobby{waiting}  match{id,seat,name,opponent:[fila PvP]}  go  peer_left  error{msg}
//                         invite{id,from,auid,rid,lv}  challenge_sent{id,name}  challenge_fail{msg}
//                         challenge_declined{name,busy}  invite_cancelled{id}  invite_expired{id}
// El jugador se identifica con su sesion HTTP del juego (X-BA-Session), que ya esta logueada. El cliente
// mantiene la conexion abierta mientras esta en el lobby, asi que un reto de un amigo le llega este donde este.
// El resultado oficial llega por el canal normal (ReportPvPBattleResultsC2S, ver handlers/pvp.ts: combate "live").
//
// Retos directos: `challenge{tag}` busca al rival por auid de rol o por nombre (como la lista de amigos); si esta
// conectado y libre recibe `invite` y el retador `challenge_sent`. `accept` empareja a los dos igual que la cola
// (el retador es el asiento 0 = arbitro); `decline`, `cancel_challenge`, la desconexion o INVITE_TIMEOUT_MS lo anulan.

import { randomUUID } from "node:crypto";
import { getSession } from "./socket.ts";
import { liveOpponentRow, beginLiveFight } from "./handlers/pvp.ts";
import { findPlayer } from "./handlers/friends.ts";
import type { Player } from "./players.ts";
import type { GameSession, Log } from "./game.ts";

export type LiveSocket = { send(text: string): void; close(): void };
export type Peer = {
  ws: LiveSocket;
  acc: string | null;
  player: Player | null;
  name: string;
  queued: boolean;
  match: Match | null;
  seat: number;
  openedAt: number;
  /** reto directo pendiente que este jugador ha enviado */
  challenge: Invite | null;
};
export type Match = {
  id: string;
  peers: [Peer, Peer];
  ready: [boolean, boolean];
  result: [number | null, number | null];
  createdAt: number;
};
export type Invite = { id: string; from: Peer; to: Peer; at: number; timer: ReturnType<typeof setTimeout> | null };

const HELLO_TIMEOUT_MS = 15_000;
export const INVITE_TIMEOUT_MS = 30_000;
const CONTROL = new Set(["hello", "queue", "cancel", "ready", "result", "ping", "challenge", "accept", "decline", "cancel_challenge"]);

const peers = new Set<Peer>();
const queue: Peer[] = [];
const matches = new Map<string, Match>();
const invites = new Map<string, Invite>();

let resolveSession: (id: string) => GameSession | undefined = getSession;
let inviteTimeout = INVITE_TIMEOUT_MS;
/** Solo para pruebas: como se resuelve la sesion del "hello" y cuanto dura un reto sin respuesta. */
export function configureLive(opts: { resolveSession?: (id: string) => GameSession | undefined; inviteTimeoutMs?: number }) {
  if (opts.resolveSession) resolveSession = opts.resolveSession;
  if (opts.inviteTimeoutMs !== undefined) inviteTimeout = opts.inviteTimeoutMs;
}

export function liveStatus() {
  return { online: peers.size, queued: queue.length, matches: matches.size, invites: invites.size };
}

function send(p: Peer, msg: Record<string, unknown>) {
  try {
    p.ws.send(JSON.stringify(msg));
  } catch {
    /* socket cerrado: close() lo limpiara */
  }
}
function other(m: Match, p: Peer): Peer {
  return m.peers[0] === p ? m.peers[1] : m.peers[0];
}
function broadcastLobby() {
  for (const p of queue) send(p, { t: "lobby", waiting: queue.length });
}
function dequeue(p: Peer) {
  const i = queue.indexOf(p);
  if (i >= 0) queue.splice(i, 1);
  p.queued = false;
}
function peerByAcc(acc: string): Peer | undefined {
  for (const q of peers) if (q.acc === acc) return q;
  return undefined;
}

export function livePeerOpen(ws: LiveSocket, log: Log): Peer {
  const p: Peer = { ws, acc: null, player: null, name: "", queued: false, match: null, seat: 0, openedAt: Date.now(), challenge: null };
  peers.add(p);
  setTimeout(() => {
    if (peers.has(p) && !p.acc) {
      send(p, { t: "error", msg: "no hello" });
      p.ws.close();
    }
  }, HELLO_TIMEOUT_MS).unref?.();
  log("live: conexion", peers.size);
  return p;
}

export function livePeerClose(p: Peer, log: Log) {
  if (!peers.delete(p)) return;
  dequeue(p);
  cancelChallenge(p, "cancel");
  dropIncomingInvites(p, `${p.name || "?"} went offline`);
  const m = p.match;
  if (m) {
    const o = other(m, p);
    o.match = null;
    matches.delete(m.id);
    send(o, { t: "peer_left" });
    log(`live: ${p.name || "?"} se fue de la partida ${m.id.slice(0, 8)} (rival ${o.name})`);
  }
  broadcastLobby();
}

export function liveMessage(p: Peer, raw: string, log: Log) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  const t = String(msg.t ?? "");
  if (t === "hello") return hello(p, msg, log);
  if (!p.acc) {
    send(p, { t: "error", msg: "hello first" });
    return;
  }
  switch (t) {
    case "queue":
      if (p.match) return send(p, { t: "error", msg: "already in a match" });
      if (!p.queued) {
        p.queued = true;
        queue.push(p);
      }
      tryMatch(log);
      broadcastLobby();
      return;
    case "cancel":
      dequeue(p);
      broadcastLobby();
      return;
    case "ping":
      return;
    case "challenge":
      return challenge(p, String(msg.tag ?? ""), log);
    case "accept":
      return acceptInvite(p, String(msg.id ?? ""), log);
    case "decline": {
      const inv = invites.get(String(msg.id ?? ""));
      if (!inv || inv.to !== p) return;
      clearInvite(inv);
      send(inv.from, { t: "challenge_declined", name: p.name, busy: Number(msg.busy) === 1 ? 1 : 0 });
      log(`live: ${p.name} rechaza el reto de ${inv.from.name}${Number(msg.busy) === 1 ? " (ocupado)" : ""}`);
      return;
    }
    case "cancel_challenge":
      cancelChallenge(p, "cancel");
      return;
    case "ready": {
      const m = p.match;
      if (!m) return;
      m.ready[p.seat] = true;
      if (m.ready[0] && m.ready[1]) {
        m.ready = [false, false];
        for (const q of m.peers) send(q, { t: "go" });
        log(`live: partida ${m.id.slice(0, 8)} asalto ${String(msg.r ?? "?")} en marcha`);
      }
      return;
    }
    case "result": {
      const m = p.match;
      if (!m) return;
      m.result[p.seat] = Number(msg.win) === 1 ? 1 : 0;
      // el rival adopta este veredicto si su combate sigue en curso (p. ej. aun en la lona)
      send(other(m, p), { t: "peer_result", win: m.result[p.seat] });
      const [a, b] = m.result;
      if (a !== null && b !== null) {
        log(`live: partida ${m.id.slice(0, 8)} terminada: ${m.peers[0].name} ${a ? "gana" : "pierde"} / ${m.peers[1].name} ${b ? "gana" : "pierde"}${a === b ? " (INCONSISTENTE)" : ""}`);
        for (const q of m.peers) q.match = null;
        matches.delete(m.id);
      }
      return;
    }
  }
  // todo lo demas se reenvia al rival tal cual
  if (CONTROL.has(t)) return;
  const m = p.match;
  if (!m) return;
  other(m, p).ws.send(raw);
}

function hello(p: Peer, msg: Record<string, unknown>, log: Log) {
  const s = resolveSession(String(msg.session ?? ""));
  if (!s || !s.player || !s.acc) {
    send(p, { t: "error", msg: "not logged in" });
    p.ws.close();
    return;
  }
  // una conexion por cuenta: la nueva sustituye a la anterior
  for (const q of peers) {
    if (q !== p && q.acc === s.acc) {
      send(q, { t: "error", msg: "replaced by a new connection" });
      q.ws.close();
      livePeerClose(q, log);
    }
  }
  p.acc = s.acc;
  p.player = s.player;
  p.name = s.player.name;
  send(p, { t: "welcome", name: p.name });
  log(`live: hola ${p.name}`);
}

function createMatch(a: Peer, b: Peer, log: Log, how: string) {
  if (!a.player || !b.player) return;
  dequeue(a);
  dequeue(b);
  for (const q of [a, b]) {
    cancelChallenge(q, "cancel");
    dropIncomingInvites(q, `${q.name} started another fight`);
  }
  const m: Match = { id: randomUUID(), peers: [a, b], ready: [false, false], result: [null, null], createdAt: Date.now() };
  a.match = m;
  a.seat = 0;
  b.match = m;
  b.seat = 1;
  matches.set(m.id, m);
  beginLiveFight(a.player, b.player);
  beginLiveFight(b.player, a.player);
  send(a, { t: "match", id: m.id, seat: 0, name: b.name, opponent: liveOpponentRow(b.player) });
  send(b, { t: "match", id: m.id, seat: 1, name: a.name, opponent: liveOpponentRow(a.player) });
  log(`live: partida ${m.id.slice(0, 8)} (${how}): ${a.name} (P1) vs ${b.name} (P2)`);
}

function tryMatch(log: Log) {
  while (queue.length >= 2) {
    const a = queue[0];
    const b = queue.find((q) => q !== a && q.acc !== a.acc);
    if (!b) return;
    dequeue(a);
    dequeue(b);
    if (!a.player || !b.player) continue;
    createMatch(a, b, log, "cola");
  }
}

// ---------------------------------------------------------------- retos directos
function clearInvite(inv: Invite) {
  if (inv.timer) clearTimeout(inv.timer);
  inv.timer = null;
  invites.delete(inv.id);
  if (inv.from.challenge === inv) inv.from.challenge = null;
}

/** Anula el reto pendiente que envio `p` (si lo hay); el retado recibe invite_cancelled. */
function cancelChallenge(p: Peer, why: "cancel" | "expired") {
  const inv = p.challenge;
  if (!inv) return;
  clearInvite(inv);
  send(inv.to, { t: why === "expired" ? "invite_expired" : "invite_cancelled", id: inv.id });
}

/** Anula los retos que otros enviaron a `p`; cada retador recibe challenge_fail{msg}. */
function dropIncomingInvites(p: Peer, msg: string) {
  for (const inv of [...invites.values()]) {
    if (inv.to !== p) continue;
    clearInvite(inv);
    send(inv.from, { t: "challenge_fail", msg });
  }
}

function challenge(p: Peer, tag: string, log: Log) {
  const fail = (msg: string) => send(p, { t: "challenge_fail", msg });
  if (!tag.trim()) return fail("who?");
  if (p.match) return fail("you are already fighting");
  const q = findPlayer(tag);
  if (!q) return fail("no player named " + tag.trim());
  if (q.acc === p.acc) return fail("that is you");
  const target = peerByAcc(q.acc);
  if (!target) return fail(`${q.name} is not online right now`);
  if (target.match) return fail(`${q.name} is fighting right now`);
  cancelChallenge(p, "cancel");
  if (target.challenge && target.challenge.to === p) {
    // se estaban retando mutuamente: con eso basta
    const mutual = target.challenge;
    clearInvite(mutual);
    createMatch(target, p, log, "reto mutuo");
    return;
  }
  const inv: Invite = { id: randomUUID(), from: p, to: target, at: Date.now(), timer: null };
  inv.timer = setTimeout(() => {
    if (invites.get(inv.id) !== inv) return;
    clearInvite(inv);
    send(target, { t: "invite_expired", id: inv.id });
    send(p, { t: "challenge_fail", msg: `${q.name} did not answer` });
    log(`live: reto de ${p.name} a ${q.name} sin respuesta`);
  }, inviteTimeout);
  inv.timer.unref?.();
  invites.set(inv.id, inv);
  p.challenge = inv;
  const role = p.player ? p.player.roles[p.player.last_use] ?? Object.values(p.player.roles)[0] : undefined;
  send(target, { t: "invite", id: inv.id, from: p.name, auid: role?.auid ?? "", rid: role?.rid ?? "", lv: p.player?.lv ?? 0 });
  send(p, { t: "challenge_sent", id: inv.id, name: q.name });
  log(`live: ${p.name} reta a ${q.name}`);
}

function acceptInvite(p: Peer, id: string, log: Log) {
  const inv = invites.get(id);
  if (!inv || inv.to !== p) return send(p, { t: "error", msg: "that challenge is no longer open" });
  if (p.match) return send(p, { t: "error", msg: "you are already fighting" });
  clearInvite(inv);
  if (inv.from.match || !peers.has(inv.from)) return send(p, { t: "error", msg: `${inv.from.name} is no longer available` });
  createMatch(inv.from, p, log, "reto");
}
