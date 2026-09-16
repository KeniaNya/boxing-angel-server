// Servidor comunitario de Boxing Angel (th.in.monogame.boxingangel, Mono Play 2019).
// Reemplaza al login server (BALoginServer) y a los archivos estaticos que el cliente
// descargaba (tablas de Setting, indice de AssetBundles, noticias).
//
// Convencion LenaCloud: escucha en process.env.PORT. Estado persistente en LENA_APPDATA.

import { settingsZip, bundleDatabaseList, type SettingsConfig, gameConfigJson } from "./settings.ts";
import { loadHandlerModules } from "./game.ts";
import { config, onConfigChange, newsHtml } from "./config.ts";
import { handleAdmin } from "./admin.ts";
import { publicHtml, pickLang } from "./public.ts";
import { serveFile } from "./files.ts";
import { log } from "./logbuf.ts";
import { createAccount, verifyAccount, bindAccount, loadAccounts, accountCount, HTTP_WRONG_DATA } from "./accounts.ts";
import { handleSocket, sessionCount } from "./socket.ts";
import { livePeerOpen, liveMessage, livePeerClose, liveStatus, type Peer } from "./live.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.PUBLIC_HOST || "boxingangel.lenasuite.org";
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}`;
const GAME_HOST = process.env.GAME_SERVER_HOST || HOST;
const GAME_PORT = Number(process.env.GAME_SERVER_PORT || 80); // transporte HTTP: BAHttpSocket omite el puerto si es 80

/** Configuracion de las tablas de Setting a partir de la configuracion editable (panel /admin). */
function settingsCfg(): SettingsConfig {
  const c = config();
  return {
    host: HOST,
    baseUrl: BASE_URL,
    connection: c.connection,
    clientVersions: (process.env.CLIENT_VERSIONS || "1.0.18,1.0.17,1.0.16,1.0.15,1.0.14,1.0.13,1.0.12,1.0.11,1.0.10,1.0.9,1.0.8,1.0.7,1.0.6,1.0.5,1.0.4,1.0.3,1.0.2,1.0.1,1.0.0,1.0").split(","),
    networkName: c.networkName,
    dataVersion: c.dataVersion,
    flags: c.flags,
  };
}

// Tablas de datos corregidas (sobrescriben a las del OBB)
const TABLES_DIR = join(import.meta.dir, "..", "tables");
const overrideTables = existsSync(TABLES_DIR)
  ? readdirSync(TABLES_DIR).filter((f) => f.endsWith(".txt")).map((f) => ({ name: f, data: new Uint8Array(readFileSync(join(TABLES_DIR, f))) }))
  : [];

const startedAt = new Date();
let zipBytes = settingsZip(settingsCfg(), overrideTables);
onConfigChange(() => {
  zipBytes = settingsZip(settingsCfg(), overrideTables);
});
const nAccounts = loadAccounts();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const text = (body: string, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });

/** Lista de servidores de juego que devuelve Verify. Con connection=0 el cliente ni la usa. */
function gameList() {
  return [{ id: 1, ip: GAME_HOST, name: config().networkName, port: String(GAME_PORT), psize: "0", status: "0" }];
}

async function handleLogin(action: string, q: URLSearchParams, req: Request): Promise<Response> {
  const acc = q.get("acc") ?? "";
  const pwd = q.get("pwd") ?? "";
  const type = Number(q.get("type") ?? "0");
  switch (action) {
    case "Create": {
      const res = createAccount(acc, pwd, type);
      log("login/Create", acc, "->", res);
      return json({ res });
    }
    case "Verify": {
      if (config().maintenance) {
        log("login/Verify", acc, "-> mantenimiento");
        return json({ res: HTTP_WRONG_DATA, msg: config().maintenance });
      }
      const r = verifyAccount(acc, pwd);
      log("login/Verify", acc, "->", r.res);
      if (r.res !== 0) return json({ res: r.res });
      return json({ res: 0, token: r.token, game_list: gameList() });
    }
    case "FastAccBinding": {
      // Vinculacion de cuenta rapida: CSDataManager.Binding manda un WWWForm (POST multipart).
      const form = req.method === "POST" ? await req.formData().catch(() => null) : null;
      const field = (k: string) => String(form?.get(k) ?? q.get(k) ?? "");
      const fast = field("fast_acc");
      const target = field("binding_acc");
      const res = bindAccount(fast, field("fast_pwd"), target, field("binding_pwd"), Number(field("binding_type") || 1));
      log("login/FastAccBinding", fast, "->", target, "=", res);
      return json({ res });
    }
    default:
      return json({ res: HTTP_WRONG_DATA });
  }
}

await loadHandlerModules(log);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;

    // PvP en vivo: WebSocket de emparejamiento y reenvio (cliente parcheado, BALive)
    if (p === "/live") {
      if (server.upgrade(req, { data: { peer: null as Peer | null } })) return undefined;
      return text("websocket expected", 426);
    }

    // Panel de control (token en ADMIN_TOKEN)
    if (p === "/admin" || p.startsWith("/admin/")) return handleAdmin(p, req, { startedAt });

    // Login server original: http://<host>/BALoginServer/Login/<Create|Verify|FastAccBinding>?acc=&pwd=&type=&ver=
    const login = p.match(/^\/BALoginServer\/Login\/([A-Za-z]+)\/?$/);
    if (login) return handleLogin(login[1], url.searchParams, req);

    // Zip de tablas de Setting: el cliente pide <m_ZipDataURL><m_SettingFileName>.zip?abc=<random>
    if (/^\/boxingangel\/setting\/[^/]+\/[^/]+\.zip$/.test(p)) {
      return new Response(zipBytes, { headers: { "content-type": "application/zip", "cache-control": "no-store" } });
    }

    // Indice de AssetBundles (vacio: todo se carga desde el OBB)
    if (/^\/boxingangel\/bundles\/[^/]+\/Android\/BundleDatabaseList\.txt$/.test(p)) {
      return text(bundleDatabaseList());
    }

    // "Socket" del juego sobre HTTP (cliente parcheado con BAHttpSocket)
    if (p.startsWith("/socket/")) return handleSocket(p, req, log);

    // Config remota del cliente (sexy system, dificultad, SMS): el original vivia en boxingangel-apipay.monogame.in.th
    if (p === "/reward/game-config/api_config.php") return json(gameConfigJson(settingsCfg()));

    // Imagenes de evento (banners del gacha): Android_connect_info.lotteryEventImage + "<id>.png?abc=..."
    const img = /^\/boxingangel\/image\/([A-Za-z0-9_-]+\.png)$/.exec(p);
    if (img) {
      const path = join(import.meta.dir, "..", "static", "lottery", img[1]);
      if (existsSync(path)) return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      log("404 imagen", img[1]);
      return text("not found", 404);
    }

    if (p === "/news/index.html" || p === "/news/") {
      return text(newsHtml(), 200, "text/html; charset=utf-8");
    }

    // Descargas publicas (APK/OBB subidos desde el panel)
    if (p === "/download" || p === "/download/") return Response.redirect("/", 302);
    const dl = /^\/download\/([^/]+)$/.exec(p);
    if (dl) return serveFile(decodeURIComponent(dl[1]), req);

    if (p === "/api/health") {
      return json({ ok: true, startedAt, uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000), accounts: accountCount(), sessions: sessionCount(), live: liveStatus(), connection: config().connection, host: HOST });
    }

    if (p === "/" || p === "/index.html") {
      const lang = pickLang(url.searchParams.get("lang"), req.headers.get("accept-language"));
      return new Response(publicHtml(BASE_URL, lang), { headers: { "content-type": "text/html; charset=utf-8", vary: "Accept-Language" } });
    }

    log("404", req.method, p);
    return text("not found", 404);
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      ws.data.peer = livePeerOpen({ send: (t) => ws.send(t), close: () => ws.close() }, log);
    },
    message(ws, msg) {
      if (ws.data.peer) liveMessage(ws.data.peer, typeof msg === "string" ? msg : new TextDecoder().decode(msg), log);
    },
    close(ws) {
      if (ws.data.peer) livePeerClose(ws.data.peer, log);
    },
  },
});

log(`Boxing Angel server escuchando en :${server.port} · host publico ${HOST} · connection=${config().connection} · cuentas=${nAccounts} · tablas override=${overrideTables.map((t) => t.name).join(",") || "ninguna"}`);
