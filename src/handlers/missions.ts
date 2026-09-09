// Dominio de misiones, buzon, actividades e invitaciones (entertain).
// Formatos: *S2C.Parse del cliente y sus stubs offline (CSDataCenter.NewTestMission/NewTestMail/NewActivityData,
// CSInterfaceMission, CSInterfaceMailbox, CSInterfaceActivity, CSInterfaceSettingInvite).
//
// Misiones (CSDatabase.MissionInfo): status = MissionState (0 Doing, 1 Finish = reclamable, 2 GetFinish = cobrada),
// progress = m_finishAmount (se muestra "progress/targetAmount"). Ciclo 1 = logros/principal, 2 = diarias (se
// reinician cada dia). La cadena "前置" (mision previa) la filtra el cliente: solo muestra una mision si su previa
// ya no esta en Doing. Otros dominios avanzan el progreso con `onEvent(p, evento, cantidad)` (ver EVENT_TYPES).
//
// Buzon: cada correo lleva serial, sendTime/expiryTime en ms, sender/title/content (el cliente los pasa por
// CSLocalization.Get, que devuelve la clave tal cual si no existe: sirve texto plano), annex [{id, amount}],
// read_flag (0 no leido, 1 leido) y content_parm ([0, n] = sustituye %s del contenido por n). Al cobrar el anexo
// el cliente borra el correo, asi que el servidor tambien lo elimina.
//
// Invitaciones: el codigo propio es el auid del rol activo (CSDataCenter.SetInviteData). entertain_flag = codigo que
// este jugador introdujo; entertain_times = cuantos jugadores introdujeron el suyo. entertain_info: fila 0 = premio
// del que introduce un codigo (se entrega directo), filas N = premio del invitador al llegar a N invitados (se
// entrega por correo, no hay mensaje de reclamacion en el cliente).
//
// Actividades: las instancias solo existen en el servidor (ActivityType.txt solo describe tipos), asi que se
// devuelven listas vacias validas para que la UI abra limpia.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerHandler, Frame } from "../game.ts";
import { s2c, grant, parseRewards, refreshAp, isCoin, notice, currentRole, type RewardItem } from "../economy.ts";
import { table } from "../gamedata.ts";
import { config } from "../config.ts";
import { ext, listPlayers, savePlayer, type Player } from "../players.ts";

// Codigos (Localization del cliente): *_1002 "No data" (falta parametro) · *_1003 "Wrong data" / ReceiveMailAnnex_1003
// "Repeat receive" · ReceiveMissionReward_1012 / ReceiveActivityReward_1012 "Claimed already" · ReceiveMissionReward_1019
// "Mission is not completed" · EntertainID_1005 "Wrong code" · EntertainID_1020 "Code is used"
// getItemActivityReward_-2 "no such activity"
const R = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, ALREADY: 1012, NOT_DONE: 1019, WRONG_CODE: 1005, CODE_USED: 1020, NO_ACTIVITY: -2 };

export const MISSION_DOING = 0;
export const MISSION_FINISH = 1; // reclamable
export const MISSION_CLAIMED = 2;

export const MAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // el stub del cliente caduca los correos a los 30 dias

/** Correo de bienvenida de todo jugador nuevo (texto plano: CSLocalization.Get devuelve la clave si no existe). */
export const WELCOME_MAIL = {
  sender: "Boxing Angel",
  title: "Welcome to Boxing Angel!",
  content: "Thanks for joining the community server. Here is a small gift to get you started. Have fun!",
  annex: [
    { id: "gcoin", amount: 3000 },
    { id: "vcoin", amount: 50 },
    { id: "0202005", amount: 2 },
  ] as RewardItem[],
};

