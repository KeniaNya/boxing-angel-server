// Garantia del servidor comunitario: cualquier pieza que un jugador pueda llevar se consigue jugando,
// sin esperar a que su banner de gacha este activo. Las tablas las regenera tools/ungacha.ts; si una
// edicion futura vuelve a dejar algo encerrado (como los 242 objetos de evento que solo salian en
// banners de 2017), estas pruebas lo cazan.

import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { table } from "../gamedata.ts";
import { playerEquip, fragmentOfEquip, storeCandidates, wishIntervals, gachaEvent, STORE, GACHA_ROTATION_MS } from "./shop.ts";

/** Ids que suelta alguna etapa: chapter_info col 8 (recompensa) y col 22 (planos), agrupados por probabilidad. */
function stageDrops(): Set<string> {
  const out = new Set<string>();
  for (const f of table("chapter_info.txt")) {
    for (const col of [8, 22]) {
      const text = (f[col] ?? "").trim();
      if (!text || text === "{}") continue;
      for (const group of Object.values(JSON.parse(text) as Record<string, Record<string, unknown>>)) {
        for (const id of Object.keys(group ?? {})) out.add(id);
      }
    }
  }
  return out;
}

test("todo el equipo que se puede llevar tiene fragmento con el que fabricarlo", () => {
  expect(playerEquip().filter((e) => !fragmentOfEquip(e[0])).map((e) => e[0])).toEqual([]);
  expect(playerEquip().length).toBeGreaterThan(400);
});

test("cada pieza tiene una etapa que suelta su fragmento", () => {
  const drops = stageDrops();
  expect(playerEquip().filter((e) => !drops.has(fragmentOfEquip(e[0])!.id)).map((e) => e[0])).toEqual([]);
});

test("las tres tiendas pueden sacar el fragmento de cualquier pieza", () => {
  for (const store of [STORE.NORMAL, STORE.PVP, STORE.ELITE]) {
    const enVenta = new Set(storeCandidates(store).map((c) => c.id));
    const fuera = playerEquip().filter((e) => !enVenta.has(fragmentOfEquip(e[0])!.id)).map((e) => e[0]);
    expect({ store, fuera }).toEqual({ store, fuera: [] });
  }
});

test("cada tramo del pozo de deseos lleva toda su rareza, no solo los primeros doce", () => {
  const tramos = wishIntervals();
  const deRareza = (r: string) => playerEquip().filter((e) => (e[32] ?? "").trim().toUpperCase() === r).map((e) => e[0]);
  for (const [threshold, rare] of [["10", "C"], ["30", "B"], ["60", "A"], ["100", "S"]]) {
    expect({ threshold, ids: [...(tramos[threshold] ?? [])].sort() }).toEqual({ threshold, ids: deRareza(rare).sort() });
  }
  // el tramo S era el roto: el corte a 12 lo dejaba en guantes y nada mas
  expect(new Set((tramos["100"] ?? []).map((id) => id.slice(0, 4))).size).toBeGreaterThan(1);
});

test("la rotacion de banners recorre todos los eventos de cada gacha", () => {
  const filas = (tipo: string) => table("Lottery_Info.txt").filter((f) => f[0] === tipo).length;
  for (const [tipo, type] of [["Virtual", 2], ["Choice", 3]] as const) {
    const vistos = new Set<string>();
    for (let i = 0; i < filas(tipo) * 2; i++) vistos.add(gachaEvent(type, i * GACHA_ROTATION_MS));
    expect({ tipo, vistos: vistos.size }).toEqual({ tipo, vistos: filas(tipo) });
  }
});

test("todos los banners apuntan a una imagen que existe en static/lottery", () => {
  const disponibles = new Set(readdirSync(join(import.meta.dir, "..", "..", "static", "lottery")).map((f) => f.replace(/\.png$/, "")));
  expect(table("Lottery_Info.txt").filter((f) => !disponibles.has((f[2] ?? "").trim())).map((f) => `${f[1]} -> ${f[2]}`)).toEqual([]);
});
