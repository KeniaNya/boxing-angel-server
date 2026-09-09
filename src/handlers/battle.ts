// Dominio "battle": capitulos PvE (normal, especial, exterior, NPC), directo, reinicio, combate de elite,
// compras de AP/TP/sangre, dedo de oro, reparto de puntos de rol y flags de tutorial.
// Formatos de respuesta: clases *S2C.Parse del cliente; semantica: stubs offline (if (!m_Connection)).
//
// Convenciones del cliente que hay que respetar:
//  - ch_progress = id del ultimo capitulo normal (modo 0) abierto; los modos 1..3 son variantes dificiles de los
//    nodos de mapa (posType 1) y se abren al superar el modo anterior (isPass).
//  - eb_progress = numero de combates de elite superados (offset sobre el primer capitulo 31xxxxx).
//  - Contadores *_times son diarios (el cliente los pone a 0 a medianoche); aqui se reinician al cambiar de dia.
//  - BuyAP/BuyTP devuelven el INCREMENTO ("ap"/"tp"), no el total; ReportChapter devuelve el AP absoluto.

import type { PlayerHandler } from "../game.ts";
import { table, roleTable } from "../gamedata.ts";
import { ext, type Player, type Role, type Score } from "../players.ts";
import {
  s2c, notice, type Frame, type RewardItem,
  coin, pay, addCoin, removeItem, isCoin, isEquipId,
  addPlayerExp, addRoleExp, currentRole, refreshAp, spendAp, grant, maxAp,
} from "../economy.ts";

// Codigos (Localization del cliente, p.ej. PlayChapter_1016 "行動力不足"): 1002 falta parametro · 1003 parametro
// erroneo · 1005 capitulo inexistente / no terminado · 1006 no esta en un capitulo · 1012 limite alcanzado ·
// 1016 no hay suficiente (AP / vcoin / tickets) · 1019 condicion no cumplida
const ERR = { NO_PARAM: 1002, BAD_PARAM: 1003, NO_CHAPTER: 1005, NOT_IN_CHAPTER: 1006, LIMIT: 1012, NOT_ENOUGH: 1016, CONDITION: 1019 };

const PASS_TICKET_ID = "0202010"; // item_info: efecto {"8":0} = ItemEffectCode.PassTicket (ticket de directo)
const PASSERS_MAX = 60; // CSDataCenter.s_BattleNpcTimesMax
const SPECIAL_MAX = 5; // CSDataCenter.s_SpecialMaxTime (partidas diarias por capitulo especial)
const OUTSIDE_MAX = 2; // CSDataCenter.s_OutSideMaxTime (partidas diarias por capitulo exterior)
const ELITE_RESET_FREE = 1; // CSDataCenter.s_EliteResetFreeTimes
const GOLD_PER_ROUND = 100; // oro base por asalto ganado (se multiplica por la columna "倍率" del capitulo)
const ELITE_WIN_GOLD = 500; // oro base por combate de elite ganado (idem)