// ---- estado del dominio
export type MissionRec = { status: number; progress: number };
export type Mail = {
  serial: number;
  sendTime: number; // ms
  sender: string;
  title: string;
  content: string;
  annex: RewardItem[];
  read_flag: number;
  expiryTime: number; // ms
  content_parm: number[];
  notified: boolean; // ya avisado con NoticeNewMailS2C
};
type MissionsExt = {
  missions: Record<string, MissionRec>;
  dailyDay: string; // dia (YYYY-MM-DD local) al que pertenecen las diarias
  mails: Mail[];
  nextSerial: number;
  welcomed: boolean; // ya se le dejo el correo de bienvenida
  activityClaims: Record<string, number>; // tipo de actividad -> ms de cobro
  entertainRewarded: number[]; // umbrales de entertain_info ya premiados al invitador
  pending: Frame[]; // avisos push (NoticeUpdateEntertainS2C...) pendientes de entregar a este jugador
};

function st(p: Player): MissionsExt {
  return ext<MissionsExt>(p, "missions", () => ({
    missions: {},
    dailyDay: "",
    mails: [],
    nextSerial: 1,
    welcomed: false,
    activityClaims: {},
    entertainRewarded: [],
    pending: [],
  }));
}

/** Clave de dia local (helper privado: no hay uno compartido en economy.ts). */
function dayKey(d = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- mission_info: 0 id, 1 nombre (clave), 2 descripcion (clave), 3 ciclo (1 logro, 2 diaria), 4 tipo (MissionType),
// 5 objetivo (capitulo / calidad / categoria / nivel / franja AP segun tipo), 6 cantidad requerida, 7 premios (JSON), 8 mision previa.
// El servidor sirve una copia corregida en tables/mission_info.txt (sin la linea basura final); si existe, manda.
export type MissionInfo = { id: string; cycle: number; type: number; targetId: number; targetAmount: number; reward: RewardItem[]; pre: string };
let missionTable: Map<string, MissionInfo> | null = null;
export function missionInfos(): Map<string, MissionInfo> {
  if (missionTable) return missionTable;
  const fixed = join(import.meta.dir, "..", "..", "tables", "mission_info.txt");
  let rows: string[][];
  if (existsSync(fixed)) {
    rows = readFileSync(fixed, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "").slice(1).map((l) => l.split("\t"));
  } else rows = table("mission_info.txt");
  missionTable = new Map();
  for (const f of rows) {
    if (!/^\d+$/.test(f[0] ?? "") || f.length < 8) continue; // descarta la linea basura "30110"
    missionTable.set(f[0], {
      id: f[0],
      cycle: Number(f[3]),
      type: Number(f[4]),
      targetId: Number(f[5] || 0),
      targetAmount: Number(f[6] || 1),
      reward: parseRewards(f[7]),
      pre: (f[8] ?? "").trim(),
    });
  }
  return missionTable;
}

// MissionType (CSDatabase): 1 BuyRole, 2 Level_Normal (capitulo concreto), 3 Level_Elite (capitulo concreto), 4 AdvancedEquip
// (targetId = calidad), 5 CollectionEquip (targetId = categoria 101..106 del id de equipo), 6 Manufacture, 7 HallRoadLv
// (targetId = nivel), 8 NPC (transeuntes), 9 CoinChange, 10 Lottery (gacha), 11 SkillUpgrade, 12 GetAP (targetId = franja
// horaria de system_time_info), 13 Monthly, 14 Level_NormalElite (cualquier capitulo), 15 Level_NormalNoT, 16 Level_EliteNoT,
// 17 Level_OutSide, 18 Level_Special, 19 PVP, 20 EliteBattle.
const T = { BUY_ROLE: 1, LV_NORMAL: 2, LV_ELITE: 3, ADV_EQUIP: 4, COLLECT: 5, MANUFACTURE: 6, HALL_LV: 7, NPC: 8, COIN_CHANGE: 9, LOTTERY: 10, SKILL: 11, GET_AP: 12, MONTHLY: 13, LV_ANY: 14, LV_NORMAL_ANY: 15, LV_ELITE_ANY: 16, LV_OUTSIDE: 17, LV_SPECIAL: 18, PVP: 19, ELITE_BATTLE: 20 };

/**
 * Eventos que aceptan `onEvent` (el sufijo ":objetivo" es opcional salvo donde se indica):
 *  - "buy_role"                 compra de rol (tipo 1)
 *  - "chapter_clear:<chId>"     capitulo normal superado (tipos 2 si coincide el capitulo, 14 y 15)
 *  - "elite_clear:<chId>"       capitulo elite superado (tipos 3 si coincide, 14 y 16)
 *  - "outside_clear"            liga exterior (17) · "special_clear" liga especial (18) · "pvp" combate PvP (19) · "elite_battle" (20)
 *  - "equip_quality:<calidad>"  un equipo alcanza esa calidad (tipo 4, cuenta para objetivos <= calidad)
 *  - "collect_equip:<cat>"      equipo nuevo de la categoria (tipo 5; cat = "0102"/"102"... los 3-4 primeros digitos del id)
 *  - "manufacture" (6) · "npc" transeunte vencido (8) · "coin_change" cambio vcoin->gcoin (9) · "gacha" (10)
 *  - "skill_upgrade" (11) · "monthly" tarjeta mensual (13)
 *  - "level_up" / "login"       solo recalculan las misiones derivadas (nivel de gimnasio, franjas de AP, reinicio diario)
 * `amount` = incremento de progreso (por defecto 1).
 */
const EVENT_TYPES: Record<string, number[]> = {
  buy_role: [T.BUY_ROLE],
  chapter_clear: [T.LV_NORMAL, T.LV_ANY, T.LV_NORMAL_ANY],
  elite_clear: [T.LV_ELITE, T.LV_ANY, T.LV_ELITE_ANY],
  outside_clear: [T.LV_OUTSIDE],
  special_clear: [T.LV_SPECIAL],
  pvp: [T.PVP],
  elite_battle: [T.ELITE_BATTLE],
  equip_quality: [T.ADV_EQUIP],
  collect_equip: [T.COLLECT],
  manufacture: [T.MANUFACTURE],
  npc: [T.NPC],
  coin_change: [T.COIN_CHANGE],
  gacha: [T.LOTTERY],
  skill_upgrade: [T.SKILL],
  monthly: [T.MONTHLY],
  level_up: [],
  login: [],
};
export const MISSION_EVENTS = Object.keys(EVENT_TYPES);

/** Franjas horarias (HHMM) en las que se puede cobrar AP (system_time_info: 0 hora, 3 flag "每日任務-AP領取"). */
let apSlots: number[] | null = null;
function apSlotTimes(): number[] {
  if (!apSlots) apSlots = table("system_time_info.txt").filter((f) => f[3] === "1").map((f) => Number(f[0])).filter(Number.isFinite).sort((a, b) => a - b);
  return apSlots;
}

function rec(m: MissionsExt, id: string): MissionRec {
  return (m.missions[id] ??= { status: MISSION_DOING, progress: 0 });
}

/** Reinicio diario + misiones derivadas del estado del jugador (nivel de gimnasio, franjas de AP). Devuelve las que cambiaron. */
function refreshMissions(p: Player, now = new Date()): { id: string; r: MissionRec }[] {
  const m = st(p);
  const changed: { id: string; r: MissionRec }[] = [];
  const today = dayKey(now);
  if (m.dailyDay !== today) {
    m.dailyDay = today;
    for (const [id, info] of missionInfos()) if (info.cycle === 2 && m.missions[id]) delete m.missions[id];
  }
  const hhmm = now.getHours() * 100 + now.getMinutes();
  for (const info of missionInfos().values()) {
    const r = rec(m, info.id);
    if (r.status === MISSION_CLAIMED) continue;
    let status = r.status, progress = r.progress;
    if (info.type === T.HALL_LV) {
      progress = p.lv;
      status = p.lv >= info.targetId ? MISSION_FINISH : MISSION_DOING;
    } else if (info.type === T.GET_AP) {
      const slot = apSlotTimes()[info.targetId - 1];
      status = slot !== undefined && hhmm >= slot ? MISSION_FINISH : MISSION_DOING;
      progress = status;
    } else continue;
    if (status !== r.status || progress !== r.progress) {
      r.status = status;
      r.progress = progress;
      changed.push({ id: info.id, r });
    }
  }
  return changed;
}

function missionOut(id: string, r: MissionRec) {
  return { id, status: r.status, progress: r.progress };
}

/** Lista completa (id, status, progress) tal como la lee GetMissionS2C / NoticeUpdateMissionS2C. */
export function missionList(p: Player) {
  refreshMissions(p);
  const m = st(p);
  return [...missionInfos().keys()].map((id) => missionOut(id, rec(m, id)));
}

/**
 * Avanza el progreso de las misiones afectadas por `event` (ver EVENT_TYPES) en `amount`.
 * Devuelve los frames a anexar a la respuesta del dominio llamante: un NoticeUpdateMissionS2C con las misiones que
 * cambiaron (lista vacia si ninguna). Al terminar una mision pasa a status 1 (reclamable) y el cliente avisa en el lobby.
 */
export function onEvent(p: Player, event: string, amount = 1): Frame[] {
  const [name, target] = event.split(":");
  const types = EVENT_TYPES[name];
  if (!types) throw new Error("evento de mision desconocido " + event);
  const m = st(p);
  const changed = new Map<string, MissionRec>();
  for (const c of refreshMissions(p)) changed.set(c.id, c.r); // derivadas (nivel, franjas AP) y reinicio diario
  const tgt = num(target);
  for (const info of missionInfos().values()) {
    if (!types.includes(info.type)) continue;
    // filtros por objetivo segun tipo
    if (info.type === T.LV_NORMAL || info.type === T.LV_ELITE) { if (tgt === null || tgt !== info.targetId) continue; }
    else if (info.type === T.COLLECT) { if (tgt === null || tgt !== info.targetId) continue; }
    else if (info.type === T.ADV_EQUIP) { if (tgt === null || tgt < info.targetId) continue; }
    const r = rec(m, info.id);
    if (r.status === MISSION_CLAIMED || amount <= 0) continue;
    r.progress = Math.min(info.targetAmount, r.progress + amount);
    if (r.progress >= info.targetAmount) r.status = MISSION_FINISH;
    changed.set(info.id, r);
  }
  if (changed.size === 0) return [];
  return [s2c("NoticeUpdateMissionS2C", { list: [...changed].map(([id, r]) => missionOut(id, r)) })];
}

// ---- buzon
function liveMails(p: Player, now = Date.now()): Mail[] {
  const m = st(p);
  m.mails = m.mails.filter((x) => x.expiryTime > now);
  if (!m.welcomed) {
    m.welcomed = true;
    sendMail(p, config().economy.welcomeMail); // editable desde el panel (Economia)
  }
  return m.mails;
}

/** Deja un correo en el buzon del jugador (otros dominios: recompensas PvP, compensaciones...). Devuelve el correo. */
export function sendMail(p: Player, mail: { sender: string; title: string; content: string; annex?: RewardItem[]; content_parm?: number[]; ttlMs?: number }): Mail {
  const m = st(p);
  const now = Date.now();
  const out: Mail = {
    serial: m.nextSerial++,
    sendTime: now,
    sender: mail.sender,
    title: mail.title,
    content: mail.content,
    annex: (mail.annex ?? []).map((a) => ({ id: a.id, amount: a.amount })),
    read_flag: 0,
    expiryTime: now + (mail.ttlMs ?? MAIL_TTL_MS),
    content_parm: mail.content_parm ?? [],
    notified: false,
  };
  m.mails.push(out);
  return out;
}

function mailOut(x: Mail) {
  const { notified, ...pub } = x;
  return pub;
}

/** Frame NoticeNewMailS2C con los correos aun no anunciados (los marca). Util al terminar el login. */
export function newMailNotice(p: Player): Frame | null {
  const fresh = liveMails(p).filter((x) => !x.notified);
  if (fresh.length === 0) return null;
  for (const x of fresh) x.notified = true;
  return s2c("NoticeNewMailS2C", { list: fresh.map(mailOut) });
}

// ---- entertain_info: 0 numero de invitados (0 = premio del que introduce el codigo), 1 premios (JSON)
type InviteRow = { count: number; reward: RewardItem[] };
let inviteRows: InviteRow[] | null = null;
function inviteTable(): InviteRow[] {
  if (!inviteRows) inviteRows = table("entertain_info.txt").filter((f) => /^\d+$/.test(f[0] ?? "")).map((f) => ({ count: Number(f[0]), reward: parseRewards(f[1] ?? "") }));
  return inviteRows;
}

/** Busca al jugador dueno de un codigo de invitacion (auid de cualquiera de sus roles; el cliente muestra lo que va tras "_"). */
function findByInviteCode(code: string): Player | null {
  const tail = code.includes("_") ? code.slice(code.lastIndexOf("_") + 1) : code;
  for (const q of listPlayers()) if (Object.values(q.roles).some((r) => r.auid === code || r.auid === tail)) return q;
  return null;
}

/** Avisos push acumulados para este jugador (se entregan tras la respuesta del siguiente mensaje del dominio). */
function withPending(p: Player, frames: Frame[]): Frame[] {
  const m = st(p);
  if (m.pending.length === 0) return frames;
  const out = [...frames, ...m.pending];
  m.pending = [];
  return out;
}

/** Aplica premios y devuelve lo necesario para responder: deltas de monedas, exp/ap regalados y objetos [[id, n]]. */
function applyRewards(p: Player, rewards: RewardItem[]) {
  const coinDelta = [0, 0, 0, 0];
  let giveExp = 0, giveAp = 0;
  const items: [string, number][] = [];
  for (const r of rewards) {
    if (isCoin(r.id)) coinDelta[["gcoin", "vcoin", "pcoin", "ecoin"].indexOf(r.id)] += r.amount;
    else if (r.id === "exp") giveExp += r.amount;
    else if (r.id === "ap") giveAp += r.amount;
    else items.push([r.id, r.amount]);
  }
  refreshAp(p);
  const equipsBefore = p.equips.length;
  grant(p, rewards);
  return { coinDelta, giveExp, giveAp, items, newEquips: p.equips.slice(equipsBefore) };
}

export const handlers: Record<string, PlayerHandler> = {
  /** Lista de misiones {id, status, progress}; size 0 = ultimo paquete (el cliente acumula hasta size 0). */
  GetMissionC2S({ p }) {
    return withPending(p, [s2c("GetMissionS2C", { res: R.OK, size: 0, list: missionList(p) })]);
  },

  /** Cobra la mision `id`: devuelve lv/exp/ap/ap_time finales, deltas de monedas, give_exp/give_ap y objetos [[id, n]]. */
  ReceiveMissionRewardC2S({ p, params }) {
    const id = String(params.id ?? "").trim();
    if (!id) return [s2c("ReceiveMissionRewardS2C", { res: R.NO_DATA })];
    const info = missionInfos().get(id);
    if (!info) return [s2c("ReceiveMissionRewardS2C", { res: R.WRONG_DATA })];
    refreshMissions(p);
    const r = rec(st(p), id);
    if (r.status === MISSION_CLAIMED) return [s2c("ReceiveMissionRewardS2C", { res: R.ALREADY })];
    if (r.status !== MISSION_FINISH) return [s2c("ReceiveMissionRewardS2C", { res: R.NOT_DONE })];
    const g = applyRewards(p, info.reward);
    r.status = MISSION_CLAIMED;
    const out: Frame[] = [
      s2c("ReceiveMissionRewardS2C", {
        res: R.OK, lv: p.lv, exp: p.exp, ap: p.ap, ap_time: p.ap_time, coin: g.coinDelta,
        give_exp: g.giveExp, give_ap: g.giveAp, reward: g.items, change_reward: [],
      }),
    ];
    // la respuesta ya lleva monedas/nivel/AP; los objetos se sincronizan por si acaso (cantidad absoluta)
    const itemIds = g.items.map(([i]) => i).filter((i) => i in p.items);
    if (itemIds.length) out.push(notice.items(p, itemIds));
    return withPending(p, out);
  },

  /** Push de misiones cambiadas (el cliente solo lo usa como stub): devuelve la lista completa actual. */
  NoticeUpdateMissionC2S({ p }) {
    return withPending(p, [s2c("NoticeUpdateMissionS2C", { list: missionList(p) })]);
  },

  /** Correos con serial > `serial` (0 = todos), sin caducados; size 0 = ultimo paquete. */
  GetMailC2S({ p, params }) {
    const since = num(params.serial) ?? 0;
    const list = liveMails(p).filter((x) => x.serial > since);
    for (const x of list) x.notified = true;
    return withPending(p, [s2c("GetMailS2C", { res: R.OK, size: 0, list: list.map(mailOut) })]);
  },

  /** Marca el correo como leido. */
  ReadMailC2S({ p, params }) {
    const serial = num(params.serial);
    if (serial === null) return [s2c("ReadMailS2C", { res: R.NO_DATA })];
    const mail = liveMails(p).find((x) => x.serial === serial);
    if (!mail) return [s2c("ReadMailS2C", { res: R.NO_DATA })];
    mail.read_flag = 1;
    return withPending(p, [s2c("ReadMailS2C", { res: R.OK })]);
  },

  /** Cobra el anexo del correo: gcoin/vcoin/pcoin/ecoin (deltas) + reward [[id, n]] de objetos; el correo se elimina. */
  ReceiveMailAnnexC2S({ p, params }) {
    const serial = num(params.serial);
    if (serial === null) return [s2c("ReceiveMailAnnexS2C", { res: R.NO_DATA })];
    const m = st(p);
    const mail = liveMails(p).find((x) => x.serial === serial);
    if (!mail || mail.annex.length === 0) return [s2c("ReceiveMailAnnexS2C", { res: R.WRONG_DATA })]; // "Repeat receive"
    const g = applyRewards(p, mail.annex);
    m.mails = m.mails.filter((x) => x.serial !== serial);
    const [gcoin, vcoin, pcoin, ecoin] = g.coinDelta;
    const out: Frame[] = [s2c("ReceiveMailAnnexS2C", { res: R.OK, gcoin, vcoin, pcoin, ecoin, reward: g.items, change_reward: [] })];
    const itemIds = g.items.map(([i]) => i).filter((i) => i in p.items);
    if (itemIds.length) out.push(notice.items(p, itemIds));
    if (g.giveExp || g.giveAp) out.push(notice.player(p)); // exp/ap por correo no van en la respuesta
    return withPending(p, out);
  },

  /** Push de correos nuevos (stub en el cliente): devuelve los aun no anunciados. */
  NoticeNewMailC2S({ p }) {
    const f = newMailNotice(p);
    return withPending(p, [f ?? s2c("NoticeNewMailS2C", { list: [] })]);
  },

  /** Actividades vigentes: ninguna definida en el servidor -> lista vacia (la UI abre limpia). */
  GetActivityC2S({ p }) {
    return withPending(p, [s2c("GetActivityS2C", { res: R.OK, list: [] })]);
  },

  /** Registros/progreso de actividades del jugador: vacio. */
  GetActivityRecordC2S({ p }) {
    return withPending(p, [s2c("GetActivityRecordS2C", { res: R.OK, size: 0, list: [] })]);
  },

  /** Cobro de actividad por tipo (coin [deltas], reward [[id, n]]): sin actividades -> 1003; repetido -> 1012. */
  ReceiveActivityRewardC2S({ p, params }) {
    const type = num(params.type);
    if (type === null) return [s2c("ReceiveActivityRewardS2C", { res: R.NO_DATA })];
    if (st(p).activityClaims[String(type)]) return [s2c("ReceiveActivityRewardS2C", { res: R.ALREADY })];
    return [s2c("ReceiveActivityRewardS2C", { res: R.WRONG_DATA })];
  },

  /** Push de progreso de actividad de acumulacion (receptor "addItemActivityRecord", sin sufijo S2C): registro vacio. */
  addItemActivityRecordC2S() {
    return [s2c("addItemActivityRecord", { res: R.OK, id: 0, activity_id: "", activity_type: 0, item_id: "", item_count: 0 })];
  },

  /** Canje de actividad de ranking (rs, rewadList [{itemID, amount}]): no hay actividades -> rs -2 "no such activity". */
  getItemActivityRewardC2S() {
    return [s2c("getItemActivityRewardS2C", { rs: R.NO_ACTIVITY, rewadList: [] })];
  },

  /** Registros de canje del jugador para los ids pedidos: rs = lista vacia. */
  getUserItemActivityRecordC2S() {
    return [s2c("getUserItemActivityRecordS2C", { rs: [] })];
  },

  /** Objetos extra caidos (receptor "getAdditionalReward", sin sufijo S2C): rewadList [{itemID, amount}] vacio. */
  getAdditionalRewardC2S() {
    return [s2c("getAdditionalReward", { res: R.OK, rewadList: [] })];
  },

  /** Introduce el codigo de invitacion de otro jugador: premio fila 0 de entertain_info para este jugador; el invitador suma entertain_times y recibe por correo los premios de los umbrales alcanzados. */
  EntertainIDC2S({ p, params, log }) {
    const code = String(params.id ?? "").trim();
    if (!code) return [s2c("EntertainIDS2C", { res: R.NO_DATA })];
    if (p.entertain_flag) return [s2c("EntertainIDS2C", { res: R.CODE_USED })];
    if (Object.values(p.roles).some((r) => r.auid === code)) return [s2c("EntertainIDS2C", { res: R.WRONG_DATA })];
    const inviter = findByInviteCode(code);
    if (!inviter || inviter.acc === p.acc) return [s2c("EntertainIDS2C", { res: R.WRONG_CODE })];
    p.entertain_flag = code;
    const own = inviteTable().find((r) => r.count === 0)?.reward ?? [];
    const g = applyRewards(p, own);
    // invitador
    inviter.entertain_times += 1;
    const inv = st(inviter);
    for (const row of inviteTable()) {
      if (row.count === 0 || row.count > inviter.entertain_times || inv.entertainRewarded.includes(row.count)) continue;
      inv.entertainRewarded.push(row.count);
      sendMail(inviter, { sender: "Boxing Angel", title: `Invite reward: ${row.count} friends`, content: `${p.name} joined with your invite code. Thanks for growing the community! Here is your reward for ${row.count} invited friends.`, annex: row.reward });
    }
    inv.pending.push(s2c("NoticeUpdateEntertainS2C", { entertain_times: inviter.entertain_times }));
    const f = newMailNotice(inviter);
    if (f) inv.pending.push(f);
    savePlayer(inviter);
    log("EntertainIDC2S", p.name, "->", inviter.name, "invitados:", inviter.entertain_times);
    const out: Frame[] = [s2c("EntertainIDS2C", { res: R.OK })];
    // la respuesta solo lleva res: todo lo ganado se sincroniza con notice.*
    if (g.coinDelta.some((c) => c !== 0)) out.push(notice.coin(p));
    const itemIds = g.items.map(([i]) => i).filter((i) => i in p.items);
    if (itemIds.length) out.push(notice.items(p, itemIds));
    if (g.newEquips.length) out.push(notice.equips(g.newEquips));
    if (g.giveExp || g.giveAp) out.push(notice.player(p));
    return withPending(p, out);
  },

  /** Push del contador de invitados (stub en el cliente): entertain_times actual. */
  NoticeUpdateEntertainC2S({ p }) {
    return withPending(p, [s2c("NoticeUpdateEntertainS2C", { entertain_times: p.entertain_times })]);
  },
};

/** Codigo de invitacion propio tal como lo muestra el cliente (auid del rol activo). */
export const inviteCode = (p: Player) => currentRole(p).auid;
