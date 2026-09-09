// Pagina publica del servidor (/): que es, descargas (APK + OBB) e instrucciones de instalacion.
import { config, escapeHtml } from "./config.ts";
import { listFiles, type FileInfo } from "./files.ts";

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function publicHtml(baseUrl: string): string {
  const files = listFiles().filter((f) => f.sha256);
  const apk = files.find((f) => f.name.endsWith(".apk"));
  const obb = files.find((f) => f.name.endsWith(".obb"));
  const c = config();
  const row = (f: FileInfo, label: string) =>
    `<a class="dl" href="/download/${encodeURIComponent(f.name)}"><b>${escapeHtml(label)}</b><span>${escapeHtml(f.name)} · ${fmtSize(f.size)}</span>${f.description ? `<em>${escapeHtml(f.description)}</em>` : ""}<code>SHA-256 ${f.sha256}</code></a>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boxing Angel · servidor comunitario</title>
<style>
body{margin:0;background:#14101c;color:#f1eaff;font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:26px;margin:0 0 4px;color:#ff4fa3}h2{font-size:17px;margin:28px 0 10px;color:#ff4fa3}
p,li{color:#d9cfee}.muted{color:#a898c8;font-size:13px}
.dl{display:block;background:#1f1830;border:1px solid #3a2d52;border-radius:10px;padding:14px 16px;margin:10px 0;text-decoration:none;color:inherit}
.dl:hover{border-color:#ff4fa3}.dl b{display:block;font-size:17px}.dl span{color:#a898c8;font-size:13px}.dl em{display:block;color:#d9cfee;font-style:normal;font-size:13px;margin-top:4px}
.dl code{display:block;color:#7f6fa8;font-size:11px;margin-top:6px;word-break:break-all}
pre{background:#0d0a14;border:1px solid #3a2d52;border-radius:8px;padding:12px;font-size:12px;overflow:auto;color:#d9cfee}
ol li{margin:8px 0}.warn{background:#2a1f12;border:1px solid #6b4a1a;border-radius:8px;padding:10px 12px;color:#ffcf5a;font-size:13px}
footer{margin-top:40px;color:#7f6fa8;font-size:12px}
</style></head><body><main>
<h1>Boxing Angel · servidor comunitario</h1>
<p class="muted">Servidor no oficial mantenido por fans para <i>Boxing Angel</i> (Mono Play, 2019), cuyos servidores cerraron en julio de 2019. Estado: <b>${c.maintenance ? "en mantenimiento" : "en línea"}</b>${c.maintenance ? ` · ${escapeHtml(c.maintenance)}` : ""}.</p>

<h2>Descargas</h2>
${apk ? row(apk, "Juego (APK)") : `<p class="warn">El APK aún no se ha publicado.</p>`}
${obb ? row(obb, "Datos del juego (OBB)") : `<p class="warn">El archivo OBB aún no se ha publicado.</p>`}
${files.filter((f) => f !== apk && f !== obb).map((f) => row(f, f.name)).join("")}

<h2>Instalación en Android</h2>
<p class="muted">Requiere un Android que ejecute apps de 32 bits (armeabi-v7a): de Android 5 a 14 funciona, y también la mayoría de Android 15/16. Los teléfonos que solo admiten 64 bits (algunos Pixel recientes) no pueden instalarlo.</p>
<ol>
<li>Descarga e instala el <b>APK</b> (acepta "instalar apps de origen desconocido" si el teléfono lo pide). <b>No abras el juego todavía.</b></li>
<li>Descarga el <b>OBB</b> y cópialo, con ese nombre exacto, a la carpeta del almacenamiento interno:<pre>Android/obb/th.in.monogame.boxingangel/</pre>Crea la carpeta si no existe. En Android 11 o superior el explorador del teléfono puede bloquear <code>Android/obb</code>: usa un explorador con permiso de "todos los archivos" (por ejemplo, el de Xiaomi/Samsung con ese permiso activado) o un PC con cable:<pre>adb shell mkdir -p /sdcard/Android/obb/th.in.monogame.boxingangel
adb push ${escapeHtml(obb?.name ?? "main.2019042915.th.in.monogame.boxingangel.obb")} /sdcard/Android/obb/th.in.monogame.boxingangel/${escapeHtml(obb?.name ?? "main.2019042915.th.in.monogame.boxingangel.obb")}</pre></li>
<li>Abre el juego. Con internet descarga la configuración del servidor, muestra las noticias y llega al login: pulsa <b>START</b> y luego <b>Login</b> (se crea una cuenta rápida en el teléfono; no la pierdas reinstalando).</li>
</ol>
<p class="muted">Actualizaciones: basta instalar el APK nuevo encima del anterior (misma firma). El OBB no cambia. El servidor y sus noticias están en <a href="${escapeHtml(baseUrl)}/news/index.html" style="color:#ff9ad0">${escapeHtml(baseUrl)}/news/index.html</a>.</p>

<h2>Aviso</h2>
<p class="muted">El juego y sus recursos pertenecen a Mono Play Co., Ltd. Este proyecto no tiene relación con ellos; existe para que quienes jugaron puedan volver a hacerlo. Sin compras ni monetización.</p>
<footer>Boxing Angel community server · ${escapeHtml(baseUrl)}</footer>
</main></body></html>`;
}
