// Pagina publica del servidor (/): que es, descargas (APK + OBB) e instrucciones de instalacion.
// Ingles por defecto; ?lang=es y ?lang=ja. El juego en si solo esta en ingles (los textos traducidos
// viven en las tablas del OBB/servidor y solo se completo el ingles), y la pagina lo explica.
import { config, escapeHtml } from "./config.ts";
import { listFiles, type FileInfo } from "./files.ts";

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export type Lang = "en" | "es" | "ja";
type Strings = {
  title: string; intro: string; online: string; maintenance: string;
  downloads: string; apk: string; obb: string; apkMissing: string; obbMissing: string;
  install: string; requirements: string; step1: string; step2: string; step3: string;
  manualSummary: string; manualText: string;
  updates: string; news: string; langNote: string; notice: string; noticeText: string;
  langLabel: string;
};

const T: Record<Lang, Strings> = {
  en: {
    title: "Boxing Angel · community server",
    intro: "Unofficial, fan-run server for <i>Boxing Angel</i> (Mono Play, 2019), whose official servers shut down in July 2019. Status:",
    online: "online", maintenance: "under maintenance",
    downloads: "Downloads", apk: "Game (APK)", obb: "Game data (OBB) · only for manual copy",
    apkMissing: "The APK has not been published yet.", obbMissing: "The OBB file has not been published yet.",
    install: "Installing on Android",
    requirements: "Needs an Android device that can run 32-bit apps (armeabi-v7a): Android 5 to 14 work, and so do most Android 15/16 phones. Devices that only support 64-bit apps (some recent Pixels) cannot install it.",
    step1: "Download and install the <b>APK</b> (allow \"install unknown apps\" if the phone asks).",
    step2: "Open the game with an internet connection. On the first run it downloads the game data ({size}) with a progress bar and restarts when done. Wi-Fi recommended.",
    step3: "When it reopens it fetches the server configuration, shows the news and reaches the login screen: tap <b>START</b>, then <b>Login</b> (a quick account is created on the phone; don't lose it by reinstalling).",
    manualSummary: "Copy the game data manually (only if the automatic download fails)",
    manualText: "Download the <b>OBB</b> and copy it, with that exact name, to the internal storage folder <code>Android/obb/th.in.monogame.boxingangel/</code> (create it if needed). On Android 11 or newer the phone's file manager may block <code>Android/obb</code>: use a file manager with \"all files\" permission or a PC with a USB cable:",
    updates: "Updates: just install the new APK over the old one (same signature). The game data does not change. Server news: ",
    news: "news page",
    langNote: "The game itself is in <b>English only</b>. Its text lives inside the game data and only the English translation was completed, so there is no Spanish or Japanese version of the game; only this page is translated.",
    notice: "Notice",
    noticeText: "The game and its assets belong to Mono Play Co., Ltd. This project is not affiliated with them; it exists so that former players can play again. No purchases, no monetization.",
    langLabel: "Language",
  },
  es: {
    title: "Boxing Angel · servidor comunitario",
    intro: "Servidor no oficial mantenido por fans para <i>Boxing Angel</i> (Mono Play, 2019), cuyos servidores oficiales cerraron en julio de 2019. Estado:",
    online: "en línea", maintenance: "en mantenimiento",
    downloads: "Descargas", apk: "Juego (APK)", obb: "Datos del juego (OBB) · solo para copia manual",
    apkMissing: "El APK aún no se ha publicado.", obbMissing: "El archivo OBB aún no se ha publicado.",
    install: "Instalación en Android",
    requirements: "Requiere un Android que ejecute apps de 32 bits (armeabi-v7a): de Android 5 a 14 funciona, y también la mayoría de Android 15/16. Los teléfonos que solo admiten 64 bits (algunos Pixel recientes) no pueden instalarlo.",
    step1: "Descarga e instala el <b>APK</b> (acepta \"instalar apps de origen desconocido\" si el teléfono lo pide).",
    step2: "Abre el juego con internet. La primera vez descarga los datos del juego ({size}) mostrando el progreso y se reinicia al terminar. Mejor con wifi.",
    step3: "Al volver a abrirse descarga la configuración del servidor, muestra las noticias y llega al login: pulsa <b>START</b> y luego <b>Login</b> (se crea una cuenta rápida en el teléfono; no la pierdas reinstalando).",
    manualSummary: "Copiar los datos a mano (solo si la descarga automática falla)",
    manualText: "Descarga el <b>OBB</b> y cópialo, con ese nombre exacto, a la carpeta del almacenamiento interno <code>Android/obb/th.in.monogame.boxingangel/</code> (créala si no existe). En Android 11 o superior el explorador del teléfono puede bloquear <code>Android/obb</code>: usa un explorador con permiso de \"todos los archivos\" o un PC con cable:",
    updates: "Actualizaciones: basta instalar el APK nuevo encima del anterior (misma firma). Los datos del juego no cambian. Noticias del servidor: ",
    news: "página de noticias",
    langNote: "El juego en sí está <b>solo en inglés</b>. Sus textos viven dentro de los datos del juego y únicamente se completó la traducción al inglés, así que no existe versión del juego en español ni en japonés; solo esta página está traducida.",
    notice: "Aviso",
    noticeText: "El juego y sus recursos pertenecen a Mono Play Co., Ltd. Este proyecto no tiene relación con ellos; existe para que quienes jugaron puedan volver a hacerlo. Sin compras ni monetización.",
    langLabel: "Idioma",
  },
  ja: {
    title: "Boxing Angel · コミュニティサーバー",
    intro: "2019年7月に公式サーバーが終了した<i>ボクシングエンジェル</i>（Mono Play、2019年）を、ファンが非公式に運営しているサーバーです。状態：",
    online: "稼働中", maintenance: "メンテナンス中",
    downloads: "ダウンロード", apk: "ゲーム本体（APK）", obb: "ゲームデータ（OBB）・手動コピー用",
    apkMissing: "APKはまだ公開されていません。", obbMissing: "OBBファイルはまだ公開されていません。",
    install: "Androidへのインストール",
    requirements: "32ビットアプリ（armeabi-v7a）を実行できるAndroid端末が必要です。Android 5〜14で動作し、Android 15/16の多くの端末でも動作します。64ビットアプリしか動かない端末（一部の新しいPixelなど）にはインストールできません。",
    step1: "<b>APK</b>をダウンロードしてインストールします（「提供元不明のアプリ」の許可を求められたら許可してください）。",
    step2: "インターネットに接続した状態でゲームを起動します。初回のみゲームデータ（{size}）を進捗バー付きでダウンロードし、完了後に自動で再起動します。Wi-Fi推奨です。",
    step3: "再起動後はサーバー設定を取得し、お知らせを表示してログイン画面になります。<b>START</b>、続いて<b>Login</b>をタップしてください（端末にクイックアカウントが作られます。再インストールすると失われるので注意）。",
    manualSummary: "ゲームデータを手動でコピーする（自動ダウンロードが失敗した場合のみ）",
    manualText: "<b>OBB</b>をダウンロードし、ファイル名をそのままに内部ストレージの<code>Android/obb/th.in.monogame.boxingangel/</code>にコピーします（フォルダがなければ作成）。Android 11以降では端末のファイルマネージャーが<code>Android/obb</code>をブロックすることがあります。「すべてのファイル」権限のあるファイルマネージャーか、USBケーブルでPCから行ってください：",
    updates: "アップデート：新しいAPKを上書きインストールするだけです（同じ署名）。ゲームデータは変わりません。サーバーのお知らせ：",
    news: "お知らせページ",
    langNote: "ゲーム本体は<b>英語のみ</b>です。ゲームのテキストはゲームデータ内にあり、英語訳だけが完成しているため、ゲームのスペイン語版・日本語版はありません。翻訳されているのはこのページだけです。",
    notice: "注意",
    noticeText: "ゲームおよびその素材はMono Play Co., Ltd.に帰属します。本プロジェクトは同社とは無関係で、かつてのプレイヤーが再び遊べるようにするためのものです。課金や収益化は一切ありません。",
    langLabel: "言語",
  },
};

