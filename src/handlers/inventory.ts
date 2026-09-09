// Dominio de inventario: roles (compra/cambio), equipo (poner/quitar, estrellas, calidad, piezas, encantamientos),
// fabricacion con fragmentos, venta, uso de objetos y habilidades (compra, mejora, equipar).
//
// Formatos: *S2C.Parse del cliente y sus stubs offline (CSUIEquipInfoPanel, CSUIInventory, CSMakerFragment,
// CSUIItemInfo, CSPlusBuffPanel, CSUITrainingSuperSkillLearnPanel, CSUIRoleAttribute, CSDataCenter).
// Tablas (columnas segun CSDatabase.Load*): equip_info, item_info, fragment_info, skill_info,
// skill_growth_mode_info, price_info, role_info, vip_info.
//
// Modelo: p.equips es una lista de instancias unicas (un id = una pieza), p.items apilable, p.skills = habilidades
// compradas con strengthen_prop (nivel por atributo mejorable), roles[rid].equip_in (6 huecos: pelo, bikini,
// guantes, cintura, zapatos, accesorio), skill/skill2/passive_skill. Estado propio: ext(p, "inventory").

import type { PlayerHandler, Frame } from "../game.ts";
import {
  s2c, coin, pay, addCoin, itemCount, addItem, removeItem, findEquip, addEquip, removeEquip, isEquipId,
  addPlayerExp, addRoleExp, refreshAp, currentRole, notice, type RewardItem,
} from "../economy.ts";
import { ext, newRole, type Player, type Role, type Equip } from "../players.ts";
import { table, tableById, roleTable } from "../gamedata.ts";
import { config } from "../config.ts";

// Codigos (Localization del cliente, <Msg>_NNNN): 1002 "faltan parametros" · 1003 "parametro incorrecto"
// · 1005 "no existe (equipo/rol/objeto/habilidad)" · 1008 BuyRole "el rol ya existe" · 1012 "limite superado"
// (BuyRole, LevelUpSkill "nivel de gimnasio insuficiente", addBuff "encantamientos llenos") · 1016 "dinero insuficiente"
// · 1017 addBuff/clearBuff "no posees ese equipo" · 1018 Make "ya tienes el producto" · 1019 "recursos insuficientes"
// (fragmentos, nivel, puntos de entrenamiento) · 1021 BuyRole "cantidad insuficiente" · 1022 UseItem "config anomala"
const R = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, NOT_FOUND: 1005, EXISTS: 1008, LIMIT: 1012, NO_COIN: 1016, NOT_OWNED: 1017, HAVE_PRODUCT: 1018, NOT_ENOUGH: 1019, BAD_CONFIG: 1022 };

type InventoryExt = { detachTimes: number };
const st = (p: Player) => ext<InventoryExt>(p, "inventory", () => ({ detachTimes: 0 }));

// ---------------------------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------------------------

function json<T>(text: string | undefined, fallback: T): T {
  try {
    const v = JSON.parse((text ?? "").trim() || "null");
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
const num = (s: string | undefined, d = 0) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) && (s ?? "").trim() !== "" ? n : d;
};

/** equip_info: 0 id, 7 precio reciclaje, 8 precio compra, 10 nivel requerido, 14 calidad inicial, 16 oculto,
 *  23..28 piezas requeridas por calidad 1..6 (JSON de 6 ids), 32 rareza, 33 fragmentos al convertir, 34 estrellas iniciales, 35 limite encantamientos */
export type EquipInfo = { id: string; sellPrice: number; quality: number; initLv: number; buffLimit: number; toFragment: number; rare: string; hidden: boolean; slotRequires: string[][]; qualityMax: number };
const equipCache = new Map<string, EquipInfo>();
export function equipInfo(id: string): EquipInfo | undefined {
  let e = equipCache.get(id);
  if (e) return e;
  const f = tableById("equip_info.txt").get(id);
  if (!f) return undefined;
  const slotRequires: string[][] = [];
  for (let q = 0; q < 6; q++) {
    const arr = json<unknown[]>(f[23 + q], []);
    slotRequires.push(Array.from({ length: 6 }, (_, i) => String(arr[i] ?? "")));
  }
  // CSDatabase: m_QualityMax = calidades con alguna pieza requerida definida (minimo 1)
  const qualityMax = Math.max(1, slotRequires.filter((s) => s.some((x) => x !== "")).length);
  e = {
    id, sellPrice: num(f[7]), quality: Math.max(1, num(f[14], 1)), initLv: Math.max(1, num(f[34], 1)), buffLimit: num(f[35]),
    toFragment: num(f[33]), rare: (f[32] ?? "").trim().toUpperCase(), hidden: num(f[16]) !== 0, slotRequires, qualityMax,
  };
  equipCache.set(id, e);
  return e;
}

/** CSDatabase.ItemEffectCode */
export const EFFECT = { None: 0, Exp1: 1, Exp2: 2, Gold1: 3, Gold2: 4, Activity: 5, Components: 6, Blueprint: 7, PassTicket: 8, VipDay: 9, Training: 10, Fukubukuro: 11, GashaponTicket: 12, VipMonth: 13, VipWeek: 14 };

