import { test, expect } from "bun:test";
import { testSession, silentLog } from "./testutil.ts";

// testutil fija LENA_APPDATA antes de importar players.ts; el resto se importa despues.
const players = await import("./players.ts");
const game = await import("./game.ts");
const live = await import("./live.ts");
const { config } = await import("./config.ts");
type Player = import("./players.ts").Player;
type GameSession = import("./game.ts").GameSession;

const main = await testSession("live-a");
function sessionFor(p: Player, id: string) {
  const s: GameSession = { id, createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc: p.acc, player: p, sessionKey: "k" };
  return { s, p, send: (method: string, params: Record<string, unknown> = {}) => game.dispatch(s, method, params, silentLog) };
}
const a = sessionFor(main.p, "sess-a");
const b = sessionFor(players.loadPlayer("live-b") ?? players.createPlayer("live-b", "Bravo", "1100002"), "sess-b");
const sessions = new Map<string, GameSession>([
  [a.s.id, a.s],
  [b.s.id, b.s],
]);
live.configureLive({ resolveSession: (id) => sessions.get(id) });

type Msg = Record<string, unknown>;
function fakeSocket() {
  const out: Msg[] = [];
  let closed = false;
  // como en Bun, cerrar el socket dispara el evento de cierre del servidor
  let self: import("./live.ts").Peer | null = null;
  const ws = {
    send: (t: string) => out.push(JSON.parse(t) as Msg),
    close: () => {
      closed = true;
      if (self) live.livePeerClose(self, silentLog);
    },
  };
  const peer = live.livePeerOpen(ws, silentLog);
  self = peer;
  return {
    peer,
    out,
    get closed() { return closed; },
    say: (m: Msg) => live.liveMessage(peer, JSON.stringify(m), silentLog),
    last: (t: string) => [...out].reverse().find((m) => m.t === t),
    bye: () => live.livePeerClose(peer, silentLog),
  };
}
const obj = (f: { paramObject: Record<string, unknown> }) => f.paramObject;

test("hello: sesion desconocida -> error y cierre; sesion logueada -> welcome", () => {
  const x = fakeSocket();
  x.say({ t: "hello", session: "nope" });
  expect(x.last("error")).toBeTruthy();
  expect(x.closed).toBe(true);

  const y = fakeSocket();
  y.say({ t: "queue" });
  expect(y.last("error")?.msg).toBe("hello first");
  y.say({ t: "hello", session: "sess-a" });
  expect(y.last("welcome")?.name).toBe(a.p.name);
  y.bye();
});

