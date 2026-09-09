// Logica de juego: un handler por mensaje C2S. Cada handler devuelve los frames S2C a enviar.
// Los formatos vienen del cliente decompilado (clases *S2C.Parse) y de sus stubs offline.

import { resolveToken } from "./accounts.ts";
import { loadPlayer, createPlayer, savePlayer, newSessionKey, type Player, type Role } from "./players.ts";

export type Frame = { methodName: string; paramObject: Record<string, unknown> };
export type GameSession = {
  id: string;
  createdAt: number;
  lastSeen: number;
  pending: Frame[];
  acc: string | null;
  player: Player | null;
  sessionKey?: string;
};

type Handler = (s: GameSession, p: Record<string, unknown>, log: (...a: unknown[]) => void) => Frame[] | Promise<Frame[]>;

// Codigos (Localization del cliente): Login_1002 "Not enough Data" · Login_1005 "no records in this server"
// (= crear personaje) · Login_1008 "Multiple login" · Login_1014 "Certification failed" · CreatePlayer_1026 "name taken"
// · CreatePlayer_1009 "max 12 chars" · Docking_1018 "Expired" · GetOtherRoles_1015 "Not login"
export const RES = { OK: 0, NO_DATA: 1002, WRONG_DATA: 1003, NO_RECORDS: 1005, MULTI_LOGIN: 1008, CERT_FAILED: 1014, NOT_LOGIN: 1015, EXPIRED: 1018, NAME_TAKEN: 1026, NAME_TOO_LONG: 1009 };

function s2c(name: string, obj: Record<string, unknown>): Frame {
  return { methodName: name, paramObject: { ...obj, whatTime: String(Date.now()) } };
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

export async function dispatch(s: GameSession, method: string, params: Record<string, unknown>, log: (...a: unknown[]) => void): Promise<Frame[]> {
  const h = handlers[method];
  if (!h) {
    log("mensaje sin handler:", method, JSON.stringify(params).slice(0, 200));
    const reply = method.replace(/C2S$/, "S2C");
    return [s2c(reply, { res: 0 })];
  }
  try {
    const out = await h(s, params, log);
    if (s.player) savePlayer(s.player);
    return out;
  } catch (e) {
    log("error en", method, e);
    return [s2c(method.replace(/C2S$/, "S2C"), { res: RES.WRONG_DATA })];
  }
}
