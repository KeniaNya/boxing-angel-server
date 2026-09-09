// Pruebas del dominio de amigos: solicitud/aceptacion, regalo diario de AP, busqueda, borrado y aleatorio.
// testutil fija LENA_APPDATA antes de cargar players.ts, por eso se importa primero.
import { test, expect } from "bun:test";
import { silentLog } from "../testutil.ts";
import { GIVE_AP } from "./friends.ts";

const players = await import("../players.ts");
const game = await import("../game.ts");
// loadHandlerModules no es idempotente (segunda llamada = "handler duplicado"), y testSession() lo llama cada vez:
// aqui hacen falta dos sesiones por prueba, asi que se cargan los modulos una sola vez y se construyen a mano.
await game.loadHandlerModules(silentLog);

const uniq = () => Math.random().toString(36).slice(2, 8);

/** Sesion logueada de un jugador nuevo con nombre propio (misma forma que testutil.testSession). */
function session(acc: string, name: string) {
  const p = players.createPlayer(acc, name, "1100001");
  const s: import("../game.ts").GameSession = { id: acc, createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc, player: p, sessionKey: "k" };
  return { s, p, send: (method: string, params: Record<string, unknown> = {}) => game.dispatch(s, method, params, silentLog) };
}
type Session = ReturnType<typeof session>;

/** Dos jugadores, cada uno con su sesion. */
async function pair() {
  const A = session("fa-" + uniq(), "Ana" + uniq());
  const B = session("fb-" + uniq(), "Bea" + uniq());
  return { A, B };
}
const auid = (p: import("../players.ts").Player) => p.roles[p.last_use].auid;
const friendList = async (s: Session) => {
  const out = await s.send("GetFriendC2S");
  expect(out[0].methodName).toBe("GetFriendS2C");
  expect(out[0].paramObject.res).toBe(0);
  expect(out[0].paramObject.size).toBe(0);
  return out[0].paramObject.list as Record<string, unknown>[];
};

/** A y B ya amigos (A pide, B acepta). */
async function befriended() {
  const { A, B } = await pair();
  expect((await A.send("AddFriendC2S", { auid: auid(B.p) }))[0].paramObject.res).toBe(0);
  expect((await B.send("ResponsesAddFriendC2S", { type: 0, auid: auid(A.p) }))[0].paramObject.res).toBe(0);
  return { A, B };
}

test("A pide amistad, B la ve, acepta y ambos se tienen en la lista", async () => {
  const { A, B } = await pair();
  const add = await A.send("AddFriendC2S", { auid: auid(B.p) });
  expect(add[0].methodName).toBe("AddFriendS2C");
  expect(add[0].paramObject.res).toBe(0);

  // B ve la solicitud (FriendData de A) y ademas recibe el aviso push NoticeUpdateFriend(type 1, action 0)
  const ask = await B.send("GetAskAddFriendC2S");
  expect(ask[0].paramObject.res).toBe(0);
  const reqs = ask[0].paramObject.list as Record<string, unknown>[];
  expect(reqs).toHaveLength(1);
  expect(reqs[0].f_auid).toBe(auid(A.p));
  expect(reqs[0].f_name).toBe(A.p.name);
  expect(reqs[0].f_rid).toBe(A.p.last_use);
  expect(typeof reqs[0].f_lv).toBe("number");
  expect(typeof reqs[0].f_ltime).toBe("number");
  const notice = ask.find((f) => f.methodName === "NoticeUpdateFriendS2C");
  expect(notice?.paramObject).toMatchObject({ type: 1, action: 0, f_auid: auid(A.p) });

  // Pedir dos veces = "solicitud ya enviada"
  expect((await A.send("AddFriendC2S", { auid: auid(B.p) }))[0].paramObject.res).toBe(1020);

  const resp = await B.send("ResponsesAddFriendC2S", { type: 0, auid: auid(A.p) });
  expect(resp[0].methodName).toBe("ResponsesAddFriendS2C");
  expect(resp[0].paramObject.res).toBe(0);

  const la = await friendList(A);
  const lb = await friendList(B);
  expect(la.map((f) => f.f_auid)).toEqual([auid(B.p)]);
  expect(lb.map((f) => f.f_auid)).toEqual([auid(A.p)]);
  expect(la[0]).toMatchObject({ give_flag: 0, receive_flag: 0 });
  // la solicitud desaparece de la bandeja de B
  expect((await B.send("GetAskAddFriendC2S"))[0].paramObject.list).toEqual([]);
  // el estado del otro jugador quedo persistido en disco
  expect(JSON.stringify(players.loadPlayer(B.p.acc)!.ext)).toContain(A.p.acc);
});

