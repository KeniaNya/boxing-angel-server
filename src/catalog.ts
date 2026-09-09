// Catalogo legible del juego para el panel: objetos, equipo, fragmentos, capitulos, misiones y personajes
// con sus nombres en ingles (tables/srt_eng.txt) y una descripcion corta de lo que significan los ids.
// Indices de columna tomados de CSDatabase.cs del cliente decompilado.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { table } from "./gamedata.ts";
import { parseRewards, type RewardItem } from "./economy.ts";

export type Entry = { id: string; name: string; kind: string; desc: string; extra: string };

let names: Map<string, string> | null = null;
/** Texto en ingles de una clave srt (9xxxxxx); si no existe devuelve la clave. */
export function srt(key: string): string {
  if (!names) {
    names = new Map();
    const f = join(import.meta.dir, "..", "tables", "srt_eng.txt");
    if (existsSync(f)) {
      for (const l of readFileSync(f, "utf8").split(/\r?\n/).slice(1)) {
        const [k, v] = l.split("\t");
        if (k && v) names.set(k.trim(), v.trim().replace(/\\n/g, " "));
      }
    }
  }
  return names.get(key) ?? key;
}

export const CHAPTER_TYPES: Record<string, string> = {
  "10": "Story map", "15": "Tour (outside match)", "16": "Special league", "18": "NPC", "19": "PvP",
  "31": "Elite battle", "32": "Dream", "80": "Assassin",
};
const EFFECTS = ["none", "Gym EXP", "Role EXP", "Gold", "Diamonds (sell)", "Activity", "Component", "Blueprint", "Skip ticket", "VIP day(s)", "Training points", "Gift bag", "Gacha ticket", "VIP month", "VIP week"];
const SLOTS: Record<string, string> = { "0101": "Hair", "0102": "Bikini", "0103": "Gloves", "0104": "Waist", "0105": "Shoes", "0106": "Accessory", "0107": "Headgear" };
const MISSION_TYPES = ["", "Buy character", "Clear story stage", "Clear elite stage", "Upgrade equipment quality", "Collect equipment", "Manufacture", "Gym level", "NPC", "Spend/earn gold", "Gacha pull", "Skill upgrade", "Claim energy (time slot)", "Monthly", "Clear story+elite", "Clear story (no ticket)", "Clear elite (no ticket)", "Clear tour stage", "Clear special league", "PvP battle", "Elite battle"];
const COIN_NAMES: Record<string, string> = { gcoin: "Gold", vcoin: "Diamonds", pcoin: "PvP coins", ecoin: "Elite coins", exp: "Gym EXP", ap: "Energy", tp: "Training points" };

const cache = new Map<string, Entry[]>();

