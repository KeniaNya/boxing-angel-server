// Utilidades para pruebas de handlers con `bun test`. Usa un LENA_APPDATA temporal (hay que fijar
// process.env.LENA_APPDATA ANTES de importar players.ts, por eso este modulo lo hace al cargarse).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LENA_APPDATA_TEST) {
  process.env.LENA_APPDATA = mkdtempSync(join(tmpdir(), "ba-test-"));
  process.env.LENA_APPDATA_TEST = "1";
}

const players = await import("./players.ts");
const game = await import("./game.ts");

export const silentLog = (..._a: unknown[]) => {};

/** Sesion logueada con un jugador nuevo (nombre y rol por defecto). */
export async function testSession(acc = "test-" + Math.random().toString(36).slice(2), rid = "1100001") {
  await game.loadHandlerModules(silentLog);
  const p = players.loadPlayer(acc) ?? players.createPlayer(acc, "Tester", rid);
  const s: game.GameSession = { id: "s", createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc, player: p, sessionKey: "k" };
  return { s, p, send: (method: string, params: Record<string, unknown> = {}) => game.dispatch(s, method, params, silentLog) };
}
