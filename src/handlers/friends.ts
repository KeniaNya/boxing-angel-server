// Dominio de amigos: lista, solicitudes, busqueda/aleatorio, regalo diario de AP y ficha de equipo.
// Formatos: *S2C.Parse del cliente (FriendData = f_auid, f_name, f_lv, f_ltime(ms), f_rid, give_flag, receive_flag)
// y constantes de CSDataCenter: s_GetApValue = 2 AP por regalo, s_GetApMax = 50 recepciones/dia (= friend_times),
// GetFriendMaxValue = 10 + floor(lv/2) amigos, s_FriendMax = 40 (bandeja de solicitudes).
//
// Identidad: el cliente identifica a los jugadores por el auid del rol activo (m_PKRoleInfo.UID). Como cada rol
// tiene su propio auid, internamente se indexa por cuenta (acc) y se resuelve el auid/nombre escaneando listPlayers().
//
// Avisos push (NoticeUpdateFriendS2C / NoticeFriendGvieS2C): socket.ts no expone las sesiones de otros jugadores,
// asi que se encolan en el ext del destinatario y se entregan con su siguiente mensaje de este dominio
// (o al vaciar la cola con NoticeUpdateFriendC2S / NoticeFriendGvieC2S).

import type { PlayerHandler, Frame } from "../game.ts";
import { s2c, refreshAp, currentRole, findEquip } from "../economy.ts";
import { ext, listPlayers, loadPlayer, savePlayer, type Player } from "../players.ts";

// Codigos (Localization del cliente): *_1002 "faltan parametros" · *_1003 "parametro incorrecto" · *_1005 "no existe ese amigo"
// · AddFriend_1012 / ResponsesAddFriend_1012 "tus amigos estan llenos" · AddFriend_1020 "solicitud ya enviada"
// · AddFriend_1028 "bandeja de solicitudes del otro llena" · ResponsesAddFriend_1028 "amigos del otro llenos"
// · GiveFriend_1012 "hoy ya regalaste" · ReceiveFriend_1012 "hoy ya recibiste"
const R = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, NO_FRIEND: 1005, SELF_FULL: 1012, ALREADY_ASKED: 1020, OTHER_FULL: 1028, ALREADY_TODAY: 1012 };

export const GIVE_AP = 2; // CSDataCenter.s_GetApValue
export const RECEIVE_MAX_PER_DAY = 50; // CSDataCenter.s_GetApMax
export const REQUEST_INBOX_MAX = 40; // CSDataCenter.s_FriendMax
export const friendMax = (p: Player) => 10 + Math.floor(p.lv / 2); // CSDataCenter.GetFriendMaxValue

/** Registro de un amigo (clave: acc del amigo). Los dias son claves YYYY-MM-DD locales. */
type FriendRec = { gaveDay: string; giftDay: string; receivedDay: string };
type FriendsExt = {
  friends: Record<string, FriendRec>; // acc -> estado del regalo diario
  requests: string[]; // accs que me han pedido amistad (pendientes)
  timesDay: string; // dia al que pertenece p.friend_times
  lastActive: number; // ms, ultima actividad vista por este dominio (f_ltime para los demas)
  notices: Frame[]; // avisos push pendientes de entregar a este jugador
};

function st(p: Player): FriendsExt {
  return ext<FriendsExt>(p, "friends", () => ({ friends: {}, requests: [], timesDay: "", lastActive: Date.now(), notices: [] }));
}

