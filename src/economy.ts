// Helpers de economia compartidos por todos los handlers: monedas, objetos, experiencia/niveles,
// recompensas y frames NoticeUpdateS2C (el cliente actualiza inventario/monedas/nivel al recibirlos).
// Convenciones del cliente: coin = [gcoin (general), vcoin (diamantes), pcoin (PvP), ecoin (elite)].

import { table } from "./gamedata.ts";
import type { Player, Role, Equip } from "./players.ts";
import { newEquip } from "./players.ts";

export type Frame = { methodName: string; paramObject: Record<string, unknown> };
export type RewardItem = { id: string; amount: number };

export const COIN_INDEX: Record<string, number> = { gcoin: 0, vcoin: 1, pcoin: 2, ecoin: 3 };
export const isCoin = (id: string) => id in COIN_INDEX;

/** Frame S2C con whatTime (todas las respuestas lo llevan). */
export function s2c(name: string, obj: Record<string, unknown>): Frame {
  return { methodName: name, paramObject: { ...obj, whatTime: String(Date.now()) } };
}

// ---- lv_info: 0 nivel, 1 exp necesaria (gimnasio/jugador), 2 AP maximo, 3 AP regalo al subir, 4 exp necesaria (rol), 5 desbloqueos (JSON)
export type LvInfo = { lv: number; hallroadExp: number; maxAp: number; apGift: number; roleExp: number };
let lvTable: Map<number, LvInfo> | null = null;
function loadLv(): Map<number, LvInfo> {
  if (!lvTable) {
    lvTable = new Map();
    for (const f of table("lv_info.txt")) {
      const n = Number(f[0]);
      if (Number.isFinite(n)) lvTable.set(n, { lv: n, hallroadExp: Number(f[1]), maxAp: Number(f[2]), apGift: Number(f[3]), roleExp: Number(f[4]) });
    }
  }
  return lvTable;
}
export function maxLevel(): number {
  return Math.max(...loadLv().keys());
}
export function lvInfo(lv: number): LvInfo {
  const t = loadLv();
  return t.get(lv) ?? t.get(maxLevel())!;
}
export const hallroadExp = (lv: number) => lvInfo(lv).hallroadExp;
export const roleExp = (lv: number) => lvInfo(lv).roleExp;
export const maxAp = (lv: number) => lvInfo(lv).maxAp;

// ---- monedas
export function coin(p: Player, id: string): number {
  return p.coin[COIN_INDEX[id]] ?? 0;
}
export function addCoin(p: Player, id: string, amount: number): void {
  const i = COIN_INDEX[id];
  if (i === undefined) throw new Error("moneda desconocida " + id);
  p.coin[i] = Math.max(0, (p.coin[i] ?? 0) + amount);
}
/** true si pudo pagar (y descuenta). */
export function pay(p: Player, id: string, amount: number): boolean {
  if (coin(p, id) < amount) return false;
  addCoin(p, id, -amount);
  return true;
}

// ---- objetos (inventario apilable: items[id] = cantidad)
export function itemCount(p: Player, id: string): number {
  return p.items[id] ?? 0;
}
export function addItem(p: Player, id: string, amount: number): number {
  const n = (p.items[id] ?? 0) + amount;
  if (n <= 0) delete p.items[id];
  else p.items[id] = n;
  return Math.max(0, n);
}
/** true si tenia suficientes (y descuenta). */
export function removeItem(p: Player, id: string, amount: number): boolean {
  if (itemCount(p, id) < amount) return false;
  addItem(p, id, -amount);
  return true;
}

// ---- equipo (no apilable: lista p.equips)
export function findEquip(p: Player, id: string): Equip | undefined {
  return p.equips.find((e) => e.id === id);
}
export function addEquip(p: Player, id: string): Equip {
  const e = newEquip(id);
  p.equips.push(e);
  return e;
}
export function removeEquip(p: Player, id: string): boolean {
  const i = p.equips.findIndex((e) => e.id === id);
  if (i < 0) return false;
  p.equips.splice(i, 1);
  return true;
}
let equipSet: Set<string> | null = null;
export function isEquipId(id: string): boolean {
  if (!equipSet) equipSet = new Set(table("equip_info.txt").map((f) => f[0]));
  return equipSet.has(id);
}