test("emparejado, reenvio, ready/go, resultado y reporte sin tocar la escalera", async () => {
  const x = fakeSocket();
  const y = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  y.say({ t: "hello", session: "sess-b" });
  x.say({ t: "queue" });
  expect(x.last("lobby")?.waiting).toBe(1);
  expect(live.liveStatus().queued).toBe(1);
  y.say({ t: "queue" });

  const mx = x.last("match")!;
  const my = y.last("match")!;
  expect(mx).toBeTruthy();
  expect(my).toBeTruthy();
  expect(mx.seat).toBe(0);
  expect(my.seat).toBe(1);
  expect(mx.name).toBe(b.p.name);
  expect(my.name).toBe(a.p.name);
  // fila de rival en el formato de GetPvPOpponentS2C: [rank, npc, win, lose, auid, name, rid, lv, ...]
  const row = mx.opponent as unknown[];
  expect(row[1]).toBe(0);
  expect(row[5]).toBe(b.p.name);
  expect(row[6]).toBe(b.p.last_use);
  expect(row.length).toBe(24);
  expect(live.liveStatus()).toEqual({ online: 2, queued: 0, matches: 1, invites: 0 });

  // StartPvPBattle no exige registro ni consume intentos
  const timesBefore = a.p.pvp_times;
  let out = await a.send("StartPvPBattleC2S", { index: 0 });
  expect(obj(out[0]).res).toBe(0);
  expect(a.p.pvp_times).toBe(timesBefore);
  out = await b.send("StartPvPBattleC2S", { index: 0 });
  expect(obj(out[0]).res).toBe(0);

  // reenvio tal cual
  x.say({ t: "cmd", id: 2, d: 1 });
  expect(y.last("cmd")).toEqual({ t: "cmd", id: 2, d: 1 });
  y.say({ t: "hit", eb: 100 });
  expect(x.last("hit")?.eb).toBe(100);
  // los de control no se reenvian
  x.say({ t: "queue" });
  expect(y.last("queue")).toBeUndefined();

  // puerta de asalto
  x.say({ t: "ready", r: 1 });
  expect(x.last("go")).toBeUndefined();
  y.say({ t: "ready", r: 1 });
  expect(x.last("go")).toBeTruthy();
  expect(y.last("go")).toBeTruthy();

  // resultado por el canal normal: victorias en vivo aparte, rango intacto
  const rankA = a.p.pvp_rank;
  const vcoinA = a.p.coin[1];
  out = await a.send("ReportPvPBattleResultsC2S", { battle_res: 1 });
  expect(obj(out[0]).res).toBe(0);
  expect(obj(out[0]).rank).toBe(rankA);
  expect(a.p.coin[1]).toBe(vcoinA + config().economy.pvpWinDiamonds); // diamantes por victoria (tambien en vivo)
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "coin")).toBe(true);
  expect((obj(out[0]).record as { variation: number }).variation).toBe(0);
  out = await b.send("ReportPvPBattleResultsC2S", { battle_res: 0 });
  expect(obj(out[0]).res).toBe(0);
  const ext = (p: Player) => (p.ext as Record<string, { liveWins?: number; liveLosses?: number; live?: unknown }>).pvp;
  expect(ext(a.p).liveWins).toBe(1);
  expect(ext(b.p).liveLosses).toBe(1);
  expect(ext(a.p).live).toBeNull();

  x.say({ t: "result", win: 1 });
  expect(y.last("peer_result")).toEqual({ t: "peer_result", win: 1 });
  y.say({ t: "result", win: 0 });
  expect(x.last("peer_result")).toEqual({ t: "peer_result", win: 0 });
  expect(live.liveStatus().matches).toBe(0);
  x.bye();
  y.bye();
  expect(live.liveStatus().online).toBe(0);
});

test("si un jugador se desconecta en plena partida el otro recibe peer_left", () => {
  const x = fakeSocket();
  const y = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  y.say({ t: "hello", session: "sess-b" });
  x.say({ t: "queue" });
  y.say({ t: "queue" });
  expect(x.last("match")).toBeTruthy();
  x.bye();
  expect(y.last("peer_left")).toBeTruthy();
  expect(live.liveStatus().matches).toBe(0);
  y.bye();
});

test("la misma cuenta no se empareja consigo misma: la nueva conexion sustituye a la vieja", () => {
  const x1 = fakeSocket();
  x1.say({ t: "hello", session: "sess-a" });
  x1.say({ t: "queue" });
  const x2 = fakeSocket();
  x2.say({ t: "hello", session: "sess-a" });
  expect(x1.closed).toBe(true);
  x2.say({ t: "queue" });
  expect(x2.last("match")).toBeUndefined();
  expect(live.liveStatus().queued).toBe(1);
  x2.bye();
  expect(live.liveStatus()).toEqual({ online: 0, queued: 0, matches: 0, invites: 0 });
});

test("reto directo: jugador inexistente, uno mismo o desconectado -> challenge_fail", () => {
  const x = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  x.say({ t: "challenge", tag: "nadie-asi" });
  expect(x.last("challenge_fail")?.msg).toContain("no player");
  x.say({ t: "challenge", tag: a.p.roles[a.p.last_use].auid }); // por nombre seria ambiguo: todos los jugadores de prueba se llaman Tester
  expect(x.last("challenge_fail")?.msg).toContain("you");
  x.say({ t: "challenge", tag: b.p.name });
  expect(x.last("challenge_fail")?.msg).toContain("not online");
  expect(live.liveStatus().invites).toBe(0);
  x.bye();
});

