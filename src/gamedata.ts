// Tablas del juego que el servidor necesita conocer (copiadas del OBB a gamedata/).
// Formato: texto tabulado con cabecera (mismo parser que CSDatabase.ParseTextData).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "gamedata");

function rows(name: string): string[][] {
  const text = readFileSync(join(DIR, name), "utf8").replace(/^﻿/, "");
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(1)
    .map((l) => l.split("\t"));
}

/** Filas de una tabla del juego (sin la cabecera), campos separados por TAB. Cacheado. */
const tableCache = new Map<string, string[][]>();
export function table(name: string): string[][] {
  let t = tableCache.get(name);
  if (!t) {
    t = rows(name);
    tableCache.set(name, t);
  }
  return t;
}

/** Filas indexadas por el primer campo (id). */
const indexCache = new Map<string, Map<string, string[]>>();
export function tableById(name: string): Map<string, string[]> {
  let m = indexCache.get(name);
  if (!m) {
    m = new Map(table(name).map((f) => [f[0], f]));
    indexCache.set(name, m);
  }
  return m;
}

export type RoleInfo = { id: string; nameKey: string; unlockLevel: number; price: number; defaultEquip: string[]; skills: string[] };

let roles: Map<string, RoleInfo> | null = null;
let chapters: string[] | null = null;

/** role_info: 0 id, 1 nombre, 2 props base, 3 crecimiento, 4 nivel desbloqueo, 5 precio (vcoin), 6 equipo inicial (JSON array de 6),
 *  11/12 habilidades propias del rol (el cliente las da por aprendidas al comprarlo: CSDataCenter.SetDataWithBuyRoleResult) */
export function roleTable(): Map<string, RoleInfo> {
  if (!roles) {
    roles = new Map();
    for (const f of rows("role_info.txt")) {
      let eq: string[] = ["", "", "", "", "", ""];
      try {
        const parsed = JSON.parse(f[6] || "[]");
        if (Array.isArray(parsed)) eq = parsed.map((x) => String(x ?? ""));
      } catch {
        /* sin equipo inicial */
      }
      const skills = [f[11], f[12]].map((s) => (s ?? "").trim()).filter((s) => s !== "");
      roles.set(f[0], { id: f[0], nameKey: f[1], unlockLevel: Number(f[4] || 0), price: Number(f[5] || 0), defaultEquip: eq, skills });
    }
  }
  return roles;
}

/** chapter_info: 0 id (el resto no se necesita todavia) */
export function chapterIds(): string[] {
  if (!chapters) chapters = rows("chapter_info.txt").map((f) => f[0]).filter((id) => /^\d+$/.test(id));
  return chapters;
}
