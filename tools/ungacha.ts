// Regenera las tablas que hacen alcanzable TODO el equipo sin depender del gacha.
// Lee copias intactas del OBB en tools/base/ y escribe gamedata/ (el cliente recibe las
// mismas tablas en el zip de Setting: src/settings.ts -> GAMEDATA_TO_CLIENT), asi que el
// servidor y el telefono siempre ven los mismos numeros. Es idempotente: se puede volver a
// ejecutar tras tocar las constantes de abajo.
//
//   bun tools/ungacha.ts
//
// Que hace:
//  1. fragment_info: da fragmento a todo equipo visible que no lo tenia y abarata la fabricacion.
//  2. chapter_info: reparte los fragmentos por las etapas normales, uno o dos por etapa y siempre
//     garantizados, ordenados por rareza para que sigan la progresion del jugador.
//  3. Lottery_Info: apunta todos los banners a las 4 imagenes que existen en static/lottery,
//     para que la rotacion de eventos (src/handlers/shop.ts) no pida PNG que no tenemos.
//  4. tables/srt_eng.txt: nombres ingleses que faltaban (set de Navidad blanco y sus fragmentos).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASE = join(ROOT, "tools", "base");
const GAMEDATA = join(ROOT, "gamedata");

// ---- ajustes
/** Divisor de los costes de fabricacion de fragment_info (cantidad de fragmentos y oro). */
const COST_DIVISOR = 2;
/** Victorias que deberia costar sacar una pieza en su etapa: cada etapa suelta los fragmentos que hagan
 *  falta para llegar ahi. Se calcula pieza a pieza (y no por rareza) porque el requisito de la tabla no
 *  siempre casa con la rareza, y asi ninguna se dispara. A ~16 AP por etapa son una o dos barras. */
const TARGET_WINS = 8;
/** Imagen de banner por tipo de gacha (las unicas que hay en static/lottery). */
const BANNER: Record<string, string> = { Normal: "nor_0112", Virtual: "dia_0112", Choice: "sel_0112", Cosplay: "cos_1" };
/** Ranuras de equipo del personaje (role_info col 6) mas el equipo de apoyo (logistica). */
const SLOTS = ["0101", "0102", "0103", "0104", "0105", "0106"];
const SUPPORT = ["0401", "0402", "0403", "0404", "0405"];
/** Orden de reparto por las etapas: lo comun primero, lo raro al final del mapa. */
const TIER_ORDER = ["D", "C", "-", "B", "A", "S"];
/** Perfil de fragment_info por rareza para las filas nuevas: precio, reciclaje, y los 5 pares
 *  (cantidad, oro) de fabricar y subir a 2..5 estrellas. Copiado de la fila mas comun de cada rareza. */
const PROFILE: Record<string, string[]> = {
  S: ['{"1":17500,"2":10,"3":100,"4":50}', "175", "100", "35000", "10", "27000", "30", "35000", "80", "120000", "160", "225000"],
  A: ['{"1":15000,"2":8,"3":100,"4":50}', "150", "40", "6000", "10", "27000", "30", "35000", "80", "120000", "160", "225000"],
  B: ['{"1":12500,"2":6,"3":100,"4":50}', "125", "20", "3000", "10", "27000", "30", "35000", "80", "120000", "160", "225000"],
  C: ['{"1":10000,"2":4,"3":100,"4":50}', "100", "10", "1500", "10", "27000", "30", "35000", "80", "120000", "160", "225000"],
  D: ['{"1":7500,"2":2,"3":100,"4":50}', "75", "10", "1500", "10", "27000", "30", "35000", "80", "120000", "160", "225000"],
  "-": ['{"1":17500,"2":50,"3":100,"4":50}', "175", "30", "6000", "30", "27000", "40", "35000", "100", "120000", "130", "225000"],
};
/** Nombres que el CSV ingles nunca cubrio (set de Navidad blanco): id de srt -> texto. */
const NEW_NAMES: Record<string, string> = {
  "9002675": "Christmas dress (white) [eb3030][set][-]",
  "9003666": "Christmas Gloves (white) [eb3030][set][-]",
  "9005667": "Christmas boots (white) [eb3030][set][-]",
  "9006668": "Christmas hat (white) [eb3030][set][-]",
  "9302675": "Christmas dress (white) fragments",
  "9303666": "Christmas Gloves (white) fragments",
  "9305667": "Christmas boots (white) fragments",
  "9306668": "Christmas hat (white) fragments",
};

