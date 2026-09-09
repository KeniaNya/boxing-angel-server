// Logica de juego: un handler por mensaje C2S. Cada handler devuelve los frames S2C a enviar.
// Los formatos vienen del cliente decompilado (clases *S2C.Parse) y de sus stubs offline.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveToken } from "./accounts.ts";
import { loadPlayer, createPlayer, savePlayer, newSessionKey, type Player, type Role } from "./players.ts";
import { s2c, type Frame } from "./economy.ts";

export type { Frame };
export type GameSession = {
  id: string;
  createdAt: number;
  lastSeen: number;
  pending: Frame[];
  acc: string | null;
  player: Player | null;
  sessionKey?: string;
};

export type Log = (...a: unknown[]) => void;
export type Handler = (s: GameSession, p: Record<string, unknown>, log: Log) => Frame[] | Promise<Frame[]>;
/** Handler que exige jugador logueado (los modulos de src/handlers/ usan este tipo). */
export type PlayerHandler = (ctx: { s: GameSession; p: Player; params: Record<string, unknown>; log: Log }) => Frame[] | Promise<Frame[]>;

// Codigos (Localization del cliente): Login_1002 "Not enough Data" · Login_1005 "no records in this server"
// (= crear personaje) · Login_1008 "Multiple login" · Login_1014 "Certification failed" · CreatePlayer_1026 "name taken"
// · CreatePlayer_1009 "max 12 chars" · Docking_1018 "Expired" · GetOtherRoles_1015 "Not login"
export const RES = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, NO_RECORDS: 1005, MULTI_LOGIN: 1008, CERT_FAILED: 1014, NOT_LOGIN: 1015, EXPIRED: 1018, NAME_TAKEN: 1026, NAME_TOO_LONG: 1009 };

/**
 * Modulos de handlers: cada archivo src/handlers/<dominio>.ts exporta `export const handlers: Record<string, PlayerHandler>`
 * (clave = nombre del mensaje C2S). Se cargan al arrancar; un nombre repetido entre modulos es un error.
 */
const moduleHandlers: Record<string, PlayerHandler> = {};
export async function loadHandlerModules(log: Log): Promise<string[]> {
  const dir = join(import.meta.dir, "handlers");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  } catch {
    return [];
  }
  for (const f of files) {
    const mod = (await import(join(dir, f))) as { handlers?: Record<string, PlayerHandler> };
    for (const [name, h] of Object.entries(mod.handlers ?? {})) {
      if (moduleHandlers[name] || handlers[name]) throw new Error(`handler duplicado ${name} en ${f}`);
      moduleHandlers[name] = h;
    }
  }
  log(`handlers cargados: ${Object.keys(handlers).length + Object.keys(moduleHandlers).length} (modulos: ${files.join(", ") || "ninguno"})`);
  return files;
}

function roleOut(r: Role) {
  // LoginS2C.ParseRole lee "prop"; el stub offline usa "pt": se mandan ambos
  return { ...r, pt: r.prop };
}

function playerOut(p: Player) {
  const { roles, equips, items, skills, scores, acc, createdAt, ...pub } = p;
  return pub;
}

/** Secuencia completa de LoginS2C: pasos 4,3,2,1,0 (el 0 con size 0 cierra la carga). */
function loginFrames(s: GameSession, p: Player): Frame[] {
  const role = p.roles[p.last_use] ?? Object.values(p.roles)[0];
  s.sessionKey = newSessionKey();
  s.player = p;
  return [
    s2c("LoginS2C", { res: 0, step: 4, size: 4, score: p.scores }),
    s2c("LoginS2C", { res: 0, step: 3, size: 3, player: playerOut(p), role: roleOut(role), session_key: s.sessionKey, server_time: Date.now() }),
    s2c("LoginS2C", { res: 0, step: 2, size: 2, skill: p.skills.map((k) => ({ id: k.id, strengthen_prop: k.strengthen_prop })) }),
    s2c("LoginS2C", { res: 0, step: 1, size: 1, item: Object.entries(p.items).map(([id, amount]) => ({ id, amount })) }),
    s2c("LoginS2C", { res: 0, step: 0, size: 0, equip: p.equips }),
  ];
}

