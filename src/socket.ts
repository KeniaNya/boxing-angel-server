// Transporte HTTP del "socket" del juego. El cliente parcheado (BAHttpSocket) envia cada frame
// {"methodName":"XxxC2S","paramObject":"<json>"} por POST y recibe un array de frames
// {"methodName":"XxxS2C","paramObject":{...}} (respuestas + mensajes push pendientes).
//
//   POST /socket/connect              -> {"session": id}
//   POST /socket/send   X-BA-Session  -> [frames]
//   POST /socket/poll   X-BA-Session  -> [frames]
//   POST /socket/close  X-BA-Session

import { randomUUID } from "node:crypto";
import { dispatch, type Frame, type GameSession } from "./game.ts";

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, GameSession>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
}
setInterval(sweep, 60_000).unref();

/** Cierra las sesiones de juego de una cuenta (para que un jugador borrado no se vuelva a guardar desde memoria). */
export function closeSessionsOf(acc: string): number {
  let n = 0;
  for (const [id, s] of sessions) if (s.acc === acc) { sessions.delete(id); n++; }
  return n;
}

export function sessionCount(): number {
  return sessions.size;
}

/** Sesion de juego por id (X-BA-Session); la usa el PvP en vivo para identificar al jugador del WebSocket. */
export function getSession(id: string): GameSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastSeen = Date.now();
  return s;
}

export async function handleSocket(path: string, req: Request, log: (...a: unknown[]) => void): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const action = path.slice("/socket/".length);

  if (action === "connect") {
    const s: GameSession = { id: randomUUID(), createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc: null, player: null };
    sessions.set(s.id, s);
    log("socket/connect", s.id);
    return json({ session: s.id });
  }

  const sid = req.headers.get("x-ba-session") ?? "";
  const s = sessions.get(sid);
  if (!s) return json({ error: "no session" }, 401);
  s.lastSeen = Date.now();

  if (action === "close") {
    sessions.delete(sid);
    log("socket/close", sid, s.acc ?? "");
    return json({ ok: true });
  }

  if (action === "poll") {
    const out = s.pending.splice(0);
    return json(out);
  }

  if (action === "send") {
    let frame: { methodName?: string; paramObject?: unknown };
    try {
      frame = (await req.json()) as typeof frame;
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const method = String(frame.methodName ?? "");
    let params: Record<string, unknown> = {};
    try {
      params = typeof frame.paramObject === "string" ? JSON.parse(frame.paramObject) : ((frame.paramObject as Record<string, unknown>) ?? {});
    } catch {
      return json({ error: "bad paramObject" }, 400);
    }
    const replies: Frame[] = await dispatch(s, method, params, log);
    const out = [...replies, ...s.pending.splice(0)];
    const first = replies[0]?.paramObject ?? {};
    log(`${s.acc ?? s.id.slice(0, 8)} ${method} -> ${out.map((f) => f.methodName).join(",")} res=${String((first as { res?: unknown }).res ?? "?")}`);
    return json(out);
  }

  return json({ error: "unknown action" }, 404);
}
