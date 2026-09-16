// Configuracion editable en caliente (panel /admin). Se persiste en LENA_APPDATA/data/config.json;
// los valores no guardados salen de las variables de entorno (server.env) o de los defaults.
// Cualquier modulo puede leerla con config(); los cambios avisan por onConfigChange (p. ej. para
// regenerar el zip de Setting).

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { RewardItem } from "./economy.ts";

/** sexySystem: "ropa que se rompe" en combate (version japonesa). La build tailandesa lo traia apagado desde un
 *  config remoto (LoadConfigDB -> api_config.php, muerto): con el flag el servidor sirve ese config con "open" y pone
 *  brokenMode=0 en Android_connect_info; sin el, "close" y brokenMode=2 (el cliente desactiva la rotura por HP). */
export type Flags = { showTutorial: 0 | 1; isNPC: 0 | 1; isStory: 0 | 1; isPVP: 0 | 1; sexySystem: 0 | 1 };
export type ServerConfig = {
  /** 1 = el servidor comunitario es el recomendado; 0 = el modo offline del cliente */
  connection: 0 | 1;
  /** Nombre del servidor en el selector del login */
  networkName: string;
  /** Version de las tablas (subirla fuerza re-descarga del zip de Setting en el cliente) */
  dataVersion: number;
  flags: Flags;
  /** Tercer panel del gacha: 1 = Select (Choice), 2 = Cosplay */
  gachaType: 1 | 2;
  /** Noticias (popup del login y webviews del lobby) */
  news: { title: string; body: string };
  /** Codigos de canje: CODIGO -> recompensas */
  redeemCodes: Record<string, RewardItem[]>;
  /** Capitulos especiales abiertos hoy (GetTodayOpenChapter): codigos "TTCC" (15xx tour, 16xx liga especial).
   *  Lista vacia = automatico segun el horario semanal de week_open_chapter_info. */
  openChapters: string[];
  /** Mensaje de mantenimiento: si no esta vacio, el login HTTP responde error y el cliente lo muestra */
  maintenance: string;
  /** Parametros de economia que no vienen de las tablas del juego (editables desde el panel) */
  economy: Economy;
};

export type Economy = {
  /** Gacha: % de equipo y % de fragmentos por tirada (el resto son componentes). Claves: normal, virtual, choice */
  gachaWeights: Record<"normal" | "virtual" | "choice", [number, number]>;
  /** La tirada de 10 garantiza al menos un equipo */
  gachaTenGuaranteesEquip: boolean;
  /** Oro base por asalto ganado en historia (se multiplica por la columna de oro del capitulo) */
  goldPerRound: number;
  /** Oro base por combate de elite ganado */
  eliteWinGold: number;
  /** Recompensa diaria por puesto PvP (pvp_reward_info) al abrir el PvP */
  pvpDailyRewards: boolean;
  /** Bolsas regalo: oro por unidad (saiqianxiang) y diamantes por unidad (zuanshi*) */
  giftBagGold: number;
  giftBagDiamonds: number;
  /** Calendario de firma: ciclo de recompensas (cada 7 dias cae un fragmento del gacha de diamantes) */
  signinCycle: RewardItem[];
  /** Jugador nuevo: oro, diamantes y energia iniciales */
  starterGold: number;
  starterDiamonds: number;
  starterAp: number;
  /** Correo de bienvenida */
  welcomeMail: { sender: string; title: string; content: string; annex: RewardItem[] };
};

const APPDATA = process.env.LENA_APPDATA || join(import.meta.dir, "..");
const FILE = join(APPDATA, "data", "config.json");