test("reto directo por auid de rol: invite -> accept empareja (el retador es el asiento 0)", async () => {
  const x = fakeSocket();
  const y = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  y.say({ t: "hello", session: "sess-b" });
  y.say({ t: "queue" }); // el retado estaba en la cola rapida: al aceptar sale de ella
  const auidB = b.p.roles[b.p.last_use].auid;
  x.say({ t: "challenge", tag: "xx_" + auidB });
  const inv = y.last("invite")!;
  expect(inv).toBeTruthy();
  expect(inv.from).toBe(a.p.name);
  expect(inv.rid).toBe(a.p.last_use);
  expect(x.last("challenge_sent")?.name).toBe(b.p.name);
  expect(live.liveStatus().invites).toBe(1);

  y.say({ t: "accept", id: "otro-id" });
  expect(y.last("error")?.msg).toContain("no longer open");
  y.say({ t: "accept", id: inv.id });
  expect(x.last("match")?.seat).toBe(0);
  expect(y.last("match")?.seat).toBe(1);
  expect(y.last("match")?.name).toBe(a.p.name);
  expect(live.liveStatus()).toEqual({ online: 2, queued: 0, matches: 1, invites: 0 });
  // con la partida en marcha nadie puede retarlos
  const z = fakeSocket();
  z.say({ t: "hello", session: "sess-a" }); // sustituye a x: x sale de la partida
  expect(y.last("peer_left")).toBeTruthy();
  z.bye();
  y.bye();
});

test("reto directo: rechazar, cancelar, ocupado y reto mutuo", () => {
  const x = fakeSocket();
  const y = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  y.say({ t: "hello", session: "sess-b" });

  x.say({ t: "challenge", tag: b.p.name });
  let inv = y.last("invite")!;
  y.say({ t: "decline", id: inv.id });
  expect(x.last("challenge_declined")).toEqual({ t: "challenge_declined", name: b.p.name, busy: 0 });
  expect(live.liveStatus().invites).toBe(0);

  x.say({ t: "challenge", tag: b.p.name });
  inv = y.last("invite")!;
  y.say({ t: "decline", id: inv.id, busy: 1 });
  expect(x.last("challenge_declined")?.busy).toBe(1);

  x.say({ t: "challenge", tag: b.p.name });
  inv = y.last("invite")!;
  x.say({ t: "cancel_challenge" });
  expect(y.last("invite_cancelled")?.id).toBe(inv.id);
  y.say({ t: "accept", id: inv.id });
  expect(y.last("error")?.msg).toContain("no longer open");
  expect(x.last("match")).toBeUndefined();

  // un reto nuevo sustituye al anterior del mismo retador
  x.say({ t: "challenge", tag: b.p.name });
  const first = y.last("invite")!;
  x.say({ t: "challenge", tag: b.p.name });
  const second = y.last("invite")!;
  expect(second.id).not.toBe(first.id);
  expect(y.last("invite_cancelled")?.id).toBe(first.id);
  expect(live.liveStatus().invites).toBe(1);

  // reto mutuo: si el retado reta a su vez al retador, se emparejan sin mas
  y.say({ t: "challenge", tag: a.p.roles[a.p.last_use].auid });
  expect(y.last("match")?.seat).toBe(1);
  expect(x.last("match")?.seat).toBe(0);
  expect(live.liveStatus().invites).toBe(0);
  x.bye();
  y.bye();
});

test("reto directo: si el retador se desconecta el retado recibe invite_cancelled; si se va el retado, challenge_fail", () => {
  let x = fakeSocket();
  let y = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  y.say({ t: "hello", session: "sess-b" });
  x.say({ t: "challenge", tag: b.p.name });
  const inv = y.last("invite")!;
  x.bye();
  expect(y.last("invite_cancelled")?.id).toBe(inv.id);
  expect(live.liveStatus().invites).toBe(0);

  x = fakeSocket();
  x.say({ t: "hello", session: "sess-a" });
  x.say({ t: "challenge", tag: b.p.name });
  expect(y.last("invite")?.id).not.toBe(inv.id);
  y.bye();
  expect(x.last("challenge_fail")?.msg).toContain("went offline");
  x.bye();
});

test("reto directo sin respuesta caduca: invite_expired al retado y challenge_fail al retador", async () => {
  live.configureLive({ inviteTimeoutMs: 20 });
  try {
    const x = fakeSocket();
    const y = fakeSocket();
    x.say({ t: "hello", session: "sess-a" });
    y.say({ t: "hello", session: "sess-b" });
    x.say({ t: "challenge", tag: b.p.name });
    const inv = y.last("invite")!;
    await new Promise((r) => setTimeout(r, 60));
    expect(y.last("invite_expired")?.id).toBe(inv.id);
    expect(x.last("challenge_fail")?.msg).toContain("did not answer");
    expect(live.liveStatus().invites).toBe(0);
    x.bye();
    y.bye();
  } finally {
    live.configureLive({ inviteTimeoutMs: live.INVITE_TIMEOUT_MS });
  }
});
