import { test, expect } from "bun:test";
import { testSession } from "../testutil.ts";
import { coin, itemCount, findEquip, isEquipId } from "../economy.ts";
import { fragmentOfEquip, lotteryPool, LOTTERY } from "./shop.ts";

type Obj = Record<string, any>;

test("tirada de pago (virtual) descuenta diamantes y entrega premios del pool", async () => {
  const { p, send } = await testSession();
  p.coin[1] = 1000;
  const out = await send("StartGachaC2S", { type: LOTTERY.VIRTUAL, count: 1, flag: 0 });
  const r = out[0].paramObject as Obj;
  expect(out[0].methodName).toBe("StartGachaS2C");
  expect(r.res).toBe(0);
  expect(r.coin).toBe(100); // price_info fila 1, columna "gacha de diamantes"
  expect(coin(p, "vcoin")).toBe(900);
  expect(r.reward.length).toBe(1);
  // El premio (o su conversion a fragmentos) esta ahora en el inventario
  const { id, amount } = r.reward[0];
  const change = (r.change_reward as Obj[]).find((c) => c.original_id === id);
  if (change) expect(itemCount(p, change.id)).toBeGreaterThanOrEqual(change.amount);
  else if (isEquipId(id)) expect(findEquip(p, id)).toBeDefined();
  else expect(itemCount(p, id)).toBeGreaterThanOrEqual(amount);
  // Los avisos de inventario van despues de la respuesta principal
  expect(out.slice(1).every((f) => f.methodName === "NoticeUpdateS2C" || f.methodName === "NoticeUpdateMissionS2C")).toBe(true); // el gancho de misiones anade su aviso
});

test("tirada de 10 entrega 10 premios y al menos un equipo del pool", async () => {
  const { p, send } = await testSession();
  p.coin[1] = 5000;
  const out = await send("StartGachaC2S", { type: LOTTERY.VIRTUAL, count: 10, flag: 0 });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.coin).toBe(950);
  expect(r.reward.length).toBe(10);
  const pool = new Set([...lotteryPool(LOTTERY.VIRTUAL).one, ...lotteryPool(LOTTERY.VIRTUAL).ten]);
  expect((r.reward as Obj[]).some((x) => pool.has(x.id) && isEquipId(x.id))).toBe(true);
});

test("tirada gratis normal no cobra y decrementa el contador", async () => {
  const { p, send } = await testSession();
  p.gacha_normal_flag = Date.now() - 20 * 60 * 1000; // hace 20 min (> 600 s)
  const gcoin = coin(p, "gcoin");
  const out = await send("StartGachaC2S", { type: LOTTERY.NORMAL, count: 1, flag: 1 });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.coin).toBe(0);
  expect(coin(p, "gcoin")).toBe(gcoin);
  expect(r.normal_times).toBe(4); // 5 gratis al dia menos esta
  expect(p.gacha_normal_times).toBe(4);
  expect(r.normal_flag).toBeGreaterThan(Date.now() - 5000); // flag en ms
  // Sin esperar los 600 s, la siguiente gratis se rechaza
  const again = await send("StartGachaC2S", { type: LOTTERY.NORMAL, count: 1, flag: 1 });
  expect(again[0].paramObject.res).toBe(1019);
});

test("tirada de pago sin diamantes -> 1016", async () => {
  const { p, send } = await testSession();
  p.coin[1] = 0;
  const out = await send("StartGachaC2S", { type: LOTTERY.CHOICE, count: 1, flag: 0 });
  expect(out[0].paramObject.res).toBe(1016);
});

test("elegir premio del gacha de seleccion exige 6 tiradas y resetea el contador", async () => {
  const { p, send } = await testSession();
  p.gacha_choice_times = 2;
  expect((await send("DesignateChoiceGachaRewardC2S", { index: 0 }))[0].paramObject.res).toBe(1019);
  p.gacha_choice_times = 6;
  const out = await send("DesignateChoiceGachaRewardC2S", { index: 0 });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.reward.id).toBe(lotteryPool(LOTTERY.CHOICE).one[0]);
  expect(p.gacha_choice_times).toBe(0);
});

test("equipo duplicado se convierte en fragmentos (change_reward)", async () => {
  const { p, send } = await testSession();
  const id = lotteryPool(LOTTERY.CHOICE).one[0];
  const frag = fragmentOfEquip(id)!;
  p.gacha_choice_times = 6;
  await send("DesignateChoiceGachaRewardC2S", { index: 0 }); // primera vez: equipo
  expect(findEquip(p, id)).toBeDefined();
  p.gacha_choice_times = 6;
  const out = await send("DesignateChoiceGachaRewardC2S", { index: 0 }); // segunda: fragmentos
  const r = out[0].paramObject as Obj;
  expect(r.reward).toEqual({ id, amount: 1 });
  expect(r.change_reward.original_id).toBe(id);
  expect(r.change_reward.id).toBe(frag.id);
  expect(itemCount(p, frag.id)).toBe(r.change_reward.amount);
  expect(p.equips.filter((e) => e.id === id).length).toBe(1);
});

