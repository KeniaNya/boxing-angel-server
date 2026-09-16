import { test, expect } from "bun:test";
import { testSession } from "../testutil.ts";
import { fragmentOf, itemInfo, skillBuyCost, equipInfo, priceAt, PRICE } from "./inventory.ts";
import { roleTable } from "../gamedata.ts";
import { addEquip, findEquip, itemCount } from "../economy.ts";

const res = (out: { paramObject: Record<string, unknown> }[]) => out[0].paramObject.res;

test("BuyRole: falla sin diamantes, luego descuenta y crea el rol con su equipo inicial", async () => {
  const { p, send } = await testSession();
  const rid = "1100002";
  const info = roleTable().get(rid)!;
  expect(info.price).toBeGreaterThan(0);
  p.coin[1] = info.price - 1;
  expect(res(await send("BuyRoleC2S", { rid }))).toBe(1016);
  expect(p.roles[rid]).toBeUndefined();

  p.coin[1] = info.price + 100;
  const out = await send("BuyRoleC2S", { rid });
  expect(res(out)).toBe(0);
  expect(p.coin[1]).toBe(100);
  expect(p.roles[rid]).toBeDefined();
  expect(p.roles[rid].equip_in).toEqual(info.defaultEquip);
  for (const id of info.defaultEquip.filter((x) => x !== "")) expect(findEquip(p, id)).toBeDefined();
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "coin")).toBe(true);
  expect(res(await send("BuyRoleC2S", { rid }))).toBe(1008);
  expect(res(await send("BuyRoleC2S", { rid: "9999999" }))).toBe(1003);
});

test("ChangeRole cambia last_use y devuelve el rol", async () => {
  const { p, send } = await testSession();
  expect(res(await send("ChangeRoleC2S", { rid: "1100002" }))).toBe(1005);
  const out = await send("ChangeRoleC2S", { rid: p.last_use });
  expect(res(out)).toBe(0);
  expect((out[0].paramObject.role as { rid: string }).rid).toBe(p.last_use);
});

test("SetupEquip / TakeOffEquip actualizan equip_in", async () => {
  const { p, send } = await testSession();
  const role = p.roles[p.last_use];
  const before = role.equip_in[2];
  addEquip(p, "0103001"); // guantes -> hueco 2
  expect(res(await send("SetupEquipC2S", { eid: "0103001", index: 1, rid: p.last_use }))).toBe(1003); // hueco equivocado
  expect(res(await send("SetupEquipC2S", { eid: "0103002", index: 2, rid: p.last_use }))).toBe(1005); // no se posee
  expect(res(await send("SetupEquipC2S", { eid: "0103001", index: 2, rid: p.last_use }))).toBe(0);
  expect(role.equip_in[2]).toBe("0103001");
  expect(role.equip_in[2]).not.toBe(before);
  expect(res(await send("TakeOffEquipC2S", { index: 2, type: 0 }))).toBe(0);
  expect(role.equip_in[2]).toBe("");
});

test("Sell quita el objeto y suma oro", async () => {
  const { p, send } = await testSession();
  const id = "0201039";
  const price = itemInfo(id)!.sellPrice;
  const had = itemCount(p, id), gold = p.coin[0];
  expect(had).toBeGreaterThanOrEqual(4);
  const out = await send("SellC2S", { id, amount: 4 });
  expect(res(out)).toBe(0);
  expect(out[0].paramObject.coin).toBe(price * 4);
  expect(itemCount(p, id)).toBe(had - 4);
  expect(p.coin[0]).toBe(gold + price * 4);
  expect(res(await send("SellC2S", { id, amount: 100000 }))).toBe(1005);
});

test("LevelUpEquip gasta fragmentos + oro y sube lv", async () => {
  const { p, send } = await testSession();
  const eid = p.roles[p.last_use].equip_in[2];
  const frag = fragmentOf(eid)!;
  const e = findEquip(p, eid)!;
  const need = frag.condition[e.lv], cost = frag.price[e.lv];
  p.items[frag.id] = need - 1;
  p.coin[0] = cost + 5;
  expect(res(await send("LevelUpEquipC2S", { eid }))).toBe(1019);
  p.items[frag.id] = need;
  p.coin[0] = cost - 1;
  expect(res(await send("LevelUpEquipC2S", { eid }))).toBe(1016);
  p.coin[0] = cost + 5;
  expect(res(await send("LevelUpEquipC2S", { eid }))).toBe(0);
  expect(e.lv).toBe(2);
  expect(itemCount(p, frag.id)).toBe(0);
  expect(p.coin[0]).toBe(5);
});

test("Make fabrica un equipo nuevo a partir de fragmentos", async () => {
  const { p, send } = await testSession();
  const frag = fragmentOf("0103001")!;
  p.items[frag.id] = frag.condition[0];
  p.coin[0] = frag.price[0];
  const out = await send("MakeC2S", { id: frag.id, amount: 1 });
  expect(res(out)).toBe(0);
  expect(out[0].paramObject.id).toBe("0103001");
  const e = findEquip(p, "0103001")!;
  expect(e.lv).toBe(equipInfo("0103001")!.initLv);
  expect(p.coin[0]).toBe(0);
});