/** item_info: 0 id, 3 efecto (JSON {"codigo": valor}), 4 precio compra, 5 precio reciclaje, 9 encantamiento (JSON [[claves]...]) */
export type ItemInfo = { id: string; effect: number; value: number; attr?: { key: number; value: number }; blueprint?: { id: string; slot: string[]; gcoin: number }; pool: Record<string, number>; sellPrice: number; buff: number[][] };
const itemCache = new Map<string, ItemInfo>();
export function itemInfo(id: string): ItemInfo | undefined {
  let it = itemCache.get(id);
  if (it) return it;
  const f = tableById("item_info.txt").get(id);
  if (!f) return undefined;
  it = { id, effect: 0, value: 0, pool: {}, sellPrice: num(f[5]), buff: json<number[][]>(f[9], []) };
  for (const [k, v] of Object.entries(json<Record<string, unknown>>(f[3], {}))) {
    if (k === "LV") continue;
    it.effect = Number(k);
    if (it.effect === EFFECT.Components && v && typeof v === "object") {
      for (const [ak, av] of Object.entries(v as Record<string, unknown>)) it.attr = { key: Number(ak), value: Number(av) };
    } else if (it.effect === EFFECT.Blueprint && v && typeof v === "object") {
      const b = v as { id?: string; slot?: unknown[]; gcoin?: number };
      it.blueprint = { id: String(b.id ?? ""), slot: (b.slot ?? []).map(String), gcoin: Number(b.gcoin ?? 0) };
    } else if (it.effect === EFFECT.Fukubukuro && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) it.pool[pk] = Number(pv);
    } else it.value = Number(v);
    break;
  }
  itemCache.set(id, it);
  return it;
}

/** fragment_info: 0 id, 3 objeto resultante, 5 precio reciclaje, 6/7 cantidad+oro para fabricar (estrella 1),
 *  8..15 cantidad+oro para subir a estrella 2..5 */
export type FragmentInfo = { id: string; target: string; sellPrice: number; condition: number[]; price: number[]; starMax: number };
const fragCache = new Map<string, FragmentInfo>();
let fragByTarget: Map<string, string> | null = null;
export function fragmentInfo(id: string): FragmentInfo | undefined {
  let fr = fragCache.get(id);
  if (fr) return fr;
  const f = tableById("fragment_info.txt").get(id);
  if (!f) return undefined;
  const condition = [6, 8, 10, 12, 14].map((c) => num(f[c]));
  const price = [7, 9, 11, 13, 15].map((c) => num(f[c]));
  let starMax = 0;
  for (const c of condition) {
    if (c <= 0) break;
    starMax++;
  }
  fr = { id, target: (f[3] ?? "").trim(), sellPrice: num(f[5]), condition, price, starMax };
  fragCache.set(id, fr);
  return fr;
}
/** Fragmento que fabrica el objeto/equipo dado (CSDataCenter: InventoryInfo.m_CombineFrom). */
export function fragmentOf(targetId: string): FragmentInfo | undefined {
  if (!fragByTarget) fragByTarget = new Map(table("fragment_info.txt").map((f) => [(f[3] ?? "").trim(), f[0]]));
  const id = fragByTarget.get(targetId);
  return id ? fragmentInfo(id) : undefined;
}

/** skill_info: 0 id, 7 nivel de gimnasio para comprar, 9 nivel de rol para equipar, 21..24 modulo de coste por atributo
 *  mejorable, 25 atributos mejorables (JSON). Tipo: 0301 activa, 0302 pasiva. */
export type SkillInfo = { id: string; buyLv: number; equipLv: number; modes: string[]; canLevelUp: number[]; passive: boolean };
export function skillInfo(id: string): SkillInfo | undefined {
  const f = tableById("skill_info.txt").get(id);
  if (!f) return undefined;
  const canLevelUp = json<number[]>(f[25], []).map(Number);
  return { id, buyLv: num(f[7]), equipLv: num(f[9]), modes: canLevelUp.map((_, k) => (f[21 + k] ?? "").trim()), canLevelUp, passive: id.startsWith("0302") };
}
/** skill_growth_mode_info: 0 modulo, 1 nivel, 2 puntos de entrenamiento, 3 oro. */
export function skillLevelCost(mode: string, level: number): { tp: number; coin: number } | undefined {
  const f = table("skill_growth_mode_info.txt").find((r) => r[0] === mode && num(r[1]) === level);
  return f ? { tp: num(f[2]), coin: num(f[3]) } : undefined;
}
/** Coste de comprar una habilidad = suma del nivel 1 de cada atributo mejorable (CSUIRoleAttribute.BuySkill). */
export function skillBuyCost(id: string): number {
  const k = skillInfo(id);
  return k ? k.modes.reduce((a, m) => a + (skillLevelCost(m, 1)?.coin ?? 0), 0) : 0;
}

/** price_info: filas ordenadas por "veces" (col 0); solo cuentan las celdas no vacias (CSDatabase.LoadCostData).
 *  Columnas usadas: 14/15 quitar pieza (oro/diamantes), 19 subir calidad, 23/24 encantar (oro/diamantes). */
export const PRICE = { SLOT_REMOVE_G: 14, SLOT_REMOVE_V: 15, QUALITY_UP: 19, BUFF_G: 23, BUFF_V: 24 };
const priceCache = new Map<number, number[]>();
export function priceList(col: number): number[] {
  let l = priceCache.get(col);
  if (!l) {
    l = table("price_info.txt")
      .filter((f) => /^\d+$/.test((f[0] ?? "").trim()))
      .sort((a, b) => num(a[0]) - num(b[0]))
      .filter((f) => (f[col] ?? "").trim() !== "")
      .map((f) => num(f[col]));
    priceCache.set(col, l);
  }
  return l;
}
/** Valor en la posicion `index` (0-based), o la ultima fila si se pasa (GetCostDataByIndex con IsReturnMax). */
export function priceAt(col: number, index: number): number {
  const l = priceList(col);
  return l.length ? l[Math.min(Math.max(0, index), l.length - 1)] : 0;
}

