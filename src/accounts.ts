// Cuentas del login server (BALoginServer). Persistencia simple en JSON dentro de
// LENA_APPDATA (sobrevive a los deploys). Se migrara a LenaDB cuando haga falta.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export type Account = {
  acc: string;
  salt: string;
  hash: string;
  type: number;
  createdAt: string;
  lastLoginAt?: string;
};

export type Session = { token: string; acc: string; issuedAt: number };

const APPDATA = process.env.LENA_APPDATA || join(import.meta.dir, "..");
const DATA_DIR = join(APPDATA, "data");
const FILE = join(DATA_DIR, "accounts.json");

let accounts: Map<string, Account> = new Map();
const sessions: Map<string, Session> = new Map();

export function loadAccounts(): number {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(FILE)) {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Account[];
    accounts = new Map(raw.map((a) => [a.acc, a]));
  }
  return accounts.size;
}

function save() {
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify([...accounts.values()], null, 2));
  renameSync(tmp, FILE);
}

function hashPassword(pwd: string, salt: string): string {
  return scryptSync(pwd, salt, 32).toString("hex");
}

export const ACC_RE = /^[A-Za-z0-9_.@-]{6,64}$/;

// Codigos que el cliente localiza (Localization del juego, claves Http_*):
//   1003 "Wrong data" · 1005 "This account do not exist" · 1008 "This account is already in use"
//   1027 "Game version is too old" (fuerza actualizacion)
export const HTTP_WRONG_DATA = 1003;
export const HTTP_NO_ACCOUNT = 1005;
export const HTTP_ACCOUNT_TAKEN = 1008;

/** Devuelve 0 si se creo, 1008 si ya existe, 1003 si el formato es invalido. */
export function createAccount(acc: string, pwd: string, type: number): number {
  if (!ACC_RE.test(acc) || pwd.length < 6 || pwd.length > 128) return HTTP_WRONG_DATA;
  if (accounts.has(acc)) return HTTP_ACCOUNT_TAKEN;
  const salt = randomBytes(16).toString("hex");
  accounts.set(acc, { acc, salt, hash: hashPassword(pwd, salt), type, createdAt: new Date().toISOString() });
  save();
  return 0;
}

/** Devuelve 0 y un token si las credenciales son validas; 1005 si la cuenta no existe; 1003 si la clave es incorrecta. */
export function verifyAccount(acc: string, pwd: string): { res: number; token?: string } {
  const a = accounts.get(acc);
  if (!a) return { res: HTTP_NO_ACCOUNT };
  const given = Buffer.from(hashPassword(pwd, a.salt), "hex");
  const stored = Buffer.from(a.hash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return { res: HTTP_WRONG_DATA };
  a.lastLoginAt = new Date().toISOString();
  save();
  const token = randomUUID();
  sessions.set(token, { token, acc, issuedAt: Date.now() });
  return { res: 0, token };
}

export function resolveToken(token: string): Session | undefined {
  return sessions.get(token);
}

/** Borra una cuenta del login (y sus sesiones). El personaje se borra aparte (players.deletePlayer). */
export function deleteAccount(acc: string): boolean {
  if (!accounts.delete(acc)) return false;
  for (const [t, s] of sessions) if (s.acc === acc) sessions.delete(t);
  save();
  return true;
}

export function accountCount(): number {
  return accounts.size;
}

/** Todas las cuentas (para el panel de administracion). */
export function listAccounts(): Account[] {
  return [...accounts.values()];
}
