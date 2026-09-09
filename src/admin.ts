// Panel de control: API JSON bajo /admin/api/* protegida con ADMIN_TOKEN (server.env) y la pagina /admin.
// Permite editar la configuracion en caliente, las noticias, los codigos de canje, ver jugadores y cuentas,
// ajustar monedas/objetos, mandar regalos por correo y leer el log reciente.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, updateConfig, normalizeRewards, type ServerConfig } from "./config.ts";
import { listAccounts, accountCount } from "./accounts.ts";
import { loadPlayer, savePlayer, listPlayers, type Player } from "./players.ts";
import { grant, isEquipId } from "./economy.ts";
import { table } from "./gamedata.ts";
import { sendMail } from "./handlers/missions.ts";
import { recentLog, log } from "./logbuf.ts";
import { sessionCount } from "./socket.ts";
import { ADMIN_HTML } from "./admin-ui.ts";

const TOKEN = process.env.ADMIN_TOKEN || "";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

type Ctx = { startedAt: Date };

export async function handleAdmin(path: string, req: Request, ctx: Ctx): Promise<Response> {
  if (path === "/admin" || path === "/admin/") {
    return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (!path.startsWith("/admin/api/")) return fail("not found", 404);
  if (!TOKEN) return fail("Panel desactivado: define ADMIN_TOKEN en server.env (lena env push)", 503);
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${TOKEN}`) return fail("token invalido", 401);

  const route = path.slice("/admin/api/".length);
  const body = async () => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      throw new Error("cuerpo JSON invalido");
    }
  };

  try {
    if (route === "status" && req.method === "GET") {
      return json({
        startedAt: ctx.startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
        accounts: accountCount(),
        sessions: sessionCount(),
        players: listPlayers().length,
        config: config(),
      });
    }
    if (route === "config") {
      if (req.method === "GET") return json(config());
      if (req.method === "PUT") {
        const patch = (await body()) as Partial<ServerConfig>;
        const c = updateConfig(patch);
        log("admin: configuracion actualizada", Object.keys(patch).join(","));
        return json(c);
      }
    }
    if (route === "log" && req.method === "GET") {
      const n = Number(new URL(req.url).searchParams.get("n") ?? 200);
      return json({ lines: recentLog(Math.min(500, Math.max(1, n))) });
    }
    if (route === "accounts" && req.method === "GET") {
      return json(listAccounts().map((a) => ({ acc: a.acc, type: a.type, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt ?? null })));
    }
    if (route === "items" && req.method === "GET") {
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const all = itemCatalog();
      const hits = q ? all.filter((i) => i.id.includes(q) || i.name.toLowerCase().includes(q)) : all;
      return json(hits.slice(0, 60));
    }
    if (route === "players" && req.method === "GET") {
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const logins = new Map(listAccounts().map((a) => [a.acc, a.lastLoginAt ?? null]));
      const out = listPlayers()
        .filter((p) => !q || p.acc.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .map((p) => summary(p, logins.get(p.acc) ?? null));
      return json(out);
    }
    const pm = /^players\/([^/]+)(?:\/(items|mail))?$/.exec(route);
    if (pm) {
      const acc = decodeURIComponent(pm[1]);
      const p = loadPlayer(acc);
      if (!p) return fail("jugador no encontrado", 404);
      if (!pm[2] && req.method === "GET") return json(p);
      if (!pm[2] && req.method === "PATCH") {
        const b = await body();
        applyPlayerPatch(p, b);
        savePlayer(p);
        log("admin: jugador editado", acc, JSON.stringify(b).slice(0, 200));
        return json(summary(p, null));
      }
      if (pm[2] === "items" && req.method === "POST") {
        const rewards = normalizeRewards((await body()).rewards);
        grant(p, rewards);
        savePlayer(p);
        log("admin: objetos entregados a", acc, JSON.stringify(rewards));
        return json({ ok: true, coin: p.coin, items: p.items, equips: p.equips.length });
      }
      if (pm[2] === "mail" && req.method === "POST") {
        const b = await body();
        const n = giftMail([p], b);
        return json({ ok: true, sent: n });
      }
    }
    if (route === "gift" && req.method === "POST") {
      const b = await body();
      const to = b.to;
      let targets: Player[];
      if (to === "all") targets = listPlayers();
      else if (Array.isArray(to)) targets = to.map((a) => loadPlayer(String(a))).filter((p): p is Player => !!p);
      else return fail("to debe ser \"all\" o una lista de cuentas");
      const n = giftMail(targets, b);
      return json({ ok: true, sent: n });
    }
    return fail("ruta desconocida", 404);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function summary(p: Player, lastLoginAt: string | null) {
  return {
    acc: p.acc, name: p.name, lv: p.lv, exp: p.exp, vip: p.vip, coin: p.coin, ap: p.ap, tp: p.tp,
    roles: Object.keys(p.roles).length, equips: p.equips.length, items: Object.keys(p.items).length,
    ch_progress: p.ch_progress, pvp_rank: p.pvp_rank, teaching_flag: p.teaching_flag, createdAt: p.createdAt, lastLoginAt,
  };
}

/** Campos editables del jugador desde el panel. */
function applyPlayerPatch(p: Player, b: Record<string, unknown>): void {
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n || n.length > 12) throw new Error("nombre: 1-12 caracteres");
    p.name = n;
  }
  if (Array.isArray(b.coin)) {
    if (b.coin.length !== 4) throw new Error("coin debe tener 4 valores [gcoin, vcoin, pcoin, ecoin]");
    p.coin = b.coin.map((c) => clampInt(c, 0, 99_999_999));
  }
  for (const k of ["vip", "ap", "tp", "lv", "teaching_flag"] as const) {
    if (b[k] !== undefined) p[k] = clampInt(b[k], 0, k === "lv" ? 999 : 999_999);
  }
  if (b.ch_progress !== undefined) p.ch_progress = String(b.ch_progress).replace(/\D/g, "").slice(0, 8);
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new Error("valor numerico invalido");
  return Math.max(min, Math.min(max, n));
}

function giftMail(targets: Player[], b: Record<string, unknown>): number {
  const title = String(b.title ?? "").trim();
  const content = String(b.content ?? "").trim();
  if (!title) throw new Error("falta el titulo");
  const sender = String(b.sender ?? "Boxing Angel").trim() || "Boxing Angel";
  const annex = b.annex ? normalizeRewards(b.annex) : [];
  const ttlDays = b.ttlDays !== undefined ? clampInt(b.ttlDays, 1, 365) : 30;
  for (const p of targets) {
    sendMail(p, { sender, title, content, annex, ttlMs: ttlDays * 86_400_000 });
    savePlayer(p);
  }
  log(`admin: regalo "${title}" enviado a ${targets.length} jugador(es)`, JSON.stringify(annex));
  return targets.length;
}

// ---- catalogo de objetos para el buscador de regalos: id + nombre en ingles (srt_eng) + tipo
type CatalogItem = { id: string; name: string; kind: "coin" | "item" | "equip" | "fragment" };
let catalog: CatalogItem[] | null = null;
function itemCatalog(): CatalogItem[] {
  if (catalog) return catalog;
  const names = new Map<string, string>();
  const srt = join(import.meta.dir, "..", "tables", "srt_eng.txt");
  if (existsSync(srt)) {
    for (const l of readFileSync(srt, "utf8").split(/\r?\n/).slice(1)) {
      const [k, v] = l.split("\t");
      if (k && v) names.set(k.trim(), v.trim());
    }
  }
  const nameOf = (key: string, fallback: string) => names.get(key) ?? fallback;
  const row = (kind: CatalogItem["kind"]) => (f: string[]): CatalogItem => ({ id: f[0], name: nameOf(f[1], f[1]), kind });
  const coins: CatalogItem[] = [
    { id: "gcoin", name: "Gold", kind: "coin" },
    { id: "vcoin", name: "Diamonds", kind: "coin" },
    { id: "pcoin", name: "PvP coins", kind: "coin" },
    { id: "ecoin", name: "Elite coins", kind: "coin" },
  ];
  const list: CatalogItem[] = [
    ...coins,
    ...table("item_info.txt").map(row("item")),
    ...table("equip_info.txt").map(row("equip")),
    ...table("fragment_info.txt").map(row("fragment")),
  ].filter((i) => /^[A-Za-z0-9_]+$/.test(i.id));
  // sanity: los ids de equipo deben coincidir con economy.isEquipId
  const fixed: CatalogItem[] = list.map((i): CatalogItem => (i.kind === "item" && isEquipId(i.id) ? { id: i.id, name: i.name, kind: "equip" } : i));
  catalog = fixed;
  return fixed;
}