test("rechazar una solicitud la elimina sin crear amistad", async () => {
  const { A, B } = await pair();
  await A.send("AddFriendC2S", { auid: auid(B.p) });
  expect((await B.send("ResponsesAddFriendC2S", { type: 1, auid: auid(A.p) }))[0].paramObject.res).toBe(0);
  expect((await B.send("GetAskAddFriendC2S"))[0].paramObject.list).toEqual([]);
  expect(await friendList(A)).toEqual([]);
  expect(await friendList(B)).toEqual([]);
});

test("GiveFriend/ReceiveFriend: 2 AP por amigo, una vez al dia", async () => {
  const { A, B } = await befriended();
  const give = await A.send("GiveFriendC2S", { list: [auid(B.p)] });
  expect(give[0].methodName).toBe("GiveFriendS2C");
  expect(give[0].paramObject).toMatchObject({ res: 0, list: [auid(B.p)] });
  // segunda vez hoy: "hoy ya regalaste"
  expect((await A.send("GiveFriendC2S", { list: [auid(B.p)] }))[0].paramObject.res).toBe(1012);
  expect((await friendList(A))[0].give_flag).toBe(1);

  // B ve el regalo (receive_flag 1 = CanGet) y, tras la respuesta, el aviso push NoticeFriendGvie{f_auid de A}
  const getB = await B.send("GetFriendC2S");
  expect((getB[0].paramObject.list as Record<string, unknown>[])[0].receive_flag).toBe(1);
  const notice = getB.find((f) => f.methodName === "NoticeFriendGvieS2C");
  expect(notice?.paramObject.f_auid).toBe(auid(A.p));

  const apBefore = B.p.ap;
  const timesBefore = B.p.friend_times;
  const recv = await B.send("ReceiveFriendC2S", { list: [auid(A.p)] });
  expect(recv[0].methodName).toBe("ReceiveFriendS2C");
  expect(recv[0].paramObject).toMatchObject({ res: 0, list: [auid(A.p)], ap: apBefore + GIVE_AP });
  expect(typeof recv[0].paramObject.ap_time).toBe("number");
  expect(B.p.ap).toBe(apBefore + GIVE_AP);
  expect(B.p.friend_times).toBe(timesBefore + 1);
  expect((await friendList(B))[0].receive_flag).toBe(2);

  // recibir de nuevo el mismo dia: "hoy ya recibiste" y sin AP extra
  expect((await B.send("ReceiveFriendC2S", { list: [auid(A.p)] }))[0].paramObject.res).toBe(1012);
  expect(B.p.ap).toBe(apBefore + GIVE_AP);
});

test("GiveFriend a alguien que no es amigo y parametros invalidos", async () => {
  const { A, B } = await pair();
  expect((await A.send("GiveFriendC2S", { list: [auid(B.p)] }))[0].paramObject.res).toBe(1005);
  expect((await A.send("GiveFriendC2S", {}))[0].paramObject.res).toBe(1002);
  expect((await A.send("ReceiveFriendC2S", {}))[0].paramObject.res).toBe(1002);
  expect((await A.send("AddFriendC2S", {}))[0].paramObject.res).toBe(1002);
  expect((await A.send("AddFriendC2S", { auid: auid(A.p) }))[0].paramObject.res).not.toBe(0); // a uno mismo
  expect((await A.send("AddFriendC2S", { auid: "no-existe" }))[0].paramObject.res).not.toBe(0);
  expect((await A.send("DeleteFriendC2S", { auid: auid(B.p) }))[0].paramObject.res).not.toBe(0);
  expect((await A.send("ResponsesAddFriendC2S", { type: 0, auid: auid(B.p) }))[0].paramObject.res).not.toBe(0);
});