/** Clave de dia local (helper privado: no hay uno compartido en economy.ts). */
export function dayKey(d = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Reinicia el contador diario de recepciones (friend_times) si cambio el dia. Util para el login. */
export function refreshFriendDay(p: Player): void {
  const f = st(p);
  const today = dayKey();
  if (f.timesDay !== today) {
    f.timesDay = today;
    p.friend_times = 0;
  }
}

/** Marca actividad del jugador (f_ltime que ven sus amigos). El login puede llamarlo. */
export function touchFriendActivity(p: Player): void {
  st(p).lastActive = Date.now();
}

const auidOf = (p: Player) => currentRole(p).auid;
const nameEq = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Busca un jugador por auid (de cualquiera de sus roles) o por nombre. Acepta "xxx_auid" (el cliente parte por "_"). */
function findPlayer(tag: string): Player | null {
  const t = tag.trim();
  if (!t) return null;
  const tail = t.includes("_") ? t.slice(t.lastIndexOf("_") + 1) : t;
  for (const q of listPlayers()) {
    if (Object.values(q.roles).some((r) => r.auid === t || r.auid === tail)) return q;
  }
  for (const q of listPlayers()) if (nameEq(q.name, t)) return q;
  return null;
}

function friendOf(p: Player, acc: string): Player | null {
  const q = loadPlayer(acc);
  if (!q) delete st(p).friends[acc]; // amigo borrado del servidor
  return q;
}

/** Hashtable FriendData que espera el cliente; las banderas se calculan desde el punto de vista de `viewer`. */
function friendData(target: Player, viewer?: Player) {
  const today = dayKey();
  const rec = viewer ? st(viewer).friends[target.acc] : undefined;
  const give_flag = rec && rec.gaveDay === today ? 1 : 0; // 1 = CanNotGive (hoy ya regale)
  const receive_flag = !rec ? 0 : rec.receivedDay === today ? 2 : rec.giftDay === today ? 1 : 0; // 0 CanNotGet · 1 CanGet · 2 HasGet
  const role = currentRole(target);
  return { f_auid: role.auid, f_name: target.name, f_lv: target.lv, f_ltime: st(target).lastActive, f_rid: role.rid, give_flag, receive_flag };
}

/** Encola un aviso push para otro jugador y lo guarda. */
function pushNotice(target: Player, frame: Frame): void {
  st(target).notices.push(frame);
  savePlayer(target);
}

/** Avisos pendientes de este jugador (se vacian al entregarlos). */
function drainNotices(p: Player, method?: string): Frame[] {
  const f = st(p);
  const out = f.notices.filter((n) => !method || n.methodName === method);
  f.notices = method ? f.notices.filter((n) => n.methodName !== method) : [];
  return out;
}

function areFriends(a: Player, b: Player): boolean {
  return !!st(a).friends[b.acc] && !!st(b).friends[a.acc];
}

function link(a: Player, b: Player): void {
  st(a).friends[b.acc] ??= { gaveDay: "", giftDay: "", receivedDay: "" };
  st(b).friends[a.acc] ??= { gaveDay: "", giftDay: "", receivedDay: "" };
  st(a).requests = st(a).requests.filter((x) => x !== b.acc);
  st(b).requests = st(b).requests.filter((x) => x !== a.acc);
}

function paramList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x)).filter((x) => x !== "");
}

/** Respuesta comun: frames de la respuesta + avisos pendientes del jugador. */
function reply(p: Player, frames: Frame[]): Frame[] {
  touchFriendActivity(p);
  return [...frames, ...drainNotices(p)];
}

