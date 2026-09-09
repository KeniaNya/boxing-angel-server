// Dominio de tienda/economia: gacha (Lottery_Info), pozo de deseos, tiendas (normal/PvP/elite), firma diaria,
// compras in-app (ya no operativas) y canje de codigos.
// Formatos: *S2C.Parse del cliente y sus stubs offline (CSInterfaceLottery, CSDataCenter.RandomStoreItem,
// CSInterfaceSignInReward, CSInterfaceSettingExchange). Tablas: Lottery_Info (0 tipo, 1 evento, 2 imagen, 3 texto,
// 4 pool de 1 tirada, 5 pool de 10 tiradas), fragment_info (0 id, 3 equipo asociado, 4 precio compra JSON
// {"1":gcoin,"2":vcoin,"3":pcoin,"4":ecoin}, 16 origen), equip_info (31 origen, 32 rareza, 33 fragmentos al duplicar),
// item_info (3 efecto JSON {"6":{...}} = componente, 4 precio compra JSON, 8 origen), price_info (columna = tipo de
// coste, fila = numero de veces; ver CSDatabase.LoadCostData), system_time_info (horas de rotacion de la tienda normal).
//
// Reglas del cliente que importan aqui (CSDataCenter): tirada normal gratis si gacha_normal_times > 0 y han pasado 600 s
// desde gacha_normal_flag; tirada virtual gratis si han pasado 144000 s desde gacha_virtual_flag; con 6 tiradas
// acumuladas de Choice/Cosplay se puede elegir un premio (DesignateChoiceGachaReward). signin_flag lo lee el cliente con
// int.Parse (NO puede ser un timestamp en ms): 0 = puede firmar hoy, 1 = ya firmo. Las flags de gacha si son ms.
//
// Reinicios diarios: el cliente los recibe por ServerMsg (cmd 16/17/18) o al hacer login; como este modulo no ve el
// login, exporta refreshShopDaily(p) para que el dominio de login lo llame antes de mandar el jugador.

import type { PlayerHandler, Frame } from "../game.ts";
import { s2c, notice, coin, addCoin, pay, itemCount, addItem, removeItem, addEquip, findEquip, isEquipId, isCoin, type RewardItem } from "../economy.ts";
import { table, tableById } from "../gamedata.ts";
import { ext, type Player, type Equip } from "../players.ts";

// Codigos (Localization del cliente): *_1002 "faltan parametros" · *_1003 "parametro incorrecto" · StartGacha_1016 /
// StoreShopping_1016 / RefreshStore_1016 "dinero insuficiente" · StartGacha_1019 / startWishPoolGacha_1019 "condiciones no
// cumplidas" · DesignateChoiceGachaReward_1019 "aun no llevas 6 tiradas" · DoSignin_1019 "hoy ya firmaste" ·
// StoreShopping_1020 "ya comprado" · CodeRedemption_1005 "codigo incorrecto" · CodeRedemption_1020 "codigo ya usado" ·
// IAPB_1025 "recibo invalido" · startWishPoolGacha_1 "no existe esa actividad" · GetIapbInfo_1005 "no hay productos"
const R = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, NOT_FOUND: 1005, NO_MONEY: 1016, CONDITION: 1019, ALREADY: 1020, BAD_RECEIPT: 1025, NO_ACTIVITY: 1 };

// ---- constantes del cliente
export const LOTTERY = { NORMAL: 1, VIRTUAL: 2, CHOICE: 3, COSPLAY: 4 } as const; // CSInterfaceLottery.LotteryType
export const FREE_NORMAL_MS = 600 * 1000; // s_RecoveryTime_LotteryNormal
export const FREE_VIRTUAL_MS = 144000 * 1000; // s_RecoveryTime_LotteryVirtual
export const FREE_NORMAL_TIMES = 5; // s_LotteryTimes_Normal (tiradas normales gratis al dia)
export const FREE_CHOOSE_TIMES = 6; // s_LotteryFreeChooseTimes
export const STORE = { NORMAL: 1, PVP: 2, ELITE: 3 } as const; // StoreType
export const STORE_SLOTS = 6;
/** Evento activo de Lottery_Info por tipo de gacha (columna 1). Cosplay no tiene pool en la tabla: usa el de Choice. */
export const GACHA_EVENT: Record<number, string> = { 1: "1", 2: "2", 3: "4", 4: "6" };
const COIN_IDS = ["gcoin", "vcoin", "pcoin", "ecoin"]; // coinType de la tienda 0..3 == clave "1".."4" del precio JSON