test("FindPlayer por nombre y por auid", async () => {
  const { A, B } = await pair();
  const byName = await A.send("FindPlayerC2S", { tag: B.p.name });
  expect(byName[0].methodName).toBe("FindPlayerS2C");
  expect(byName[0].paramObject.res).toBe(0);
  const list = byName[0].paramObject.list as Record<string, unknown>[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ f_auid: auid(B.p), f_name: B.p.name, f_rid: B.p.last_use, give_flag: 0 });

  const byAuid = await A.send("FindPlayerC2S", { tag: auid(B.p) });
  expect((byAuid[0].paramObject.list as unknown[]).length).toBe(1);

  // sin coincidencias: lista vacia con res 0; sin tag: error
  expect((await A.send("FindPlayerC2S", { tag: "zzz-nadie-" + uniq() }))[0].paramObject).toMatchObject({ res: 0, list: [] });
  expect((await A.send("FindPlayerC2S", {}))[0].paramObject.res).toBe(1002);
  // uno mismo no aparece
  expect((await A.send("FindPlayerC2S", { tag: A.p.name }))[0].paramObject.list).toEqual([]);
});

test("DeleteFriend borra de ambas listas y avisa al otro", async () => {
  const { A, B } = await befriended();
  const del = await A.send("DeleteFriendC2S", { auid: auid(B.p) });
  expect(del[0].methodName).toBe("DeleteFriendS2C");
  expect(del[0].paramObject.res).toBe(0);
  expect(await friendList(A)).toEqual([]);
  // B recibe NoticeUpdateFriend(type 0, action 1) con su proxima respuesta del dominio
  const askB = await B.send("GetAskAddFriendC2S");
  const notice = askB.find((f) => f.methodName === "NoticeUpdateFriendS2C");
  expect(notice?.paramObject).toMatchObject({ type: 0, action: 1, f_auid: auid(A.p) });
  expect(await friendList(B)).toEqual([]);
  // ya no se puede regalar
  expect((await A.send("GiveFriendC2S", { list: [auid(B.p)] }))[0].paramObject.res).toBe(1005);
});

test("GetFriendInfo devuelve rid y equipo del amigo", async () => {
  const { A, B } = await befriended();
  const info = await A.send("GetFriendInfoC2S", { type: 0, auid: auid(B.p) });
  expect(info[0].methodName).toBe("GetFriendInfoS2C");
  expect(info[0].paramObject.res).toBe(0);
  expect(info[0].paramObject.rid).toBe(B.p.last_use);
  const equip = info[0].paramObject.equip as Record<string, unknown>[];
  expect(equip.length).toBeGreaterThan(0);
  expect(equip[0]).toHaveProperty("id");
  expect(equip[0]).toHaveProperty("lv");
  expect(equip[0]).toHaveProperty("quality");
  expect((await A.send("GetFriendInfoC2S", { type: 0, auid: "nadie" }))[0].paramObject.res).toBe(1005);
});

test("RandomPlayer nunca devuelve a uno mismo ni a amigos y tolera no tener candidatos", async () => {
  const { A, B } = await befriended();
  const out = await A.send("RandomPlayerC2S");
  expect(out[0].methodName).toBe("RandomPlayerS2C");
  expect(out[0].paramObject.res).toBe(0);
  const list = out[0].paramObject.list as Record<string, unknown>[];
  expect(Array.isArray(list)).toBe(true);
  expect(list.length).toBeLessThanOrEqual(5);
  const ids = list.map((f) => f.f_auid);
  expect(ids).not.toContain(auid(A.p));
  expect(ids).not.toContain(auid(B.p));
  for (const f of list) expect(f).toMatchObject({ give_flag: 0 });
});

test("NoticeUpdateFriendC2S / NoticeFriendGvieC2S vacian la cola sin mandar frames vacios", async () => {
  const { A } = await pair();
  expect(await A.send("NoticeUpdateFriendC2S")).toEqual([]);
  expect(await A.send("NoticeFriendGvieC2S")).toEqual([]);
});
