// Descargas publicas (APK y OBB del juego) guardadas en LENA_APPDATA/data/downloads (persiste entre deploys).
// Se suben desde el panel /admin por trozos (Cloudflare limita cada peticion a 100 MB) y se sirven en
// /download/<nombre> con soporte de Range (reanudar/descargar por partes desde el telefono).

import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, appendFileSync, writeFileSync, renameSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APPDATA = process.env.LENA_APPDATA || join(import.meta.dir, "..");
const DIR = join(APPDATA, "data", "downloads");
const META = join(DIR, "meta.json");

export type FileInfo = { name: string; size: number; sha256: string | null; updatedAt: string; description: string };
type Meta = Record<string, { sha256?: string; description?: string; uploading?: boolean }>;

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const CONTENT_TYPES: Record<string, string> = { apk: "application/vnd.android.package-archive", obb: "application/octet-stream", zip: "application/zip", txt: "text/plain; charset=utf-8" };

function ensure() {
  mkdirSync(DIR, { recursive: true });
}
function meta(): Meta {
  if (!existsSync(META)) return {};
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return {};
  }
}
function saveMeta(m: Meta) {
  ensure();
  writeFileSync(META + ".tmp", JSON.stringify(m, null, 2));
  renameSync(META + ".tmp", META);
}
function pathOf(name: string) {
  if (!NAME_RE.test(name) || name === "meta.json") throw new Error("nombre de archivo invalido");
  return join(DIR, name);
}

export function listFiles(): FileInfo[] {
  ensure();
  const m = meta();
  return readdirSync(DIR)
    .filter((f) => f !== "meta.json" && !f.endsWith(".tmp") && NAME_RE.test(f))
    .map((f) => {
      const st = statSync(join(DIR, f));
      return { name: f, size: st.size, sha256: m[f]?.uploading ? null : (m[f]?.sha256 ?? null), updatedAt: st.mtime.toISOString(), description: m[f]?.description ?? "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Trozo de subida: `first` trunca/crea el archivo; `last` calcula el SHA-256 y cierra. */
export function appendChunk(name: string, data: Uint8Array, first: boolean, last: boolean): FileInfo {
  const p = pathOf(name);
  ensure();
  const m = meta();
  if (first) {
    writeFileSync(p, data);
    m[name] = { ...(m[name] ?? {}), uploading: true, sha256: undefined };
  } else {
    if (!existsSync(p) || !m[name]?.uploading) throw new Error("no hay una subida en curso para " + name);
    appendFileSync(p, data);
  }
  if (last) {
    m[name] = { ...(m[name] ?? {}), uploading: false, sha256: sha256File(p) };
  }
  saveMeta(m);
  const st = statSync(p);
  return { name, size: st.size, sha256: m[name]?.uploading ? null : (m[name]?.sha256 ?? null), updatedAt: st.mtime.toISOString(), description: m[name]?.description ?? "" };
}

export function setDescription(name: string, description: string) {
  pathOf(name);
  const m = meta();
  m[name] = { ...(m[name] ?? {}), description: description.slice(0, 200) };
  saveMeta(m);
}

export function deleteFile(name: string): boolean {
  const p = pathOf(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  const m = meta();
  delete m[name];
  saveMeta(m);
  return true;
}

function sha256File(p: string): string {
  const h = createHash("sha256");
  const fd = openSync(p, "r");
  const buf = new Uint8Array(1 << 20);
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** Respuesta de descarga con soporte de `Range: bytes=a-b` (una sola parte). */
export function serveFile(name: string, req: Request): Response {
  let p: string;
  try {
    p = pathOf(name);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(p) || meta()[name]?.uploading) return new Response("not found", { status: 404 });
  const size = statSync(p).size;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "public, max-age=3600",
  };
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!m[1]) start = Math.max(0, size - Number(m[2]));
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
    headers["content-length"] = String(end - start + 1);
    return new Response(Bun.file(p).slice(start, end + 1), { status: 206, headers });
  }
  headers["content-length"] = String(size);
  return new Response(Bun.file(p), { headers });
}