function jsonSafe(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Lista de recompensas en texto: "Gold ×100, Jab Fiber ×2". Acepta los formatos de las tablas. */
export function rewardsText(text: string | RewardItem[]): string {
  const list = typeof text === "string" ? parseRewards(text) : text;
  return list.map((r) => `${nameOf(r.id)} ×${r.amount}`).join(", ");
}

/** Nombre legible de cualquier id (moneda, objeto, equipo, fragmento, capitulo, mision, personaje). */
export function nameOf(id: string): string {
  if (COIN_NAMES[id]) return COIN_NAMES[id];
  return dictionary().get(id) ?? id;
}

let dict: Map<string, string> | null = null;
export function dictionary(): Map<string, string> {
  if (!dict) {
    dict = new Map();
    for (const k of ["item", "equip", "fragment", "chapter", "mission", "role"]) for (const e of catalog(k)) dict.set(e.id, e.name);
    for (const [k, v] of Object.entries(COIN_NAMES)) dict.set(k, v);
  }
  return dict;
}

export const KINDS = ["item", "equip", "fragment", "chapter", "mission", "role"] as const;

/** Entradas de un tipo de catalogo (cacheado). */
export function catalog(kind: string): Entry[] {
  const c = cache.get(kind);
  if (c) return c;
  let out: Entry[] = [];
  switch (kind) {
    case "item":
      // item_info: 0 id, 1 nombre, 2 descripcion, 3 efecto {"code":{"k":v}}, 4 precio compra, 5 precio venta
      out = table("item_info.txt").map((f) => {
        const eff = jsonSafe(f[3] ?? "") as Record<string, Record<string, number>> | null;
        const code = eff ? Number(Object.keys(eff)[0]) : 0;
        const val = eff ? Object.values(Object.values(eff)[0] ?? {})[0] : undefined;
        return { id: f[0], name: srt(f[1]), kind, desc: srt(f[2] ?? ""), extra: `${EFFECTS[code] ?? "effect " + code}${val !== undefined ? " " + val : ""} · sells for ${f[5] || 0} gold` };
      });
      break;
    case "equip":
      // equip_info: 0 id, 1 nombre, 7 precio venta, 9 descripcion, 10 nivel, 32 rareza
      out = table("equip_info.txt").map((f) => ({ id: f[0], name: srt(f[1]), kind, desc: srt(f[9] ?? ""), extra: `${SLOTS[f[0].slice(0, 4)] ?? "equip"} · rank ${f[32] || "?"} · lv ${f[10] || 1} · sells for ${f[7] || 0} gold` }));
      break;
    case "fragment":
      // fragment_info: 0 id, 1 nombre, 2 descripcion, 3 equipo que forma, 6 cantidad necesaria
      out = table("fragment_info.txt").map((f) => ({ id: f[0], name: srt(f[1]), kind, desc: srt(f[2] ?? ""), extra: `${f[6] || "?"} pieces make ${srtEquip(f[3])}` }));
      break;
    case "chapter":
      // chapter_info: 0 id (TTCCSSM: tipo, capitulo, seccion, modo), 1 nombre, 3 exp gimnasio, 4 exp rol, 5 AP, 6 AP al perder, 8 recompensas
      out = table("chapter_info.txt")
        .filter((f) => /^\d{7}$/.test(f[0]))
        .map((f) => {
          const t = f[0].slice(0, 2);
          const rewards = chapterRewards(f[8] ?? "");
          return {
            id: f[0], name: srt(f[1]), kind,
            desc: `${CHAPTER_TYPES[t] ?? "type " + t} · chapter ${Number(f[0].slice(2, 4))} · stage ${Number(f[0].slice(4, 6))}${f[0][6] !== "0" ? " · mode " + f[0][6] : ""}`,
            extra: `AP ${f[5] || 0} (lose ${f[6] || 0}) · gym EXP ${f[3] || 0} · role EXP ${f[4] || 0}${rewards ? " · drops: " + rewards : ""}`,
          };
        });
      break;
    case "mission":
      // mission_info: 0 id, 1 nombre, 2 descripcion, 3 ciclo (1 logro, 2 diaria), 4 tipo, 5 objetivo, 6 cantidad, 7 recompensa, 8 mision previa
      out = table("mission_info.txt")
        .filter((f) => f.length >= 8 && /^\d{7}$/.test(f[0]))
        .map((f) => ({
          id: f[0], name: srt(f[1]), kind, desc: srt(f[2]),
          extra: `${f[3] === "2" ? "daily" : "achievement"} · ${MISSION_TYPES[Number(f[4])] ?? "type " + f[4]}${f[5] && f[5] !== "0" ? " (" + nameOfChapterOrRaw(f[5]) + ")" : ""} ×${f[6]} · reward: ${rewardsText(f[7] ?? "")}${f[8] ? " · after " + f[8] : ""}`,
        }));
      break;
    case "role":
      // role_info: 0 id, 1 nombre, 4 nivel de desbloqueo, 5 precio (diamantes), 10 nombre interno, 13 edad
      out = table("role_info.txt").map((f) => ({ id: f[0], name: srt(f[1]), kind, desc: `${f[10] || ""} · age ${f[13] || "?"}`, extra: Number(f[5]) > 0 ? `unlock at gym lv ${f[4]} · ${f[5]} diamonds` : "starter character" }));
      break;
    default:
      out = [];
  }
  cache.set(kind, out);
  return out;
}

function srtEquip(id: string): string {
  const e = catalog("equip").find((x) => x.id === id);
  return e ? `${e.name} (${id})` : id;
}
function nameOfChapterOrRaw(v: string): string {
  const ch = catalog("chapter").find((x) => x.id === v);
  return ch ? `${ch.name} ${v}` : v;
}
/** Recompensas de capitulo: {"1000":{"0511007":{"base":3,"amount":2}}, "150":{...}} (clave = probabilidad en ‰). */
function chapterRewards(text: string): string {
  const j = jsonSafe(text) as Record<string, Record<string, { amount?: number }>> | null;
  if (!j) return "";
  const parts: string[] = [];
  for (const [prob, items] of Object.entries(j)) {
    for (const [id, v] of Object.entries(items ?? {})) parts.push(`${nameOf(id)} ×${v?.amount ?? 1}${Number(prob) >= 1000 ? "" : ` (${Number(prob) / 10}%)`}`);
  }
  return parts.join(", ");
}

// ---- capitulos especiales abiertos (GetTodayOpenChapter): codigos "TTCC" = tipo (15 tour / 16 liga especial) + capitulo
export type OpenChapterOption = { code: string; name: string; type: string };
export function openChapterOptions(): OpenChapterOption[] {
  const seen = new Map<string, OpenChapterOption>();
  for (const e of catalog("chapter")) {
    const t = e.id.slice(0, 2);
    if (t !== "15" && t !== "16") continue;
    const code = e.id.slice(0, 4);
    if (!seen.has(code)) seen.set(code, { code, name: e.name.replace(/\s*I+$/, ""), type: CHAPTER_TYPES[t] });
  }
  return [...seen.values()];
}
/** week_open_chapter_info: 0 dia de la semana (1 lunes … 7 domingo), 1 codigo abierto ese dia */
export function weekSchedule(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of table("week_open_chapter_info.txt")) {
    if (!/^\d$/.test(f[0]) || !/^\d{4}$/.test(f[1] ?? "")) continue;
    (out[f[0]] ??= []).push(f[1]);
  }
  return out;
}
/** Codigos abiertos hoy segun la tabla semanal (lunes = 1). */
export function todayOpenChapters(now = new Date()): string[] {
  const day = now.getDay() === 0 ? "7" : String(now.getDay());
  return weekSchedule()[day] ?? [];
}
