// "¿De donde sale esto?" — todas las rutas de una pieza de equipo, para responder a los jugadores.
//
//   bun tools/where.ts 0103066          (por id de equipo)
//   bun tools/where.ts Christmas        (por nombre, busca en tables/srt_eng.txt)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { table } from "../src/gamedata.ts";
import { fragmentOfEquip, playerEquip, wishIntervals } from "../src/handlers/shop.ts";

const query = process.argv[2];
if (!query) {
  console.error("uso: bun tools/where.ts <id de equipo | trozo del nombre>");
  process.exit(1);
}

const srt = new Map<string, string>();
for (const line of readFileSync(join(import.meta.dir, "..", "tables", "srt_eng.txt"), "utf8").split(/\r?\n/)) {
  const [id, text] = line.split("\t");
  if (id && text) srt.set(id, text);
}
const nameOf = (equip: string[]) => srt.get((equip[1] ?? "").trim()) ?? `(sin nombre: ${equip[1]})`;

const matches = playerEquip().filter((e) => e[0] === query || nameOf(e).toLowerCase().includes(query.toLowerCase()));
if (!matches.length) {
  console.error(`nada coincide con "${query}"`);
  process.exit(1);
}

const tramos = Object.entries(wishIntervals());
for (const e of matches.slice(0, 10)) {
  const frag = fragmentOfEquip(e[0]);
  console.log(`\n${nameOf(e)}  ·  ${e[0]}  ·  rareza ${(e[32] ?? "-").trim() || "-"}`);
  if (!frag) {
    console.log("  sin fragmento");
    continue;
  }
  const row = table("fragment_info.txt").find((f) => f[0] === frag.id)!;
  console.log(`  fabricar: ${row[6]} fragmentos + ${row[7]} oro  (fragmento ${frag.id}, ${srt.get(row[1]) ?? row[1]})`);

  // etapas que lo sueltan
  for (const c of table("chapter_info.txt")) {
    const text = (c[8] ?? "").trim();
    if (!text.includes(frag.id)) continue;
    const groups = JSON.parse(text) as Record<string, Record<string, { amount?: number }>>;
    for (const [prob, entries] of Object.entries(groups)) {
      const hit = entries?.[frag.id];
      if (!hit) continue;
      const chapter = `${Number(c[0].slice(2, 4))}-${Number(c[0].slice(4, 6))}`;
      const chance = Number(prob) >= 1000 ? "siempre" : `${Number(prob) / 10} %`;
      console.log(`  etapa ${chapter} (${c[0]}, nivel ${c[16] || 0}): ${hit.amount} por victoria, ${chance}`);
    }
  }

  // tienda, pozo de deseos y banners
  console.log(`  tiendas: normal (oro/diamantes), PvP y elite venden el fragmento cuando rota al stock`);
  const tramo = tramos.find(([, ids]) => ids.includes(e[0]));
  if (tramo) console.log(`  pozo de deseos: tramo de ${tramo[0]} puntos (1 entre ${tramo[1].length})`);
  const banners = table("Lottery_Info.txt").filter((f) => `${f[4]},${f[5]}`.includes(e[0])).map((f) => `${f[0]}/${f[1]}`);
  if (banners.length) console.log(`  gacha: sale en el banner ${banners.join(", ")} cuando le toca rotar`);
}
