// Dominio PvP asincrono + rankings + "asesino" (evento semanal de pisos con ranking).
//
// PvP (formatos de *S2C.Parse y stubs offline del cliente):
//  - El jugador registra un rol (RegisterPvPContestant) y ocupa un puesto unico en una escalera de rangos
//    (1 = mejor). Los puestos 1..NPC_LADDER que no ocupa ningun jugador real los rellenan NPC (npc_info),
//    deterministas por rango, asi la comunidad pequena siempre tiene rivales y tabla de clasificacion.
//  - GetPvPOpponent ofrece hasta 3 rivales con mejor rango (jugadores reales primero, NPC de relleno);
//    StartPvPBattle(index) elige uno de esa lista, consume un intento (pvp_times = usados hoy, max
//    PVP_TIMES_MAX) y arranca el enfriamiento (pvp_flag = ms de la ultima batalla, PVP_COOLDOWN_MS).
//  - ReportPvPBattleResults: victoria = tomar el puesto del rival (rival real: intercambio de puestos,
//    fail++ y registro en su historial) + PVP coin de pvp_reward_info por el rango nuevo; derrota = fail++.
//  - Recompensa diaria de rango (pvp_reward_info: gcoin/vcoin/objetos) al abrir el PvP el dia siguiente.
//  - Precios (price_info): col 1 = reset de enfriamiento (por refresh_pvp_times), col 2 = comprar intento
//    (por buy_pvp_times, tope vip_info fila 4). Contadores diarios: se reinician al cambiar de dia.
//  - BulletinBattleFail es un push del servidor al perdedor; no hay acceso a otras sesiones, asi que la
//    derrota queda en su historial y en pvp_rank/pvp_fail (se ve al reloguear). No se responde nada.
//
// Rankings (getRank*): no hay tabla de eventos; se ofrecen dos rankings fijos (victorias PvP y nivel de
// gimnasio) con las recompensas por tramo de pvp_reward_info. Identidad de jugadores: auid de rol.
//
// Asesino (getPlayerAssassinInfo/playAssassin/reportAssassinChapter/getAssassinRank*): capitulos tipo 80
// de chapter_info encadenados como el cliente (mismo tipo+capitulo+modo, seccion siguiente). Progreso y
// estadisticas semanales por jugador; rankings por tipo 1..6 (AsnRankLabelDescript_*).

import type { PlayerHandler, Frame } from "../game.ts";
import {
  s2c, notice, addCoin, pay, grant, isCoin, isEquipId, addPlayerExp, addRoleExp, spendAp, refreshAp, currentRole, findEquip,
  type RewardItem,
} from "../economy.ts";
import { ext, listPlayers, loadPlayer, savePlayer, type Player, type Role } from "../players.ts";
import { config } from "../config.ts";
import { table, tableById, roleTable } from "../gamedata.ts";

// Codigos (Localization del cliente): *_1002 "No data" · *_1003 "Wrong data" · RegisterPvPContestant_1008
// "Already registered" · StartPvPBattle_1012 "Maximum times today" · StartPvPBattle_1019 "Requirement is not
// fullfilled" · GetPvPOpponent_1019 "need higher gym level / not registered" · BuyPvPTimes_1019 /
// RefreshPvPCoolDown_1019 "You don't have CD time" · playAssassin_1 "Chapter isn't exist" · playAssassin_2 "need more AP"
const R = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, MAX_TIMES: 1012, REQUIREMENT: 1019 };

export const PVP_TIMES_MAX = 5; // CSDataCenter.s_PVP_TimesMax
export const PVP_COOLDOWN_MS = 600 * 1000; // CSDataCenter.s_PVP_RecoveryTime (s)
export const NPC_LADDER = 100; // puestos virtuales rellenados por NPC
const RECORDS_MAX = 20;
const ASN_TYPE = "80"; // CSChapterType.Assassin
const PVP_CHAPTER_TYPE = "19"; // CSChapterType.PVP (filas con rol NPC + modo de IA)

// ---------------------------------------------------------------- estado del dominio
type Opp = { rank: number; npc: boolean; acc: string; auid: string; name: string; rid: string; lv: number };
type BattleRecord = { ctime: number; opponent_auid: string; opponent_name: string; opponent_rid: string; opponent_lv: number; variation: number };
type AsnState = { week: string; chapter: string; progress: number; finished: boolean; stars: number; damage: number; maxHit: number; wins: number; battles: number; playing: string };
type PvpExt = {
  day: string; // dia de los contadores pvp_times / buy_pvp_times / refresh_pvp_times
  rewardDay: string; // ultimo dia liquidado de la recompensa diaria de rango
  offered: Opp[] | null; // ultima lista de GetPvPOpponent (StartPvPBattle usa su indice)
  fighting: Opp | null; // rival de la batalla en curso
  records: BattleRecord[]; // historial (mas reciente primero)
  assassin: AsnState;
};