// ---- lectura/escritura conservando el formato exacto: BOM UTF-8, el salto de linea que ya
// usaba cada tabla (chapter/fragment vienen con LF, Lottery con CRLF) y sin salto final.
type Table = { bom: string; eol: string; header: string; rows: string[][] };
function load(name: string, dir = BASE): Table {
  const raw = readFileSync(join(dir, name), "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const lines = (bom ? raw.slice(1) : raw).split(/\r?\n/).filter((l) => l !== "");
  return { bom, eol: raw.includes("\r\n") ? "\r\n" : "\n", header: lines[0], rows: lines.slice(1).map((l) => l.split("\t")) };
}
function save(t: Table, name: string, dir = GAMEDATA): void {
  writeFileSync(join(dir, name), t.bom + [t.header, ...t.rows.map((r) => r.join("\t"))].join(t.eol), "utf8");
}
const cell = (r: string[], i: number) => (r[i] ?? "").trim();
const half = (v: string) => {
  const n = Number(v.trim());
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? String(Math.max(1, Math.round(n / COST_DIVISOR))) : v;
};

// ---- equipo objetivo: visible (col 16 = oculto) y de una ranura real del personaje
// equip_info: 0 id · 1 nombre (srt) · 16 oculto · 31 origen · 32 rareza mostrada
const equip = load("equip_info.txt", GAMEDATA); // no lo tocamos, se lee tal cual
const rarityOf = (r: string[]) => cell(r, 32).toUpperCase() || "-";
const targets = equip.rows.filter((r) => cell(r, 16) === "0" && [...SLOTS, ...SUPPORT].includes(r[0].slice(0, 4)));

// ---- 1. fragment_info: fragmento para todos + fabricacion mas barata
// fragment_info: 0 id · 1 nombre · 2 descripcion · 3 equipo · 4 precio · 5 reciclaje · 6..15 costes · 16 origen
const frag = load("fragment_info.txt");
const fragOfEquip = new Map(frag.rows.filter((r) => cell(r, 3)).map((r) => [cell(r, 3), r]));
const usedFragIds = new Set(frag.rows.map((r) => r[0]));
const columns = frag.header.split("\t").length;
let added = 0;
for (const e of targets) {
  if (fragOfEquip.has(e[0])) continue;
  const id = "05" + e[0].slice(2); // 0103666 -> 0503666 (regla de las 513 filas que ya existen)
  if (usedFragIds.has(id)) throw new Error(`el id de fragmento ${id} para ${e[0]} ya esta en uso`);
  const name = String(Number(cell(e, 1)) + 300000); // nombre del fragmento = nombre del equipo + 300000
  if (!Number.isFinite(Number(cell(e, 1)))) throw new Error(`${e[0]} no tiene id de nombre numerico`);
  const p = PROFILE[rarityOf(e)] ?? PROFILE.S;
  const row = [id, name, "9150001", e[0], ...p, "drop"];
  while (row.length < columns) row.push("");
  frag.rows.push(row);
  usedFragIds.add(id);
  fragOfEquip.set(e[0], row);
  added++;
}
for (const r of frag.rows) for (let i = 6; i <= 15; i++) if (r[i] !== undefined) r[i] = half(r[i]);
save(frag, "fragment_info.txt");
console.log(`fragment_info: ${frag.rows.length} filas (${added} nuevas), costes de fabricacion /${COST_DIVISOR}`);

// ---- 2. chapter_info: cada etapa normal suelta el fragmento que le toca, siempre
// chapter_info: 0 id (TT CC SS M) · 8 recompensa JSON {"probabilidad‰": {"id": {"amount": n}}} · 16 nivel
const chapter = load("chapter_info.txt");
const stages = chapter.rows
  .filter((r) => /^10\d{5}$/.test(r[0]))
  .sort((a, b) => Number(cell(a, 16)) - Number(cell(b, 16)) || Number(a[0]) - Number(b[0]));
const spread = [...targets].sort(
  (a, b) => TIER_ORDER.indexOf(rarityOf(a)) - TIER_ORDER.indexOf(rarityOf(b)) || Number(a[0]) - Number(b[0]),
);
const assigned = new Map<string, string[][]>(); // id de etapa -> equipos que suelta
spread.forEach((e, i) => {
  const stage = stages[Math.floor((i * stages.length) / spread.length)];
  if (!assigned.has(stage[0])) assigned.set(stage[0], []);
  assigned.get(stage[0])!.push(e);
});
for (const s of stages) {
  const list = assigned.get(s[0]);
  if (!list) continue;
  const reward = JSON.parse(cell(s, 8) || "{}") as Record<string, Record<string, unknown>>;
  const always = (reward["1000"] ??= {});
  for (const e of list) {
    const f = fragOfEquip.get(e[0])!;
    always[f[0]] = { amount: Math.max(1, Math.round(Number(cell(f, 6)) / TARGET_WINS)) };
  }
  s[8] = JSON.stringify(reward);
}
save(chapter, "chapter_info.txt");
const stagesUsed = assigned.size;
console.log(`chapter_info: ${spread.length} equipos repartidos por ${stagesUsed} de ${stages.length} etapas normales`);

// ---- 3. Lottery_Info: banners que existen (la rotacion de eventos usa todas las filas)
// Lottery_Info: 0 tipo · 1 id de evento · 2 imagen · 3 texto · 4 pool de 1 tirada · 5 pool de 10
const lottery = load("Lottery_Info.txt");
let repointed = 0;
for (const r of lottery.rows) {
  const img = BANNER[cell(r, 0)];
  if (img && r[2] !== img) {
    r[2] = img;
    repointed++;
  }
}
save(lottery, "Lottery_Info.txt");
console.log(`Lottery_Info: ${repointed} banners apuntados a las imagenes de static/lottery`);

// ---- 4. tables/srt_eng.txt: nombres que faltaban (se añaden solo si no estan)
const srtPath = join(ROOT, "tables", "srt_eng.txt");
const srt = readFileSync(srtPath, "utf8");
const have = new Set(srt.split(/\r?\n/).map((l) => l.split("\t")[0]));
const missing = Object.entries(NEW_NAMES).filter(([id]) => !have.has(id));
if (missing.length) {
  const eol = srt.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(srtPath, srt.replace(/[\r\n]+$/, "") + eol + missing.map(([id, text]) => `${id}\t${text}`).join(eol), "utf8");
}
console.log(`srt_eng: ${missing.length} nombres añadidos`);