// ---- experiencia con subida de nivel (misma logica que los stubs del cliente)
export function addPlayerExp(p: Player, amount: number): { lv: number; exp: number; levelsGained: number } {
  let lv = p.lv, exp = p.exp + amount, gained = 0;
  const max = maxLevel();
  while (lv < max && exp >= hallroadExp(lv)) {
    exp -= hallroadExp(lv);
    lv++;
    gained++;
    p.ap += lvInfo(lv).apGift; // regalo de AP al subir
  }
  p.lv = lv;
  p.exp = exp;
  return { lv, exp, levelsGained: gained };
}
export function addRoleExp(r: Role, amount: number): { lv: number; exp: number } {
  let lv = r.lv, exp = r.exp + amount;
  const max = maxLevel();
  while (lv < max && exp >= roleExp(lv)) {
    exp -= roleExp(lv);
    lv++;
  }
  r.lv = lv;
  r.exp = exp;
  return { lv, exp };
}
export function currentRole(p: Player): Role {
  return p.roles[p.last_use] ?? Object.values(p.roles)[0];
}

// ---- AP (energia): se regenera con el tiempo. El cliente calcula la regeneracion a partir de
// ap/ap_time (ms), asi que el servidor solo tiene que llevar la cuenta con la misma regla.
export const AP_REGEN_MS = 5 * 60 * 1000; // 1 AP cada 5 min
export function refreshAp(p: Player, now = Date.now()): void {
  const max = maxAp(p.lv);
  if (p.ap >= max) {
    p.ap_time = now;
    return;
  }
  const ticks = Math.floor((now - p.ap_time) / AP_REGEN_MS);
  if (ticks > 0) {
    p.ap = Math.min(max, p.ap + ticks);
    p.ap_time = p.ap >= max ? now : p.ap_time + ticks * AP_REGEN_MS;
  }
}
export function spendAp(p: Player, amount: number): boolean {
  refreshAp(p);
  if (p.ap < amount) return false;
  if (p.ap >= maxAp(p.lv)) p.ap_time = Date.now(); // empieza a regenerar desde ahora
  p.ap -= amount;
  return true;
}

// ---- recompensas: aplica una lista {id, amount} (monedas, exp, ap, objetos o equipo) al jugador
export function grant(p: Player, rewards: RewardItem[]): void {
  for (const r of rewards) {
    if (!r.amount) continue;
    if (isCoin(r.id)) addCoin(p, r.id, r.amount);
    else if (r.id === "exp") addPlayerExp(p, r.amount);
    else if (r.id === "ap") p.ap += r.amount;
    else if (r.id === "tp") p.tp += r.amount;
    else if (isEquipId(r.id)) for (let i = 0; i < r.amount; i++) addEquip(p, r.id);
    else addItem(p, r.id, r.amount);
  }
}
/** Parsea recompensas en formato de tabla: JSON [["id",n],...], [{"id","amount"}], {"id":n} o "id:n;id:n". */
export function parseRewards(text: string): RewardItem[] {
  const t = (text ?? "").trim();
  if (!t || t === "[]") return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) {
      return j.map((x) => (Array.isArray(x) ? { id: String(x[0]), amount: Number(x[1]) } : { id: String(x.id), amount: Number(x.amount) }));
    }
    if (j && typeof j === "object") return Object.entries(j).map(([id, amount]) => ({ id, amount: Number(amount) }));
  } catch {
    /* no es JSON */
  }
  return t
    .split(/[;,]/)
    .filter(Boolean)
    .map((s) => {
      const [id, n] = s.split(":");
      return { id: id.trim(), amount: Number(n ?? 1) };
    });
}

// ---- frames NoticeUpdateS2C (el cliente los acepta en cualquier momento y actualiza su estado local)
export const notice = {
  items: (p: Player, ids: string[]): Frame => s2c("NoticeUpdateS2C", { cmd: "item", list: ids.map((id) => ({ id, amount: itemCount(p, id) })) }),
  equips: (equips: Equip[]): Frame => s2c("NoticeUpdateS2C", { cmd: "equip", list: equips }),
  coin: (p: Player): Frame => s2c("NoticeUpdateS2C", { cmd: "coin", coin: p.coin }),
  player: (p: Player): Frame => s2c("NoticeUpdateS2C", { cmd: "player", lv: p.lv, exp: p.exp, ap: p.ap, ap_time: p.ap_time }),
  role: (r: Role): Frame => s2c("NoticeUpdateS2C", { cmd: "role", lv: r.lv, exp: r.exp }),
};
