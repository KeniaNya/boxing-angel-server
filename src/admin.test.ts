import { test, expect } from "bun:test";
process.env.ADMIN_TOKEN = "t";
const { testSession } = await import("./testutil.ts");
const { handleAdmin } = await import("./admin.ts");
const { loadPlayer } = await import("./players.ts");

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(path, new Request("http://x" + path, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), { startedAt: new Date() });

test("admin: rechaza sin token", async () => {
  const r = await handleAdmin("/admin/api/status", new Request("http://x/admin/api/status"), { startedAt: new Date() });
  expect(r.status).toBe(401);
});

test("admin: regalo por correo, edicion y objetos directos", async () => {
  const { p, send } = await testSession();
  const gift = await (await call("POST", "/admin/api/gift", { to: [p.acc], title: "Hola", content: "Regalo", annex: [{ id: "vcoin", amount: 20 }] })).json();
  expect(gift.sent).toBe(1);
  const mails = await send("GetMailC2S", { serial: 0 });
  const list = mails[0].paramObject.list as { title: string; annex: { id: string; amount: number }[] }[];
  expect(list.some((m) => m.title === "Hola" && m.annex[0].id === "vcoin")).toBe(true);

  const edit = await (await call("PATCH", "/admin/api/players/" + encodeURIComponent(p.acc), { coin: [1, 2, 3, 4], vip: 1 })).json();
  expect(edit.coin).toEqual([1, 2, 3, 4]);
  expect(loadPlayer(p.acc)!.vip).toBe(1);

  const items = await (await call("POST", "/admin/api/players/" + encodeURIComponent(p.acc) + "/items", { rewards: [{ id: "0202004", amount: 3 }] })).json();
  expect(items.items["0202004"]).toBeGreaterThanOrEqual(3);

  const bad = await call("PUT", "/admin/api/config", { gachaType: 9 });
  expect(bad.status).toBe(400);
});

test("admin: borrar personaje y cuenta", async () => {
  const { p } = await testSession();
  const r1 = await call("DELETE", "/admin/api/players/" + encodeURIComponent(p.acc));
  expect(r1.status).toBe(200);
  expect(loadPlayer(p.acc)).toBeNull();
  const r2 = await call("DELETE", "/admin/api/players/" + encodeURIComponent(p.acc));
  expect(r2.status).toBe(404);
});
