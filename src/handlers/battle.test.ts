import { test, expect } from "bun:test";
import { testSession } from "../testutil.ts";
import { hallroadExp, lvInfo, itemCount } from "../economy.ts";

const first = (out: { methodName: string; paramObject: Record<string, unknown> }[]) => out[0].paramObject;

test("jugar y reportar un capitulo normal avanza ch_progress y da exp/recompensas", async () => {
  const { p, send } = await testSession();
  const ap0 = p.ap;
  const play = first(await send("PlayChapterC2S", { chapter: "1001010" }));
  expect(play.res).toBe(0);
  expect(play.isPass).toBe(false); // 1001010 no es nodo de mapa (posType 0)
  expect(p.ap).toBe(ap0 - 1); // AP de derrota (col 6) cobrado por adelantado

  const out = await send("ReportChapterC2S", { score: [1, 1, 1], rate: [], isPass: false });
  const r = first(out);
  expect(r.res).toBe(0);
  expect(r.progress).toBe("1001020");
  expect(p.ch_progress).toBe("1001020");
  // exp de gimnasio 6 (con subida de nivel si toca) y exp de rol 16
  const expGain = 6;
  const levelUp = expGain >= hallroadExp(1);
  expect(p.lv).toBe(levelUp ? 2 : 1);
  expect(p.exp).toBe(levelUp ? expGain - hallroadExp(1) : expGain);
  expect(r.player_lv).toBe(p.lv);
  expect(r.player_exp).toBe(p.exp);
  const role = p.roles[p.last_use];
  expect(r.role_lv).toBe(role.lv);
  expect(r.role_exp).toBe(role.exp);
  // AP total de la victoria = apNeed (6), mas el regalo de AP si subio de nivel
  expect(p.ap).toBe(ap0 - 6 + (levelUp ? lvInfo(2).apGift : 0));
  expect(r.ap).toBe(p.ap);
  // recompensa segura de la tabla: 0511007 x2
  expect(itemCount(p, "0511007")).toBe(2);
  expect(r.reward).toEqual([["0511007", 2]]);
  expect(Array.isArray(r.gold)).toBe(true);
  expect((r.gold as number[]).length).toBe(3);
  expect(p.scores.find((s) => s.ch_id === "1001010")?.score).toEqual([1, 1, 1]);
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "item")).toBe(true);
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "coin")).toBe(true);

  // reportar sin capitulo en curso falla
  expect(first(await send("ReportChapterC2S", { score: [1, 1, 1], rate: [], isPass: false })).res).toBe(1005);
});

test("un capitulo no alcanzado no se puede jugar; sin AP tampoco", async () => {
  const { p, send } = await testSession();
  expect(first(await send("PlayChapterC2S", { chapter: "1001050" })).res).toBe(1019);
  expect(first(await send("PlayChapterC2S", { chapter: "9999999" })).res).toBe(1005);
  expect(first(await send("PlayChapterC2S", {})).res).toBe(1002);
  p.ap = 2;
  expect(first(await send("PlayChapterC2S", { chapter: "1001010" })).res).toBe(1016);
});

test("BuyAP falla sin diamantes y suma AP con ellos", async () => {
  const { p, send } = await testSession();
  p.coin[1] = 0;
  expect(first(await send("BuyAPC2S", {})).res).toBe(1016);
  expect(p.buy_ap_times).toBe(0);

  p.coin[1] = 300;
  const ap0 = p.ap;
  const r = first(await send("BuyAPC2S", {}));
  expect(r.res).toBe(0);
  expect(r.coin).toBe(50); // price_info fila 1, col 3
  expect(r.ap).toBe(120); // col 4: AP obtenido
  expect(r.buy_ap_times).toBe(1);
  expect(p.ap).toBe(ap0 + 120);
  expect(p.coin[1]).toBe(250);
  // limite diario VIP 0 = 2 compras
  expect(first(await send("BuyAPC2S", {})).res).toBe(0);
  expect(first(await send("BuyAPC2S", {})).res).toBe(1012);
});

test("GoldFinger convierte diamantes en oro con multiplicador", async () => {
  const { p, send } = await testSession();
  const g0 = p.coin[0];
  const r = first(await send("GoldFingerC2S", {}));
  expect(r.res).toBe(0);
  expect(r.coin).toBe(10);
  expect(r.give).toBe(14040);
  expect(r.gold_finger_times).toBe(1);
  const mag = (r.magnification as number) / 100;
  expect(mag).toBeGreaterThanOrEqual(1);
  expect(mag).toBeLessThanOrEqual(10);
  expect(r.actual_give_gcoin).toBe(14040 * mag);
  expect(p.coin[0]).toBe(g0 + 14040 * mag);
  expect(p.coin[1]).toBe(290);
  expect(p.gold_finger_times).toBe(1);
});

test("BuyTP suma puntos de entrenamiento y BuyBlood exige estar en un capitulo", async () => {
  const { p, send } = await testSession();
  const tp0 = p.tp;
  const r = first(await send("BuyTPC2S", {}));
  expect(r.res).toBe(0);
  expect(r.coin).toBe(10);
  expect(r.tp).toBe(10);
  expect(p.tp).toBe(tp0 + 10);

  expect(first(await send("BuyBloodC2S", {})).res).toBe(1006);
  await send("PlayChapterC2S", { chapter: "1001010" });
  const b = first(await send("BuyBloodC2S", {}));
  expect(b.res).toBe(0);
  expect(b.times).toBe(1);
  expect(b.need_coin).toBe(10);
  expect(b.next_coin).toBe(20);
  expect(p.buy_blood_times).toBe(1);
});