export const handlers: Record<string, PlayerHandler> = {
  // Lista de amigos con banderas de regalo (give_flag/receive_flag); size 0 cierra la carga paginada.
  GetFriendC2S({ p }) {
    refreshFriendDay(p);
    drainNotices(p, "NoticeUpdateFriendS2C"); // la lista es la verdad: los avisos de lista quedan obsoletos
    const list: Record<string, unknown>[] = [];
    for (const acc of Object.keys(st(p).friends)) {
      const q = friendOf(p, acc);
      if (q) list.push(friendData(q, p));
    }
    return reply(p, [s2c("GetFriendS2C", { res: R.OK, list, size: 0 })]);
  },

  // Solicitudes de amistad recibidas (FriendData con give_flag 0).
  GetAskAddFriendC2S({ p }) {
    const f = st(p);
    f.requests = f.requests.filter((acc) => loadPlayer(acc));
    const list = f.requests.map((acc) => friendData(loadPlayer(acc)!, p));
    return reply(p, [s2c("GetAskAddFriendS2C", { res: R.OK, list })]);
  },

  // Enviar solicitud de amistad a `auid`; el otro la ve en GetAskAddFriend y recibe NoticeUpdateFriend(type 1, action 0).
  AddFriendC2S({ p, params, log }) {
    const tag = String(params.auid ?? "");
    if (!tag) return reply(p, [s2c("AddFriendS2C", { res: R.NO_DATA })]);
    const q = findPlayer(tag);
    if (!q || q.acc === p.acc || areFriends(p, q)) return reply(p, [s2c("AddFriendS2C", { res: R.WRONG_DATA })]);
    if (Object.keys(st(p).friends).length >= friendMax(p)) return reply(p, [s2c("AddFriendS2C", { res: R.SELF_FULL })]);
    if (st(q).requests.includes(p.acc)) return reply(p, [s2c("AddFriendS2C", { res: R.ALREADY_ASKED })]);
    if (st(p).requests.includes(q.acc)) {
      // El otro ya me habia pedido amistad: se aceptan mutuamente.
      if (Object.keys(st(q).friends).length >= friendMax(q)) return reply(p, [s2c("AddFriendS2C", { res: R.OTHER_FULL })]);
      link(p, q);
      pushNotice(q, s2c("NoticeUpdateFriendS2C", { type: 0, action: 0, ...friendData(p, q) }));
      log("AddFriendC2S: amistad mutua", p.name, "<->", q.name);
      return reply(p, [s2c("AddFriendS2C", { res: R.OK })]);
    }
    if (st(q).requests.length >= REQUEST_INBOX_MAX) return reply(p, [s2c("AddFriendS2C", { res: R.OTHER_FULL })]);
    st(q).requests.push(p.acc);
    pushNotice(q, s2c("NoticeUpdateFriendS2C", { type: 1, action: 0, ...friendData(p, q) }));
    log("AddFriendC2S", p.name, "->", q.name);
    return reply(p, [s2c("AddFriendS2C", { res: R.OK })]);
  },

  // Responder a una solicitud: type 0 acepta (ambos se anaden), type 1 rechaza. El solicitante recibe NoticeUpdateFriend(type 0, action 0).
  ResponsesAddFriendC2S({ p, params, log }) {
    const tag = String(params.auid ?? "");
    const type = Number(params.type);
    if (!tag || params.type === undefined) return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.NO_DATA })]);
    const q = findPlayer(tag);
    if (!q || (type !== 0 && type !== 1) || !st(p).requests.includes(q.acc)) return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.WRONG_DATA })]);
    if (type === 1) {
      st(p).requests = st(p).requests.filter((x) => x !== q.acc);
      log("ResponsesAddFriendC2S: rechazada", q.name, "->", p.name);
      return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.OK })]);
    }
    if (Object.keys(st(p).friends).length >= friendMax(p)) return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.SELF_FULL })]);
    if (Object.keys(st(q).friends).length >= friendMax(q)) return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.OTHER_FULL })]);
    link(p, q);
    pushNotice(q, s2c("NoticeUpdateFriendS2C", { type: 0, action: 0, ...friendData(p, q) }));
    log("ResponsesAddFriendC2S: aceptada", q.name, "<->", p.name);
    return reply(p, [s2c("ResponsesAddFriendS2C", { res: R.OK })]);
  },

  // Borrar amigo (de ambas listas); el otro recibe NoticeUpdateFriend(type 0, action 1).
  DeleteFriendC2S({ p, params, log }) {
    const tag = String(params.auid ?? "");
    if (!tag) return reply(p, [s2c("DeleteFriendS2C", { res: R.NO_DATA })]);
    const q = findPlayer(tag);
    if (!q || !st(p).friends[q.acc]) return reply(p, [s2c("DeleteFriendS2C", { res: R.WRONG_DATA })]);
    delete st(p).friends[q.acc];
    delete st(q).friends[p.acc];
    pushNotice(q, s2c("NoticeUpdateFriendS2C", { type: 0, action: 1, f_auid: auidOf(p) }));
    log("DeleteFriendC2S", p.name, "-x-", q.name);
    return reply(p, [s2c("DeleteFriendS2C", { res: R.OK })]);
  },

  // Regalar AP a la lista de amigos (una vez al dia por amigo). Devuelve los auid que si se regalaron; el amigo
  // pasa a receive_flag 1 (CanGet) y recibe NoticeFriendGvie{f_auid}. El que regala no gana nada.
  GiveFriendC2S({ p, params, log }) {
    const ids = paramList(params.list);
    if (!ids) return reply(p, [s2c("GiveFriendS2C", { res: R.NO_DATA })]);
    const today = dayKey();
    const ok: string[] = [];
    let known = 0;
    for (const id of ids) {
      const q = findPlayer(id);
      const rec = q ? st(p).friends[q.acc] : undefined;
      if (!q || !rec) continue;
      known++;
      if (rec.gaveDay === today) continue;
      rec.gaveDay = today;
      const theirs = (st(q).friends[p.acc] ??= { gaveDay: "", giftDay: "", receivedDay: "" });
      theirs.giftDay = today;
      pushNotice(q, s2c("NoticeFriendGvieS2C", { f_auid: auidOf(p) }));
      ok.push(id);
    }
    if (ids.length > 0 && known === 0) return reply(p, [s2c("GiveFriendS2C", { res: R.NO_FRIEND })]);
    if (ids.length > 0 && ok.length === 0) return reply(p, [s2c("GiveFriendS2C", { res: R.ALREADY_TODAY })]);
    log("GiveFriendC2S", p.name, "->", ok.length, "amigos");
    return reply(p, [s2c("GiveFriendS2C", { res: R.OK, list: ok })]);
  },

  // Recibir el AP regalado por la lista de amigos (2 AP cada uno, max 50 recepciones/dia = friend_times).
  // La respuesta lleva ap/ap_time y el cliente los aplica directamente (no hace falta notice.player).
  ReceiveFriendC2S({ p, params, log }) {
    const ids = paramList(params.list);
    if (!ids) return reply(p, [s2c("ReceiveFriendS2C", { res: R.NO_DATA })]);
    refreshFriendDay(p);
    refreshAp(p);
    const today = dayKey();
    const ok: string[] = [];
    let known = 0;
    for (const id of ids) {
      if (p.friend_times >= RECEIVE_MAX_PER_DAY) break;
      const q = findPlayer(id);
      const rec = q ? st(p).friends[q.acc] : undefined;
      if (!q || !rec) continue;
      known++;
      if (rec.giftDay !== today || rec.receivedDay === today) continue;
      rec.receivedDay = today;
      p.friend_times++;
      p.ap += GIVE_AP;
      ok.push(id);
    }
    if (ids.length > 0 && ok.length === 0) {
      const res = p.friend_times >= RECEIVE_MAX_PER_DAY || known > 0 ? R.ALREADY_TODAY : R.NO_FRIEND;
      return reply(p, [s2c("ReceiveFriendS2C", { res })]);
    }
    log("ReceiveFriendC2S", p.name, "+", ok.length * GIVE_AP, "AP");
    return reply(p, [s2c("ReceiveFriendS2C", { res: R.OK, list: ok, ap: p.ap, ap_time: p.ap_time })]);
  },

  // Ficha de un amigo: rid del rol activo y su equipo puesto (mismo formato Equip que LoginS2C.ParseEquip).
  GetFriendInfoC2S({ p, params }) {
    const tag = String(params.auid ?? "");
    if (!tag) return reply(p, [s2c("GetFriendInfoS2C", { res: R.NO_DATA })]);
    const q = findPlayer(tag);
    if (!q) return reply(p, [s2c("GetFriendInfoS2C", { res: R.NO_FRIEND })]);
    const role = currentRole(q);
    const equip = role.equip_in.filter((id) => id !== "").map((id) => findEquip(q, id)).filter((e) => e !== undefined);
    return reply(p, [s2c("GetFriendInfoS2C", { res: R.OK, rid: role.rid, equip })]);
  },

  // Buscar jugadores por nombre o auid (tag). Lista vacia = "no existe ese amigo" en el cliente.
  FindPlayerC2S({ p, params }) {
    const tag = String(params.tag ?? "").trim();
    if (!tag) return reply(p, [s2c("FindPlayerS2C", { res: R.NO_DATA })]);
    const q = findPlayer(tag);
    const list = q && q.acc !== p.acc ? [friendData(q, p)] : [];
    return reply(p, [s2c("FindPlayerS2C", { res: R.OK, list })]);
  },

  // Hasta 5 jugadores al azar que no sean yo, ni amigos, ni tengan ya una solicitud mia. Vacio si no hay nadie.
  RandomPlayerC2S({ p }) {
    const f = st(p);
    const pool = listPlayers().filter((q) => q.acc !== p.acc && !f.friends[q.acc] && !st(q).requests.includes(p.acc) && !f.requests.includes(q.acc));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const list = pool.slice(0, 5).map((q) => friendData(q, p));
    return reply(p, [s2c("RandomPlayerS2C", { res: R.OK, list })]);
  },

  // El cliente real nunca lo envia (solo stubs de prueba): entrega los NoticeFriendGvieS2C pendientes (un amigo me regalo AP).
  NoticeFriendGvieC2S({ p }) {
    return drainNotices(p, "NoticeFriendGvieS2C");
  },

  // Idem: entrega los NoticeUpdateFriendS2C pendientes (altas/bajas de amigos y solicitudes). Nunca se manda uno vacio:
  // el cliente lo interpretaria como "anadir amigo con uid vacio".
  NoticeUpdateFriendC2S({ p }) {
    return drainNotices(p, "NoticeUpdateFriendS2C");
  },
};
