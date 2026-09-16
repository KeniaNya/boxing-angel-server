// Tablas de "Setting" que el cliente descargaba en un zip desde el servidor original.
// Formato (deducido de CSDatabase.ParseTextData): texto tabulado, la primera linea es
// cabecera y se ignora; campos separados por TAB; lineas por \r\n o \n.
// Indices de campo tomados de CSDatabase.InitChannelVersionData, LoadNetworkInfoData y
// CSDownload.CheckSettingData del cliente decompilado.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildZip } from "./zip.ts";

export type SettingsConfig = {
  /** Host publico (sin esquema) que el cliente usara para login: http://<host>/BALoginServer/... */
  host: string;
  /** Base URL publica con esquema, p. ej. http://boxingangel.lenasuite.org */
  baseUrl: string;
  /** 1 = el cliente habla con el servidor de juego; 0 = modo offline integrado en el cliente */
  connection: 0 | 1;
  /** Versiones del cliente para las que emitir la linea de Android_connect_info (debe coincidir con CSSceneManager.m_Version) */
  clientVersions: string[];
  /** Nombre del servidor que se muestra en el selector */
  networkName: string;
  /** Version de las tablas de datos (network_info campo 9); subirla fuerza re-descarga del zip de datos */
  dataVersion: number;
  /** Flags de funciones (Android_connect_info) */
  flags: { showTutorial: 0 | 1; isNPC: 0 | 1; isStory: 0 | 1; isPVP: 0 | 1; sexySystem: 0 | 1 };
  /** Precio en diamantes de los personajes de pago (0 = el de role_info): se sirve una role_info corregida en el zip */
  rolePriceDiamonds: number;
};

const CRLF = "\r\n";
const row = (fields: (string | number)[]) => fields.join("\t");

export function channelVersion(cfg: SettingsConfig): string {
  // id, version minima requerida, URL de descarga del APK, fiveStar, tucao, nombre de tabla de red, iapType
  return [
    row(["id", "version", "downloadURL", "fiveStarURL", "tucaoURL", "networkFileName", "iapType"]),
    row([1, "1.0.0", `${cfg.baseUrl}/download`, "", "", "network_info_base", 0]),
  ].join(CRLF) + CRLF;
}

export function networkInfo(cfg: SettingsConfig): string {
  // 0 id, 1 name, 2 order (>0 para poder loguear; el mayor es el recomendado), 3 connection,
  // 4 ip (host del login server), 5 fileIP, 6 resourceType (0 = tablas desde Resources/OBB),
  // 7 (sin uso), 8 urlNews, 9 version, 10 fileUrl, 11 iapCallbackAndroid, 12 iapCallbackIos,
  // 13 zipFileName, 14 zipFileURL, 15 ddmUrl
  return [
    row(["id", "name", "order", "connection", "ip", "fileIP", "resourceType", "unused", "urlNews", "version", "fileUrl", "iapAndroid", "iapIos", "zipFileName", "zipFileURL", "ddmUrl"]),
    // resourceType 2 (Zip): las tablas se leen primero de la cache (nuestro zip) y si no, del OBB.
    // zipFileName "setting": el "zip de datos" es este mismo zip de Setting.
    // Dos entradas: la de mayor "order" es la recomendada; la otra se elige en el selector de servidor del login.
    //   id 1 = modo offline integrado (connection 0) · id 2 = servidor comunitario (connection 1, socket HTTP)
    row([1, `${cfg.networkName} (offline)`, cfg.connection === 0 ? 2 : 1, 0, cfg.host, `${cfg.baseUrl}/boxingangel/files/`, 2, "", `${cfg.baseUrl}/news/index.html`, cfg.dataVersion, "", "", "", "setting", "", ""]),
    row([2, cfg.networkName, cfg.connection === 1 ? 2 : 1, 1, cfg.host, `${cfg.baseUrl}/boxingangel/files/`, 2, "", `${cfg.baseUrl}/news/index.html`, cfg.dataVersion, "", "", "", "setting", "", ""]),
  ].join(CRLF) + CRLF;
}

export function androidConnectInfo(cfg: SettingsConfig): string {
  // 0 version del cliente, 1 host de bundles (se le anade "/Android/"), 2 isExchange, 3 newsURL,
  // 4 iapSandbox, 5 useCommunity (Facebook), 6 brokenMode, 7 brokenModel, 8 lotteryEventImage,
  // 9 showTutorial, 10 lockSystem, 11 useIAP, 12-14 sin uso conocido, 15 isNPC, 16 isStory,
  // 17 isPVP, 18 isFive (pedir valoracion), 19 isChangeCoin
  // brokenMode (CSDownload.CheckSettingData): 0 = rotura de ropa con el modelo "爆衣ID" de equip_info (col 30), 1 = modelo+"_B"
  // (esos prefabs no existen en el OBB tailandes), 2 = desactivada (m_BrokenMoldeHP = -1), 3 = "desnudo". brokenModel = modelo
  // de reserva (CSDataCenter.m_BrokenMolde, por defecto CH00BC51: una cadena vacia lo anulaba). La rotura ademas exige que el
  // cliente tenga PlayerPrefs "sexysystem" = 1, que llega por /reward/game-config/api_config.php (gameConfigJson).
  const header = row(["version", "bundleHost", "isExchange", "newsURL", "iapSandbox", "useCommunity", "brokenMode", "brokenModel", "lotteryEventImage", "showTutorial", "lockSystem", "useIAP", "f12", "f13", "f14", "isNPC", "isStory", "isPVP", "isFive", "isChangeCoin"]);
  const brokenMode = cfg.flags.sexySystem ? 0 : 2;
  const lines = cfg.clientVersions.map((v) =>
    row([v, `${cfg.baseUrl}/boxingangel/bundles/Google`, 0, `${cfg.baseUrl}/news/index.html`, 0, 0, brokenMode, "CH00BC51", `${cfg.baseUrl}/boxingangel/image/`, cfg.flags.showTutorial, 0, 0, 0, 0, 0, cfg.flags.isNPC, cfg.flags.isStory, cfg.flags.isPVP, 0, 0]),
  );
  return [header, ...lines].join(CRLF) + CRLF;
}