test("directo exige capitulo superado y tickets", async () => {
  const { p, send } = await testSession();
  expect(first(await send("StraightAheadChapterC2S", { chapter: "1001010", type: 1, amount: 1, rate: [] })).res).toBe(1019);
  await send("PlayChapterC2S", { chapter: "1001010" });
  await send("ReportChapterC2S", { score: [1, 1, 1], rate: [], isPass: false });
  expect(first(await send("StraightAheadChapterC2S", { chapter: "1001010", type: 1, amount: 2, rate: [] })).res).toBe(1016); // sin tickets
  p.items["0202010"] = 3;
  const g0 = p.coin[0];
  const r = first(await send("StraightAheadChapterC2S", { chapter: "1001010", type: 1, amount: 2, rate: [] }));
  expect(r.res).toBe(0);
  expect(r.reward).toEqual([["0511007", 4]]);
  expect(r.get_player_exp).toBe(12);
  expect(itemCount(p, "0202010")).toBe(1);
  expect(p.coin[0]).toBe(g0 + (r.gold as number));
  expect(r.ap).toBe(p.ap);
});

test("combate de elite: lista, rival, victoria y nodo de premio en orden", async () => {
  const { p, send } = await testSession();
  const list = first(await send("GetEliteBattleListC2S", {})).list as string[];
  expect(list.length).toBe(20);
  expect(first(await send("GetEliteBattleRivalC2S", { index: 1 })).res).toBe(1019); // hay que empezar por el 0
  const rival = first(await send("GetEliteBattleRivalC2S", { index: 0 })).rival as Record<string, unknown>;
  expect(rival.rid).toBe(list[0]);
  expect((rival.equip as unknown[]).length).toBe(6);
  expect((rival.skill as unknown[]).length).toBe(2);

  // derrota: no avanza, guarda hp del rol y del rival
  let r = first(await send("ReportEliteBattleC2S", { index: 0, role_id: p.last_use, role_hp: 0, role_anger: 5, tag_hp: 40, tag_anger: 7 }));
  expect(r.res).toBe(0);
  expect(r.progress).toBe(0);
  expect(p.eb_progress).toBe("");
  expect((first(await send("GetEliteBattleRivalC2S", { index: 0 })).rival as Record<string, unknown>).hp).toBe(40);

  for (let i = 0; i < 3; i++) {
    r = first(await send("ReportEliteBattleC2S", { index: i, role_id: p.last_use, role_hp: 80, role_anger: 0, tag_hp: 0, tag_anger: 0 }));
    expect(r.res).toBe(0);
    expect(r.progress).toBe(i + 1);
  }
  expect(p.eb_progress).toBe("3");
  expect(p.roles[p.last_use].elite_battle_hp).toBe(80);
  // indice 3 = nodo de premio (50 ecoin)
  const e0 = p.coin[3];
  r = first(await send("GetEliteBattleRivalC2S", { index: 3 }));
  expect(r.res).toBe(0);
  expect(r.rival).toBeUndefined();
  expect(r.coin).toEqual([0, 0, 0, 50]);
  expect(p.coin[3]).toBe(e0 + 50);
  expect(p.eb_progress).toBe("4");
  expect(first(await send("GetEliteBattleRivalC2S", { index: 3 })).res).toBe(1019); // no se cobra dos veces

  // reinicio: el primero es gratis
  const v0 = p.coin[1];
  r = first(await send("ReEliteBattleC2S", {}));
  expect(r.res).toBe(0);
  expect(r.coin).toBe(0);
  expect(r.times).toBe(1);
  expect((r.list as string[]).length).toBe(20);
  expect(p.coin[1]).toBe(v0);
  expect(p.eb_progress).toBe("0");
  expect(p.roles[p.last_use].elite_battle_hp).toBe(100);
  expect(first(await send("ReEliteBattleC2S", {})).res).toBe(1012); // VIP 0: 1 reinicio al dia
});

test("transeuntes, reparto de puntos, entrenamiento base y flags de tutorial", async () => {
  const { p, send } = await testSession();
  const ap0 = p.ap;
  const r = first(await send("ReportPassersC2S", { id: "1801001" }));
  expect(r.res).toBe(0);
  expect(r.ap).toBe(2);
  expect(r.passers_times).toBe(1);
  expect(p.ap).toBe(ap0 + 2);
  expect(first(await send("ReportPassersC2S", { id: "1001010" })).res).toBe(1003);

  const role = p.roles[p.last_use];
  expect(first(await send("ConfigurationPtC2S", { configuration: { "1": 3, "2": 2 } })).res).toBe(0);
  expect(role.prop["1"]).toBe(4);
  expect(role.pt_amount).toBe(5);
  expect(first(await send("ConfigurationPtC2S", { configuration: { "3": 99 } })).res).toBe(1019);

  // entrenamiento base: nivel del atributo no puede superar el nivel del rol (1)
  expect(first(await send("ConfigurationRolePropC2S", { configuration: '{"3":1}' })).res).toBe(1012);
  role.lv = 5;
  const g0 = p.coin[0], tp0 = p.tp;
  expect(first(await send("ConfigurationRolePropC2S", { configuration: '{"3":1}' })).res).toBe(0);
  expect(role.prop["3"]).toBe(2);
  expect(p.tp).toBe(tp0 - 1);
  expect(p.coin[0]).toBe(g0 - 500); // TrainBasePointCost para nivel 1 -> fila 2 (col 18 = 500)

  expect(first(await send("ChangeTeachingFlagC2S", { flag: 1234567 })).res).toBe(0);
  expect(p.teaching_flag).toBe(1234567);
  expect(first(await send("LogTeachingFlagC2S", { main: 3, deputy: 1 })).res).toBe(0);

  const g = first(await send("getGeneralChapterC2S", {}));
  expect(g.res).toBe(0);
  expect(g.size).toBe(0);
  expect(Array.isArray(g.chapters)).toBe(true);
});