/** vip_info fila 6: habilidades equipables (columna 3 + nivel VIP). */
export function vipSkillSlots(p: Player): number {
  const f = table("vip_info.txt").find((r) => num(r[0]) === 6);
  return f ? Math.max(1, num(f[3 + Math.min(Math.max(p.vip, 0), 1)], 1)) : 1;
}

/** Hueco de equipo por prefijo de id: 0101 pelo(0) 0102 bikini(1) 0103 guantes(2) 0104 cintura(3) 0105 zapatos(4) 0106 accesorio(5). */
export function slotIndexOf(id: string): number {
  if (!/^01\d{5}$/.test(id)) return -1;
  const i = Number(id.slice(2, 4)) - 1;
  return i >= 0 && i < 6 ? i : -1;
}

// ---------------------------------------------------------------------------------------------
// Utilidades de estado
// ---------------------------------------------------------------------------------------------

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const int = (v: unknown, d = NaN) => {
  const n = typeof v === "number" ? v : Number(str(v));
  return Number.isInteger(n) ? n : d;
};

/** LoginS2C.ParseRole lee "prop"; los stubs offline usan "pt": se mandan ambos. */
export const roleOut = (r: Role) => ({ ...r, pt: r.prop });

/** Garantiza 6 huecos de piezas en el equipo (el cliente rellena con "" cuando llega vacio). */
function slots6(e: Equip): string[] {
  while (e.slot.length < 6) e.slot.push("");
  return e.slot;
}

/** Quita un equipo de todos los roles que lo lleven (una pieza = una instancia). */
function unequipEverywhere(p: Player, eid: string): void {
  for (const r of Object.values(p.roles)) {
    for (let i = 0; i < r.equip_in.length; i++) if (r.equip_in[i] === eid) r.equip_in[i] = "";
  }
}

/** Crea un equipo nuevo con estrellas/calidad iniciales de la tabla. */
function createEquip(p: Player, id: string): Equip {
  const info = equipInfo(id);
  const e = addEquip(p, id);
  e.lv = info?.initLv ?? 1;
  e.quality = info?.quality ?? 1;
  slots6(e);
  return e;
}

/** Entrega recompensas; los equipos que ya se poseen se convierten en fragmentos (change_reward del cliente). */
function grantWithChange(p: Player, rewards: RewardItem[]): { reward: [string, number][]; change: Record<string, unknown>[]; items: string[]; equips: Equip[] } {
  const out: [string, number][] = [];
  const change: Record<string, unknown>[] = [];
  const items = new Set<string>();
  const equips: Equip[] = [];
  for (const r of rewards) {
    if (!r.amount) continue;
    out.push([r.id, r.amount]);
    if (isEquipId(r.id)) {
      for (let i = 0; i < r.amount; i++) {
        if (!findEquip(p, r.id)) {
          equips.push(createEquip(p, r.id));
          continue;
        }
        const frag = fragmentOf(r.id);
        const n = equipInfo(r.id)?.toFragment || 1;
        if (frag) {
          addItem(p, frag.id, n);
          items.add(frag.id);
          change.push({ id: frag.id, amount: n, original_id: r.id, original_amount: 1 });
        }
      }
    } else if (r.id in { gcoin: 1, vcoin: 1, pcoin: 1, ecoin: 1 }) addCoin(p, r.id, r.amount);
    else if (r.id === "exp") addPlayerExp(p, r.amount);
    else if (r.id === "ap") p.ap += r.amount;
    else if (r.id === "tp") p.tp += r.amount;
    else {
      addItem(p, r.id, r.amount);
      items.add(r.id);
    }
  }
  return { reward: out, change, items: [...items], equips };
}

/** Sube una estrella (lv) al equipo, o lo fabrica si no se posee, pagando fragmentos + oro (fragment_info). */
function starUp(p: Player, equipId: string): { res: number; equip?: Equip; created?: boolean; fragId?: string } {
  const frag = fragmentOf(equipId);
  const info = equipInfo(equipId);
  if (!frag || !info) return { res: R.NOT_FOUND };
  const e = findEquip(p, equipId);
  const idx = e ? e.lv : 0; // condition[lv] = coste para pasar de lv a lv+1; condition[0] = fabricar
  if (e && (e.lv >= frag.starMax || idx >= frag.condition.length)) return { res: R.HAVE_PRODUCT };
  const need = frag.condition[idx], cost = frag.price[idx];
  if (need <= 0) return { res: R.HAVE_PRODUCT };
  if (itemCount(p, frag.id) < need) return { res: R.NOT_ENOUGH };
  if (coin(p, "gcoin") < cost) return { res: R.NO_COIN };
  removeItem(p, frag.id, need);
  pay(p, "gcoin", cost);
  if (e) {
    e.lv++;
    return { res: R.OK, equip: e, created: false, fragId: frag.id };
  }
  return { res: R.OK, equip: createEquip(p, equipId), created: true, fragId: frag.id };
}

/** Bolsas regalo (ItemEffectCode.Fukubukuro): el nombre del pool no esta en las tablas del cliente; se interpreta
 *  por su nombre en pinyin: saiqianxiang = caja de oro, zuanshi* = diamantes, {yx,jl,ss,cs}zhuangbei* = equipo
 *  aleatorio de rareza C/B/A/S. El valor es la cantidad. */