/**
 * Config remota del cliente (LoadConfigDB.test: POST https://boxingangel-apipay.monogame.in.th/reward/game-config/api_config.php,
 * el cliente parcheado la pide a nuestro host). Indices fijos del cliente: data[0] sexysystem ("open"/"close"), [2] version que
 * fuerza actualizacion en Android ("" = nunca), [3] idem iOS, [4] bossdifficult, [5] storydifficult, [6] pvpdifficult,
 * [7] assassindifficult, [8] dualdifficult (se suman a la IA del rival; 0 = como hasta ahora), [9] gamesms (promocion por SMS
 * tailandesa: "version-d/m/a/hora-d/m/a/hora", fechas del 2000 para que nunca salte), [10] sandboxversion.
 */
export function gameConfigJson(cfg: SettingsConfig): { status: string; data: { name: string; value: string }[] } {
  const sexy = cfg.flags.sexySystem ? "open" : "close";
  const data = [
    ["sexysystemandroid", sexy], ["sexysystemios", sexy], ["forceupdateandroid", ""], ["forceupdateios", ""],
    ["bossdifficult", "0"], ["storydifficult", "0"], ["pvpdifficult", "0"], ["assassindifficult", "0"], ["dualdifficult", "0"],
    ["gamesms", "0-1/1/2000/00:00-1/1/2000/00:00"], ["sandboxversion", ""],
  ].map(([name, value]) => ({ name, value }));
  return { status: "OK", data };
}

export function coverLocalization(): string {
  // Sobrescrituras de textos (clave TAB valor). Vacio por ahora: solo cabecera.
  return row(["key", "value"]) + CRLF;
}

/**
 * Tablas del OBB corregidas a partir de la configuracion (se generan al vuelo, a diferencia de las de `tables/`).
 * role_info.txt: col 5 = precio en diamantes de cada personaje; con rolePriceDiamonds > 0 se sustituye el de los
 * personajes de pago para que el cliente muestre y cobre lo mismo que el servidor (handlers/inventory.ts BuyRoleC2S).
 */
export function dynamicTables(cfg: SettingsConfig): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  if (cfg.rolePriceDiamonds > 0) {
    const raw = readFileSync(join(import.meta.dir, "..", "gamedata", "role_info.txt"), "utf8");
    const lines = raw.split("\n").map((line, i) => {
      if (i === 0) return line;
      const eol = line.endsWith("\r") ? "\r" : "";
      const f = (eol ? line.slice(0, -1) : line).split("\t");
      if (!/^\d+$/.test(f[0] ?? "") || Number(f[5]) <= 0) return line;
      f[5] = String(cfg.rolePriceDiamonds);
      return f.join("\t") + eol;
    });
    out.push({ name: "role_info.txt", data: new TextEncoder().encode(lines.join("\n")) });
  }
  return out;
}

/** Indice de AssetBundles vacio: el cliente no descarga nada y carga todo desde el OBB. */
export function bundleDatabaseList(): string {
  return "@default_version\t1\n";
}

/**
 * Zip de Setting. Ademas de las 4 tablas de configuracion incluye las tablas de datos
 * corregidas de `tables/` (sobrescriben a las del OBB: con resourceType=2 el cliente lee
 * primero temporaryCachePath/<nombre>.txt, donde se descomprime este zip en cada arranque).
 */
export function settingsZip(cfg: SettingsConfig, overrideTables: { name: string; data: Uint8Array }[] = []): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const overridden = new Set(overrideTables.map((t) => t.name));
  // Las tablas generadas ceden ante un override del mismo nombre en tables/ (p. ej. cover_localization.txt
  // con la traduccion inglesa de la interfaz): un zip con dos entradas iguales seria ambiguo.
  const generated = [
    { name: "channelVersion.txt", data: enc.encode(channelVersion(cfg)) },
    { name: "cover_localization.txt", data: enc.encode(coverLocalization()) },
    { name: "network_info_base.txt", data: enc.encode(networkInfo(cfg)) },
    { name: "Android_connect_info.txt", data: enc.encode(androidConnectInfo(cfg)) },
  ].filter((t) => !overridden.has(t.name));
  return buildZip([...generated, ...overrideTables]);
}