// ---- price_info: indices de columna segun CSDatabase.LoadCostData
const COST_COL = { LOTTERY_NORMAL: 9, LOTTERY_VIRTUAL: 10, LOTTERY_CHOICE: 11, STORE_NORMAL: 12, STORE_PVP: 13, STORE_ELITE: 21 };
const costCache = new Map<number, number[]>();
function costList(col: number): number[] {
  let l = costCache.get(col);
  if (!l) {
    l = table("price_info.txt")
      .filter((f) => /^\d+$/.test(f[0]))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map((f) => (f[col] ?? "").trim())
      .filter((v) => v !== "")
      .map(Number);
    costCache.set(col, l);
  }
  return l;
}
/** Coste de la vez `index` (0-based); pasado el final devuelve el ultimo (GetCostDataByIndex con IsReturnMax). */
function costAt(col: number, index: number): number {
  const l = costList(col);
  if (l.length === 0) return 0;
  return l[Math.min(index, l.length - 1)];
}

// ---- tablas de objetos
type FragInfo = { id: string; equip: string; price: Record<string, number>; source: string };
let fragByEquip: Map<string, FragInfo> | null = null;
let fragById: Map<string, FragInfo> | null = null;
function loadFrags() {
  if (!fragByEquip) {
    fragByEquip = new Map();
    fragById = new Map();
    for (const f of table("fragment_info.txt")) {
      const info: FragInfo = { id: f[0], equip: f[3] ?? "", price: parsePrice(f[4]), source: (f[16] ?? "").trim() };
      fragById.set(info.id, info);
      if (info.equip && !fragByEquip.has(info.equip)) fragByEquip.set(info.equip, info);
    }
  }
  return { fragByEquip: fragByEquip!, fragById: fragById! };
}
function parsePrice(text: string | undefined): Record<string, number> {
  try {
    const j = JSON.parse(text || "{}");
    const out: Record<string, number> = {};
    if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) out[k] = Number(v);
    return out;
  } catch {
    return {};
  }
}
/** Fragmento correspondiente a un equipo (fragment_info col 3) o undefined. */
export function fragmentOfEquip(equipId: string): FragInfo | undefined {
  return loadFrags().fragByEquip.get(equipId);
}
function equipRow(id: string): string[] | undefined {
  return tableById("equip_info.txt").get(id);
}
/** Fragmentos que devuelve un equipo duplicado (equip_info col 33; 10 por defecto como en la tabla). */
function toFragmentAmount(equipId: string): number {
  const n = Number(equipRow(equipId)?.[33]);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
type ItemInfo = { id: string; component: number; price: Record<string, number>; source: string };
let componentItems: ItemInfo[] | null = null;
/** Objetos "componente" (item_info efecto {"6":{"1":valor}}): relleno de gacha, moneda del pozo de deseos. */
function components(): ItemInfo[] {
  if (!componentItems) {
    componentItems = [];
    for (const f of table("item_info.txt")) {
      let component = 0;
      try {
        const eff = JSON.parse(f[3] || "{}");
        const c = eff?.["6"];
        if (c && typeof c === "object") component = Number(Object.values(c)[0] ?? 1) || 1;
      } catch {
        /* sin efecto */
      }
      if (component > 0) componentItems.push({ id: f[0], component, price: parsePrice(f[4]), source: (f[8] ?? "").trim() });
    }
  }
  return componentItems;
}

// ---- Lottery_Info
type LotteryPool = { type: string; event: string; one: string[]; ten: string[] };
let lotteryRows: LotteryPool[] | null = null;
function lotteryTable(): LotteryPool[] {
  if (!lotteryRows) {
    const split = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    lotteryRows = table("Lottery_Info.txt").map((f) => ({ type: f[0], event: f[1], one: split(f[4]), ten: split(f[5]) }));
  }
  return lotteryRows;
}
const LOTTERY_TYPE_NAME: Record<number, string> = { 1: "Normal", 2: "Virtual", 3: "Choice", 4: "Cosplay" };
/** Pool de un tipo de gacha (fila Lottery_Info del evento activo). Cosplay sin objetos cae al pool de Choice. */
export function lotteryPool(type: number): LotteryPool {
  const find = (t: number) => lotteryTable().find((r) => r.type === LOTTERY_TYPE_NAME[t] && r.event === GACHA_EVENT[t]);
  const row = find(type);
  if (row && row.one.length > 0) return row;
  return find(LOTTERY.CHOICE) ?? { type: "Choice", event: GACHA_EVENT[3], one: [], ten: [] };
}

// ---- utilidades de tiempo y azar
function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** PRNG determinista (mulberry32) para el stock de la tienda. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(arr: T[], rnd: () => number): T => arr[Math.floor(rnd() * arr.length)];
const rangeInt = (a: number, b: number, rnd: () => number) => a + Math.floor(rnd() * (b - a + 1)); // [a, b]

// ---- estado del dominio
type StoreRow = [number, string, number, number, number]; // [buyFlag, id, amount, cost, coinType] (GetStoreS2C)
type StoreState = { key: string; day: string; refreshTimes: number; list: StoreRow[] };
type ShopExt = {
  stores: Record<string, StoreState>;
  signinMonth: string; // mes al que pertenece signin_times
  signinDay: string; // ultimo dia firmado
  gachaDay: string; // dia del ultimo reinicio de tiradas normales gratis
  redeemed: string[]; // codigos ya canjeados
};
function st(p: Player): ShopExt {
  return ext<ShopExt>(p, "shop", () => ({ stores: {}, signinMonth: "", signinDay: "", gachaDay: "", redeemed: [] }));
}

/** Reinicios diarios/mensuales de este dominio (firma, tiradas gratis). El login deberia llamarlo antes de enviar el jugador. */
export function refreshShopDaily(p: Player, now = new Date()): void {
  const s = st(p);
  const today = dayKey(now);
  if (s.signinDay !== today) p.signin_flag = 0; // ServerMsg cmd 16: hoy se puede firmar
  if (s.signinMonth !== monthKey(now)) {
    s.signinMonth = monthKey(now); // ServerMsg cmd 17: calendario nuevo
    p.signin_times = 0;
  }
  if (s.gachaDay !== today) {
    s.gachaDay = today; // ServerMsg cmd 18: tiradas normales gratis del dia
    p.gacha_normal_times = FREE_NORMAL_TIMES;
  }
}

// ---- recompensas: conversion de equipo duplicado en fragmentos (change_reward) y entrega con avisos
type RewardOut = { id: string; amount: number };
type ChangeOut = { id: string; amount: number; original_id: string; original_amount: number };
/**
 * Aplica una lista de recompensas al jugador. Un equipo que ya se posee (o que se repite en la misma lista) se convierte
 * en sus fragmentos como hace el stub: `reward` lleva el equipo original y `change_reward` la conversion.
 * Devuelve tambien los frames NoticeUpdateS2C (items/equips/coin) que hay que mandar tras la respuesta principal.
 */
function deliver(p: Player, rewards: RewardItem[]): { reward: RewardOut[]; change_reward: ChangeOut[]; notices: Frame[] } {
  const reward: RewardOut[] = [];
  const change_reward: ChangeOut[] = [];
  const itemIds = new Set<string>();
  const newEquips: Equip[] = [];
  let coinChanged = false;
  for (const r of rewards) {
    if (!r.amount) continue;
    reward.push({ id: r.id, amount: r.amount });
    if (isCoin(r.id)) {
      addCoin(p, r.id, r.amount);
      coinChanged = true;
    } else if (isEquipId(r.id)) {
      const frag = fragmentOfEquip(r.id);
      if (frag && findEquip(p, r.id)) {
        const n = toFragmentAmount(r.id) * r.amount;
        addItem(p, frag.id, n);
        itemIds.add(frag.id);
        change_reward.push({ id: frag.id, amount: n, original_id: r.id, original_amount: r.amount });
      } else for (let i = 0; i < r.amount; i++) newEquips.push(addEquip(p, r.id));
    } else {
      addItem(p, r.id, r.amount);
      itemIds.add(r.id);
    }
  }
  const notices: Frame[] = [];
  if (itemIds.size) notices.push(notice.items(p, [...itemIds]));
  if (newEquips.length) notices.push(notice.equips(newEquips));
  if (coinChanged) notices.push(notice.coin(p));
  return { reward, change_reward, notices };
}

// ---- gacha
/** Una tirada del pool: equipo destacado, fragmentos de un destacado o un componente de relleno (pesos por tipo). */
function rollOne(type: number, pool: string[], rnd: () => number): RewardItem {
  const weights = type === LOTTERY.NORMAL ? [5, 35] : type === LOTTERY.VIRTUAL ? [15, 45] : [20, 50]; // % equipo, % fragmento
  const roll = rnd() * 100;
  const equips = pool.filter(isEquipId);
  if (equips.length && roll < weights[0]) return { id: pick(equips, rnd), amount: 1 };
  if (equips.length && roll < weights[0] + weights[1]) {
    const eq = pick(equips, rnd);
    const frag = fragmentOfEquip(eq);
    if (frag) return { id: frag.id, amount: rangeInt(3, 5, rnd) };
  }
  const nonEquip = pool.filter((id) => !isEquipId(id));
  if (nonEquip.length && rnd() < 0.5) return { id: pick(nonEquip, rnd), amount: 1 };
  const filler = components().filter((c) => (type === LOTTERY.NORMAL ? c.component <= 2 : c.component <= 4));
  const all = filler.length ? filler : components();
  if (!all.length) return { id: "gcoin", amount: 500 };
  return { id: pick(all, rnd).id, amount: rangeInt(1, 2, rnd) };
}
/** Recompensas de `count` tiradas; la de 10 usa ademas el pool de 10 y garantiza al menos un equipo. */
export function drawGacha(type: number, count: number, rnd: () => number = Math.random): RewardItem[] {
  const pool = lotteryPool(type);
  const ids = count >= 10 ? [...new Set([...pool.one, ...pool.ten])] : pool.one;
  const out: RewardItem[] = [];
  for (let i = 0; i < count; i++) out.push(rollOne(type, ids, rnd));
  const equips = ids.filter(isEquipId);
  if (count >= 10 && equips.length && !out.some((r) => isEquipId(r.id))) out[out.length - 1] = { id: pick(equips, rnd), amount: 1 };
  return out;
}
function gachaCost(type: number, count: number): number {
  const ten = count >= 10 ? 1 : 0;
  if (type === LOTTERY.NORMAL) return costAt(COST_COL.LOTTERY_NORMAL, ten);
  if (type === LOTTERY.VIRTUAL) return costAt(COST_COL.LOTTERY_VIRTUAL, ten);
  // Choice = fila 1, Cosplay = fila 2 de la columna "precio gacha seleccion" (GetLotteryItemDataOK); una sola tirada por precio
  return costAt(COST_COL.LOTTERY_CHOICE, type === LOTTERY.CHOICE ? 0 : 1) * (count >= 10 ? 10 : 1);
}
/** Lista "info" del lobby de gacha: objetos elegibles del pool de Choice (LobbyData id/amount). */
function choiceInfo(): RewardOut[] {
  return lotteryPool(LOTTERY.CHOICE).one.map((id) => ({ id, amount: 1 }));
}
function gachaState(p: Player, cost: number, now: number) {
  return {
    choice_times: p.gacha_choice_times, cosplay_times: p.gacha_cosplay_times,
    normal_times: p.gacha_normal_times, normal_flag: p.gacha_normal_flag,
    virtual_times: p.gacha_virtual_times, virtual_flag: p.gacha_virtual_flag,
    coin: cost, server_time: now,
  };
}

// ---- tiendas
function storeCostCol(storeId: number): number {
  return storeId === STORE.PVP ? COST_COL.STORE_PVP : storeId === STORE.ELITE ? COST_COL.STORE_ELITE : COST_COL.STORE_NORMAL;
}
/** Moneda con la que se paga el refresco de cada tienda (SetStoreData del cliente). */
function storeRefreshCoin(storeId: number): string {
  return storeId === STORE.PVP ? "pcoin" : storeId === STORE.ELITE ? "ecoin" : "vcoin";
}
/** Clave de rotacion del stock: la tienda normal rota a las horas de system_time_info (col 2 = 1); el resto a diario. */
function stockKey(storeId: number, now: Date): string {
  const day = dayKey(now);
  if (storeId !== STORE.NORMAL) return day;
  const hours = table("system_time_info.txt")
    .filter((f) => (f[2] ?? "").trim() === "1")
    .map((f) => Number(f[0].slice(0, 2)) * 60 + Number(f[0].slice(2, 4)))
    .filter((m) => Number.isFinite(m));
  const minutes = now.getHours() * 60 + now.getMinutes();
  return `${day}#${hours.filter((h) => minutes >= h).length}`;
}
type Candidate = { id: string; price: Record<string, number>; coinTypes: number[] };
function storeCandidates(storeId: number): Candidate[] {
  const { fragById } = loadFrags();
  const out: Candidate[] = [];
  if (storeId === STORE.PVP) {
    for (const f of fragById.values()) if (f.source === "pvp") out.push({ id: f.id, price: f.price, coinTypes: [2] });
  } else if (storeId === STORE.ELITE) {
    for (const f of fragById.values()) if ((equipRow(f.equip)?.[31] ?? "").trim() === "eshop") out.push({ id: f.id, price: f.price, coinTypes: [3] });
  } else {
    for (const f of fragById.values()) if (f.source === "shop") out.push({ id: f.id, price: f.price, coinTypes: [0, 1] });
    for (const c of components()) if (c.source === "gdraw" && c.component <= 3) out.push({ id: c.id, price: c.price, coinTypes: [0] });
  }
  // Solo candidatos con precio en alguna de sus monedas
  return out.filter((c) => c.coinTypes.some((t) => c.price[String(t + 1)] > 0));
}
/** Stock determinista de una tienda a partir de una semilla (misma forma que RandomStoreItem del stub). */
export function generateStock(storeId: number, seed: string): StoreRow[] {
  const rnd = seeded(hashStr(seed));
  const cands = storeCandidates(storeId);
  const rows: StoreRow[] = [];
  if (!cands.length) return rows;
  const used = new Set<string>();
  for (let i = 0; i < STORE_SLOTS; i++) {
    let c = pick(cands, rnd);
    for (let tries = 0; used.has(c.id) && tries < 10; tries++) c = pick(cands, rnd);
    used.add(c.id);
    const types = c.coinTypes.filter((t) => c.price[String(t + 1)] > 0);
    const coinType = pick(types, rnd);
    const amount = rangeInt(1, 3, rnd);
    rows.push([0, c.id, amount, c.price[String(coinType + 1)] * amount, coinType]);
  }
  return rows;
}
/** Estado de una tienda con el stock rotado y el contador de refrescos del dia. */
function store(p: Player, storeId: number, now = new Date()): StoreState {
  const s = st(p);
  const key = stockKey(storeId, now);
  const day = dayKey(now);
  let cur = s.stores[storeId];
  if (!cur) cur = s.stores[storeId] = { key: "", day, refreshTimes: 0, list: [] };
  if (cur.day !== day) {
    cur.day = day;
    cur.refreshTimes = 0;
  }
  if (cur.key !== key) {
    cur.key = key;
    cur.list = generateStock(storeId, `${p.acc}|${storeId}|${key}`);
  }
  return cur;
}
function validStore(v: unknown): number | null {
  const n = Number(v);
  return n === STORE.NORMAL || n === STORE.PVP || n === STORE.ELITE ? n : null;
}

// ---- firma diaria
/** Calendario del mes: ciclo fijo de monedas con un fragmento (de un equipo de gacha) cada 7 dias. */
export function signinCalendar(month: string): RewardOut[] {
  const rnd = seeded(hashStr("signin|" + month));
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const cycle: RewardOut[] = [
    { id: "gcoin", amount: 500 }, { id: "vcoin", amount: 20 }, { id: "gcoin", amount: 800 },
    { id: "pcoin", amount: 100 }, { id: "vcoin", amount: 30 }, { id: "gcoin", amount: 1000 },
  ];
  const frags = lotteryPool(LOTTERY.VIRTUAL).one.map(fragmentOfEquip).filter((f): f is FragInfo => !!f);
  const out: RewardOut[] = [];
  for (let d = 1; d <= days; d++) {
    if (d % 7 === 0 && frags.length) out.push({ id: pick(frags, rnd).id, amount: rangeInt(5, 7, rnd) });
    else out.push(cycle[(d - 1) % cycle.length]);
  }
  return out;
}
function monthRange(now: Date): [number, number] {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
  return [start, end];
}

// ---- pozo de deseos (una actividad fija definida aqui)
export const WISH_TYPE = 31;
const WISH_ID = "WISH_0001";
/** Umbrales de intercambio -> rareza del equipo que se sortea (equip_info col 32). */
const WISH_INTERVALS: [number, string][] = [[10, "C"], [30, "B"], [60, "A"], [100, "S"]];
/** Objetos que se pueden entregar al pozo y su valor de intercambio (componentes; valor = nivel del componente). */
function wishConsume(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of components()) out[c.id] = c.component;
  return out;
}
let wishIntervalCache: Record<string, string[]> | null = null;
function wishIntervals(): Record<string, string[]> {
  if (!wishIntervalCache) {
    wishIntervalCache = {};
    for (const [threshold, rare] of WISH_INTERVALS) {
      const ids = table("equip_info.txt")
        .filter((f) => (f[32] ?? "").trim().toUpperCase() === rare && ["gdraw", "vdraw", "v2draw"].includes((f[31] ?? "").trim()))
        .map((f) => f[0])
        .slice(0, 12);
      wishIntervalCache[String(threshold)] = ids;
    }
  }
  return wishIntervalCache;
}

