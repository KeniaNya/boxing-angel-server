// Estado de jugador (por cuenta). Persistencia en JSON dentro de LENA_APPDATA/data/players/.
// Los nombres de campo siguen el protocolo del cliente (LoginS2C.ParsePlayer / ParseRole / ParseEquip / ParseItem).

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roleTable, chapterIds } from "./gamedata.ts";

const APPDATA = process.env.LENA_APPDATA || join(import.meta.dir, "..");
const DIR = join(APPDATA, "data", "players");

export type Role = {
  auid: string;
  rid: string;
  lv: number;
  exp: number;
  prop: Record<string, number>; // "1".."6"
  pt_amount: number;
  pt_time: number;
  skill: string;
  skill2: string;
  passive_skill: string;
  equip_in: string[]; // 6 huecos
  logistics: string[];
  elite_battle_hp: number;
  elite_battle_anger: number;
  pvp_ai_type: string;
};

export type Equip = { id: string; lv: number; quality: number; slot: string[]; prop: Record<string, number>; buff: Record<string, number>; buff_item: string[] };
export type Skill = { id: string; strengthen_prop: number[] };
export type Score = { ch_id: string; score: number[]; times: number; refresh_times: number };

export type Player = {
  acc: string;
  name: string;
  status: number;
  vcoin_tal: number;
  vip: number;
  lv: number;
  exp: number;
  coin: number[]; // general, virtual, pvp, elite
  last_use: string; // rid activo
  ap: number;
  ap_time: number; // ms
  tp: number;
  tp_time: number; // ms
  ch_progress: string;
  ech_progress: string;
  eb_progress: string;
  ch_outer_times: number[];
  ch_special_times: number[];
  gacha_cosplay_times: number;
  gacha_choice_times: number;
  gacha_normal_times: number;
  gacha_normal_flag: number;
  gacha_virtual_times: number;
  gacha_virtual_flag: number;
  gold_finger_times: number;
  buy_ap_times: number;
  buy_tp_times: number;
  passers_times: number;
  pvp_times: number;
  pvp_flag: number;
  pvp_rank: number;
  pvp_role: string;
  pvp_victory: number;
  pvp_fail: number;
  buy_pvp_times: number;
  refresh_pvp_times: number;
  teaching_flag: number;
  signin_times: number;
  signin_flag: number;
  buy_blood_times: number;
  frist_buy_iapb: string[];
  vip_times: number;
  entertain_times: number;
  entertain_flag: string;
  eb_re_times: number;
  friend_times: number;
  roles: Record<string, Role>;
  equips: Equip[];
  items: Record<string, number>;
  skills: Skill[];
  scores: Score[];
  createdAt: string;
  /** Estado por dominio (misiones, correo, amigos, PvP...). Cada modulo de src/handlers/ guarda lo suyo bajo su clave. */
  ext: Record<string, unknown>;
};

const cache = new Map<string, Player>();

function file(acc: string) {
  return join(DIR, encodeURIComponent(acc) + ".json");
}

export function loadPlayer(acc: string): Player | null {
  const c = cache.get(acc);
  if (c) return c;
  const f = file(acc);
  if (!existsSync(f)) return null;
  const p = JSON.parse(readFileSync(f, "utf8")) as Player;
  if (!p.ext) p.ext = {};
  cache.set(acc, p);
  return p;
}

export function savePlayer(p: Player) {
  mkdirSync(DIR, { recursive: true });
  const f = file(p.acc);
  writeFileSync(f + ".tmp", JSON.stringify(p, null, 2));
  renameSync(f + ".tmp", f);
  cache.set(p.acc, p);
}

export function newRole(rid: string): Role {
  const info = roleTable().get(rid);
  return {
    auid: String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
    rid,
    lv: 1,
    exp: 0,
    prop: { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1 },
    pt_amount: 10,
    pt_time: 0,
    skill: "",
    skill2: "",
    passive_skill: "",
    equip_in: info ? [...info.defaultEquip] : ["", "", "", "", "", ""],
    logistics: [],
    elite_battle_hp: 100,
    elite_battle_anger: 0,
    pvp_ai_type: "",
  };
}

export function newEquip(id: string): Equip {
  return { id, lv: 1, quality: 1, slot: [], prop: {}, buff: {}, buff_item: [] };
}

/** Inventario inicial (tomado del stub offline del cliente, sin los "x50 de todo" de pruebas). */
const STARTER_ITEMS: Record<string, number> = {
  "0503052": 200, "0501002": 10, "0506052": 7, "0504014": 3, "0504007": 50, "0501004": 1,
  "0202001": 1000, "0202004": 10, "0504005": 3, "0510023": 5, "0201039": 104, "0201004": 28,
  "0202011": 15, "0202012": 2, "0510015": 150,
};

export function createPlayer(acc: string, name: string, rid: string): Player {
  const now = Date.now();
  const role = newRole(rid);
  const p: Player = {
    acc, name, status: 10, vcoin_tal: 0, vip: 0, lv: 1, exp: 0,
    coin: [5000, 300, 0, 0],
    last_use: rid,
    ap: 59, ap_time: now, tp: 10, tp_time: now,
    ch_progress: "1001010", ech_progress: "1001181", eb_progress: "",
    ch_outer_times: [0, 0], ch_special_times: [0, 0, 0, 0],
    gacha_cosplay_times: 5, gacha_choice_times: 2, gacha_normal_times: 5, gacha_normal_flag: now,
    gacha_virtual_times: 1, gacha_virtual_flag: now,
    gold_finger_times: 0, buy_ap_times: 0, buy_tp_times: 0, passers_times: 0,
    pvp_times: 0, pvp_flag: 0, pvp_rank: 0, pvp_role: "", pvp_victory: 0, pvp_fail: 0, buy_pvp_times: 0, refresh_pvp_times: 0,
    teaching_flag: 0, signin_times: 20, signin_flag: 0, buy_blood_times: 0, frist_buy_iapb: [], vip_times: 0,
    entertain_times: 0, entertain_flag: "", eb_re_times: 0, friend_times: 0,
    roles: { [rid]: role },
    equips: role.equip_in.filter((e) => e !== "").map(newEquip),
    items: { ...STARTER_ITEMS },
    skills: [],
    scores: chapterIds().map((ch_id) => ({ ch_id, score: [0, 0, 0], times: 0, refresh_times: 0 })),
    createdAt: new Date(now).toISOString(),
    ext: {},
  };
  savePlayer(p);
  return p;
}

export function newSessionKey(): string {
  return randomUUID().replace(/-/g, "");
}

/** Estado de un dominio dentro de player.ext (se crea con `init` la primera vez). */
export function ext<T>(p: Player, key: string, init: () => T): T {
  if (!p.ext) p.ext = {};
  if (p.ext[key] === undefined) p.ext[key] = init();
  return p.ext[key] as T;
}

/** Todos los jugadores guardados (para rankings, busqueda de amigos, oponentes PvP). */
export function listPlayers(): Player[] {
  if (!existsSync(DIR)) return [];
  const out: Player[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const acc = decodeURIComponent(f.slice(0, -5));
    const p = loadPlayer(acc);
    if (p) out.push(p);
  }
  return out;
}