function giftPool(name: string, n: number): RewardItem[] {
  if (name === "saiqianxiang") return [{ id: "gcoin", amount: config().economy.giftBagGold * n }];
  if (name.startsWith("zuanshi")) return [{ id: "vcoin", amount: config().economy.giftBagDiamonds * n }];
  const rare = ({ yx: "C", jl: "B", ss: "A", cs: "S" } as Record<string, string>)[name.slice(0, 2)];
  if (!rare || !name.includes("zhuangbei")) return [];
  const pool = table("equip_info.txt").map((f) => f[0]).filter((id) => /^01\d{5}$/.test(id) && !equipInfo(id)!.hidden && equipInfo(id)!.rare === rare);
  const out: RewardItem[] = [];
  for (let i = 0; i < n && pool.length; i++) out.push({ id: pool[Math.floor(Math.random() * pool.length)], amount: 1 });
  return out;
}

const reply = (name: string, obj: Record<string, unknown>): Frame => s2c(name, obj);

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

export const handlers: Record<string, PlayerHandler> = {
  /** Compra un rol con diamantes (role_info col 5, desbloqueo col 4); el cliente espera {res} y crea el rol localmente. */
  BuyRoleC2S({ p, params }) {
    const rid = str(params.rid);
    if (!rid) return [reply("BuyRoleS2C", { res: R.NO_DATA })];
    const info = roleTable().get(rid);
    if (!info) return [reply("BuyRoleS2C", { res: R.WRONG_DATA })];
    if (p.roles[rid]) return [reply("BuyRoleS2C", { res: R.EXISTS })];
    if (p.lv < info.unlockLevel) return [reply("BuyRoleS2C", { res: R.NOT_ENOUGH })];
    if (!pay(p, "vcoin", info.price)) return [reply("BuyRoleS2C", { res: R.NO_COIN })];
    const role = newRole(rid);
    p.roles[rid] = role;
    const equips = role.equip_in.filter((id) => id !== "" && !findEquip(p, id)).map((id) => createEquip(p, id));
    return [reply("BuyRoleS2C", { res: R.OK, change_reward: [], role: roleOut(role) }), notice.coin(p), notice.equips(equips)];
  },

  /** Cambia el rol activo; el cliente espera {res, role} (LoginS2C.ParseRole). */
  ChangeRoleC2S({ p, params }) {
    const rid = str(params.rid);
    if (!rid) return [reply("ChangeRoleS2C", { res: R.NO_DATA })];
    const role = p.roles[rid];
    if (!role) return [reply("ChangeRoleS2C", { res: R.NOT_FOUND })];
    p.last_use = rid;
    return [reply("ChangeRoleS2C", { res: R.OK, role: roleOut(role) })];
  },

  /** Pone el equipo eid en el hueco index del rol rid; el cliente solo espera {res} y actualiza equip_in localmente. */
  SetupEquipC2S({ p, params }) {
    const eid = str(params.eid), rid = str(params.rid) || p.last_use, index = int(params.index);
    if (!eid || !Number.isInteger(index)) return [reply("SetupEquipS2C", { res: R.NO_DATA })];
    const role = p.roles[rid];
    if (!role || index < 0 || index > 5 || slotIndexOf(eid) !== index) return [reply("SetupEquipS2C", { res: R.WRONG_DATA })];
    if (!findEquip(p, eid)) return [reply("SetupEquipS2C", { res: R.NOT_FOUND })];
    unequipEverywhere(p, eid);
    role.equip_in[index] = eid;
    return [reply("SetupEquipS2C", { res: R.OK })];
  },

  /** Quita el equipo del hueco index del rol activo (type 0) o el suministro logistico (type 1). Solo {res}. */
  TakeOffEquipC2S({ p, params }) {
    const index = int(params.index), type = int(params.type, 0);
    if (!Number.isInteger(index)) return [reply("TakeOffEquipS2C", { res: R.NO_DATA })];
    const role = currentRole(p);
    const list = type === 1 ? role.logistics : role.equip_in;
    if (index < 0 || index >= (type === 1 ? Math.max(list.length, 1) : 6)) return [reply("TakeOffEquipS2C", { res: R.WRONG_DATA })];
    if (index < list.length) list[index] = "";
    return [reply("TakeOffEquipS2C", { res: R.OK })];
  },

  /** Sube una estrella al equipo (o lo fabrica) con fragmentos + oro de fragment_info. Solo {res}; el cliente descuenta localmente. */
  LevelUpEquipC2S({ p, params }) {
    let eid = str(params.eid);
    if (!eid) return [reply("LevelUpEquipS2C", { res: R.NO_DATA })];
    if (!isEquipId(eid)) eid = fragmentInfo(eid)?.target ?? eid; // tambien acepta el id del fragmento
    const r = starUp(p, eid);
    if (r.res !== R.OK) return [reply("LevelUpEquipS2C", { res: r.res })];
    return [reply("LevelUpEquipS2C", { res: R.OK }), notice.coin(p), notice.items(p, [r.fragId!]), notice.equips([r.equip!])];
  },

  /** Sube la calidad: exige las 6 piezas puestas, paga price_info col 19 (indice = calidad actual), consume las piezas
   *  y devuelve {res, coin (pagado), prop} donde prop = (prop anterior + piezas) x 1.22 (claves "1".."8"). */
  AdvancedEquipC2S({ p, params }) {
    const eid = str(params.eid);
    if (!eid) return [reply("AdvancedEquipS2C", { res: R.NO_DATA })];
    const e = findEquip(p, eid), info = equipInfo(eid);
    if (!e || !info) return [reply("AdvancedEquipS2C", { res: R.NOT_FOUND })];
    const slot = slots6(e);
    if (slot.some((s) => !s || itemInfo(s)?.effect !== EFFECT.Components) || e.quality >= info.qualityMax) return [reply("AdvancedEquipS2C", { res: R.WRONG_DATA })];
    const cost = priceAt(PRICE.QUALITY_UP, e.quality);
    if (!pay(p, "gcoin", cost)) return [reply("AdvancedEquipS2C", { res: R.NO_COIN })];
    const sum: Record<string, number> = { ...e.prop };
    for (const s of slot) {
      const a = itemInfo(s)!.attr;
      if (a && a.key >= 1 && a.key <= 8) sum[String(a.key)] = (sum[String(a.key)] ?? 0) + a.value;
    }
    const prop: Record<string, number> = {};
    for (const [k, v] of Object.entries(sum)) if (v > 0) prop[k] = Math.round(v * 1.22 * 100) / 100;
    e.prop = prop;
    e.quality++;
    e.slot = ["", "", "", "", "", ""];
    return [reply("AdvancedEquipS2C", { res: R.OK, coin: cost, prop }), notice.coin(p), notice.equips([e])];
  },

  /** Inserta la pieza pid (item Components) en el hueco index del equipo eid; debe coincidir con lo que pide
   *  equip_info para la calidad actual (cols 23..28). Solo {res}; el cliente descuenta la pieza localmente. */
  EquipInsertPartsC2S({ p, params }) {
    const eid = str(params.eid), pid = str(params.pid), index = int(params.index);
    if (!eid || !pid || !Number.isInteger(index)) return [reply("EquipInsertPartsS2C", { res: R.NO_DATA })];
    if (index < 0 || index > 5) return [reply("EquipInsertPartsS2C", { res: R.WRONG_DATA })];
    const e = findEquip(p, eid), info = equipInfo(eid), it = itemInfo(pid);
    if (!e || !info || !it || it.effect !== EFFECT.Components || itemCount(p, pid) < 1) return [reply("EquipInsertPartsS2C", { res: R.NOT_FOUND })];
    const slot = slots6(e);
    const required = info.slotRequires[Math.min(e.quality, 6) - 1]?.[index] ?? "";
    if (slot[index] !== "" || (required !== "" && required !== pid)) return [reply("EquipInsertPartsS2C", { res: R.WRONG_DATA })];
    removeItem(p, pid, 1);
    slot[index] = pid;
    return [reply("EquipInsertPartsS2C", { res: R.OK }), notice.items(p, [pid]), notice.equips([e])];
  },

  /** Destruye la pieza del hueco index pagando oro (type 0, price_info col 14) o diamantes (type 1, col 15) segun
   *  las veces acumuladas. Responde {res, coin (pagado), detach_parts_times, g_coin, v_coin (proximos precios)}. */
  EquipDetachPartsC2S({ p, params }) {
    const eid = str(params.id), index = int(params.index), type = int(params.type, 0);
    if (!eid || !Number.isInteger(index)) return [reply("EquipDetachPartsS2C", { res: R.NO_DATA })];
    if (index < 0 || index > 5 || (type !== 0 && type !== 1)) return [reply("EquipDetachPartsS2C", { res: R.WRONG_DATA })];
    const e = findEquip(p, eid);
    if (!e) return [reply("EquipDetachPartsS2C", { res: R.NOT_FOUND })];
    const slot = slots6(e);
    if (slot[index] === "") return [reply("EquipDetachPartsS2C", { res: R.NOT_ENOUGH })];
    const s = st(p);
    const cost = priceAt(type === 0 ? PRICE.SLOT_REMOVE_G : PRICE.SLOT_REMOVE_V, s.detachTimes);
    if (!pay(p, type === 0 ? "gcoin" : "vcoin", cost)) return [reply("EquipDetachPartsS2C", { res: R.NO_COIN })];
    slot[index] = "";
    s.detachTimes++;
    const times = Math.min(s.detachTimes, Math.max(priceList(PRICE.SLOT_REMOVE_G).length - 1, 0));
    return [
      reply("EquipDetachPartsS2C", { res: R.OK, coin: cost, detach_parts_times: times, g_coin: priceAt(PRICE.SLOT_REMOVE_G, times), v_coin: priceAt(PRICE.SLOT_REMOVE_V, times) }),
      notice.coin(p),
      notice.equips([e]),
    ];
  },

  /** Fabrica con el fragmento id: equipo (crea o sube estrella, amount ignorado) o piezas/objetos (amount unidades,
   *  cada una condition[0] fragmentos + price[0] oro). Responde {res, id (objeto resultante), quality}. */
  MakeC2S({ p, params }) {
    const id = str(params.id), amount = Math.max(1, int(params.amount, 1));
    if (!id) return [reply("MakeS2C", { res: R.NO_DATA })];
    const frag = fragmentInfo(id);
    if (!frag || !frag.target) return [reply("MakeS2C", { res: R.WRONG_DATA })];
    if (isEquipId(frag.target) || frag.target.startsWith("04")) {
      const r = starUp(p, frag.target);
      if (r.res !== R.OK) return [reply("MakeS2C", { res: r.res })];
      return [reply("MakeS2C", { res: R.OK, id: frag.target, quality: r.equip!.quality }), notice.coin(p), notice.items(p, [frag.id]), notice.equips([r.equip!])];
    }
    const need = frag.condition[0] * amount, cost = frag.price[0] * amount;
    if (frag.condition[0] <= 0) return [reply("MakeS2C", { res: R.WRONG_DATA })];
    if (itemCount(p, frag.id) < need) return [reply("MakeS2C", { res: R.NOT_ENOUGH })];
    if (coin(p, "gcoin") < cost) return [reply("MakeS2C", { res: R.NO_COIN })];
    removeItem(p, frag.id, need);
    pay(p, "gcoin", cost);
    addItem(p, frag.target, amount);
    return [reply("MakeS2C", { res: R.OK, id: frag.target }), notice.coin(p), notice.items(p, [frag.id, frag.target])];
  },

  /** Igual que MakeC2S para equipo (id = fragmento), respondiendo {res, eid}. */
  MakeEquipC2S({ p, params }) {
    const id = str(params.id);
    if (!id) return [reply("MakeEquipS2C", { res: R.NO_DATA })];
    const target = fragmentInfo(id)?.target ?? (isEquipId(id) ? id : "");
    if (!target) return [reply("MakeEquipS2C", { res: R.WRONG_DATA })];
    const r = starUp(p, target);
    if (r.res !== R.OK) return [reply("MakeEquipS2C", { res: r.res })];
    return [reply("MakeEquipS2C", { res: R.OK, eid: target }), notice.coin(p), notice.items(p, [r.fragId!]), notice.equips([r.equip!])];
  },

  /** Vende amount unidades de un objeto/fragmento (precio reciclaje) o un equipo (equip_info col 7).
   *  Los objetos Gold2 se cambian por diamantes (valor del efecto). Responde {res, coin (obtenido)}. */
  SellC2S({ p, params }) {
    const id = str(params.id), amount = int(params.amount, 1);
    if (!id) return [reply("SellS2C", { res: R.NO_DATA })];
    if (amount < 1) return [reply("SellS2C", { res: R.WRONG_DATA })];
    const it = itemInfo(id), frag = fragmentInfo(id);
    if (isEquipId(id)) {
      const e = findEquip(p, id);
      if (!e) return [reply("SellS2C", { res: R.NOT_FOUND })];
      const got = equipInfo(id)?.sellPrice ?? 0;
      unequipEverywhere(p, id);
      removeEquip(p, id);
      addCoin(p, "gcoin", got);
      return [reply("SellS2C", { res: R.OK, coin: got }), notice.coin(p)];
    }
    if (!it && !frag) return [reply("SellS2C", { res: R.WRONG_DATA })];
    if (!removeItem(p, id, amount)) return [reply("SellS2C", { res: R.NOT_FOUND })];
    const vcoin = it?.effect === EFFECT.Gold2;
    const got = (vcoin ? it!.value : (it?.sellPrice ?? frag!.sellPrice)) * amount;
    addCoin(p, vcoin ? "vcoin" : "gcoin", got);
    return [reply("SellS2C", { res: R.OK, coin: got }), notice.coin(p), notice.items(p, [id])];
  },

  /** Usa amount unidades del objeto id segun item_info efecto: exp de gimnasio/rol, oro, diamantes, AP, entrenamiento,
   *  VIP (dias), bolsa regalo o plano (materiales + oro -> equipo; si ya se posee, fragmentos via change_reward).
   *  Responde {res, id, amount, coin[], ap, ap_time, player_lv, player_exp, ...} (CSUIItemInfo / CSMakerFragment). */
  UseItemC2S({ p, params, log }) {
    const id = str(params.id), amount = int(params.amount, 1), rid = str(params.rid);
    if (!id) return [reply("UseItemS2C", { res: R.NO_DATA })];
    const it = itemInfo(id);
    if (!it || amount < 1) return [reply("UseItemS2C", { res: R.WRONG_DATA })];
    const tutorialBlueprint = it.effect === EFFECT.Blueprint && !(p.teaching_flag & (1 << 19)); // ver rama Blueprint
    if (itemCount(p, id) < amount && !tutorialBlueprint) return [reply("UseItemS2C", { res: R.NOT_FOUND })];
    refreshAp(p);
    const base = () => ({ res: R.OK, id, amount, coin: p.coin, ap: p.ap, ap_time: p.ap_time, player_lv: p.lv, player_exp: p.exp });
    const total = it.value * amount;
    switch (it.effect) {
      case EFFECT.Exp1: {
        removeItem(p, id, amount);
        addPlayerExp(p, total);
        return [reply("UseItemS2C", base()), notice.player(p), notice.items(p, [id])];
      }
      case EFFECT.Exp2: {
        const role = p.roles[rid] ?? currentRole(p);
        removeItem(p, id, amount);
        addRoleExp(role, total);
        return [reply("UseItemS2C", { ...base(), role_id: role.rid, role_lv: role.lv, role_exp: role.exp }), notice.role(role), notice.items(p, [id])];
      }
      case EFFECT.Gold1:
      case EFFECT.Gold2: {
        removeItem(p, id, amount);
        addCoin(p, it.effect === EFFECT.Gold1 ? "gcoin" : "vcoin", total);
        return [reply("UseItemS2C", base()), notice.coin(p), notice.items(p, [id])];
      }
      case EFFECT.Activity: {
        removeItem(p, id, amount);
        p.ap += total;
        return [reply("UseItemS2C", base()), notice.player(p), notice.items(p, [id])];
      }
      case EFFECT.Training: {
        removeItem(p, id, amount);
        p.tp += total;
        return [reply("UseItemS2C", { ...base(), tp: p.tp, tp_time: p.tp_time }), notice.items(p, [id])];
      }
      case EFFECT.VipDay:
      case EFFECT.VipWeek:
      case EFFECT.VipMonth: {
        const days = (it.effect === EFFECT.VipDay ? it.value : it.effect === EFFECT.VipWeek ? 7 : 30) * amount;
        removeItem(p, id, amount);
        p.vip = 1;
        p.vip_times = Math.max(0, p.vip_times) + days;
        // el stub usa "vip_times" y UseItemResponse lee "vip_time": se mandan ambos
        return [reply("UseItemS2C", { ...base(), vip: p.vip, vip_times: p.vip_times, vip_time: p.vip_times, tp_time: p.tp_time }), notice.items(p, [id])];
      }
      case EFFECT.Fukubukuro: {
        removeItem(p, id, amount);
        const rewards: RewardItem[] = [];
        for (const [pool, n] of Object.entries(it.pool)) for (let i = 0; i < amount; i++) rewards.push(...giftPool(pool, n));
        const g = grantWithChange(p, rewards);
        return [
          reply("UseItemS2C", { ...base(), reward: g.reward, change_reward: g.change }),
          notice.coin(p), notice.player(p), notice.items(p, [id, ...g.items]), notice.equips(g.equips),
        ];
      }
      case EFFECT.Blueprint: {
        const bp = it.blueprint;
        if (!bp || !bp.id) return [reply("UseItemS2C", { res: R.BAD_CONFIG })];
        // materiales: el propio plano (o cualquier objeto/equipo listado), cada uno 1 unidad
        const need: Record<string, number> = {};
        for (const m of bp.slot) need[m] = (need[m] ?? 0) + 1;
        need[id] = Math.max(need[id] ?? 0, 1);
        // Tutorial "KnowBlueprint" (TutorialType 20): el cliente da por hechos los materiales del primer plano
        // (los combates Dream los aplica en local) y no maneja un error aqui (se queda cargando). Mientras ese
        // tutorial no este marcado, se completan los materiales y el oro que falten.
        if (tutorialBlueprint) {
          for (const [m, n] of Object.entries(need)) {
            if (isEquipId(m)) {
              if (!findEquip(p, m)) createEquip(p, m);
            } else if (itemCount(p, m) < n) addItem(p, m, n - itemCount(p, m));
          }
          if (coin(p, "gcoin") < bp.gcoin) addCoin(p, "gcoin", bp.gcoin - coin(p, "gcoin"));
          log("UseItem: tutorial de planos, materiales completados para", id);
        }
        for (const [m, n] of Object.entries(need)) {
          const ok = isEquipId(m) ? (n === 1 && !!findEquip(p, m)) : itemCount(p, m) >= n;
          if (!ok) return [reply("UseItemS2C", { res: R.NOT_ENOUGH })];
        }
        if (coin(p, "gcoin") < bp.gcoin) return [reply("UseItemS2C", { res: R.NO_COIN })];
        pay(p, "gcoin", bp.gcoin);
        const usedItems: string[] = [];
        for (const [m, n] of Object.entries(need)) {
          if (isEquipId(m)) {
            unequipEverywhere(p, m);
            removeEquip(p, m);
          } else {
            removeItem(p, m, n);
            usedItems.push(m);
          }
        }
        const frames: Frame[] = [];
        let change: Record<string, unknown> | undefined;
        if (findEquip(p, bp.id)) {
          const frag = fragmentOf(bp.id), n = equipInfo(bp.id)?.toFragment || 1;
          if (frag) {
            addItem(p, frag.id, n);
            usedItems.push(frag.id);
            change = { id: frag.id, amount: n, original_id: bp.id, original_amount: 1 };
          }
        } else frames.push(notice.equips([createEquip(p, bp.id)]));
        // CSMakerFragment lee "reward" como id (string) y "change_reward" como objeto
        return [reply("UseItemS2C", { ...base(), amount: 1, reward: bp.id, ...(change ? { change_reward: change } : {}) }), notice.coin(p), notice.items(p, usedItems), ...frames];
      }
      default:
        // Components/PassTicket/GashaponTicket: no se consumen desde el almacen
        return [reply("UseItemS2C", { res: R.WRONG_DATA })];
    }
  },

  /** Compra la habilidad id: exige nivel de gimnasio (skill_info col 7) y paga la suma del nivel 1 de sus atributos
   *  mejorables (skill_growth_mode_info). Solo {res}; strengthen_prop queda a 1 en cada atributo. */
  BuySkillC2S({ p, params }) {
    const id = str(params.id);
    if (!id) return [reply("BuySkillS2C", { res: R.NO_DATA })];
    const k = skillInfo(id);
    if (!k || p.skills.some((s) => s.id === id)) return [reply("BuySkillS2C", { res: R.WRONG_DATA })];
    if (p.lv < k.buyLv) return [reply("BuySkillS2C", { res: R.NOT_ENOUGH })];
    if (!pay(p, "gcoin", skillBuyCost(id))) return [reply("BuySkillS2C", { res: R.NOT_ENOUGH })];
    p.skills.push({ id, strengthen_prop: k.canLevelUp.map(() => 1) });
    return [reply("BuySkillS2C", { res: R.OK, id }), notice.coin(p)];
  },

  /** Sube un nivel el atributo marcado en configuration (primer indice > 0, orden de skill_info col 25) pagando
   *  puntos de entrenamiento + oro del modulo (cols 21..24); el nivel no puede superar el de gimnasio. Solo {res}. */
  LevelUpSkillC2S({ p, params }) {
    const id = str(params.id);
    const conf = Array.isArray(params.configuration) ? params.configuration.map((x) => int(x, 0)) : [];
    if (!id || conf.length === 0) return [reply("LevelUpSkillS2C", { res: R.NO_DATA })];
    const k = skillInfo(id), owned = p.skills.find((s) => s.id === id);
    const idx = conf.findIndex((n) => n > 0);
    if (!k || !owned || idx < 0 || idx >= k.modes.length) return [reply("LevelUpSkillS2C", { res: R.WRONG_DATA })];
    while (owned.strengthen_prop.length < k.modes.length) owned.strengthen_prop.push(1);
    const next = owned.strengthen_prop[idx] + 1;
    const cost = skillLevelCost(k.modes[idx], next);
    if (!cost) return [reply("LevelUpSkillS2C", { res: R.WRONG_DATA })];
    if (next > p.lv) return [reply("LevelUpSkillS2C", { res: R.LIMIT })];
    if (p.tp < cost.tp || coin(p, "gcoin") < cost.coin) return [reply("LevelUpSkillS2C", { res: R.NOT_ENOUGH })];
    p.tp -= cost.tp;
    pay(p, "gcoin", cost.coin);
    owned.strengthen_prop[idx] = next;
    return [reply("LevelUpSkillS2C", { res: R.OK }), notice.coin(p)];
  },

  /** Equipa la habilidad id en el hueco index (0 skill, 1 skill2; el segundo exige VIP): exige poseerla y el nivel de
   *  rol de skill_info col 9. Solo {res}. */
  EquipSkillC2S({ p, params }) {
    const id = str(params.id), index = int(params.index, 0);
    if (!id) return [reply("EquipSkillS2C", { res: R.NO_DATA })];
    const k = skillInfo(id), role = currentRole(p);
    if (!k || k.passive || index < 0 || index >= vipSkillSlots(p)) return [reply("EquipSkillS2C", { res: R.WRONG_DATA })];
    if (!p.skills.some((s) => s.id === id)) return [reply("EquipSkillS2C", { res: R.NOT_FOUND })];
    if (role.lv < k.equipLv) return [reply("EquipSkillS2C", { res: R.NOT_ENOUGH })];
    const other = index === 0 ? role.skill2 : role.skill;
    if (other === id) return [reply("EquipSkillS2C", { res: R.WRONG_DATA })];
    if (index === 0) role.skill = id;
    else role.skill2 = id;
    return [reply("EquipSkillS2C", { res: R.OK })];
  },

  /** Desequipa la habilidad del hueco index del rol activo. Solo {res}. */
  UnloadSkillC2S({ p, params }) {
    const index = int(params.index);
    if (!Number.isInteger(index)) return [reply("UnloadSkillS2C", { res: R.NO_DATA })];
    const role = currentRole(p);
    if (index === 0) role.skill = "";
    else if (index === 1) role.skill2 = "";
    else return [reply("UnloadSkillS2C", { res: R.WRONG_DATA })];
    return [reply("UnloadSkillS2C", { res: R.OK })];
  },

  /** Equipa la habilidad pasiva id (0302xxx) en el rol activo; id vacio la quita. Solo {res}. */
  EquipPassiveSkillC2S({ p, params }) {
    const id = str(params.id), role = currentRole(p);
    if (id) {
      const k = skillInfo(id);
      if (!k || !k.passive) return [reply("EquipPassiveSkillS2C", { res: R.WRONG_DATA })];
    }
    role.passive_skill = id;
    return [reply("EquipPassiveSkillS2C", { res: R.OK })];
  },

  /** Encanta el equipo equipid con el objeto itemid (item_info col 9: grupos de atributos posibles) pagando oro
   *  (type 0, price_info col 23, valor 1..30) o diamantes (type 1, col 24, valor 20..30) segun encantamientos previos.
   *  Responde {res, buff (acumulado), buff_course (tirada), coin[]} (addBuffS2C). */
  addBuffC2S({ p, params }) {
    const eid = str(params.equipid), iid = str(params.itemid), type = int(params.type, 0);
    if (!eid || !iid) return [reply("addBuffS2C", { res: R.NO_DATA })];
    const e = findEquip(p, eid), info = equipInfo(eid), it = itemInfo(iid);
    if (!e || !info) return [reply("addBuffS2C", { res: R.NOT_OWNED })];
    if (!it || it.buff.length === 0 || (type !== 0 && type !== 1) || itemCount(p, iid) < 1) return [reply("addBuffS2C", { res: R.WRONG_DATA })];
    const used = e.buff_item.length;
    const col = type === 0 ? PRICE.BUFF_G : PRICE.BUFF_V;
    if ((info.buffLimit > 0 && used >= info.buffLimit) || used >= priceList(col).length) return [reply("addBuffS2C", { res: R.LIMIT })];
    if (!pay(p, type === 0 ? "gcoin" : "vcoin", priceAt(col, used))) return [reply("addBuffS2C", { res: R.WRONG_DATA })];
    removeItem(p, iid, 1);
    const course: Record<string, number[]> = {};
    for (const group of it.buff) {
      if (!group.length) continue;
      const key = String(group[Math.floor(Math.random() * group.length)]);
      const value = type === 0 ? 1 + Math.floor(Math.random() * 30) : 20 + Math.floor(Math.random() * 11);
      e.buff[key] = (e.buff[key] ?? 0) + value;
      (course[key] ??= []).push(value);
    }
    e.buff_item.push(iid);
    return [reply("addBuffS2C", { res: R.OK, buff: e.buff, buff_course: course, coin: p.coin }), notice.items(p, [iid]), notice.equips([e])];
  },

  /** Borra todos los encantamientos del equipo. Solo {res}. */
  clearBuffC2S({ p, params }) {
    const eid = str(params.equipid);
    if (!eid) return [reply("clearBuffS2C", { res: R.NO_DATA })];
    const e = findEquip(p, eid);
    if (!e) return [reply("clearBuffS2C", { res: R.NOT_OWNED })];
    e.buff = {};
    e.buff_item = [];
    return [reply("clearBuffS2C", { res: R.OK }), notice.equips([e])];
  },
};
