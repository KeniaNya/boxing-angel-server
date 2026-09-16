// Vinculacion de cuentas rapidas (FastAccBinding) y rescate desde el panel.
// Lo importante: el personaje NO se mueve al vincular, porque su clave de datos es lo que amigos,
// ranking PvP y correo guardan como identidad del jugador.
import { test, expect } from "bun:test";
process.env.ADMIN_TOKEN = "t";
const { testSession } = await import("./testutil.ts");
const {
  createAccount, verifyAccount, bindAccount, setAccountLogin, resolveToken, playerKey, loadAccounts,
} = await import("./accounts.ts");
const { dispatch } = await import("./game.ts");
const { loadPlayer } = await import("./players.ts");
const { handleAdmin } = await import("./admin.ts");

loadAccounts();
const silent = () => {};
let n = 0;
const fresh = () => `fast${Date.now()}${n++}`.slice(0, 20);

/** Entra en el juego como lo hace el cliente: Verify -> token -> LoginC2S con el nombre de acceso. */
async function login(acc: string, pwd: string) {
  const v = verifyAccount(acc, pwd);
  const s = { id: "s", createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc: "", player: null } as unknown as import("./game.ts").GameSession;
  const frames = await dispatch(s, "LoginC2S", { token: v.token ?? "", acc }, silent);
  return { res: v.res, frames, session: s };
}

test("vincular una cuenta rapida conserva el personaje y permite entrar con el nombre nuevo", async () => {
  const fast = fresh();
  expect(createAccount(fast, "pwdfast", 0)).toBe(0);
  const { p } = await testSession(fast); // le crea personaje con la clave de datos = nombre rapido
  p.name = "Recuperable";

  expect(bindAccount(fast, "pwdfast", "jugador.uno", "secreto1", 1)).toBe(0);

  // El nombre viejo ya no vale y el nuevo entra al MISMO personaje.
  expect(verifyAccount(fast, "pwdfast").res).toBe(1005);
  expect(playerKey("jugador.uno")).toBe(fast);
  const { res, frames, session } = await login("jugador.uno", "secreto1");
  expect(res).toBe(0);
  expect(frames.some((f) => f.methodName === "LoginS2C" && f.paramObject.res === 0)).toBe(true);
  expect(session.acc).toBe(fast); // los datos siguen bajo la clave original
  expect(loadPlayer(session.acc!)!.name).toBe("Recuperable");
});

test("una sesion abierta sobrevive a la vinculacion (se vincula jugando)", async () => {
  const fast = fresh();
  createAccount(fast, "pwdfast", 0);
  const token = verifyAccount(fast, "pwdfast").token!;
  expect(bindAccount(fast, "pwdfast", "enjuego.uno", "secreto1", 1)).toBe(0);
  const sess = resolveToken(token)!;
  expect(sess.acc).toBe("enjuego.uno"); // LoginC2S compara con el nombre que ya usa el cliente
  expect(sess.key).toBe(fast);
});

test("codigos de error de la vinculacion (los que el cliente localiza como Binding_<res>)", () => {
  const fast = fresh();
  createAccount(fast, "pwdfast", 0);
  expect(bindAccount("no-existe", "pwdfast", "libre.uno", "secreto1", 1)).toBe(1005);
  expect(bindAccount(fast, "mala-clave", "libre.uno", "secreto1", 1)).toBe(1005);
  expect(bindAccount(fast, "pwdfast", "corto", "secreto1", 1)).toBe(1003); // nombre < 6
  expect(bindAccount(fast, "pwdfast", "libre.uno", "corto", 1)).toBe(1003); // clave < 6
  expect(bindAccount(fast, "pwdfast", "libre.uno", "secreto1", 1)).toBe(0);
  // Ya vinculada: no se puede volver a vincular, y su nombre queda ocupado.
  expect(bindAccount("libre.uno", "secreto1", "otro.nombre", "secreto2", 1)).toBe(1008);
  const otra = fresh();
  createAccount(otra, "pwdfast", 0);
  expect(bindAccount(otra, "pwdfast", "libre.uno", "secreto1", 1)).toBe(1008);
});

test("el nombre rapido viejo no se puede reutilizar: seguiria siendo el archivo del personaje", async () => {
  const fast = fresh();
  createAccount(fast, "pwdfast", 0);
  await testSession(fast);
  expect(bindAccount(fast, "pwdfast", "sinrobo.uno", "secreto1", 1)).toBe(0);
  // El nombre rapido quedo libre en el mapa de cuentas, pero sigue siendo data/players/<fast>.json
  expect(createAccount(fast, "otraclave", 0)).toBe(1008);
  const otro = fresh();
  createAccount(otro, "pwdfast", 0);
  expect(bindAccount(otro, "pwdfast", fast, "secreto1", 1)).toBe(1008);
});

test("el panel puede dar credenciales nuevas a una cuenta perdida sin tocar el personaje", async () => {
  const fast = fresh();
  createAccount(fast, "pwdfast", 0);
  const { p } = await testSession(fast);
  p.name = "Perdido";

  const r = await handleAdmin("/admin/api/accounts/" + encodeURIComponent(fast) + "/login",
    new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ acc: "rescatado.uno", pwd: "nueva123" }) }), { startedAt: new Date() });
  expect(r.status).toBe(200);

  const { session } = await login("rescatado.uno", "nueva123");
  expect(session.acc).toBe(fast);
  expect(loadPlayer(session.acc!)!.name).toBe("Perdido");
  expect(setAccountLogin("rescatado.uno", "mal", "nueva123")).toBe(1003);
});
