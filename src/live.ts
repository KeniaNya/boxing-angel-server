// PvP EN VIVO: emparejamiento y reenvio de mensajes entre dos clientes por WebSocket (/live).
//
// El servidor NO simula el combate: cada cliente parcheado (BALive en el APK) ejecuta el motor original con
// su jugador y un espejo del rival; aqui solo se emparejan jugadores en cola y se reenvia todo lo que se
// dicen (comandos, resultados de golpes, sincronizacion de asaltos). Ver apk-lab/LIVE-PVP.md.
//
// Protocolo (JSON de texto, campo "t"):
//   cliente -> servidor:  hello{session}  queue  cancel  ready{r}  result{win}   (el resto se reenvia al rival)
//   servidor -> cliente:  welcome{name}  lobby{waiting}  match{id,seat,name,opponent:[fila PvP]}  go  peer_left  error{msg}
// El jugador se identifica con su sesion HTTP del juego (X-BA-Session), que ya esta logueada.
// El resultado oficial llega por el canal normal (ReportPvPBattleResultsC2S, ver handlers/pvp.ts: combate "live").

import { randomUUID } from "node:crypto";
import { getSession } from "./socket.ts";
import { liveOpponentRow, beginLiveFight } from "./handlers/pvp.ts";
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
};
export type Match = {
  id: string;
  peers: [Peer, Peer];
  ready: [boolean, boolean];
  result: [number | null, number | null];
  createdAt: number;
};

const HELLO_TIMEOUT_MS = 15_000;
const CONTROL = new Set(["hello", "queue", "cancel", "ready", "result", "ping"]);

const peers = new Set<Peer>();
const queue: Peer[] = [];
const matches = new Map<string, Match>();

let resolveSession: (id: string) => GameSession | undefined = getSession;
/** Solo para pruebas: como se resuelve la sesion del "hello". */
export function configureLive(opts: { resolveSession?: (id: string) => GameSession | undefined }) {
  if (opts.resolveSession) resolveSession = opts.resolveSession;
}

export function liveStatus() {
  return { online: peers.size, queued: queue.length, matches: matches.size };
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

export function livePeerOpen(ws: LiveSocket, log: Log): Peer {
  const p: Peer = { ws, acc: null, player: null, name: "", queued: false, match: null, seat: 0, openedAt: Date.now() };
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

function tryMatch(log: Log) {
  while (queue.length >= 2) {
    const a = queue[0];
    const b = queue.find((q) => q !== a && q.acc !== a.acc);
    if (!b) return;
    dequeue(a);
    dequeue(b);
    if (!a.player || !b.player) continue;
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
    log(`live: partida ${m.id.slice(0, 8)}: ${a.name} (P1) vs ${b.name} (P2)`);
  }
}