test("EquipInsertParts / EquipDetachParts / AdvancedEquip", async () => {
  const { p, send } = await testSession();
  const eid = "0103001";
  addEquip(p, eid);
  const req = equipInfo(eid)!.slotRequires[0];
  for (const pid of req) p.items[pid] = (p.items[pid] ?? 0) + 1;
  for (let i = 0; i < 6; i++) expect(res(await send("EquipInsertPartsC2S", { index: i, eid, pid: req[i] }))).toBe(0);
  const e = findEquip(p, eid)!;
  expect(e.slot).toEqual(req);
  expect(res(await send("EquipInsertPartsC2S", { index: 0, eid, pid: req[0] }))).toBe(1005); // ya no quedan piezas
  p.coin[0] = 10_000_000;
  const detach = await send("EquipDetachPartsC2S", { index: 5, id: eid, type: 0 });
  expect(res(detach)).toBe(0);
  expect(detach[0].paramObject.coin).toBe(priceAt(PRICE.SLOT_REMOVE_G, 0));
  expect(e.slot[5]).toBe("");
  expect(res(await send("AdvancedEquipC2S", { eid }))).toBe(1003); // falta una pieza
  p.items[req[5]] = 1;
  expect(res(await send("EquipInsertPartsC2S", { index: 5, eid, pid: req[5] }))).toBe(0);
  const adv = await send("AdvancedEquipC2S", { eid });
  expect(res(adv)).toBe(0);
  expect(e.quality).toBe(2);
  expect(e.slot).toEqual(["", "", "", "", "", ""]);
  expect(Object.keys(e.prop).length).toBeGreaterThan(0);
});

test("BuySkill / EquipSkill / LevelUpSkill / UnloadSkill", async () => {
  const { p, send } = await testSession();
  const id = "0301001";
  expect(res(await send("BuySkillC2S", { id }))).toBe(1019); // nivel de gimnasio
  p.lv = 10;
  p.coin[0] = skillBuyCost(id) + 7;
  expect(res(await send("BuySkillC2S", { id }))).toBe(0);
  expect(p.coin[0]).toBe(7);
  expect(p.skills.find((s) => s.id === id)?.strengthen_prop).toEqual([1, 1, 1, 1]);
  expect(res(await send("EquipSkillC2S", { id, index: 0 }))).toBe(1019); // nivel de rol (skill_info col 9)
  p.roles[p.last_use].lv = 10;
  expect(res(await send("EquipSkillC2S", { id, index: 0 }))).toBe(0);
  expect(p.roles[p.last_use].skill).toBe(id);
  expect(res(await send("EquipSkillC2S", { id, index: 1 }))).toBe(1003); // segundo hueco: VIP o nivel 27 (TutorialAndLock Skill2)
  p.lv = 27;
  expect(res(await send("EquipSkillC2S", { id, index: 1 }))).toBe(1003); // la misma habilidad ya esta en el hueco 0
  expect(res(await send("UnloadSkillC2S", { index: 0 }))).toBe(0);
  expect(res(await send("EquipSkillC2S", { id, index: 1 }))).toBe(0);
  expect(p.roles[p.last_use].skill2).toBe(id);
  expect(res(await send("UnloadSkillC2S", { index: 1 }))).toBe(0);
  expect(res(await send("EquipSkillC2S", { id, index: 0 }))).toBe(0);
  p.lv = 10;
  p.coin[0] = 1_000_000;
  p.tp = 10;
  expect(res(await send("LevelUpSkillC2S", { id, configuration: [0, 1, 0, 0] }))).toBe(0);
  expect(p.skills.find((s) => s.id === id)?.strengthen_prop).toEqual([1, 2, 1, 1]);
  expect(res(await send("UnloadSkillC2S", { index: 0 }))).toBe(0);
  expect(p.roles[p.last_use].skill).toBe("");
});

test("UseItem: pocion de AP suma AP y responde con el estado", async () => {
  const { p, send } = await testSession();
  const id = "0202011"; // {"5":60}
  const ap = p.ap, had = itemCount(p, id);
  const out = await send("UseItemC2S", { id, amount: 1, rid: "" });
  expect(res(out)).toBe(0);
  expect(out[0].paramObject.ap).toBe(ap + 60);
  expect(itemCount(p, id)).toBe(had - 1);
  expect(res(await send("UseItemC2S", { id: "0201039", amount: 1, rid: "" }))).toBe(1003); // pieza: no usable
});

test("tutorial de planos: fabrica el primer plano aunque falten materiales y oro", async () => {
  const { p, send } = await testSession();
  p.teaching_flag = 0;
  p.items = {};
  p.coin = [0, 0, 0, 0];
  const out = await send("UseItemC2S", { id: "5002035", amount: 1, rid: null });
  expect(out[0].paramObject.res).toBe(0);
  expect(out[0].paramObject.reward).toBe("0102035");
  expect(p.equips.some((e) => e.id === "0102035")).toBe(true);
  // con el tutorial marcado, sin materiales -> error
  p.teaching_flag = 1 << 19;
  const again = await send("UseItemC2S", { id: "5002035", amount: 1, rid: null });
  expect(again[0].paramObject.res).not.toBe(0);
});

test("combate Dream (tutorial): ReportPvEResult concede las recompensas del capitulo una sola vez", async () => {
  const { p, send } = await testSession();
  const gold = p.coin[0];
  const out = await send("ReportPvEResultC2S", { ch_id: "3201090", result: 1, prop: {}, prop1: {} });
  expect(out[0].paramObject.res).toBe(0);
  expect(p.coin[0]).toBe(gold + 1500);
  expect(p.items["0201026"]).toBeGreaterThanOrEqual(2);
  await send("ReportPvEResultC2S", { ch_id: "3201090", result: 1, prop: {}, prop1: {} });
  expect(p.coin[0]).toBe(gold + 1500);
});