// ---------------------------------------------------------------------------------------------
// Estado propio del dominio (player.ext.battle)
// ---------------------------------------------------------------------------------------------
type BattleState = {
  day: string; // fecha local del ultimo reinicio de contadores diarios
  playing: string | null; // capitulo empezado con PlayChapter y aun no reportado
  playingIsPass: boolean;
  eliteList: string[]; // rid del rival de cada capitulo de elite (GetEliteBattleList)
  eliteNpc: Record<string, { hp: number; anger: number }>; // hp/ira restante del rival por indice
  lastPvE: { ch_id: string; result: number; at: number } | null;
  teachLog: { main: number; deputy: number; at: number }[];
};
function state(p: Player): BattleState {
  const st = ext<BattleState>(p, "battle", () => ({
    day: today(), playing: null, playingIsPass: false, eliteList: [], eliteNpc: {}, lastPvE: null, teachLog: [],
  }));
  dailyReset(p, st);
  return st;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
/** Reinicio diario de contadores (misma lista que el cliente al cambiar de dia). */
function dailyReset(p: Player, st: BattleState): void {
  const t = today();
  if (st.day === t) return;
  st.day = t;
  p.buy_ap_times = 0;
  p.buy_tp_times = 0;
  p.gold_finger_times = 0;
  p.buy_blood_times = 0;
  p.passers_times = 0;
  p.eb_re_times = 0;
  p.ch_outer_times = p.ch_outer_times.map(() => 0);
  p.ch_special_times = p.ch_special_times.map(() => 0);
  for (const sc of p.scores) {
    sc.times = 0;
    sc.refresh_times = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// chapter_info.txt (CSDatabase.LoadChapterInfoData): 0 id · 3 exp gimnasio · 4 exp rol · 5 AP · 6 AP al fallar ·
// 7 limite diario · 8 recompensas JSON {"prob‰":{"id":{"amount":n}|[{"amount":n}]}} · 9 npc · 12 posType ·
// 13 multiplicador de oro · 16 nivel requerido · 22 planos (mismo formato que 8)
// id = TT CC SS M (tipo, capitulo, seccion, modo); elite: attachId = digitos 5-6.
// ---------------------------------------------------------------------------------------------
type ChapterType = 10 | 15 | 16 | 18 | 19 | 31 | 32 | 80;
const CH = { NORMAL: 10, OUTSIDE: 15, SPECIAL: 16, NPC: 18, PVP: 19, ELITE: 31, DREAM: 32, ASSASSIN: 80 } as const;
type RewardGroup = { prob: number; items: RewardItem[] };
type ChapterInfo = {
  id: number; idStr: string; type: ChapterType; chapter: number; section: number; mode: number; attachId: number;
  expHallroad: number; expRole: number; apNeed: number; apFail: number; times: number;
  rewards: RewardGroup[]; npcId: string; posType: number; coinRate: number; unlockLv: number;
};
let chapterCache: Map<number, ChapterInfo> | null = null;
function chapters(): Map<number, ChapterInfo> {
  if (chapterCache) return chapterCache;
  chapterCache = new Map();
  for (const f of table("chapter_info.txt")) {
    if (!/^\d{7}$/.test(f[0] ?? "")) continue;
    const idStr = f[0];
    const type = Number(idStr.slice(0, 2)) as ChapterType;
    const mode = Number(idStr.slice(6, 7));
    const c: ChapterInfo = {
      id: Number(idStr), idStr, type, chapter: Number(idStr.slice(2, 4)), section: Number(idStr.slice(4, 6)), mode,
      attachId: type === CH.ELITE ? Number(idStr.slice(5, 7)) : Number(idStr) - mode,
      expHallroad: num(f[3]), expRole: num(f[4]), apNeed: num(f[5]), apFail: num(f[6]), times: num(f[7]),
      rewards: [...parseRewardGroups(f[8]), ...parseRewardGroups(f[22])],
      npcId: f[9] ?? "", posType: num(f[12]), coinRate: Number(f[13]) || 1, unlockLv: num(f[16]),
    };
    chapterCache.set(c.id, c);
  }
  return chapterCache;
}
const num = (s: string | undefined) => Number(s) || 0;
function parseRewardGroups(text: string | undefined): RewardGroup[] {
  const t = (text ?? "").trim();
  if (!t || t === "{}") return [];
  let j: Record<string, Record<string, unknown>>;
  try {
    j = JSON.parse(t);
  } catch {
    return [];
  }
  const out: RewardGroup[] = [];
  for (const [prob, entries] of Object.entries(j)) {
    const items: RewardItem[] = [];
    for (const [id, v] of Object.entries(entries ?? {})) {
      const list = Array.isArray(v) ? v : [v];
      for (const e of list) items.push({ id, amount: Number((e as { amount?: unknown })?.amount) || 0 });
    }
    out.push({ prob: Number(prob) || 0, items });
  }
  return out;
}
function chapter(id: unknown): ChapterInfo | undefined {
  const n = Number(String(id ?? "").trim());
  return Number.isFinite(n) ? chapters().get(n) : undefined;
}
function chaptersOfType(type: ChapterType): ChapterInfo[] {
  return [...chapters().values()].filter((c) => c.type === type).sort((a, b) => a.id - b.id);
}
/** Recompensas del capitulo: los grupos con prob >= 1000‰ siempre; el resto se sortea (diseño aleatorio de la tabla). */
function rollRewards(c: ChapterInfo, deterministic = false): RewardItem[] {
  const out: RewardItem[] = [];
  for (const g of c.rewards) {
    if (g.prob >= 1000 || (!deterministic && Math.random() * 1000 < g.prob)) out.push(...g.items.filter((r) => r.amount > 0));
  }
  return out;
}
/** Siguiente seccion del mismo capitulo y modo, o primera del capitulo siguiente (CSDatabase.GetNextSection). */
function nextChapter(c: ChapterInfo): ChapterInfo | undefined {
  const same = chaptersOfType(c.type).filter((x) => x.mode === c.mode);
  return same.find((x) => x.chapter === c.chapter && x.section > c.section) ?? same.find((x) => x.chapter === c.chapter + 1);
}
function score(p: Player, c: ChapterInfo): Score {
  let sc = p.scores.find((s) => s.ch_id === c.idStr);
  if (!sc) {
    sc = { ch_id: c.idStr, score: [0, 0, 0], times: 0, refresh_times: 0 };
    p.scores.push(sc);
  }
  return sc;
}
/** Capitulo superado: modo 0 por debajo del progreso, o con alguna evaluacion registrada. */
function cleared(p: Player, c: ChapterInfo): boolean {
  if (c.type === CH.NORMAL && c.mode === 0 && c.id < Number(p.ch_progress)) return true;
  return (p.scores.find((s) => s.ch_id === c.idStr)?.score ?? []).some((x) => x > 0);
}
/** Un capitulo normal es jugable si su nodo esta alcanzado y (modos 1..3) el modo anterior esta superado. */
function normalUnlocked(p: Player, c: ChapterInfo): boolean {
  if (c.mode === 0) return c.id <= Number(p.ch_progress);
  const prev = chapters().get(c.id - 1);
  return !!prev && c.attachId < Number(p.ch_progress) && cleared(p, prev);
}
/** Modo mas alto abierto de un nodo de mapa (para getGeneralChapter y para isPass). */
function highestOpenMode(p: Player, node: ChapterInfo): ChapterInfo {
  let open = node;
  while (open.mode < 3 && cleared(p, open)) {
    const nx = chapters().get(open.id + 1);
    if (!nx) break;
    open = nx;
  }
  return open;
}
/** Oro por asalto: base x multiplicador de la tabla, solo asaltos con evaluacion. */
function roundGold(c: ChapterInfo, scores: number[]): number[] {
  return [0, 1, 2].map((i) => ((scores[i] ?? 0) > 0 ? Math.round(GOLD_PER_ROUND * c.coinRate) : 0));
}

// ---------------------------------------------------------------------------------------------
// price_info.txt (CSDatabase.LoadCostData): fila = numero de compra (col 0); columnas de coste (y valor obtenido):
// BuyAP 3(+4) · ResetLevel 5 · PassLevel 6 · TrainingPoint 7(+8) · ChangeCoin 16(+17) · TrainBasePointCost 18 ·
// BuyBlood 20 · EliteBattleReset 22. Celda vacia = la lista termina ahi (GetCostDataByIndex devuelve el ultimo).
// ---------------------------------------------------------------------------------------------
type CostType = "BuyAP" | "ResetLevel" | "PassLevel" | "TrainingPoint" | "ChangeCoin" | "TrainBasePointCost" | "BuyBlood" | "EliteBattleReset";
const COST_COLS: Record<CostType, [number, number?]> = {
  BuyAP: [3, 4], ResetLevel: [5], PassLevel: [6], TrainingPoint: [7, 8], ChangeCoin: [16, 17],
  TrainBasePointCost: [18], BuyBlood: [20], EliteBattleReset: [22],
};
type CostData = { cost: number; value: number };
const costCache = new Map<CostType, CostData[]>();
function costList(t: CostType): CostData[] {
  let l = costCache.get(t);
  if (!l) {
    const [ci, vi] = COST_COLS[t];
    l = table("price_info.txt")
      .filter((f) => /^\d+$/.test(f[0] ?? ""))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .filter((f) => /^-?\d+$/.test((f[ci] ?? "").trim()))
      .map((f) => ({ cost: Number(f[ci]), value: vi !== undefined ? num(f[vi]) : 0 }));
    costCache.set(t, l);
  }
  return l;
}
/** Coste de la compra numero `index` (0 = primera). Con returnMax, pasado el final se repite el ultimo. */
function costAt(t: CostType, index: number, returnMax = true): CostData | null {
  const l = costList(t);
  if (l.length === 0) return null;
  if (index >= l.length) return returnMax ? l[l.length - 1] : null;
  return l[Math.max(0, index)];
}

// vip_info.txt: fila = concepto (col 0), columnas 3.. = VIP_0, VIP_1... Conceptos: 1 compras de AP/dia ·
// 2 compras de TP/dia · 3 TP maximo · 5 reinicios de capitulo/dia · 7 dedos de oro/dia · 10 reinicios de elite/dia
const VIP = { BUY_AP: "1", BUY_TP: "2", TP_MAX: "3", RESTART_CHAPTER: "5", GOLD_FINGER: "7", ELITE_RESET: "10" } as const;
function vipLimit(p: Player, rowId: string): number {
  const row = table("vip_info.txt").find((f) => f[0] === rowId);
  if (!row) return 0;
  const cols = row.slice(3).filter((x) => x.trim() !== "");
  const i = Math.min(Math.max(0, p.vip | 0), cols.length - 1);
  return Number(cols[i]) || 0;
}

// ---------------------------------------------------------------------------------------------
// Utilidades de respuesta
// ---------------------------------------------------------------------------------------------
const err = (name: string, res: number): Frame[] => [s2c(name, { res })];
const rewardList = (rs: RewardItem[]) => rs.map((r) => [r.id, r.amount]);
/** Aplica recompensas y devuelve los frames notice.* de lo que cambio (objetos y equipo; monedas aparte). */
function grantWithNotices(p: Player, rewards: RewardItem[]): Frame[] {
  const before = p.equips.length;
  grant(p, rewards);
  const out: Frame[] = [];
  const itemIds = [...new Set(rewards.filter((r) => !isCoin(r.id) && !["exp", "ap", "tp"].includes(r.id) && !isEquipId(r.id)).map((r) => r.id))];
  if (itemIds.length) out.push(notice.items(p, itemIds));
  if (p.equips.length > before) out.push(notice.equips(p.equips.slice(before)));
  return out;
}
function intParam(params: Record<string, unknown>, key: string): number | null {
  const v = params[key];
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** "configuration" llega como objeto o como string JSON ({"1":1,...}); devuelve pares clave->cantidad > 0. */
function parseConfiguration(v: unknown): Record<string, number> | null {
  let obj: unknown = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj as Record<string, unknown>)) {
    const q = Math.floor(Number(n));
    if (!Number.isFinite(q) || q < 0) return null;
    if (q > 0) out[k] = q;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rival de elite (GetEliteBattleRivalS2C.Parse: hashtable "rival" con equip[] de 6 hashtables y skill[] de 2)
// ---------------------------------------------------------------------------------------------
function randomRoleId(): string {
  const ids = [...roleTable().keys()];
  return ids[Math.floor(Math.random() * ids.length)] ?? "1100001";
}
function eliteEquip(id: string, lv: number) {
  return { id, lv, quality: 1, slot: ["", "", "", "", "", ""], prop: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } };
}
function eliteRival(rid: string, index: number, npc: { hp: number; anger: number }) {
  const info = roleTable().get(rid);
  const lv = 30 + index;
  const prop: Record<string, number> = {};
  for (let i = 1; i <= 6; i++) prop[String(i)] = 1 + Math.floor(index / 2);
  return {
    sid: "1", rid, auid: "1", lv, flag: rid, hp: npc.hp, anger: npc.anger, name: `Elite ${index + 1}`, prop,
    equip: (info?.defaultEquip ?? ["", "", "", "", "", ""]).map((e) => eliteEquip(e, Math.max(1, Math.floor(lv / 10)))),
    logistics: [],
    skill: [{ id: "0301001", strengthen_prop: [0, 0, 0, 0] }, { id: "0301002", strengthen_prop: [0, 0, 0, 0] }],
    passive_skill: "",
  };
}
function eliteList(st: BattleState): string[] {
  const n = chaptersOfType(CH.ELITE).length;
  if (st.eliteList.length !== n) st.eliteList = Array.from({ length: n }, () => randomRoleId());
  return st.eliteList;
}
const ebProgress = (p: Player) => Number(p.eb_progress) || 0;

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------
export const handlers: Record<string, PlayerHandler> = {
  /** PlayChapterC2S {chapter}: valida desbloqueo/limites, cobra el AP de derrota por adelantado y responde {res, isPass}. */
  PlayChapterC2S({ p, params }) {
    const R = "PlayChapterS2C";
    if (params.chapter === undefined) return err(R, ERR.NO_PARAM);
    const c = chapter(params.chapter);
    if (!c) return err(R, ERR.NO_CHAPTER);
    const st = state(p);
    if (c.unlockLv > p.lv) return err(R, ERR.CONDITION);
    let isPass = false;
    const out: Frame[] = [];
    switch (c.type) {
      case CH.NORMAL: {
        if (!normalUnlocked(p, c)) return err(R, ERR.CONDITION);
        if (c.times > 0 && score(p, c).times >= c.times) return err(R, ERR.CONDITION);
        // isPass: nodo de mapa con modo siguiente (id+1) -> al ganar se abre ese modo
        isPass = c.posType === 1 && c.mode < 3 && chapters().has(c.id + 1);
        break;
      }
      case CH.SPECIAL:
      case CH.OUTSIDE: {
        const arr = c.type === CH.SPECIAL ? p.ch_special_times : p.ch_outer_times;
        const max = c.type === CH.SPECIAL ? SPECIAL_MAX : OUTSIDE_MAX;
        const i = c.chapter - 1; // el cliente antepone un 0 a la lista, asi que el indice servidor es capitulo-1
        while (arr.length <= i) arr.push(0);
        if (arr[i] >= max) return err(R, ERR.CONDITION);
        break;
      }
      default:
        break; // NPC, sueño, asesino: sin requisitos
    }
    refreshAp(p);
    if (c.apNeed > 0) {
      if (p.ap < c.apNeed) return err(R, ERR.NOT_ENOUGH);
      if (!spendAp(p, c.apFail)) return err(R, ERR.NOT_ENOUGH); // el resto (apNeed-apFail) se cobra al reportar victoria
      out.push(notice.player(p));
    }
    st.playing = c.idStr;
    st.playingIsPass = isPass;
    return [s2c(R, { res: 0, isPass }), ...out];
  },

  /** ReportChapterC2S {score[3], rate, isPass}: victoria del capitulo en curso -> progreso, exp, recompensas y oro. */
  ReportChapterC2S({ p, params }) {
    const R = "ReportChapterS2C";
    const st = state(p);
    const c = st.playing ? chapter(st.playing) : undefined;
    if (!c) return err(R, ERR.NO_CHAPTER);
    if (!Array.isArray(params.score)) return err(R, ERR.NO_PARAM);
    const scores = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number((params.score as unknown[])[i]) || 0)));
    st.playing = null;

    // AP restante de la victoria (la derrota ya se cobro en PlayChapter)
    refreshAp(p);
    if (p.ap >= maxAp(p.lv)) p.ap_time = Date.now();
    p.ap = Math.max(0, p.ap - Math.max(0, c.apNeed - c.apFail));

    // experiencia de gimnasio y de rol
    const role = currentRole(p);
    addPlayerExp(p, c.expHallroad);
    addRoleExp(role, c.expRole);

    // recompensas: el gcoin de la tabla va al oro del primer asalto, el resto a la lista (como el stub)
    const rolled = rollRewards(c);
    const gold = roundGold(c, scores);
    gold[0] += rolled.filter((r) => r.id === "gcoin").reduce((a, r) => a + r.amount, 0);
    const rewards = rolled.filter((r) => r.id !== "gcoin");
    const notices = grantWithNotices(p, rewards);
    addCoin(p, "gcoin", gold.reduce((a, b) => a + b, 0));

    // evaluacion por asalto (menor es mejor, 0 = sin jugar) y contadores
    const sc = score(p, c);
    for (let i = 0; i < 3; i++) if (scores[i] !== 0 && (sc.score[i] === 0 || scores[i] < sc.score[i])) sc.score[i] = scores[i];
    sc.times++;
    if (c.type === CH.SPECIAL || c.type === CH.OUTSIDE) {
      const arr = c.type === CH.SPECIAL ? p.ch_special_times : p.ch_outer_times;
      while (arr.length < c.chapter) arr.push(0);
      arr[c.chapter - 1]++;
    }

    // progreso: modo 0 avanza ch_progress; modos 1..3 solo dejan constancia en ech_progress
    let progress = "";
    if (c.type === CH.NORMAL) {
      if (c.mode === 0) {
        const nx = nextChapter(c);
        if (nx && nx.id > Number(p.ch_progress)) p.ch_progress = nx.idStr;
      } else if (c.id > Number(p.ech_progress)) p.ech_progress = c.idStr;
      progress = p.ch_progress;
    }

    return [
      s2c(R, {
        res: 0, reward: rewardList(rewards), change_reward: [], progress,
        ap: p.ap, ap_time: p.ap_time, player_lv: p.lv, player_exp: p.exp, role_lv: role.lv, role_exp: role.exp, gold,
      }),
      ...notices,
      notice.coin(p),
    ];
  },

  /** RestartChapterC2S {chapter}: pone a 0 las partidas diarias del capitulo pagando vcoin (price_info "ResetLevel"). */
  RestartChapterC2S({ p, params }) {
    const R = "RestartChapterS2C";
    if (params.chapter === undefined) return err(R, ERR.NO_PARAM);
    const c = chapter(params.chapter);
    if (!c) return err(R, ERR.NO_CHAPTER);
    state(p);
    const sc = score(p, c);
    if (sc.refresh_times >= vipLimit(p, VIP.RESTART_CHAPTER)) return err(R, ERR.LIMIT);
    const cost = costAt("ResetLevel", sc.refresh_times);
    if (!cost || !pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    sc.times = 0;
    sc.refresh_times++;
    const next = costAt("ResetLevel", sc.refresh_times);
    return [s2c(R, { res: 0, coin: cost.cost, next_coin: next?.cost ?? 0, refresh_times: sc.refresh_times }), notice.coin(p)];
  },

  /** StraightAheadChapterC2S {chapter, type, amount, rate}: repite `amount` veces un capitulo ya superado con tickets. */
  StraightAheadChapterC2S({ p, params }) {
    const R = "StraightAheadChapterS2C";
    if (params.chapter === undefined) return err(R, ERR.NO_PARAM);
    const c = chapter(params.chapter);
    if (!c) return err(R, ERR.NO_CHAPTER);
    const amount = Math.floor(intParam(params, "amount") ?? 1);
    if (amount < 1) return err(R, ERR.BAD_PARAM);
    state(p);
    if (!cleared(p, c)) return err(R, ERR.CONDITION);
    const sc = score(p, c);
    if (c.times > 0 && sc.times + amount > c.times) return err(R, ERR.CONDITION);
    refreshAp(p);
    if (p.ap < c.apNeed * amount) return err(R, ERR.NOT_ENOUGH);
    if (!removeItem(p, PASS_TICKET_ID, amount)) return err(R, ERR.NOT_ENOUGH);
    spendAp(p, c.apNeed * amount);

    const expGain = c.expHallroad * amount;
    addPlayerExp(p, expGain);
    // recompensas deterministas (grupos seguros) x amount; el gcoin de la tabla se suma al oro
    let gold = Math.round(GOLD_PER_ROUND * c.coinRate * 3) * amount;
    const rewards: RewardItem[] = [];
    for (const r of rollRewards(c, true)) {
      if (r.id === "gcoin") gold += r.amount * amount;
      else rewards.push({ id: r.id, amount: r.amount * amount });
    }
    const notices = grantWithNotices(p, rewards);
    addCoin(p, "gcoin", gold);
    sc.times += amount;
    return [
      s2c(R, {
        res: 0, reward: rewardList(rewards), change_reward: [], ap: p.ap, ap_time: p.ap_time,
        player_lv: p.lv, player_exp: p.exp, get_player_exp: expGain, gold,
      }),
      notice.items(p, [PASS_TICKET_ID]),
      ...notices,
      notice.coin(p),
    ];
  },

  /** ReportPvEResultC2S {ch_id, result(1 gana/0 pierde/2 abandona), prop, prop1}: telemetria; una derrota cierra el capitulo en curso. */
  ReportPvEResultC2S({ p, params }) {
    const st = state(p);
    const chId = String(params.ch_id ?? "");
    const result = intParam(params, "result") ?? 0;
    st.lastPvE = { ch_id: chId, result, at: Date.now() };
    if (result !== 1 && st.playing === chId) st.playing = null;
    return [s2c("ReportPvEResultS2C", { res: 0 })];
  },

  /** getGeneralChapterC2S: por cada nodo de mapa alcanzado, el id del modo mas alto abierto (ChapterLevel_Status). */
  getGeneralChapterC2S({ p }) {
    state(p);
    const progress = Number(p.ch_progress);
    const list = chaptersOfType(CH.NORMAL)
      .filter((c) => c.mode === 0 && c.posType === 1 && c.id <= progress)
      .map((node) => highestOpenMode(p, node).id);
    return [s2c("getGeneralChapterS2C", { res: 0, size: 0, chapters: list })];
  },

  /** GetEliteBattleListC2S: rid del rival de cada capitulo de elite (se conserva hasta ReEliteBattle). */
  GetEliteBattleListC2S({ p }) {
    const st = state(p);
    return [s2c("GetEliteBattleListS2C", { res: 0, list: eliteList(st) })];
  },

  /** GetEliteBattleRivalC2S {index}: nodo de combate -> datos del rival; nodo de premio -> entrega la recompensa. */
  GetEliteBattleRivalC2S({ p, params }) {
    const R = "GetEliteBattleRivalS2C";
    const index = intParam(params, "index");
    if (index === null) return err(R, ERR.NO_PARAM);
    const list = chaptersOfType(CH.ELITE);
    const c = list[index];
    if (!c) return err(R, ERR.BAD_PARAM);
    const st = state(p);
    if (ebProgress(p) !== c.attachId - 1) return err(R, ERR.CONDITION); // hay que ir en orden (y no repetir premios)

    if (c.rewards.length > 0) {
      // Nodo de premio: coin[4] y give_exp/give_ap son lo entregado; reward lleva el resto
      const rolled = rollRewards(c, true);
      const coins = ["gcoin", "vcoin", "pcoin", "ecoin"].map((id) => rolled.filter((r) => r.id === id).reduce((a, r) => a + r.amount, 0));
      const giveExp = rolled.filter((r) => r.id === "exp").reduce((a, r) => a + r.amount, 0);
      const giveAp = rolled.filter((r) => r.id.toLowerCase() === "ap").reduce((a, r) => a + r.amount, 0);
      const rest = rolled.filter((r) => !isCoin(r.id) && r.id !== "exp" && r.id.toLowerCase() !== "ap");
      refreshAp(p);
      const notices = grantWithNotices(p, [...rolled.filter((r) => isCoin(r.id) || r.id === "exp"), ...rest]);
      p.ap += giveAp;
      p.eb_progress = String(c.attachId);
      return [
        s2c(R, {
          res: 0, lv: p.lv, exp: p.exp, ap: p.ap, ap_time: p.ap_time, coin: coins, give_exp: giveExp, give_ap: giveAp,
          reward: rewardList(rest), change_reward: [],
        }),
        ...notices,
        notice.coin(p),
        notice.player(p),
      ];
    }
    const npc = (st.eliteNpc[String(index)] ??= { hp: 100, anger: 0 });
    return [s2c(R, { res: 0, rival: eliteRival(eliteList(st)[index] ?? randomRoleId(), index, npc) })];
  },

  /** ReEliteBattleC2S: reinicia la torre de elite (progreso, hp de roles y rivales) pagando vcoin; el primero es gratis. */
  ReEliteBattleC2S({ p }) {
    const R = "ReEliteBattleS2C";
    const st = state(p);
    if (p.eb_re_times >= vipLimit(p, VIP.ELITE_RESET)) return err(R, ERR.LIMIT);
    const cost = p.eb_re_times < ELITE_RESET_FREE ? { cost: 0, value: 0 } : costAt("EliteBattleReset", p.eb_re_times) ?? { cost: 0, value: 0 };
    if (!pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    p.eb_re_times++;
    p.eb_progress = "0";
    for (const r of Object.values(p.roles)) {
      r.elite_battle_hp = 100;
      r.elite_battle_anger = 0;
    }
    st.eliteNpc = {};
    st.eliteList = [];
    const next = costAt("EliteBattleReset", p.eb_re_times);
    return [s2c(R, { res: 0, coin: cost.cost, next_coin: next?.cost ?? 0, times: p.eb_re_times, list: eliteList(st) }), notice.coin(p)];
  },

  /** ReportEliteBattleC2S {index, role_id, role_hp, role_anger, tag_hp, tag_anger}: guarda hp/ira y avanza si el rival cayo. */
  ReportEliteBattleC2S({ p, params }) {
    const R = "ReportEliteBattleS2C";
    const index = intParam(params, "index");
    if (index === null) return err(R, ERR.NO_PARAM);
    const c = chaptersOfType(CH.ELITE)[index];
    if (!c || c.rewards.length > 0) return err(R, ERR.BAD_PARAM);
    const st = state(p);
    if (ebProgress(p) !== c.attachId - 1) return err(R, ERR.CONDITION);
    const roleHp = Math.max(0, intParam(params, "role_hp") ?? 0);
    const roleAnger = Math.max(0, intParam(params, "role_anger") ?? 0);
    const tagHp = Math.max(0, intParam(params, "tag_hp") ?? 0);
    const tagAnger = Math.max(0, intParam(params, "tag_anger") ?? 0);
    const win = tagHp <= 0 && roleHp > 0;
    const role: Role | undefined = p.roles[String(params.role_id ?? "")] ?? currentRole(p);
    role.elite_battle_hp = roleHp;
    role.elite_battle_anger = roleAnger;
    st.eliteNpc[String(index)] = { hp: tagHp, anger: tagAnger };
    const gcoin = win ? Math.round(ELITE_WIN_GOLD * c.coinRate) : 0;
    addCoin(p, "gcoin", gcoin);
    if (win) p.eb_progress = String(c.attachId);
    return [
      s2c(R, { res: 0, progress: ebProgress(p), gcoin, role_hp: roleHp, role_anger: roleAnger, tag_hp: tagHp, tag_anger: tagAnger }),
      notice.coin(p),
    ];
  },

  /** ReportPassersC2S {id}: victoria contra un transeunte (capitulo 18xxxxx) -> AP de la tabla, maximo 60 al dia. */
  ReportPassersC2S({ p, params }) {
    const R = "ReportPassersS2C";
    if (params.id === undefined) return err(R, ERR.NO_PARAM);
    const c = chapter(params.id);
    if (!c || c.type !== CH.NPC) return err(R, ERR.BAD_PARAM);
    const st = state(p);
    if (p.passers_times >= PASSERS_MAX) return err(R, ERR.LIMIT);
    const ap = rollRewards(c, true).filter((r) => r.id.toLowerCase() === "ap").reduce((a, r) => a + r.amount, 0);
    refreshAp(p);
    p.ap += ap;
    p.passers_times++;
    if (st.playing === c.idStr) st.playing = null;
    return [s2c(R, { res: 0, ap, passers_times: p.passers_times }), notice.player(p)];
  },

  /** BuyBloodC2S: en mitad de un combate, recupera vida pagando vcoin (price_info "BuyBlood"); precio por numero de compra. */
  BuyBloodC2S({ p }) {
    const R = "BuyBloodS2C";
    const st = state(p);
    if (!st.playing) return err(R, ERR.NOT_IN_CHAPTER);
    const cost = costAt("BuyBlood", p.buy_blood_times, false);
    if (!cost) return err(R, ERR.LIMIT);
    if (!pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    p.buy_blood_times++;
    const next = costAt("BuyBlood", p.buy_blood_times, false);
    return [s2c(R, { res: 0, times: p.buy_blood_times, need_coin: cost.cost, next_coin: next?.cost ?? cost.cost }), notice.coin(p)];
  },

  /** BuyAPC2S: compra AP con vcoin; "ap" es el incremento. Limite diario por VIP. */
  BuyAPC2S({ p }) {
    const R = "BuyAPS2C";
    state(p);
    if (p.buy_ap_times >= vipLimit(p, VIP.BUY_AP)) return err(R, ERR.LIMIT);
    const cost = costAt("BuyAP", p.buy_ap_times);
    if (!cost || !pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    refreshAp(p);
    p.ap += cost.value;
    p.buy_ap_times++;
    const next = costAt("BuyAP", p.buy_ap_times);
    return [
      s2c(R, { res: 0, coin: cost.cost, next_coin: next?.cost ?? cost.cost, ap: cost.value, ap_time: p.ap_time, buy_ap_times: p.buy_ap_times }),
      notice.coin(p),
      notice.player(p),
    ];
  },

  /** BuyTPC2S: compra puntos de entrenamiento con vcoin; el cliente lee el hashtable tal cual (coin, next_coin, tp, tp_time, buy_tp_times). */
  BuyTPC2S({ p }) {
    const R = "BuyTPS2C";
    state(p);
    if (p.buy_tp_times >= vipLimit(p, VIP.BUY_TP)) return err(R, ERR.LIMIT);
    const cost = costAt("TrainingPoint", p.buy_tp_times);
    if (!cost || !pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    const now = Date.now();
    if (p.tp >= vipLimit(p, VIP.TP_MAX)) p.tp_time = now; // por encima del maximo no regenera: el reloj arranca ahora
    p.tp += cost.value;
    p.buy_tp_times++;
    const next = costAt("TrainingPoint", p.buy_tp_times);
    return [
      s2c(R, { res: 0, coin: cost.cost, next_coin: next?.cost ?? cost.cost, tp: cost.value, tp_time: p.tp_time, buy_tp_times: p.buy_tp_times }),
      notice.coin(p),
    ];
  },

  /** GoldFingerC2S: cambia vcoin por gcoin con multiplicador aleatorio x1..x10 (magnification en %). */
  GoldFingerC2S({ p }) {
    const R = "GoldFingerS2C";
    state(p);
    if (p.gold_finger_times >= vipLimit(p, VIP.GOLD_FINGER)) return err(R, ERR.LIMIT);
    const cost = costAt("ChangeCoin", p.gold_finger_times);
    if (!cost || !pay(p, "vcoin", cost.cost)) return err(R, ERR.NOT_ENOUGH);
    const mag = 1 + Math.floor(Math.random() * 10);
    const actual = cost.value * mag;
    addCoin(p, "gcoin", actual);
    p.gold_finger_times++;
    const next = costAt("ChangeCoin", p.gold_finger_times);
    return [
      s2c(R, {
        res: 0, coin: cost.cost, next_coin: next?.cost ?? cost.cost, give: cost.value, gold_finger_times: p.gold_finger_times,
        actual_give_gcoin: actual, magnification: mag * 100,
      }),
      notice.coin(p),
    ];
  },

  /** ConfigurationPtC2S {configuration:{"1..8":n}}: reparte puntos de atributo del rol (pt_amount) entre sus props. */
  ConfigurationPtC2S({ p, params }) {
    const R = "ConfigurationPtS2C";
    const conf = parseConfiguration(params.configuration);
    if (!conf) return err(R, ERR.NO_PARAM);
    const keys = Object.keys(conf);
    if (keys.length === 0 || keys.some((k) => !/^[1-8]$/.test(k))) return err(R, ERR.BAD_PARAM);
    const role = currentRole(p);
    const total = keys.reduce((a, k) => a + conf[k], 0);
    if (total > role.pt_amount) return err(R, ERR.CONDITION);
    for (const k of keys) role.prop[k] = (role.prop[k] ?? 0) + conf[k];
    role.pt_amount -= total;
    return [s2c(R, { res: 0 })];
  },

  /** ConfigurationRolePropC2S {configuration:'{"1..8":n}'}: entrena un atributo base: 1 TP + gcoin (price_info "TrainBasePointCost") por punto, sin superar el nivel del rol. */
  ConfigurationRolePropC2S({ p, params }) {
    const R = "ConfigurationRolePropS2C";
    const conf = parseConfiguration(params.configuration);
    if (!conf) return err(R, ERR.NO_PARAM);
    const keys = Object.keys(conf);
    if (keys.length === 0 || keys.some((k) => !/^[1-8]$/.test(k))) return err(R, ERR.BAD_PARAM);
    const role = currentRole(p);
    let points = 0, price = 0;
    for (const k of keys) {
      const lv = role.prop[k] ?? 0;
      if (lv + conf[k] > role.lv) return err(R, ERR.LIMIT); // "超過額定": no puede superar el nivel del rol
      for (let i = 0; i < conf[k]; i++) price += costAt("TrainBasePointCost", lv + i)?.cost ?? 0;
      points += conf[k];
    }
    if (p.tp < points || coin(p, "gcoin") < price) return err(R, ERR.CONDITION); // "數量不足"
    pay(p, "gcoin", price);
    p.tp -= points;
    for (const k of keys) role.prop[k] = (role.prop[k] ?? 0) + conf[k];
    return [s2c(R, { res: 0 }), notice.coin(p)];
  },

  /** ChangeTeachingFlagC2S {flag}: mascara de bits de tutoriales terminados (bit N-1 = TutorialType N). */
  ChangeTeachingFlagC2S({ p, params }) {
    const flag = intParam(params, "flag");
    if (flag === null || flag < 0) return err("ChangeTeachingFlagS2C", ERR.NO_PARAM);
    p.teaching_flag = Math.floor(flag);
    return [s2c("ChangeTeachingFlagS2C", { res: 0 })];
  },

  /** LogTeachingFlagC2S {main, deputy}: telemetria del paso de tutorial en curso (se guardan los ultimos 50). */
  LogTeachingFlagC2S({ p, params }) {
    const st = state(p);
    st.teachLog.push({ main: intParam(params, "main") ?? 0, deputy: intParam(params, "deputy") ?? 0, at: Date.now() });
    if (st.teachLog.length > 50) st.teachLog.splice(0, st.teachLog.length - 50);
    return [s2c("LogTeachingFlagS2C", { res: 0 })];
  },
};