/** Idioma de la pagina: ingles por defecto; ?lang=es / ?lang=ja para las otras versiones. */
export function pickLang(param: string | null, _acceptLanguage: string | null): Lang {
  if (param === "es" || param === "ja" || param === "en") return param;
  return "en";
}

export function publicHtml(baseUrl: string, lang: Lang = "en"): string {
  const t = T[lang];
  const files = listFiles().filter((f) => f.sha256);
  const apk = files.find((f) => f.name.endsWith(".apk"));
  const obb = files.find((f) => f.name.endsWith(".obb"));
  const c = config();
  const obbName = obb?.name ?? "main.2019042915.th.in.monogame.boxingangel.obb";
  const row = (f: FileInfo, label: string) =>
    `<a class="dl" href="/download/${encodeURIComponent(f.name)}?v=${(f.sha256 ?? "").slice(0, 8)}"><b>${escapeHtml(label)}</b><span>${escapeHtml(f.name)} · ${fmtSize(f.size)}</span>${f.description ? `<em>${escapeHtml(f.description)}</em>` : ""}<code>SHA-256 ${f.sha256}</code></a>`;
  const langLink = (l: Lang, label: string) => (l === lang ? `<b>${label}</b>` : `<a href="/?lang=${l}">${label}</a>`);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.title)}</title>