export const DEFAULTS: ServerConfig = {
  connection: process.env.GAME_CONNECTION === "1" ? 1 : 0,
  networkName: process.env.NETWORK_NAME || "Community",
  dataVersion: Number(process.env.DATA_VERSION || 1),
  flags: { showTutorial: 1, isNPC: 1, isStory: 1, isPVP: 0, sexySystem: 1 },
  gachaType: 1,
  news: {
    title: "Boxing Angel · servidor comunitario",
    body: "<p>Este es un servidor no oficial mantenido por fans. El juego original cerro en 2019.</p>",
  },
  redeemCodes: {
    WELCOME: [{ id: "vcoin", amount: 300 }, { id: "gcoin", amount: 5000 }],
    BOXINGANGEL: [{ id: "0201001", amount: 5 }, { id: "0201002", amount: 3 }, { id: "vcoin", amount: 100 }],
    REVIVAL: [{ id: "0202004", amount: 5 }, { id: "gcoin", amount: 10000 }],
  },
  openChapters: [],
  maintenance: "",
  economy: {
    gachaWeights: { normal: [5, 35], virtual: [15, 45], choice: [20, 50] },
    gachaTenGuaranteesEquip: true,
    goldPerRound: 100,
    eliteWinGold: 500,
    pvpDailyRewards: true,
    giftBagGold: 10000,
    giftBagDiamonds: 10,
    signinCycle: [
      { id: "gcoin", amount: 500 }, { id: "vcoin", amount: 20 }, { id: "gcoin", amount: 800 },
      { id: "pcoin", amount: 100 }, { id: "vcoin", amount: 30 }, { id: "gcoin", amount: 1000 },
    ],
    starterGold: 5000,
    starterDiamonds: 300,
    starterAp: 59,
    welcomeMail: {
      sender: "Boxing Angel",
      title: "Welcome to Boxing Angel!",
      content: "Thanks for joining the community server. Here is a small gift to get you started. Have fun!",
      annex: [{ id: "gcoin", amount: 3000 }, { id: "vcoin", amount: 50 }, { id: "0202005", amount: 2 }],
    },
  },
};

let current: ServerConfig | null = null;
const listeners: Array<(c: ServerConfig) => void> = [];

function load(): ServerConfig {
  let saved: Partial<ServerConfig> = {};
  if (existsSync(FILE)) {
    try {
      saved = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      /* archivo corrupto: se ignora y se usan los defaults */
    }
  }
  return merge(DEFAULTS, saved);
}

function merge(base: ServerConfig, patch: Partial<ServerConfig>): ServerConfig {
  const out: ServerConfig = { ...base, ...patch };
  out.flags = { ...base.flags, ...(patch.flags ?? {}) };
  out.news = { ...base.news, ...(patch.news ?? {}) };
  if (patch.redeemCodes) out.redeemCodes = { ...patch.redeemCodes };
  if (patch.openChapters) out.openChapters = [...patch.openChapters];
  out.economy = { ...base.economy, ...(patch.economy ?? {}) };
  out.economy.gachaWeights = { ...base.economy.gachaWeights, ...(patch.economy?.gachaWeights ?? {}) };
  out.economy.welcomeMail = { ...base.economy.welcomeMail, ...(patch.economy?.welcomeMail ?? {}) };
  return out;
}

export function config(): ServerConfig {
  if (!current) current = load();
  return current;
}

/** Valida y aplica un parche; devuelve la configuracion resultante. Lanza Error con texto legible si algo no vale. */
export function updateConfig(patch: Partial<ServerConfig>): ServerConfig {
  const p: Partial<ServerConfig> = {};
  if (patch.connection !== undefined) {
    if (patch.connection !== 0 && patch.connection !== 1) throw new Error("connection debe ser 0 o 1");
    p.connection = patch.connection;
  }
  if (patch.networkName !== undefined) {
    const n = String(patch.networkName).trim();
    if (!n || n.length > 24 || /[\t\r\n]/.test(n)) throw new Error("networkName: 1-24 caracteres sin tabuladores");
    p.networkName = n;
  }
  if (patch.dataVersion !== undefined) {
    const v = Number(patch.dataVersion);
    if (!Number.isInteger(v) || v < 1) throw new Error("dataVersion debe ser un entero >= 1");
    p.dataVersion = v;
  }
  if (patch.flags) {
    const f: Partial<Flags> = {};
    for (const k of ["showTutorial", "isNPC", "isStory", "isPVP", "sexySystem"] as const) {
      if (patch.flags[k] !== undefined) f[k] = patch.flags[k] ? 1 : 0;
    }
    p.flags = { ...config().flags, ...f };
  }
  if (patch.gachaType !== undefined) {
    if (patch.gachaType !== 1 && patch.gachaType !== 2) throw new Error("gachaType debe ser 1 (Select) o 2 (Cosplay)");
    p.gachaType = patch.gachaType;
  }
  if (patch.news) {
    p.news = { title: String(patch.news.title ?? config().news.title).slice(0, 200), body: String(patch.news.body ?? config().news.body).slice(0, 20000) };
  }
  if (patch.redeemCodes) {
    const codes: Record<string, RewardItem[]> = {};
    for (const [code, rewards] of Object.entries(patch.redeemCodes)) {
      const c = code.trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,32}$/.test(c)) throw new Error(`codigo invalido: ${code}`);
      codes[c] = normalizeRewards(rewards);
    }
    p.redeemCodes = codes;
  }
  if (patch.openChapters) {
    p.openChapters = patch.openChapters.map(String).filter((s) => /^\d{4}$/.test(s));
  }
  if (patch.maintenance !== undefined) p.maintenance = String(patch.maintenance).slice(0, 500);
  if (patch.economy) p.economy = validateEconomy(patch.economy);

  current = merge(config(), p);
  mkdirSync(join(APPDATA, "data"), { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(current, null, 2));
  renameSync(FILE + ".tmp", FILE);
  for (const l of listeners) l(current);
  return current;
}

