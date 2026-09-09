// Panel de control: API JSON bajo /admin/api/* protegida con ADMIN_TOKEN (server.env) y la pagina /admin.
// Permite editar la configuracion en caliente, las noticias, los codigos de canje, ver jugadores y cuentas,
// ajustar monedas/objetos, mandar regalos por correo y leer el log reciente.

import { config, updateConfig, normalizeRewards, type ServerConfig } from "./config.ts";
import { catalog, dictionary, nameOf, openChapterOptions, weekSchedule, todayOpenChapters, KINDS } from "./catalog.ts";
import { listAccounts, accountCount, deleteAccount } from "./accounts.ts";
import { loadPlayer, savePlayer, listPlayers, deletePlayer, type Player } from "./players.ts";
import { grant } from "./economy.ts";
import { sendMail } from "./handlers/missions.ts";
import { recentLog, log } from "./logbuf.ts";
import { sessionCount, closeSessionsOf } from "./socket.ts";
import { listFiles, appendChunk, setDescription, deleteFile, NAME_RE } from "./files.ts";
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
      // buscador de recompensas (monedas + objetos + equipo + fragmentos) por nombre o id
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const all = [...COINS, ...catalog("item"), ...catalog("equip"), ...catalog("fragment")];
      const hits = q ? all.filter((i) => i.id.includes(q) || i.name.toLowerCase().includes(q)) : all;
      return json(hits.slice(0, 60).map((i) => ({ id: i.id, name: i.name, kind: i.kind })));
    }
    const cm = /^catalog\/([a-z]+)$/.exec(route);
    if (cm && req.method === "GET") {
      if (!(KINDS as readonly string[]).includes(cm[1])) return fail("tipo de catalogo desconocido", 404);
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const all = catalog(cm[1]);
      return json(q ? all.filter((e) => [e.id, e.name, e.desc, e.extra].some((t) => t.toLowerCase().includes(q))) : all);
    }
    if (route === "dictionary" && req.method === "GET") return json(Object.fromEntries(dictionary()));
    if (route === "openchapters" && req.method === "GET") {
      return json({ options: openChapterOptions(), schedule: weekSchedule(), today: todayOpenChapters(), configured: config().openChapters });
    }
    if (route === "players" && req.method === "GET") {
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const logins = new Map(listAccounts().map((a) => [a.acc, a.lastLoginAt ?? null]));
      const out = listPlayers()
        .filter((p) => !q || p.acc.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .map((p) => summary(p, logins.get(p.acc) ?? null));
      return json(out);
    }
    if (route === "files" && req.method === "GET") return json(listFiles());
    const fm = /^files\/([^/]+)$/.exec(route);
    if (fm) {
      const name = decodeURIComponent(fm[1]);
      if (!NAME_RE.test(name)) return fail("nombre de archivo invalido (letras, numeros, . _ -)");
      const q = new URL(req.url).searchParams;
      if (req.method === "PUT") {
        // subida por trozos: ?first=1 en el primero, ?last=1 en el ultimo (cuerpo binario, <= 90 MB por peticion)
        const data = new Uint8Array(await req.arrayBuffer());
        const info = appendChunk(name, data, q.get("first") === "1", q.get("last") === "1");
        if (q.get("last") === "1") log("admin: archivo publicado", name, info.size, "bytes", info.sha256);
        return json(info);
      }
      if (req.method === "PATCH") {
        setDescription(name, String((await body()).description ?? ""));
        return json({ ok: true });
      }
      if (req.method === "DELETE") {
        if (!deleteFile(name)) return fail("archivo no encontrado", 404);
        log("admin: archivo borrado", name);
        return json({ ok: true });
      }
    }
    const am = /^accounts\/([^/]+)$/.exec(route);
    if (am && req.method === "DELETE") {
      const acc = decodeURIComponent(am[1]);
      const kicked = closeSessionsOf(acc);
      const hadPlayer = deletePlayer(acc);
      const ok = deleteAccount(acc);
      if (!ok && !hadPlayer) return fail("cuenta no encontrada", 404);
      log("admin: cuenta borrada", acc, `(personaje: ${hadPlayer}, sesiones cerradas: ${kicked})`);
      return json({ ok: true, account: ok, player: hadPlayer, sessions: kicked });
    }
    const pm = /^players\/([^/]+)(?:\/(items|mail|inventory))?$/.exec(route);
    if (pm) {
      const acc = decodeURIComponent(pm[1]);
      if (!pm[2] && req.method === "DELETE") {
        const kicked = closeSessionsOf(acc);
        if (!deletePlayer(acc)) return fail("jugador no encontrado", 404);
        log("admin: personaje borrado", acc, `(sesiones cerradas: ${kicked})`);
        return json({ ok: true, sessions: kicked });
      }
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
      if (pm[2] === "inventory" && req.method === "GET") {
        const role = p.roles[p.last_use];
        return json({
          coins: [["gcoin", p.coin[0]], ["vcoin", p.coin[1]], ["pcoin", p.coin[2]], ["ecoin", p.coin[3]]].map(([id, n]) => ({ id, name: nameOf(String(id)), amount: n })),
          items: Object.entries(p.items).map(([id, amount]) => ({ id, name: nameOf(id), amount })),
          equips: p.equips.map((e) => ({ id: e.id, name: nameOf(e.id), lv: e.lv, quality: e.quality, equipped: role ? role.equip_in.includes(e.id) : false })),
          roles: Object.values(p.roles).map((r) => ({ rid: r.rid, name: nameOf(r.rid), lv: r.lv, active: r.rid === p.last_use })),
          progress: { story: `${nameOf(p.ch_progress)} (${p.ch_progress})`, elite: p.ech_progress ? `${nameOf(p.ech_progress)} (${p.ech_progress})` : "-" },
        });
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
const COINS = [
  { id: "gcoin", name: "Gold", kind: "coin" },
  { id: "vcoin", name: "Diamonds", kind: "coin" },
  { id: "pcoin", name: "PvP coins", kind: "coin" },
  { id: "ecoin", name: "Elite coins", kind: "coin" },
];
