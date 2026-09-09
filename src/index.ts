// Servidor comunitario de Boxing Angel (th.in.monogame.boxingangel, Mono Play 2019).
// Reemplaza al login server (BALoginServer) y a los archivos estaticos que el cliente
// descargaba (tablas de Setting, indice de AssetBundles, noticias).
//
// Convencion LenaCloud: escucha en process.env.PORT. Estado persistente en LENA_APPDATA.

import { settingsZip, bundleDatabaseList, type SettingsConfig } from "./settings.ts";
import { createAccount, verifyAccount, loadAccounts, accountCount, HTTP_WRONG_DATA } from "./accounts.ts";

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.PUBLIC_HOST || "boxingangel.lenasuite.org";
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}`;
const CONNECTION = (process.env.GAME_CONNECTION === "1" ? 1 : 0) as 0 | 1;
const GAME_HOST = process.env.GAME_SERVER_HOST || HOST;
const GAME_PORT = Number(process.env.GAME_SERVER_PORT || 9003);

const settingsCfg: SettingsConfig = {
  host: HOST,
  baseUrl: BASE_URL,
  connection: CONNECTION,
  clientVersions: (process.env.CLIENT_VERSIONS || "1.0.18,1.0.17,1.0.16,1.0.15,1.0.14,1.0.13,1.0.12,1.0.11,1.0.10,1.0.9,1.0.8,1.0.7,1.0.6,1.0.5,1.0.4,1.0.3,1.0.2,1.0.1,1.0.0,1.0").split(","),
  networkName: process.env.NETWORK_NAME || "Community",
  flags: { showTutorial: 1, isNPC: 1, isStory: 1, isPVP: 0 },
};

const startedAt = new Date();
const zipBytes = settingsZip(settingsCfg);
const nAccounts = loadAccounts();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const text = (body: string, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });

function log(...parts: unknown[]) {
  console.log(new Date().toISOString(), ...parts);
}

/** Lista de servidores de juego que devuelve Verify. Con connection=0 el cliente ni la usa. */
function gameList() {
  return [{ id: 1, ip: GAME_HOST, name: settingsCfg.networkName, port: String(GAME_PORT), psize: "0", status: "0" }];
}

function handleLogin(action: string, q: URLSearchParams): Response {
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
      const r = verifyAccount(acc, pwd);
      log("login/Verify", acc, "->", r.res);
      if (r.res !== 0) return json({ res: r.res });
      return json({ res: 0, token: r.token, game_list: gameList() });
    }
    case "FastAccBinding":
      // Vinculacion de cuenta rapida (Facebook/dispositivo): no soportado todavia.
      return json({ res: HTTP_WRONG_DATA });
    default:
      return json({ res: HTTP_WRONG_DATA });
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // Login server original: http://<host>/BALoginServer/Login/<Create|Verify|FastAccBinding>?acc=&pwd=&type=&ver=
    const login = p.match(/^\/BALoginServer\/Login\/([A-Za-z]+)\/?$/);
    if (login) return handleLogin(login[1], url.searchParams);

    // Zip de tablas de Setting: el cliente pide <m_ZipDataURL><m_SettingFileName>.zip?abc=<random>
    if (/^\/boxingangel\/setting\/[^/]+\/[^/]+\.zip$/.test(p)) {
      return new Response(zipBytes, { headers: { "content-type": "application/zip", "cache-control": "no-store" } });
    }

    // Indice de AssetBundles (vacio: todo se carga desde el OBB)
    if (/^\/boxingangel\/bundles\/[^/]+\/Android\/BundleDatabaseList\.txt$/.test(p)) {
      return text(bundleDatabaseList());
    }

    if (p === "/news/index.html" || p === "/news/") {
      return text(NEWS_HTML, 200, "text/html; charset=utf-8");
    }

    if (p === "/download") return Response.redirect("https://apkfab.com/boxing-angel/th.in.monogame.boxingangel", 302);

    if (p === "/api/health") {
      return json({ ok: true, startedAt, uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000), accounts: accountCount(), connection: CONNECTION, host: HOST });
    }

    if (p === "/") return text(INDEX_HTML, 200, "text/html; charset=utf-8");

    log("404", req.method, p);
    return text("not found", 404);
  },
});

const NEWS_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="margin:0;background:#1a1020;color:#f3e9ff;font-family:sans-serif;padding:16px">
<h2 style="margin:0 0 8px">Boxing Angel · servidor comunitario</h2>
<p>Este es un servidor no oficial mantenido por fans. El juego original cerro en 2019.</p>
</body>`;

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>Boxing Angel community server</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h1>Boxing Angel · servidor comunitario</h1>
<p>Servidor no oficial para el juego <code>th.in.monogame.boxingangel</code> (Mono Play, 2019).</p>
<ul>
<li><code>GET /BALoginServer/Login/Create?acc=&amp;pwd=&amp;type=</code></li>
<li><code>GET /BALoginServer/Login/Verify?acc=&amp;pwd=&amp;type=</code></li>
<li><code>GET /boxingangel/setting/v1_0/&lt;nombre&gt;.zip</code> · tablas de Setting</li>
<li><code>GET /boxingangel/bundles/Google/Android/BundleDatabaseList.txt</code></li>
<li><code>GET /api/health</code></li>
</ul>
</body>`;

log(`Boxing Angel server escuchando en :${server.port} · host publico ${HOST} · connection=${CONNECTION} · cuentas=${nAccounts}`);