test("GetStore da 6 huecos y StoreShopping descuenta y entrega", async () => {
  const { p, send } = await testSession();
  p.coin = [10_000_000, 100_000, 100_000, 100_000];
  const got = (await send("GetStoreC2S", { store_id: 1 }))[0].paramObject as Obj;
  expect(got.res).toBe(0);
  expect(got.commodity_list.length).toBe(6);
  expect(got.refresh_times).toBe(0);
  const [buyFlag, id, amount, cost, coinType] = got.commodity_list[0] as [number, string, number, number, number];
  expect(buyFlag).toBe(0);
  const before = p.coin[coinType];
  const had = itemCount(p, id);
  const out = await send("StoreShoppingC2S", { store_id: 1, index: 0 });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.reward).toEqual([{ id, amount }]);
  expect(p.coin[coinType]).toBe(before - cost);
  expect(itemCount(p, id)).toBe(had + amount);
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "coin")).toBe(true);
  // Segunda compra del mismo hueco: ya vendido
  expect((await send("StoreShoppingC2S", { store_id: 1, index: 0 }))[0].paramObject.res).toBe(1020);
  // El stock marca el hueco como vendido
  const again = (await send("GetStoreC2S", { store_id: 1 }))[0].paramObject as Obj;
  expect(again.commodity_list[0][0]).toBe(1);
});

test("RefreshStore cobra segun price_info y renueva el stock", async () => {
  const { p, send } = await testSession();
  p.coin[1] = 1000;
  const out = await send("RefreshStoreC2S", { store_id: 1 });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.coin).toBe(50);
  expect(r.next_coin).toBe(50);
  expect(r.refresh_times).toBe(1);
  expect(r.new_commodity_list.length).toBe(6);
  expect(coin(p, "vcoin")).toBe(950);
  p.coin[2] = 0;
  expect((await send("RefreshStoreC2S", { store_id: 2 }))[0].paramObject.res).toBe(1016);
});

test("DoSignin entrega el premio del dia y la segunda vez el mismo dia falla", async () => {
  const { p, send } = await testSession();
  const cal = (await send("GetSigninC2S", {}))[0].paramObject as Obj;
  expect(cal.res).toBe(0);
  expect(cal.list.length).toBeGreaterThanOrEqual(28);
  expect(cal.expiration.length).toBe(2);
  expect(p.signin_times).toBe(0); // calendario del mes nuevo
  const gcoin = coin(p, "gcoin");
  const out = await send("DoSigninC2S", {});
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.reward).toEqual(cal.list[0]);
  expect(coin(p, "gcoin")).toBe(gcoin + cal.list[0].amount); // dia 1 = gcoin
  expect(p.signin_times).toBe(1);
  expect(p.signin_flag).toBe(1);
  const second = await send("DoSigninC2S", {});
  expect(second[0].paramObject.res).toBe(1019);
});

test("codigo de canje una sola vez por jugador", async () => {
  const { p, send } = await testSession();
  const vcoin = coin(p, "vcoin");
  const out = await send("CodeRedemptionC2S", { code: "welcome" });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.coin).toEqual([5000, 300, 0, 0]);
  expect(coin(p, "vcoin")).toBe(vcoin + 300);
  expect((await send("CodeRedemptionC2S", { code: "WELCOME" }))[0].paramObject.res).toBe(1020);
  expect((await send("CodeRedemptionC2S", { code: "NOPE" }))[0].paramObject.res).toBe(1005);
});

test("pozo de deseos: datos en dos frames y tirada consumiendo componentes", async () => {
  const { p, send } = await testSession();
  const frames = await send("getWishPoolDataC2S", {});
  expect(frames.length).toBe(2);
  expect(frames[0].paramObject.step).toBe(1);
  expect(frames[1].paramObject.step).toBe(0);
  expect(frames[1].paramObject.size).toBe(0);
  const consume = frames[0].paramObject.consume as Obj[];
  const [id, value] = Object.entries(consume[0])[0] as [string, number];
  p.items[id] = 100;
  const need = Math.ceil(10 / value); // primer tramo = 10
  const out = await send("startWishPoolGachaC2S", { actiivityType: 31, consumeItem: { [id]: need } });
  const r = out[0].paramObject as Obj;
  expect(r.res).toBe(0);
  expect(r.reward.length).toBe(1);
  expect(isEquipId(r.reward[0].id)).toBe(true);
  expect(itemCount(p, id)).toBe(100 - need);
  expect((await send("startWishPoolGachaC2S", { actiivityType: 31, consumeItem: { [id]: 0 } }))[0].paramObject.res).toBe(1019);
});

test("compras in-app no disponibles", async () => {
  const { send } = await testSession();
  const info = (await send("GetIapbInfoC2S", { type: 0 }))[0].paramObject as Obj;
  expect(info.res).toBe(0);
  expect(info.list).toEqual([]);
  expect((await send("IAPBC2S", { type: 0, receipt: "x", productId: "mono.gp_dia175", packageName: "p" }))[0].paramObject.res).toBe(1025);
  expect((await send("ReportIAPBC2S", { pay_order: "1" }))[0].paramObject.res).toBe(1003);
  expect((await send("dmmPurchasebeforeC2S", { paymentId: "1" }))[0].paramObject.res).toBe(1003);
});