// ---- compras in-app: la plataforma de pago ya no existe
// GetIapbInfo devuelve lista vacia (res 0) para que la tienda de diamantes abra sin productos; IAPB responde 1025
// ("recibo invalido"), ReportIAPB y dmmPurchasebefore 1003.

// ---- codigos de canje definidos en el modulo (una vez por jugador)
export const REDEEM_CODES: Record<string, RewardItem[]> = {
  WELCOME: [{ id: "vcoin", amount: 300 }, { id: "gcoin", amount: 5000 }],
  BOXINGANGEL: [{ id: "0201001", amount: 5 }, { id: "0201002", amount: 3 }, { id: "vcoin", amount: 100 }],
  REVIVAL: [{ id: "0202004", amount: 5 }, { id: "gcoin", amount: 10000 }],
};

export const handlers: Record<string, PlayerHandler> = {
  /** Tirada de gacha: reward/change_reward + contadores y flags (ms) + coin (lo cobrado). flag=1 pide tirada gratis. */
  StartGachaC2S({ p, params, log }) {
    if (params.type === undefined || params.count === undefined) return [s2c("StartGachaS2C", { res: R.NO_DATA })];
    const type = Number(params.type);
    const count = Number(params.count) >= 10 ? 10 : 1;
    const free = Number(params.flag ?? 0) === 1;
    if (!LOTTERY_TYPE_NAME[type]) return [s2c("StartGachaS2C", { res: R.WRONG_DATA })];
    refreshShopDaily(p);
    const now = Date.now();
    let cost = gachaCost(type, count);
    if (free) {
      if (count !== 1) return [s2c("StartGachaS2C", { res: R.CONDITION })];
      if (type === LOTTERY.NORMAL) {
        if (p.gacha_normal_times <= 0 || now - p.gacha_normal_flag < FREE_NORMAL_MS) return [s2c("StartGachaS2C", { res: R.CONDITION })];
        p.gacha_normal_times--;
        p.gacha_normal_flag = now;
      } else if (type === LOTTERY.VIRTUAL) {
        if (now - p.gacha_virtual_flag < FREE_VIRTUAL_MS) return [s2c("StartGachaS2C", { res: R.CONDITION })];
        p.gacha_virtual_flag = now;
      } else return [s2c("StartGachaS2C", { res: R.CONDITION })];
      cost = 0;
    } else if (!pay(p, type === LOTTERY.NORMAL ? "gcoin" : "vcoin", cost)) {
      return [s2c("StartGachaS2C", { res: R.NO_MONEY })];
    }
    if (type === LOTTERY.CHOICE) p.gacha_choice_times += count;
    if (type === LOTTERY.COSPLAY) p.gacha_cosplay_times += count;
    const { reward, change_reward, notices } = deliver(p, drawGacha(type, count));
    log("StartGachaC2S", p.name, LOTTERY_TYPE_NAME[type], count, free ? "gratis" : `coste ${cost}`, reward.map((r) => r.id).join(","));
    // coin va en la respuesta; los avisos de items/equipo (y coin, idempotente) van despues
    return [s2c("StartGachaS2C", { res: R.OK, reward, change_reward, ...gachaState(p, cost, now) }), ...notices];
  },

  /** Info del lobby de gacha: type (1 = panel Choice), id (eventos de Lottery_Info), coin (precios 1/10) e info (objetos elegibles). */
  GetGachaInfoC2S({ params }) {
    const req = Number(params.type ?? 0); // 0 = todo; 1/2/3 = un panel (LotteryReNewType)
    const events = [GACHA_EVENT[1], GACHA_EVENT[2], GACHA_EVENT[3]];
    const id = req >= 1 && req <= 3 ? [events[req - 1]] : events;
    const coinList = [
      [costAt(COST_COL.LOTTERY_NORMAL, 0), costAt(COST_COL.LOTTERY_NORMAL, 1)],
      [costAt(COST_COL.LOTTERY_VIRTUAL, 0), costAt(COST_COL.LOTTERY_VIRTUAL, 1)],
      [costAt(COST_COL.LOTTERY_CHOICE, 0)],
    ];
    return [s2c("GetGachaInfoS2C", { res: R.OK, type: 1, id, coin: coinList, info: choiceInfo() })];
  },

  /** Info del gacha de seleccion: type, id (evento, string) e info (objetos elegibles). El cliente actual no lo envia. */
  GetChoiceGachaInfoC2S() {
    return [s2c("GetChoiceGachaInfoS2C", { res: R.OK, type: 1, id: GACHA_EVENT[3], info: choiceInfo() })];
  },

  /** Elegir premio tras 6 tiradas de Choice/Cosplay: reward {id, amount} (+ change_reward objeto si es duplicado); resetea el contador. */
  DesignateChoiceGachaRewardC2S({ p, params, log }) {
    if (params.index === undefined) return [s2c("DesignateChoiceGachaRewardS2C", { res: R.NO_DATA })];
    const info = choiceInfo();
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= info.length) return [s2c("DesignateChoiceGachaRewardS2C", { res: R.WRONG_DATA })];
    const useChoice = p.gacha_choice_times >= FREE_CHOOSE_TIMES;
    if (!useChoice && p.gacha_cosplay_times < FREE_CHOOSE_TIMES) return [s2c("DesignateChoiceGachaRewardS2C", { res: R.CONDITION })];
    if (useChoice) p.gacha_choice_times = 0;
    else p.gacha_cosplay_times = 0;
    const { reward, change_reward, notices } = deliver(p, [{ id: info[index].id, amount: info[index].amount }]);
    log("DesignateChoiceGachaRewardC2S", p.name, reward[0].id);
    const out: Record<string, unknown> = { res: R.OK, reward: reward[0] };
    if (change_reward.length) out.change_reward = change_reward[0];
    return [s2c("DesignateChoiceGachaRewardS2C", out), ...notices];
  },

  /** Pozo de deseos: dos frames, step 1 (type + consume [{id: valor}]) y step 0 size 0 (data con intervalos) que cierra la carga. */
  getWishPoolDataC2S() {
    const now = Date.now();
    const consume = Object.entries(wishConsume()).map(([id, v]) => ({ [id]: v }));
    const data = [{
      id: WISH_ID, type: WISH_TYPE, icon: "", title: "Wish Pool", content: "Trade components for a random outfit of the reached tier.",
      note: "", stime: now - 24 * 3600 * 1000, etime: now + 30 * 24 * 3600 * 1000, interval: wishIntervals(),
    }];
    return [
      s2c("getWishPoolDataS2C", { res: R.OK, step: 1, size: 1, type: WISH_TYPE, consume }),
      s2c("getWishPoolDataS2C", { res: R.OK, step: 0, size: 0, data }),
    ];
  },

  /** Tirada del pozo: consume {id: cantidad}, suma valor*cantidad y sortea un equipo del tramo alcanzado. */
  startWishPoolGachaC2S({ p, params, log }) {
    if (params.actiivityType === undefined || !params.consumeItem) return [s2c("startWishPoolGachaS2C", { res: R.NO_DATA })];
    if (Number(params.actiivityType) !== WISH_TYPE) return [s2c("startWishPoolGachaS2C", { res: R.NO_ACTIVITY })];
    const values = wishConsume();
    const consume = params.consumeItem as Record<string, unknown>;
    if (typeof consume !== "object") return [s2c("startWishPoolGachaS2C", { res: R.WRONG_DATA })];
    let total = 0;
    const entries: [string, number][] = [];
    for (const [id, n] of Object.entries(consume)) {
      const amount = Number(n);
      if (!Number.isInteger(amount) || amount < 0 || !(id in values)) return [s2c("startWishPoolGachaS2C", { res: R.WRONG_DATA })];
      if (amount === 0) continue;
      if (itemCount(p, id) < amount) return [s2c("startWishPoolGachaS2C", { res: R.CONDITION })];
      entries.push([id, amount]);
      total += amount * values[id];
    }
    const intervals = wishIntervals();
    const keys = Object.keys(intervals).map(Number).sort((a, b) => a - b);
    const reached = keys.filter((k) => total >= k);
    if (!reached.length) return [s2c("startWishPoolGachaS2C", { res: R.CONDITION })];
    const tier = intervals[String(reached[reached.length - 1])];
    if (!tier.length) return [s2c("startWishPoolGachaS2C", { res: R.CONDITION })];
    for (const [id, amount] of entries) removeItem(p, id, amount);
    const { reward, change_reward, notices } = deliver(p, [{ id: pick(tier, Math.random), amount: 1 }]);
    log("startWishPoolGachaC2S", p.name, "valor", total, "->", reward[0].id);
    const consumedNotice = notice.items(p, entries.map(([id]) => id));
    return [s2c("startWishPoolGachaS2C", { res: R.OK, reward, change_reward }), consumedNotice, ...notices];
  },

  /** Stock de una tienda: commodity_list [[buyFlag, id, amount, cost, coinType]...] y refresh_times del dia. */
  GetStoreC2S({ p, params }) {
    if (params.store_id === undefined) return [s2c("GetStoreS2C", { res: R.NO_DATA })];
    const storeId = validStore(params.store_id);
    if (storeId === null) return [s2c("GetStoreS2C", { res: R.WRONG_DATA })];
    const s = store(p, storeId);
    return [s2c("GetStoreS2C", { res: R.OK, commodity_list: s.list, refresh_times: s.refreshTimes })];
  },

  /** Refresco pagado (price_info por numero de veces): new_commodity_list, coin (cobrado), next_coin, refresh_times. */
  RefreshStoreC2S({ p, params, log }) {
    if (params.store_id === undefined) return [s2c("RefreshStoreS2C", { res: R.NO_DATA })];
    const storeId = validStore(params.store_id);
    if (storeId === null) return [s2c("RefreshStoreS2C", { res: R.WRONG_DATA })];
    const s = store(p, storeId);
    const col = storeCostCol(storeId);
    const cost = costAt(col, s.refreshTimes);
    if (!pay(p, storeRefreshCoin(storeId), cost)) return [s2c("RefreshStoreS2C", { res: R.NO_MONEY })];
    s.refreshTimes++;
    s.list = generateStock(storeId, `${p.acc}|${storeId}|${s.key}|r${s.refreshTimes}|${Math.random()}`);
    log("RefreshStoreC2S", p.name, "tienda", storeId, "coste", cost, "veces", s.refreshTimes);
    // El cliente descuenta `coin` el mismo; el aviso de monedas es absoluto, asi que no duplica
    return [
      s2c("RefreshStoreS2C", { res: R.OK, new_commodity_list: s.list, coin: cost, next_coin: costAt(col, s.refreshTimes), refresh_times: s.refreshTimes }),
      notice.coin(p),
    ];
  },

  /** Compra del hueco `index`: valida precio/moneda, entrega y marca vendido. reward [{id, amount}] (+ change_reward). */
  StoreShoppingC2S({ p, params, log }) {
    if (params.store_id === undefined || params.index === undefined) return [s2c("StoreShoppingS2C", { res: R.NO_DATA })];
    const storeId = validStore(params.store_id);
    const index = Number(params.index);
    if (storeId === null) return [s2c("StoreShoppingS2C", { res: R.WRONG_DATA })];
    const s = store(p, storeId);
    const row = s.list[index];
    if (!row) return [s2c("StoreShoppingS2C", { res: R.WRONG_DATA })];
    if (row[0] !== 0) return [s2c("StoreShoppingS2C", { res: R.ALREADY })];
    const coinId = COIN_IDS[row[4]] ?? "gcoin";
    if (!pay(p, coinId, row[3])) return [s2c("StoreShoppingS2C", { res: R.NO_MONEY })];
    row[0] = 1;
    const { reward, change_reward, notices } = deliver(p, [{ id: row[1], amount: row[2] }]);
    log("StoreShoppingC2S", p.name, "tienda", storeId, row[1], "x" + row[2], row[3], coinId);
    return [s2c("StoreShoppingS2C", { res: R.OK, reward, change_reward }), ...notices, notice.coin(p)];
  },

  /** Calendario de firma del mes: list [{id, amount}] (indice = dia de firma) y expiration [inicio, fin] en ms. */
  GetSigninC2S({ p }) {
    refreshShopDaily(p);
    const now = new Date();
    return [s2c("GetSigninS2C", { res: R.OK, list: signinCalendar(monthKey(now)), expiration: monthRange(now) })];
  },

  /** Firma de hoy: entrega list[signin_times], incrementa signin_times y pone signin_flag = 1 hasta manana. */
  DoSigninC2S({ p, log }) {
    refreshShopDaily(p);
    if (p.signin_flag !== 0) return [s2c("DoSigninS2C", { res: R.CONDITION })];
    const now = new Date();
    const list = signinCalendar(monthKey(now));
    const item = list[p.signin_times];
    if (!item) return [s2c("DoSigninS2C", { res: R.CONDITION })];
    const s = st(p);
    p.signin_times++;
    p.signin_flag = 1;
    s.signinDay = dayKey(now);
    const { reward, change_reward, notices } = deliver(p, [{ id: item.id, amount: item.amount }]);
    log("DoSigninC2S", p.name, "dia", p.signin_times, reward[0].id, reward[0].amount);
    const out: Record<string, unknown> = { res: R.OK, reward: reward[0] };
    if (change_reward.length) out.change_reward = change_reward[0];
    return [s2c("DoSigninS2C", out), ...notices];
  },

  /** Productos de pago: lista vacia (la tienda de diamantes abre sin nada que comprar). */
  GetIapbInfoC2S() {
    return [s2c("GetIapbInfoS2C", { res: R.OK, list: [] })];
  },

  /** Validacion de recibo de compra: ya no hay plataforma de pago -> 1025 "recibo invalido". */
  IAPBC2S({ p, params, log }) {
    log("IAPBC2S rechazado", p.name, String(params.productId ?? ""));
    return [s2c("IAPBS2C", { res: R.BAD_RECEIPT })];
  },

  /** Confirmacion de pedido: nada que confirmar -> 1003. */
  ReportIAPBC2S() {
    return [s2c("ReportIAPBS2C", { res: R.WRONG_DATA })];
  },

  /** Pre-compra DMM (Japon): sin pasarela -> 1003. */
  dmmPurchasebeforeC2S() {
    return [s2c("dmmPurchasebeforeS2C", { res: R.WRONG_DATA })];
  },

  /** Canje de codigo: coin = deltas [g, v, p, e], reward = [[id, amount]...] (listas, no objetos), lv/exp/ap/ap_time actuales. */
  CodeRedemptionC2S({ p, params, log }) {
    if (params.code === undefined) return [s2c("CodeRedemptionS2C", { res: R.NO_DATA })];
    const code = String(params.code).trim().toUpperCase();
    const rewards = REDEEM_CODES[code];
    if (!code || !rewards) return [s2c("CodeRedemptionS2C", { res: R.NOT_FOUND })];
    const s = st(p);
    if (s.redeemed.includes(code)) return [s2c("CodeRedemptionS2C", { res: R.ALREADY })];
    s.redeemed.push(code);
    const before = [...p.coin];
    const { reward, change_reward, notices } = deliver(p, rewards);
    const delta = COIN_IDS.map((id, i) => coin(p, id) - (before[i] ?? 0));
    log("CodeRedemptionC2S", p.name, code);
    return [
      s2c("CodeRedemptionS2C", {
        res: R.OK, lv: p.lv, exp: p.exp, ap: p.ap, ap_time: p.ap_time, coin: delta, give_exp: 0, give_ap: 0,
        reward: reward.filter((r) => !isCoin(r.id)).map((r) => [r.id, r.amount]), change_reward,
      }),
      ...notices,
    ];
  },
};
