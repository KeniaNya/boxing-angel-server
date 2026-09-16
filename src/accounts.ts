// Cuentas del login server (BALoginServer). Persistencia simple en JSON dentro de
// LENA_APPDATA (sobrevive a los deploys). Se migrara a LenaDB cuando haga falta.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export type Account = {
  /** Nombre de acceso (el que el jugador escribe). Cambia al vincular una cuenta rapida. */
  acc: string;
  /** Clave de datos del jugador (data/players/<key>.json). Solo esta si `acc` ya no coincide
   *  con ella, es decir, si la cuenta era rapida y se vinculo. NUNCA cambia: los amigos, el
   *  ranking PvP y el correo guardan esta cadena como identidad del jugador. */
  key?: string;
  salt: string;
  hash: string;
  type: number;
  createdAt: string;
  lastLoginAt?: string;
  /** Cuando se vinculo (cuenta rapida -> cuenta con contrasena). */
  boundAt?: string;
};

export type Session = { token: string; acc: string; key: string; issuedAt: number };

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

/** Clave de datos de una cuenta (ver Account.key). Para cuentas no vinculadas es el propio nombre. */
export function playerKey(acc: string): string {
  return accounts.get(acc)?.key ?? acc;
}

/**
 * Un nombre esta ocupado si es el de una cuenta O la clave de datos de otra. Lo segundo importa
 * porque al vincular se libera el nombre rapido viejo, pero sigue siendo el nombre del archivo del
 * personaje: si alguien creara una cuenta con ese nombre, entraria al personaje del otro.
 */
function nameTaken(name: string): boolean {
  if (accounts.has(name)) return true;
  for (const a of accounts.values()) if (a.key === name) return true;
  return false;
}

function passwordOk(a: Account, pwd: string): boolean {
  const given = Buffer.from(hashPassword(pwd, a.salt), "hex");
  const stored = Buffer.from(a.hash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

// Codigos que el cliente localiza (Localization del juego, claves Http_*):
//   1003 "Wrong data" · 1005 "This account do not exist" · 1008 "This account is already in use"
//   1027 "Game version is too old" (fuerza actualizacion)
export const HTTP_WRONG_DATA = 1003;
export const HTTP_NO_ACCOUNT = 1005;
export const HTTP_ACCOUNT_TAKEN = 1008;

/** Devuelve 0 si se creo, 1008 si ya existe, 1003 si el formato es invalido. */
export function createAccount(acc: string, pwd: string, type: number): number {
  if (!ACC_RE.test(acc) || pwd.length < 6 || pwd.length > 128) return HTTP_WRONG_DATA;
  if (nameTaken(acc)) return HTTP_ACCOUNT_TAKEN;
  const salt = randomBytes(16).toString("hex");
  accounts.set(acc, { acc, salt, hash: hashPassword(pwd, salt), type, createdAt: new Date().toISOString() });
  save();
  return 0;
}

/** Devuelve 0 y un token si las credenciales son validas; 1005 si la cuenta no existe; 1003 si la clave es incorrecta. */
export function verifyAccount(acc: string, pwd: string): { res: number; token?: string } {
  const a = accounts.get(acc);
  if (!a) return { res: HTTP_NO_ACCOUNT };
  if (!passwordOk(a, pwd)) return { res: HTTP_WRONG_DATA };
  a.lastLoginAt = new Date().toISOString();
  save();
  const token = randomUUID();
  sessions.set(token, { token, acc, key: a.key ?? a.acc, issuedAt: Date.now() });
  return { res: 0, token };
}

/**
 * Vinculacion de una cuenta rapida (FastAccBinding): el jugador entro con el boton "Fast Login",
 * que genera acc/pwd aleatorios y solo los guarda en el PlayerPrefs del telefono; si desinstala,
 * pierde el personaje. Vincular le pone un nombre y una contrasena suyos SIN mover los datos: la
 * cuenta conserva su `key` original, que es la identidad que ya guardan amigos, ranking y correo.
 *
 * Codigos: los que el cliente localiza como `Binding_<res>`.
 *   0 ok · 1003 formato invalido · 1005 la cuenta rapida no existe o la clave no coincide
 *   1008 el nombre elegido ya esta en uso, o la cuenta ya estaba vinculada
 */
export function bindAccount(fastAcc: string, fastPwd: string, newAcc: string, newPwd: string, type: number): number {
  const a = accounts.get(fastAcc);
  if (!a || !passwordOk(a, fastPwd)) return HTTP_NO_ACCOUNT;
  if (a.type !== 0) return HTTP_ACCOUNT_TAKEN; // solo las cuentas rapidas se vinculan
  if (!ACC_RE.test(newAcc) || newPwd.length < 6 || newPwd.length > 128) return HTTP_WRONG_DATA;
  if (nameTaken(newAcc)) return HTTP_ACCOUNT_TAKEN;
  renameLogin(a, newAcc, newPwd, type || 1);
  a.boundAt = new Date().toISOString();
  save();
  return 0;
}

/**
 * Cambia el nombre de acceso y la contrasena de una cuenta conservando su personaje (panel /admin).
 * Es la via de rescate para quien perdio una cuenta rapida antes de vincularla: se busca su
 * personaje por nombre y se le dan credenciales nuevas. Devuelve los mismos codigos que bindAccount.
 */
export function setAccountLogin(acc: string, newAcc: string, newPwd: string): number {
  const a = accounts.get(acc);
  if (!a) return HTTP_NO_ACCOUNT;
  if (!ACC_RE.test(newAcc) || newPwd.length < 6 || newPwd.length > 128) return HTTP_WRONG_DATA;
  if (newAcc !== acc && newAcc !== (a.key ?? a.acc) && nameTaken(newAcc)) return HTTP_ACCOUNT_TAKEN;
  renameLogin(a, newAcc, newPwd, a.type === 0 ? 1 : a.type);
  save();
  return 0;
}

/** Reescribe nombre/clave/tipo de una cuenta dejando intacta su clave de datos y sus sesiones abiertas. */
function renameLogin(a: Account, newAcc: string, newPwd: string, type: number) {
  const key = a.key ?? a.acc;
  const salt = randomBytes(16).toString("hex");
  accounts.delete(a.acc);
  a.acc = newAcc;
  a.key = key;
  a.salt = salt;
  a.hash = hashPassword(newPwd, salt);
  a.type = type;
  accounts.set(newAcc, a);
  // Las sesiones vivas siguen valiendo (el jugador puede vincular en mitad de la partida): solo
  // hay que actualizar el nombre con el que LoginC2S las comprueba.
  for (const s of sessions.values()) if (s.key === key) s.acc = newAcc;
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