function newAsn(): AsnState {
  return { week: weekKey(), chapter: firstAssassinChapter(), progress: 0, finished: false, stars: 0, damage: 0, maxHit: 0, wins: 0, battles: 0, playing: "" };
}
function st(p: Player): PvpExt {
  return ext<PvpExt>(p, "pvp", () => ({ day: "", rewardDay: "", offered: null, fighting: null, records: [], assassin: newAsn() }));
}
function asn(p: Player): AsnState {
  const e = st(p);
  if (!e.assassin || e.assassin.week !== weekKey()) e.assassin = newAsn();
  return e.assassin;
}

// ---------------------------------------------------------------- helpers privados (no hay compartidos)
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const intAt = (f: string[], i: number): number | null => {
  const s = (f[i] ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
function jsonAt<T>(f: string[], i: number, fallback: T): T {
  try {
    const s = (f[i] ?? "").trim();
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
/** Clave de dia local YYYY-MM-DD. */
function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Clave de semana (lunes local). */
function weekKey(d = new Date()): string {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(m);
}
/** Hash determinista (para elegir NPC por rango). */
const hash = (n: number) => Math.imul(n + 1, 2654435761) >>> 0;

/** Reinicia los contadores diarios de PvP si cambio el dia (el login puede llamarlo). */
export function refreshPvpDay(p: Player): void {
  const e = st(p);
  const today = dayKey();
  if (e.day !== today) {
    e.day = today;
    p.pvp_times = 0;
    p.buy_pvp_times = 0;
    p.refresh_pvp_times = 0;
  }
}

// ---------------------------------------------------------------- tablas
/** price_info: columna `col` por numero de veces (indice 0 = primera vez); mas alla del final se repite el ultimo. */
function costList(col: number): number[] {
  return table("price_info.txt")
    .map((f) => intAt(f, col))
    .filter((n): n is number => n !== null);
}
const costAt = (list: number[], idx: number) => (list.length ? list[Math.min(Math.max(0, idx), list.length - 1)] : 0);

/** vip_info fila 4 "compras de PvP al dia" (col 3 = VIP0, col 4 = VIP1). */
function vipBuyPvpMax(vip: number): number {
  const f = tableById("vip_info.txt").get("4");
  return (f && intAt(f, 3 + Math.min(1, Math.max(0, vip)))) ?? 13;
}

/** JSON {"id":{"amount":n}} o {"id":n} -> lista de recompensas. */
function amountMap(obj: unknown): RewardItem[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>)
    .map(([id, v]) => ({ id, amount: v && typeof v === "object" ? num((v as { amount?: unknown }).amount) : num(v) }))
    .filter((r) => r.amount > 0);
}

// pvp_reward_info: 0 rango min, 1 rango max, 2 gcoin, 3 vcoin, 4 pcoin, 5 objetos JSON {"id":{"amount":n}}
type PvpReward = { min: number; max: number; gcoin: number; vcoin: number; pcoin: number; items: RewardItem[] };
let pvpRewards: PvpReward[] | null = null;
function pvpRewardRows(): PvpReward[] {
  if (!pvpRewards) {
    pvpRewards = table("pvp_reward_info.txt")
      .filter((f) => intAt(f, 0) !== null)
      .map((f) => ({ min: num(f[0]), max: num(f[1]), gcoin: num(f[2]), vcoin: num(f[3]), pcoin: num(f[4]), items: amountMap(jsonAt(f, 5, {})) }));
  }
  return pvpRewards;
}
const pvpRewardByRank = (rank: number) => pvpRewardRows().find((r) => rank >= r.min && rank <= r.max) ?? null;
/** Recompensa de un tramo como hashtable {id: amount} (formato de getRankRewardList / getUserRankData). */
function rewardTable(r: PvpReward): Record<string, number> {
  const out: Record<string, number> = {};
  if (r.gcoin > 0) out.gcoin = r.gcoin;
  if (r.vcoin > 0) out.vcoin = r.vcoin;
  if (r.pcoin > 0) out.pcoin = r.pcoin;
  for (const it of r.items) out[it.id] = it.amount;
  return out;
}

// npc_info: 0 id, 1 nombre (clave), 2 atributos JSON {"1".."8",...}, 6 equipo JSON [6], 7/8 habilidades JSON {"id":..}, 9 rol/sonido, 10 pasiva
type NpcRow = { id: string; attr: Record<string, number>; equip: string[]; skill1: string; skill2: string; passive: string; rid: string };
let npcs: NpcRow[] | null = null;
function npcRows(): NpcRow[] {
  if (!npcs) {
    const rids = [...roleTable().keys()];
    npcs = table("npc_info.txt")
      .filter((f) => f.length > 10 && /^\d+$/.test(f[0]))
      .map((f, i) => {
        const raw = jsonAt<Record<string, unknown>>(f, 2, {});
        const attr: Record<string, number> = {};
        for (const k of ["1", "2", "3", "4", "5", "6"]) attr[k] = Math.max(1, Math.round(num(raw[k], 1)));
        const eq = jsonAt<unknown[]>(f, 6, []).map((x) => (x === "0" ? "" : str(x)));
        while (eq.length < 6) eq.push("");
        const skillId = (j: number) => str(jsonAt<{ id?: unknown }>(f, j, {}).id ?? "");
        const rid = roleTable().has(f[9]) ? f[9] : rids[i % Math.max(1, rids.length)] ?? "1100001";
        return { id: f[0], attr, equip: eq.slice(0, 6), skill1: skillId(7), skill2: skillId(8), passive: str(f[10]), rid };
      });
  }
  return npcs;
}
/** Modos de IA de los capitulos PvP (chapter_info tipo 19, col 10); fallback 1010. */
function pvpAiTypes(): string[] {
  const l = table("chapter_info.txt").filter((f) => f[0].startsWith(PVP_CHAPTER_TYPE) && (f[10] ?? "").trim() !== "").map((f) => f[10].trim());
  return l.length ? l : ["1010"];
}
/** Nombre visible del rol (role_info col 10, p.ej. "Erisa"). */
const roleName = (rid: string) => tableById("role_info.txt").get(rid)?.[10] || rid;

/** NPC determinista para un puesto libre de la escalera (rango 1 = fila mas alta de npc_info). */
function npcAt(rank: number): { opp: Opp; row: NpcRow; ai: string } {
  const rows = npcRows();
  const t = rank <= NPC_LADDER ? (NPC_LADDER - rank) / NPC_LADDER : 0;
  const idx = rows.length ? clamp(Math.floor(t * (rows.length - 1)), 0, rows.length - 1) : 0;
  const row = rows[idx] ?? { id: "npc", attr: { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1 }, equip: ["", "", "", "", "", ""], skill1: "", skill2: "", passive: "", rid: "1100001" };
  const ais = pvpAiTypes();
  const lv = clamp(Math.round(100 - (rank - 1) * 0.9), 5, 99);
  return {
    opp: { rank, npc: true, acc: "", auid: "npc" + rank, name: roleName(row.rid), rid: row.rid, lv },
    row,
    ai: ais[hash(rank) % ais.length],
  };
}

// chapter_info: 3 exp gimnasio, 4 exp rol, 5 AP, 6 AP al perder, 8 recompensas JSON {"<permil>":{"id":{"amount":n}}}
type Chapter = { id: string; expGym: number; expRole: number; apNeed: number; apFail: number; rewards: { chance: number; items: RewardItem[] }[] };
function chapter(id: string): Chapter | null {
  const f = tableById("chapter_info.txt").get(id);
  if (!f) return null;
  const groups = Object.entries(jsonAt<Record<string, unknown>>(f, 8, {})).map(([k, v]) => ({ chance: num(k, 1000), items: amountMap(v) }));
  return { id, expGym: num(f[3]), expRole: num(f[4]), apNeed: num(f[5]), apFail: num(f[6]), rewards: groups };
}
const assassinIds = () => table("chapter_info.txt").map((f) => f[0]).filter((id) => /^\d{7}$/.test(id) && id.startsWith(ASN_TYPE)).sort();
/** Primer capitulo del asesino: tipo 80, capitulo 01, modo 0, seccion minima (CSDatabase.GetChapterFirstInfo). */
function firstAssassinChapter(): string {
  const ids = assassinIds();
  return ids.find((id) => id.slice(2, 4) === "01" && id[6] === "0") ?? ids[0] ?? "";
}
/** Siguiente seccion con mismo tipo+capitulo+modo (CSDatabase.GetNextSection); null si era la ultima. */
function nextSection(id: string): string | null {
  return assassinIds().find((c) => c.slice(0, 4) === id.slice(0, 4) && c[6] === id[6] && c.slice(4, 6) > id.slice(4, 6)) ?? null;
}

// ---------------------------------------------------------------- jugadores / escalera
function findByAuid(auid: string): { q: Player; role: Role } | null {
  if (!auid) return null;
  for (const q of listPlayers()) for (const role of Object.values(q.roles)) if (role.auid === auid) return { q, role };
  return null;
}
/** Jugadores inscritos en PvP (con rol registrado y puesto). */
function contestants(): { q: Player; role: Role }[] {
  const out: { q: Player; role: Role }[] = [];
  for (const q of listPlayers()) {
    const role = q.pvp_role ? q.roles[q.pvp_role] : undefined;
    if (role && q.pvp_rank > 0) out.push({ q, role });
  }
  return out;
}
function realByRank(): Map<number, { q: Player; role: Role }> {
  return new Map(contestants().map((c) => [c.q.pvp_rank, c]));
}
const ladderSize = (byRank: Map<number, unknown>) => Math.max(NPC_LADDER, ...byRank.keys());

function oppOf(q: Player, role: Role): Opp {
  return { rank: q.pvp_rank, npc: false, acc: q.acc, auid: role.auid, name: q.name, rid: role.rid, lv: role.lv };
}
/** Equipo en formato PvP (mismas claves que Player.equips) o "" si el hueco esta vacio. */
function pvpEquip(q: Player, id: string): unknown {
  if (!id) return "";
  return findEquip(q, id) ?? { id, lv: 1, quality: 1, slot: [], prop: {}, buff: {}, buff_item: [] };
}
function pvpSkill(q: Player | null, id: string): unknown {
  if (!id) return "";
  const k = q?.skills.find((s) => s.id === id);
  return { id, strengthen_prop: k?.strengthen_prop ?? [0, 0, 0, 0] };
}
/**
 * Fila de rival tal como la lee GetPvPOpponentS2C.Parse (posicional, 24 entradas):
 * [rank, npc, win, lose, auid, name, rid, lv, {atributos 1..6}, equipo x6, skill1, skill2, ai_type, logistica x5, pasiva]
 */
function opponentRow(o: Opp): unknown[] {
  if (!o.npc) {
    const q = loadPlayer(o.acc);
    const role = q?.roles[o.rid];
    if (q && role) {
      const attr: Record<string, number> = {};
      for (const k of ["1", "2", "3", "4", "5", "6"]) attr[k] = Math.round(num(role.prop[k], 1));
      const eq = [...role.equip_in, "", "", "", "", "", ""].slice(0, 6).map((id) => pvpEquip(q, id));
      return [o.rank, 0, q.pvp_victory, q.pvp_fail, o.auid, o.name, o.rid, o.lv, attr, ...eq, pvpSkill(q, role.skill), pvpSkill(q, role.skill2), role.pvp_ai_type || "1010", "", "", "", "", "", role.passive_skill];
    }
  }
  const { row, ai } = npcAt(o.rank);
  const eq = row.equip.map((id) => (id ? { id, lv: 1, quality: 1, slot: [], prop: {}, buff: {}, buff_item: [] } : ""));
  return [o.rank, 1, hash(o.rank) % 50 + 50, hash(o.rank + 7) % 50, o.auid, o.name, o.rid, o.lv, row.attr, ...eq, pvpSkill(null, row.skill1), pvpSkill(null, row.skill2), ai, "", "", "", "", "", row.passive];
}

/** Hasta 3 rivales con mejor puesto: jugadores reales mas cercanos primero, NPC de relleno en puestos libres. */
function pickOpponents(p: Player): Opp[] {
  const R = p.pvp_rank;
  if (R <= 1) return [];
  const byRank = realByRank();
  const out: Opp[] = [];
  const reals = [...byRank.values()].filter((c) => c.q.acc !== p.acc && c.q.pvp_rank < R).sort((a, b) => b.q.pvp_rank - a.q.pvp_rank);
  for (const c of reals.slice(0, 3)) out.push(oppOf(c.q, c.role));
  const targets = [R - 1, R - Math.ceil(R / 10), R - Math.ceil(R / 4)];
  for (let r = R - 2; r >= 1 && targets.length < R + 3; r--) targets.push(r);
  for (const r of targets) {
    if (out.length >= 3) break;
    if (r < 1 || byRank.has(r) || out.some((o) => o.rank === r)) continue;
    out.push(npcAt(r).opp);
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function addRecord(p: Player, rec: BattleRecord): void {
  const e = st(p);
  e.records.unshift(rec);
  if (e.records.length > RECORDS_MAX) e.records.length = RECORDS_MAX;
}
const cooldownLeft = (p: Player, now = Date.now()) => (p.pvp_flag > 0 ? p.pvp_flag + PVP_COOLDOWN_MS - now : 0);

/** Frames NoticeUpdate tras aplicar `grant(p, rewards)`. */
function rewardFrames(p: Player, rewards: RewardItem[]): Frame[] {
  const out: Frame[] = [];
  const items = rewards.filter((r) => !isCoin(r.id) && !["exp", "ap", "tp"].includes(r.id) && !isEquipId(r.id)).map((r) => r.id);
  const equipIds = new Set(rewards.filter((r) => isEquipId(r.id)).map((r) => r.id));
  if (rewards.some((r) => isCoin(r.id))) out.push(notice.coin(p));
  if (items.length) out.push(notice.items(p, [...new Set(items)]));
  if (equipIds.size) out.push(notice.equips(p.equips.filter((e) => equipIds.has(e.id))));
  if (rewards.some((r) => ["exp", "ap"].includes(r.id))) out.push(notice.player(p));
  return out;
}

/** Recompensa diaria por el rango que se mantiene (gcoin/vcoin/objetos de pvp_reward_info); el pcoin se gana por victoria. */
function dailyRankReward(p: Player): Frame[] {
  if (!config().economy.pvpDailyRewards) return [];
  const e = st(p);
  const today = dayKey();
  if (e.rewardDay === today) return [];
  const first = e.rewardDay === "";
  e.rewardDay = today;
  if (first || !p.pvp_role || p.pvp_rank <= 0) return [];
  const rw = pvpRewardByRank(p.pvp_rank);
  if (!rw) return [];
  const rewards: RewardItem[] = [{ id: "gcoin", amount: rw.gcoin }, { id: "vcoin", amount: rw.vcoin }, ...rw.items].filter((r) => r.amount > 0);
  grant(p, rewards);
  return rewardFrames(p, rewards);
}

/** Fichas de equipo {equipId, equipLv, quality, buff_item} (getRoleDetail / getAssassinRoleDetail). */
function equipTickets(q: Player, role: Role): Record<string, unknown>[] {
  return role.equip_in.filter(Boolean).map((id) => {
    const e = findEquip(q, id);
    return { equipId: id, equipLv: e?.lv ?? 1, quality: e?.quality ?? 1, buff_item: e?.buff_item ?? [] };
  });
}

// ---------------------------------------------------------------- rankings genericos (getRank*)
type RankActivity = { id: string; type: number; title: string; note: string; value: (p: Player) => number };
const RANK_ACTIVITIES: RankActivity[] = [
  { id: "1", type: 700, title: "PvP Victories", note: "0202004", value: (p) => p.pvp_victory },
  { id: "2", type: 700, title: "Gym Level", note: "0202006", value: (p) => p.lv },
];
const rankActivity = (id: unknown) => RANK_ACTIVITIES.find((a) => a.id === str(id)) ?? RANK_ACTIVITIES[0];
function ranking(a: RankActivity): Player[] {
  return listPlayers()
    .filter((q) => a.value(q) > 0)
    .sort((x, y) => a.value(y) - a.value(x) || x.createdAt.localeCompare(y.createdAt));
}
function rankEntry(a: RankActivity, q: Player, rank: number): Record<string, unknown> {
  const rw = pvpRewardByRank(rank);
  return {
    id: rank, activity_id: a.id, activity_type: a.type, rank, auid: currentRole(q).auid, role: q.last_use, name: q.name, lv: q.lv,
    itemCount: a.value(q), itemId: a.note,
    rankRange: rw ? { startRank: rw.min, endRank: rw.max } : {},
    reward: rw ? rewardTable(rw) : {},
  };
}

// ---------------------------------------------------------------- ranking del asesino
/** Valor del ranking por tipo: 1 pisos, 2 estrellas, 3 dano acumulado, 4 nivel de gimnasio (ascendente), 5 mayor golpe, 6 % victorias. */
function asnValue(type: number, q: Player, a: AsnState): number {
  switch (type) {
    case 2: return a.stars;
    case 3: return a.damage;
    case 4: return q.lv;
    case 5: return a.maxHit;
    case 6: return a.battles ? Math.round((a.wins / a.battles) * 100) : 0;
    default: return a.progress;
  }
}
function asnRanking(type: number): { q: Player; value: number }[] {
  const rows: { q: Player; value: number }[] = [];
  for (const q of listPlayers()) {
    const e = q.ext?.pvp as PvpExt | undefined;
    const a = e?.assassin;
    if (!a || a.week !== weekKey() || a.battles <= 0) continue;
    rows.push({ q, value: asnValue(type, q, a) });
  }
  return rows.sort((x, y) => (type === 4 ? x.value - y.value : y.value - x.value) || x.q.createdAt.localeCompare(y.q.createdAt));
}
const asnRow = (rank: number, r: { q: Player; value: number }) => [rank, r.value, currentRole(r.q).auid, r.q.name];
const isTrue = (v: unknown) => v === true || v === 1 || ["true", "1"].includes(str(v).toLowerCase());

// ---------------------------------------------------------------- handlers
export const handlers: Record<string, PlayerHandler> = {
  /** Inscribe el rol (rid, pvp_ai_type) en el PvP; responde el puesto (rank). Cambiar de rol conserva el puesto. */
  RegisterPvPContestantC2S({ p, params }) {
    const rid = str(params.rid);
    const role = p.roles[rid];
    if (!rid) return [s2c("RegisterPvPContestantS2C", { res: R.NO_DATA })];
    if (!role) return [s2c("RegisterPvPContestantS2C", { res: R.WRONG_DATA })];
    if (str(params.pvp_ai_type)) role.pvp_ai_type = str(params.pvp_ai_type);
    p.pvp_role = rid;
    if (p.pvp_rank <= 0) {
      const others = contestants().filter((c) => c.q.acc !== p.acc).map((c) => c.q.pvp_rank);
      p.pvp_rank = Math.max(NPC_LADDER, ...others) + 1;
    }
    st(p).offered = null;
    return [s2c("RegisterPvPContestantS2C", { res: 0, rank: p.pvp_rank })];
  },

  /** Lista de hasta 3 rivales (filas posicionales de 24 entradas); vacia si el jugador es el numero 1. */
  GetPvPOpponentC2S({ p }) {
    refreshPvpDay(p);
    const extra = dailyRankReward(p);
    if (!p.pvp_role || !p.roles[p.pvp_role] || p.pvp_rank <= 0) return [s2c("GetPvPOpponentS2C", { res: R.REQUIREMENT, list: [] })];
    const list = pickOpponents(p);
    st(p).offered = list;
    return [s2c("GetPvPOpponentS2C", { res: 0, list: list.map(opponentRow) }), ...extra];
  },

  /** Empieza la batalla contra offered[index]: consume un intento (pvp_times = usados hoy) y fija pvp_flag (ms). */
  StartPvPBattleC2S({ p, params }) {
    refreshPvpDay(p);
    const e = st(p);
    const idx = num(params.index, -1);
    const o = e.offered?.[idx];
    if (!p.pvp_role || !o) return [s2c("StartPvPBattleS2C", { res: R.WRONG_DATA })];
    if (PVP_TIMES_MAX - p.pvp_times <= 0) return [s2c("StartPvPBattleS2C", { res: R.MAX_TIMES })];
    if (cooldownLeft(p) > 0) return [s2c("StartPvPBattleS2C", { res: R.REQUIREMENT })];
    p.pvp_times++;
    p.pvp_flag = Date.now();
    e.fighting = o;
    return [s2c("StartPvPBattleS2C", { res: 0, pvp_times: p.pvp_times, pvp_flag: p.pvp_flag })];
  },

  /** Resultado (battle_res 1 = victoria): actualiza victory/fail/rank, historial, pcoin por rango y responde el record. */
  ReportPvPBattleResultsC2S({ p, params }) {
    refreshPvpDay(p);
    const e = st(p);
    const o = e.fighting;
    if (!o) return [s2c("ReportPvPBattleResultsS2C", { res: R.WRONG_DATA })];
    e.fighting = null;
    const win = num(params.battle_res) === 1;
    const oldRank = p.pvp_rank;
    let newRank = oldRank;
    const now = Date.now();
    const frames: Frame[] = [];
    if (win) {
      p.pvp_victory++;
      if (!o.npc) {
        const q = loadPlayer(o.acc);
        if (q && q.acc !== p.acc && q.pvp_rank > 0 && q.pvp_rank < oldRank) {
          newRank = q.pvp_rank;
          q.pvp_rank = oldRank; // intercambio de puestos
          q.pvp_fail++;
          const me = p.roles[p.pvp_role] ?? currentRole(p);
          addRecord(q, { ctime: now, opponent_auid: me.auid, opponent_name: p.name, opponent_rid: me.rid, opponent_lv: me.lv, variation: newRank - oldRank });
          savePlayer(q);
        }
      } else {
        const taken = realByRank();
        let r = o.rank;
        while (r < oldRank && taken.has(r)) r++; // puesto ocupado mientras tanto: el libre mas cercano
        if (r < oldRank) newRank = r;
      }
      p.pvp_rank = newRank;
      const rw = pvpRewardByRank(newRank);
      if (rw && rw.pcoin > 0) {
        addCoin(p, "pcoin", rw.pcoin);
        frames.push(notice.coin(p));
      }
    } else p.pvp_fail++;
    const record: BattleRecord = { ctime: now, opponent_auid: o.auid, opponent_name: o.name, opponent_rid: o.rid, opponent_lv: o.lv, variation: oldRank - newRank };
    addRecord(p, record);
    return [s2c("ReportPvPBattleResultsS2C", { res: 0, victory: p.pvp_victory, fail: p.pvp_fail, rank: p.pvp_rank, record }), ...frames];
  },

  /** Clasificacion: puestos start..end en orden (el cliente numera desde 1 por posicion): {auid, name, rid, lv}. */
  GetPvPLeaderboardC2S({ params }) {
    const byRank = realByRank();
    const start = Math.max(1, num(params.start, 1));
    const end = Math.min(num(params.end, 51), start + 199, ladderSize(byRank));
    const list: Record<string, unknown>[] = [];
    for (let r = start; r <= end; r++) {
      const c = byRank.get(r);
      const o = c ? oppOf(c.q, c.role) : npcAt(r).opp;
      list.push({ auid: o.auid, name: o.name, rid: o.rid, lv: o.lv });
    }
    return [s2c("GetPvPLeaderboardS2C", { res: 0, list })];
  },

  /** Historial de batallas (mas reciente primero): ctime ms, opponent_*, variation (+ subio, - bajo). */
  GetPvPBattleRecordC2S({ p }) {
    return [s2c("GetPvPBattleRecordS2C", { res: 0, list: st(p).records })];
  },

  /** Push de derrota (solo S2C real); el cliente no espera respuesta y una S2C vacia estropearia su contador. */
  BulletinBattleFailC2S() {
    return [];
  },

  /** Reinicia el enfriamiento (pvp_flag = 0) cobrando price_info col 1 por refresh_pvp_times. */
  RefreshPvPCoolDownC2S({ p }) {
    refreshPvpDay(p);
    if (cooldownLeft(p) <= 0) return [s2c("RefreshPvPCoolDownS2C", { res: R.REQUIREMENT })];
    const costs = costList(1);
    const cost = costAt(costs, p.refresh_pvp_times);
    if (!pay(p, "vcoin", cost)) return [s2c("RefreshPvPCoolDownS2C", { res: R.WRONG_DATA })];
    p.refresh_pvp_times++;
    p.pvp_flag = 0;
    return [
      s2c("RefreshPvPCoolDownS2C", { res: 0, coin: cost, next_coin: costAt(costs, p.refresh_pvp_times), refresh_pvp_times: p.refresh_pvp_times, pvp_flag: 0 }),
      notice.coin(p),
    ];
  },

  /** Compra 1 intento (pvp_times usados - 1) cobrando price_info col 2 por buy_pvp_times; tope vip_info fila 4. */
  BuyPvPTimesC2S({ p }) {
    refreshPvpDay(p);
    if (p.buy_pvp_times >= vipBuyPvpMax(p.vip)) return [s2c("BuyPvPTimesS2C", { res: R.REQUIREMENT })];
    const costs = costList(2);
    const cost = costAt(costs, p.buy_pvp_times);
    if (!pay(p, "vcoin", cost)) return [s2c("BuyPvPTimesS2C", { res: R.WRONG_DATA })];
    p.buy_pvp_times++;
    p.pvp_times -= 1;
    return [
      s2c("BuyPvPTimesS2C", { res: 0, coin: cost, next_coin: costAt(costs, p.buy_pvp_times), buy_pvp_times: p.buy_pvp_times, pvp_times: 1 }),
      notice.coin(p),
    ];
  },

  /** Guarda el modo de IA (pvp_ai_type) con el que pelea el rol cuando lo retan. */
  SetPvPRoleAITypeC2S({ p, params }) {
    const role = p.roles[str(params.rid)];
    if (!role) return [s2c("SetPvPRoleAITypeS2C", { res: R.WRONG_DATA })];
    role.pvp_ai_type = str(params.pvp_ai_type);
    return [s2c("SetPvPRoleAITypeS2C", { res: 0 })];
  },

  // ---- rankings genericos
  /** Eventos de ranking: rs [{id, stime, etime (ms), title, content, type 700 (activo), note = objeto icono, rule}], size 0 = fin. */
  getRankInfoC2S() {
    const now = new Date();
    const stime = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const etime = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const rs = RANK_ACTIVITIES.map((a) => ({ id: a.id, stime, etime, title: a.title, content: "", type: a.type, note: a.note, rule: "" }));
    return [s2c("getRankInfoS2C", { rs, size: 0 })];
  },

  /** Jugadores del ranking en posiciones start..end ({rank, auid, role, name, lv, itemCount, itemId, rankRange}); size 0 = fin. */
  getRankListC2S({ params }) {
    const a = rankActivity(params.activityId);
    const start = Math.max(1, num(params.start, 1));
    const end = Math.min(num(params.end, start + 29), start + 99);
    const rs = ranking(a).slice(start - 1, end).map((q, i) => rankEntry(a, q, start + i));
    return [s2c("getRankListS2C", { rs, size: 0, startRank: start })];
  },

  /** Recompensas por tramo del evento: rs [{id, activity_id, activity_type, startRank, endRank, reward {id: amount}}] (pvp_reward_info). */
  getRankRewardListC2S({ params }) {
    const a = rankActivity(params.activityId);
    const rs = pvpRewardRows().map((r, i) => ({ id: i + 1, activity_id: a.id, activity_type: a.type, startRank: String(r.min), endRank: String(r.max), reward: rewardTable(r) }));
    return [s2c("getRankRewardListS2C", { rs })];
  },

  /** Posicion del propio jugador en el evento (rs con 1 entrada + reward); rs vacio = sin clasificar. */
  getUserRankDataC2S({ p, params }) {
    const a = rankActivity(params.activityId);
    const i = ranking(a).findIndex((q) => q.acc === p.acc);
    return [s2c("getUserRankDataS2C", { rs: i < 0 ? [] : [rankEntry(a, p, i + 1)] })];
  },

  /** Total de jugadores del servidor. */
  getPlayerCountC2S() {
    return [s2c("getPlayerCountS2C", { total: listPlayers().length })];
  },

  /** Equipo de un rol ajeno (auid, roleId): roleInfo [{equipId, equipLv, quality, buff_item}]; vacio si no existe. */
  getRoleDetailC2S({ p, params }) {
    const auid = str(params.auid);
    const hit = findByAuid(auid) ?? (Object.values(p.roles).some((r) => r.auid === auid) ? { q: p, role: currentRole(p) } : null);
    if (!hit) return [s2c("getRoleDetailS2C", { roleInfo: [] })];
    const role = hit.q.roles[str(params.roleId)] ?? hit.role;
    return [s2c("getRoleDetailS2C", { roleInfo: equipTickets(hit.q, role) })];
  },

  // ---- asesino (evento semanal)
  /** Estado del asesino: rs 0 en curso / 1 terminado, chapterId actual, progressRate = pisos superados. */
  getPlayerAssassinInfoC2S({ p }) {
    const a = asn(p);
    return [s2c("getPlayerAssassinInfoS2C", { rs: a.finished ? 1 : 0, chapterId: a.chapter, progressRate: a.progress })];
  },

  /** Entra al piso actual (chapterId): rs 0 ok, 1 capitulo inexistente, 2 AP insuficiente (cobra el AP del capitulo). */
  playAssassinC2S({ p, params }) {
    const a = asn(p);
    const id = str(params.chapterId);
    const ch = chapter(id);
    if (!ch || !id.startsWith(ASN_TYPE) || (a.finished && id === a.chapter)) return [s2c("playAssassinS2C", { rs: 1 })];
    if (!spendAp(p, ch.apNeed)) return [s2c("playAssassinS2C", { rs: 2 })];
    a.chapter = id;
    a.finished = false;
    a.playing = id;
    return [s2c("playAssassinS2C", { rs: 0 }), notice.player(p)];
  },

  /**
   * Resultado del piso: rs 0 = superado (progress = siguiente piso), 1 = era el ultimo (evento completado), -1 = derrota
   * (devuelve apNeed - apFail). Con victoria: recompensas del capitulo, exp de gimnasio/rol y estadisticas del ranking.
   */
  reportAssassinChapterC2S({ p, params }) {
    const a = asn(p);
    const ch = a.playing ? chapter(a.playing) : null;
    if (!ch) return [s2c("reportAssassinChapterS2C", { rs: -1 })];
    a.playing = "";
    const win = isTrue(params.isWin);
    a.battles++;
    a.damage += Math.max(0, num(params.total_hurt));
    a.maxHit = Math.max(a.maxHit, num(params.max_one_hit));
    refreshAp(p);
    if (!win) {
      p.ap += Math.max(0, ch.apNeed - ch.apFail);
      return [s2c("reportAssassinChapterS2C", { rs: -1, progress: a.chapter, ap: p.ap, apTime: p.ap_time }), notice.player(p)];
    }
    a.wins++;
    a.progress++;
    a.stars += Math.max(0, num(params.total_star));
    const next = nextSection(ch.id);
    let rs = 0;
    if (next) a.chapter = next;
    else {
      a.finished = true;
      rs = 1;
    }
    const rewards: RewardItem[] = [];
    for (const g of ch.rewards) if (Math.random() * 1000 < g.chance) rewards.push(...g.items);
    grant(p, rewards);
    const pl = addPlayerExp(p, ch.expGym);
    const role = currentRole(p);
    const rl = addRoleExp(role, ch.expRole);
    return [
      s2c("reportAssassinChapterS2C", {
        rs, reward: rewards.map((r) => ({ [r.id]: r.amount })), change_reward: [], progress: next ?? "",
        ap: p.ap, apTime: p.ap_time, player_lv: pl.lv, player_exp: pl.exp, role_lv: rl.lv, role_exp: rl.exp, gold: [],
      }),
      ...rewardFrames(p, rewards),
      notice.player(p),
      notice.role(role),
    ];
  },

  /** Ranking semanal del asesino por tipo: rs [[rank, valor, auid, name], ...] (top 50), size 0 = fin. */
  getAssassinRankDataC2S({ params }) {
    const type = num(params.type, 1);
    const rs = asnRanking(type).slice(0, 50).map((r, i) => asnRow(i + 1, r));
    return [s2c("getAssassinRankDataS2C", { rs, size: 0 })];
  },

  /** Posicion de un jugador (auid) en el ranking: data [rank, valor, auid, name] o [] si no participa. */
  getAssassinRankDataByAuidC2S({ params }) {
    const type = num(params.type, 1);
    const auid = str(params.auid);
    const i = asnRanking(type).findIndex((r) => Object.values(r.q.roles).some((x) => x.auid === auid));
    const rows = asnRanking(type);
    return [s2c("getAssassinRankDataByAuidS2C", { data: i < 0 ? [] : asnRow(i + 1, rows[i]) })];
  },

  /** Ficha del rol de un jugador del ranking: data {roleId, skill, skill2, equipInfo [{equipId, quality, equipLv}]}; {} si no existe. */
  getAssassinRoleDetailC2S({ params }) {
    const hit = findByAuid(str(params.auid));
    if (!hit) return [s2c("getAssassinRoleDetailS2C", { data: {} })];
    const role = currentRole(hit.q);
    return [s2c("getAssassinRoleDetailS2C", { data: { roleId: role.rid, skill: role.skill, skill2: role.skill2, equipInfo: equipTickets(hit.q, role) } })];
  },
};
