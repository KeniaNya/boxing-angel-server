// Pagina publica del servidor (/): que es, descargas (APK + OBB) e instrucciones de instalacion.
// Ingles por defecto; ?lang=es y ?lang=ja. El juego en si solo esta en ingles (los textos traducidos
// viven en las tablas del OBB/servidor y solo se completo el ingles), y la pagina lo explica.
import { config, escapeHtml } from "./config.ts";
import { listFiles, type FileInfo } from "./files.ts";

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export type Lang = "en" | "es" | "ja";
type Strings = {
  title: string; intro: string; online: string; maintenance: string;
  downloads: string; apk: string; apkNote: string; apk64: string; apk64Note: string; obb: string; apkMissing: string; obbMissing: string;
  install: string; requirements: string; step1: string; step2: string; step3: string; step4: string;
  manualSummary: string; manualText: string;
  updates: string; news: string; langNote: string; notice: string; noticeText: string;
  langLabel: string;
};

const T: Record<Lang, Strings> = {
  en: {
    title: "Boxing Angel · community server",
    intro: "Unofficial, fan-run server for <i>Boxing Angel</i> (Mono Play, 2019), whose official servers shut down in July 2019. Status:",
    online: "online", maintenance: "under maintenance",
    downloads: "Downloads", apk: "Game (APK) · legacy 32-bit build", apkNote: "Frozen build: it no longer gets updates. Use it only on phones that cannot run the recommended one (Android 5 and 6). It needs the game data (OBB, {size}), which it downloads by itself on the first run.", apk64: "Game (APK) · recommended", apk64Note: "The current build, and the only one that gets updates. Needs Android 7 or newer, on either 64-bit or 32-bit hardware. Everything is inside the APK: no OBB to download. It installs over any previous APK and keeps your account.", obb: "Game data (OBB) · only for the legacy APK",
    apkMissing: "The APK has not been published yet.", obbMissing: "The OBB file has not been published yet.",
    install: "Installing on Android",
    requirements: "Needs Android 7 (Nougat) or newer, on either 64-bit or 32-bit hardware. Only Android 5 and 6 phones need the legacy 32-bit APK above.",
    step1: "Download and install the <b>APK</b> (allow \"install unknown apps\" if the phone asks).",
    step2: "Open the game with an internet connection. It fetches the server configuration and shows the news; there is nothing else to download, everything is inside the APK.",
    step3: "When it reopens it fetches the server configuration, shows the news and reaches the login screen: tap <b>START</b>, then <b>Fast Login</b> to start playing right away, or <b>Register</b> to pick your own name and password.",
    step4: "<b>Protect your character.</b> A fast account lives only on this phone: if you uninstall the game or change phone, it is gone. Open <b>Settings</b> (tap your name at the top) and choose <b>Binding</b> to give it a name and a password of your own — letters and numbers, 6 to 12 characters. After that you can log in on any phone with <b>Login</b>, and your gym and everything in it come back.",
    manualSummary: "Copy the game data manually (only for the legacy 32-bit APK)",
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
    downloads: "Descargas", apk: "Juego (APK) · versión antigua de 32 bits", apkNote: "Versión congelada: ya no recibe actualizaciones. Úsala solo en teléfonos que no puedan con la recomendada (Android 5 y 6). Necesita los datos del juego (OBB, {size}), que descarga sola en el primer arranque.", apk64: "Juego (APK) · recomendado", apk64Note: "La versión actual, y la única que recibe actualizaciones. Requiere Android 7 o superior, en equipos de 64 o de 32 bits. Todo va dentro del APK: no hay OBB que descargar. Se instala encima de cualquier APK anterior y conserva tu cuenta.", obb: "Datos del juego (OBB) · solo para el APK antiguo",
    apkMissing: "El APK aún no se ha publicado.", obbMissing: "El archivo OBB aún no se ha publicado.",
    install: "Instalación en Android",
    requirements: "Requiere Android 7 (Nougat) o superior, en equipos de 64 o de 32 bits. Solo los teléfonos con Android 5 o 6 necesitan el APK antiguo de 32 bits de arriba.",
    step1: "Descarga e instala el <b>APK</b> (acepta \"instalar apps de origen desconocido\" si el teléfono lo pide).",
    step2: "Abre el juego con internet. Descarga la configuración del servidor y muestra las noticias; no hay nada más que bajar, todo va dentro del APK.",
    step3: "Al volver a abrirse descarga la configuración del servidor, muestra las noticias y llega al login: pulsa <b>START</b> y luego <b>Fast Login</b> para empezar a jugar ya, o <b>Register</b> para elegir tú el usuario y la contraseña.",
    step4: "<b>Protege tu personaje.</b> Una cuenta rápida solo existe en ese teléfono: si desinstalas el juego o cambias de móvil, la pierdes. Entra en <b>Settings</b> (pulsa tu nombre arriba) y elige <b>Binding</b> para ponerle un usuario y una contraseña tuyos — letras y números, de 6 a 12 caracteres. A partir de ahí puedes entrar desde cualquier teléfono con <b>Login</b> y recuperas tu gimnasio con todo.",
    manualSummary: "Copiar los datos a mano (solo para el APK antiguo de 32 bits)",
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
    downloads: "ダウンロード", apk: "ゲーム本体（APK）・旧32ビット版", apkNote: "更新を終了したビルドです。推奨版が動かない端末（Android 5・6）でのみ使用してください。ゲームデータ（OBB、{size}）が必要で、初回起動時に自動でダウンロードします。", apk64: "ゲーム本体（APK）・推奨", apk64Note: "現行ビルドで、今後の更新はこちらだけに入ります。Android 7以降が必要です（64ビット・32ビットのどちらの端末でも動作します）。データはすべてAPKに含まれ、OBBのダウンロードは不要です。以前のAPKの上に上書きインストールでき、アカウントは引き継がれます。", obb: "ゲームデータ（OBB）・旧APK専用",
    apkMissing: "APKはまだ公開されていません。", obbMissing: "OBBファイルはまだ公開されていません。",
    install: "Androidへのインストール",
    requirements: "Android 7（Nougat）以降が必要です（64ビット・32ビットのどちらの端末でも動作します）。上の旧32ビット版APKが必要なのはAndroid 5・6の端末だけです。",
    step1: "<b>APK</b>をダウンロードしてインストールします（「提供元不明のアプリ」の許可を求められたら許可してください）。",
    step2: "インターネットに接続した状態でゲームを起動します。サーバー設定を取得してお知らせを表示します。データはすべてAPKに含まれているため、追加のダウンロードはありません。",
    step3: "再起動後はサーバー設定を取得し、お知らせを表示してログイン画面になります。<b>START</b>をタップし、すぐ遊ぶなら<b>Fast Login</b>、自分でIDとパスワードを決めるなら<b>Register</b>を選んでください。",
    step4: "<b>キャラクターを守りましょう。</b>クイックアカウントはその端末にしか残りません。アンインストールしたり機種変更すると失われます。<b>Settings</b>（上部の名前をタップ）から<b>Binding</b>を選び、自分のIDとパスワード（半角英数字6〜12文字）を設定してください。以降はどの端末からでも<b>Login</b>で入れて、ジムもそのまま戻ります。",
    manualSummary: "ゲームデータを手動でコピーする（旧32ビット版APKのみ）",
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
  const apk64 = files.find((f) => f.name.endsWith(".apk") && /64/.test(f.name));
  const apk = files.find((f) => f.name.endsWith(".apk") && f !== apk64);
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
${apk64 ? row(apk64, t.apk64) + `<p class="note">${escapeHtml(t.apk64Note)}</p>` : `<p class="warn">${escapeHtml(t.apkMissing)}</p>`}
${apk ? row(apk, t.apk) + `<p class="note">${escapeHtml(t.apkNote.replace("{size}", obb ? fmtSize(obb.size) : "153 MB"))}</p>` : ""}
${obb ? row(obb, t.obb) : `<p class="warn">${escapeHtml(t.obbMissing)}</p>`}
${files.filter((f) => f !== apk && f !== apk64 && f !== obb).map((f) => row(f, f.name)).join("")}

<h2>${escapeHtml(t.install)}</h2>
<p class="muted">${escapeHtml(t.requirements)}</p>
<ol>
<li>${t.step1}</li>
<li>${t.step2.replace("{size}", obb ? fmtSize(obb.size) : "153 MB")}</li>
<li>${t.step3}</li>
<li>${t.step4}</li>
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
