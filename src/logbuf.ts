// Log del servidor: a consola (LenaCloud lo recoge) y a un buffer circular en memoria que el panel /admin muestra.

const MAX = 500;
const lines: string[] = [];

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : safe(p))).join(" ")}`;
  console.log(line);
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

function safe(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Ultimas `n` lineas (por defecto todas las guardadas). */
export function recentLog(n = MAX): string[] {
  return lines.slice(-n);
}