<style>
body{margin:0;background:#14101c;color:#f1eaff;font:15px/1.5 system-ui,Segoe UI,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:26px;margin:0 0 4px;color:#ff4fa3}h2{font-size:17px;margin:28px 0 10px;color:#ff4fa3}
p,li{color:#d9cfee}.muted{color:#a898c8;font-size:13px}
.lang{float:right;font-size:13px;color:#a898c8;margin-top:6px}.lang a{color:#ff9ad0;text-decoration:none}.lang b{color:#f1eaff}.lang span{margin:0 4px}
.dl{display:block;background:#1f1830;border:1px solid #3a2d52;border-radius:10px;padding:14px 16px;margin:10px 0;text-decoration:none;color:inherit}
.dl:hover{border-color:#ff4fa3}.dl b{display:block;font-size:17px}.dl span{color:#a898c8;font-size:13px}.dl em{display:block;color:#d9cfee;font-style:normal;font-size:13px;margin-top:4px}
.dl code{display:block;color:#7f6fa8;font-size:11px;margin-top:6px;word-break:break-all}
pre{background:#0d0a14;border:1px solid #3a2d52;border-radius:8px;padding:12px;font-size:12px;overflow:auto;color:#d9cfee}
ol li{margin:8px 0}.warn{background:#2a1f12;border:1px solid #6b4a1a;border-radius:8px;padding:10px 12px;color:#ffcf5a;font-size:13px}
.note{background:#1f1830;border:1px solid #3a2d52;border-radius:8px;padding:10px 12px;font-size:13px;color:#d9cfee}
a{color:#ff9ad0}footer{margin-top:40px;color:#7f6fa8;font-size:12px}
</style></head><body><main>
<div class="lang">${escapeHtml(t.langLabel)}: ${langLink("en", "English")}<span>·</span>${langLink("es", "Español")}<span>·</span>${langLink("ja", "日本語")}</div>
<h1>${escapeHtml(t.title)}</h1>
<p class="muted">${t.intro} <b>${c.maintenance ? escapeHtml(t.maintenance) : escapeHtml(t.online)}</b>${c.maintenance ? ` · ${escapeHtml(c.maintenance)}` : ""}.</p>
<p class="note">${t.langNote}</p>

<h2>${escapeHtml(t.downloads)}</h2>
${apk ? row(apk, t.apk) : `<p class="warn">${escapeHtml(t.apkMissing)}</p>`}
${obb ? row(obb, t.obb) : `<p class="warn">${escapeHtml(t.obbMissing)}</p>`}
${files.filter((f) => f !== apk && f !== obb).map((f) => row(f, f.name)).join("")}

<h2>${escapeHtml(t.install)}</h2>
<p class="muted">${escapeHtml(t.requirements)}</p>
<ol>
<li>${t.step1}</li>
<li>${t.step2.replace("{size}", obb ? fmtSize(obb.size) : "153 MB")}</li>
<li>${t.step3}</li>
</ol>
<details><summary class="muted">${escapeHtml(t.manualSummary)}</summary>
<p class="muted">${t.manualText}</p><pre>adb shell mkdir -p /sdcard/Android/obb/th.in.monogame.boxingangel
adb push ${escapeHtml(obbName)} /sdcard/Android/obb/th.in.monogame.boxingangel/${escapeHtml(obbName)}</pre>
</details>
<p class="muted">${escapeHtml(t.updates)}<a href="${escapeHtml(baseUrl)}/news/index.html">${escapeHtml(t.news)}</a>.</p>

<h2>${escapeHtml(t.notice)}</h2>
<p class="muted">${escapeHtml(t.noticeText)}</p>
<footer>Boxing Angel community server · ${escapeHtml(baseUrl)}</footer>
</main></body></html>`;
}