const handlers: Record<string, Handler> = {
  LoginC2S(s, p, log) {
    const token = String(p.token ?? "");
    const acc = String(p.acc ?? "");
    const sess = resolveToken(token);
    if (!sess || sess.acc !== acc) {
      log("LoginC2S: token invalido para", acc);
      return [s2c("LoginS2C", { res: RES.CERT_FAILED, step: 0, size: 0 })];
    }
    s.acc = acc;
    const player = loadPlayer(acc);
    if (!player) {
      log("LoginC2S: cuenta sin personaje ->", acc);
      return [s2c("LoginS2C", { res: RES.NO_RECORDS, step: 0, size: 0 })];
    }
    log("LoginC2S ok", acc, player.name);
    return loginFrames(s, player);
  },

  CreatePlayerC2S(s, p, log) {
    if (!s.acc) return [s2c("CreatePlayerS2C", { res: RES.NOT_LOGIN })];
    const name = String(p.player_name ?? "").trim();
    const rid = String(p.rid ?? "1100001");
    if (name.length === 0 || name.length > 12) return [s2c("CreatePlayerS2C", { res: RES.NAME_TOO_LONG })];
    if (loadPlayer(s.acc)) return [s2c("CreatePlayerS2C", { res: RES.MULTI_LOGIN })]; // "Already create data" (1008)
    const player = createPlayer(s.acc, name, rid);
    log("CreatePlayerC2S", s.acc, name, rid);
    s.player = player;
    return [s2c("CreatePlayerS2C", { res: 0 })];
  },

  DockingC2S(s, p) {
    const key = String(p.session_key ?? "");
    if (!s.player || !s.sessionKey || key !== s.sessionKey) return [s2c("DockingS2C", { res: RES.EXPIRED })];
    return [s2c("DockingS2C", { res: 0, session_key: s.sessionKey })];
  },

  GetOtherRolesC2S(s) {
    if (!s.player) return [s2c("GetOtherRolesS2C", { res: RES.NOT_LOGIN })];
    const list = Object.values(s.player.roles).filter((r) => r.rid !== s.player!.last_use).map(roleOut);
    return [s2c("GetOtherRolesS2C", { res: 0, list })];
  },

  regularSocketC2S() {
    return [s2c("regularSocketS2C", { res: 0 })];
  },

  ServerMsgC2S() {
    return [s2c("ServerMsgS2C", { res: 0, msg_type_list: [] })];
  },

  GetTodayOpenChapterC2S() {
    // Capitulos especiales abiertos hoy (tipo+subtipo). Igual que el stub offline: todos abiertos.
    return [s2c("GetTodayOpenChapterS2C", { res: 0, list: ["1501", "1502", "1601", "1602", "1603", "1604"] })];
  },
};

export async function dispatch(s: GameSession, method: string, params: Record<string, unknown>, log: Log): Promise<Frame[]> {
  const reply = method.replace(/C2S$/, "S2C");
  const h = handlers[method];
  const mh = moduleHandlers[method];
  if (!h && !mh) {
    log("mensaje sin handler:", method, JSON.stringify(params).slice(0, 200));
    return [s2c(reply, { res: 0 })];
  }
  try {
    let out: Frame[];
    if (h) out = await h(s, params, log);
    else {
      if (!s.player) return [s2c(reply, { res: RES.NOT_LOGIN })];
      out = await mh!({ s, p: s.player, params, log });
    }
    if (s.player) savePlayer(s.player);
    return out;
  } catch (e) {
    log("error en", method, e);
    return [s2c(reply, { res: RES.WRONG_DATA })];
  }
}