export function onConfigChange(fn: (c: ServerConfig) => void): void {
  listeners.push(fn);
}

function num(v: unknown, name: string, min: number, max: number, integer = true): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${name}: valor invalido (${min}-${max})`);
  return n;
}

/** Valida un parche parcial de economia sobre la configuracion actual. */
function validateEconomy(e: Partial<Economy>): Economy {
  const cur = config().economy;
  const out: Economy = { ...cur, gachaWeights: { ...cur.gachaWeights }, welcomeMail: { ...cur.welcomeMail } };
  if (e.gachaWeights) {
    for (const k of ["normal", "virtual", "choice"] as const) {
      const w = e.gachaWeights[k];
      if (!w) continue;
      const a = num(w[0], `gacha ${k} equipo %`, 0, 100), b = num(w[1], `gacha ${k} fragmento %`, 0, 100);
      if (a + b > 100) throw new Error(`gacha ${k}: equipo + fragmento no puede superar 100 %`);
      out.gachaWeights[k] = [a, b];
    }
  }
  if (e.gachaTenGuaranteesEquip !== undefined) out.gachaTenGuaranteesEquip = !!e.gachaTenGuaranteesEquip;
  if (e.goldPerRound !== undefined) out.goldPerRound = num(e.goldPerRound, "oro por asalto", 0, 1_000_000);
  if (e.eliteWinGold !== undefined) out.eliteWinGold = num(e.eliteWinGold, "oro por elite", 0, 1_000_000);
  if (e.pvpDailyRewards !== undefined) out.pvpDailyRewards = !!e.pvpDailyRewards;
  if (e.giftBagGold !== undefined) out.giftBagGold = num(e.giftBagGold, "oro de bolsa", 0, 10_000_000);
  if (e.giftBagDiamonds !== undefined) out.giftBagDiamonds = num(e.giftBagDiamonds, "diamantes de bolsa", 0, 1_000_000);
  if (e.signinCycle) {
    out.signinCycle = normalizeRewards(e.signinCycle);
    if (out.signinCycle.length < 1) throw new Error("el ciclo de firma necesita al menos una recompensa");
  }
  if (e.starterGold !== undefined) out.starterGold = num(e.starterGold, "oro inicial", 0, 10_000_000);
  if (e.starterDiamonds !== undefined) out.starterDiamonds = num(e.starterDiamonds, "diamantes iniciales", 0, 1_000_000);
  if (e.starterAp !== undefined) out.starterAp = num(e.starterAp, "energia inicial", 0, 999);
  if (e.welcomeMail) {
    const m = e.welcomeMail;
    if (m.sender !== undefined) out.welcomeMail.sender = String(m.sender).slice(0, 40) || "Boxing Angel";
    if (m.title !== undefined) out.welcomeMail.title = String(m.title).slice(0, 80);
    if (m.content !== undefined) out.welcomeMail.content = String(m.content).slice(0, 500);
    if (m.annex !== undefined) out.welcomeMail.annex = normalizeRewards(m.annex);
  }
  return out;
}

/** Lista de recompensas saneada: {id, amount} con id alfanumerico y cantidad entera positiva. */
export function normalizeRewards(list: unknown): RewardItem[] {
  if (!Array.isArray(list)) throw new Error("recompensas: se esperaba una lista");
  return list.map((r) => {
    const id = String((r as RewardItem)?.id ?? "").trim();
    const amount = Math.floor(Number((r as RewardItem)?.amount));
    if (!/^[A-Za-z0-9_]{1,32}$/.test(id)) throw new Error(`id de recompensa invalido: ${id}`);
    if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) throw new Error(`cantidad invalida para ${id}`);
    return { id, amount };
  });
}

/** HTML completo de la pagina de noticias a partir de la configuracion. */
export function newsHtml(c = config()): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="margin:0;background:#1a1020;color:#f3e9ff;font-family:sans-serif;padding:16px">
<h2 style="margin:0 0 8px">${escapeHtml(c.news.title)}</h2>
${c.news.body}
</body>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
