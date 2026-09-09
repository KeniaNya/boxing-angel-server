import { test, expect } from "bun:test";
import { testSession, silentLog } from "../testutil.ts";

// testutil fija LENA_APPDATA antes de importar players.ts; aqui se importan despues para compartir el mismo directorio.
const players = await import("../players.ts");
const game = await import("../game.ts");
const { PVP_TIMES_MAX, NPC_LADDER } = await import("./pvp.ts");
type Player = import("../players.ts").Player;

// testSession solo puede llamarse una vez por proceso (loadHandlerModules rechaza handlers duplicados):
// el resto de jugadores se crean a mano con createPlayer + dispatch.
const main = await testSession("pvp-main");
function sessionFor(p: Player) {
  const s: import("../game.ts").GameSession = { id: "s-" + p.acc, createdAt: Date.now(), lastSeen: Date.now(), pending: [], acc: p.acc, player: p, sessionKey: "k" };
  return { p, send: (method: string, params: Record<string, unknown> = {}) => game.dispatch(s, method, params, silentLog) };
}
const rival = sessionFor(players.loadPlayer("pvp-rival") ?? players.createPlayer("pvp-rival", "Rival", "1100002"));
const obj = (f: { paramObject: Record<string, unknown> }) => f.paramObject;

test("GetPvPOpponent: sin registro falla; solo -> 3 NPC con mejor puesto", async () => {
  let out = await main.send("GetPvPOpponentC2S");
  expect(obj(out[0]).res).not.toBe(0);

  out = await main.send("RegisterPvPContestantC2S", { rid: main.p.last_use, pvp_ai_type: "1010" });
  expect(obj(out[0]).res).toBe(0);
  expect(obj(out[0]).rank).toBe(NPC_LADDER + 1);
  expect(main.p.pvp_role).toBe(main.p.last_use);

  out = await main.send("GetPvPOpponentC2S");
  expect(obj(out[0]).res).toBe(0);
  const list = obj(out[0]).list as unknown[][];
  expect(list.length).toBe(3);
  for (const row of list) {
    expect(row.length).toBe(24);
    expect(row[1]).toBe(1); // npc
    expect(row[0] as number).toBeLessThan(main.p.pvp_rank);
    expect(Object.keys(row[8] as object)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(typeof row[6]).toBe("string"); // rid valido de role_info
  }
});

test("GetPvPOpponent: con otro jugador inscrito lo ofrece como rival real", async () => {
  // El rival se inscribe despues -> puesto peor (102); desde su lado, main (101) es un rival real.
  let out = await rival.send("RegisterPvPContestantC2S", { rid: rival.p.last_use, pvp_ai_type: "1011" });
  expect(obj(out[0]).rank).toBe(NPC_LADDER + 2);

  out = await rival.send("GetPvPOpponentC2S");
  const list = obj(out[0]).list as unknown[][];
  const real = list.find((r) => r[1] === 0);
  expect(real).toBeDefined();
  expect(real![0]).toBe(main.p.pvp_rank);
  expect(real![4]).toBe(main.p.roles[main.p.pvp_role].auid);
  expect(real![5]).toBe(main.p.name);
  expect(real![17]).toBe("1010"); // ai_type del rol registrado
});

test("StartPvPBattle consume un intento y ReportPvPBattleResults intercambia puestos y da pcoin", async () => {
  const before = rival.p.coin[2];
  const list = (obj((await rival.send("GetPvPOpponentC2S"))[0]).list as unknown[][]);
  const idx = list.findIndex((r) => r[1] === 0);

  let out = await rival.send("StartPvPBattleC2S", { index: idx });
  expect(obj(out[0]).res).toBe(0);
  expect(obj(out[0]).pvp_times).toBe(1); // usados hoy
  expect(rival.p.pvp_times).toBe(1);
  expect(rival.p.pvp_flag).toBeGreaterThan(0);

  out = await rival.send("ReportPvPBattleResultsC2S", { battle_res: 1 });
  const r = obj(out[0]);
  expect(r.res).toBe(0);
  expect(r.victory).toBe(1);
  expect(r.fail).toBe(0);
  expect(r.rank).toBe(NPC_LADDER + 1);
  const rec = r.record as Record<string, unknown>;
  expect(rec.opponent_name).toBe(main.p.name);
  expect(rec.variation).toBe(1);
  expect(out[1].methodName).toBe("NoticeUpdateS2C"); // notice.coin
  expect(rival.p.coin[2]).toBeGreaterThan(before);
  // el perdedor baja un puesto y registra la derrota
  expect(main.p.pvp_rank).toBe(NPC_LADDER + 2);
  expect(main.p.pvp_fail).toBe(1);
  const log = obj((await main.send("GetPvPBattleRecordC2S"))[0]).list as Record<string, unknown>[];
  expect(log[0].opponent_name).toBe(rival.p.name);
  expect(log[0].variation).toBe(-1);

  // segunda batalla inmediata: enfriamiento activo -> 1019
  await rival.send("GetPvPOpponentC2S");
  out = await rival.send("StartPvPBattleC2S", { index: 0 });
  expect(obj(out[0]).res).toBe(1019);
});

test("RefreshPvPCoolDown cobra diamantes y quita el enfriamiento", async () => {
  const vcoin = rival.p.coin[1];
  let out = await rival.send("RefreshPvPCoolDownC2S");
  expect(obj(out[0]).res).toBe(0);
  expect(obj(out[0]).coin).toBe(50); // price_info fila 1, col 1
  expect(obj(out[0]).refresh_pvp_times).toBe(1);
  expect(rival.p.coin[1]).toBe(vcoin - 50);
  expect(rival.p.pvp_flag).toBe(0);
  out = await rival.send("RefreshPvPCoolDownC2S");
  expect(obj(out[0]).res).toBe(1019); // ya no hay enfriamiento
});

test("BuyPvPTimes cobra diamantes y anade un intento", async () => {
  const vcoin = main.p.coin[1];
  main.p.pvp_times = PVP_TIMES_MAX; // sin intentos
  const out = await main.send("BuyPvPTimesC2S");
  const r = obj(out[0]);
  expect(r.res).toBe(0);
  expect(r.coin).toBe(100); // price_info fila 1, col 2
  expect(r.next_coin).toBe(100);
  expect(r.buy_pvp_times).toBe(1);
  expect(r.pvp_times).toBe(1);
  expect(main.p.coin[1]).toBe(vcoin - 100);
  expect(main.p.pvp_times).toBe(PVP_TIMES_MAX - 1);
  expect(out[1].paramObject.cmd).toBe("coin");
});

test("GetPvPLeaderboard lista los puestos en orden con jugadores reales en el suyo", async () => {
  const out = await main.send("GetPvPLeaderboardC2S", { start: 1, end: NPC_LADDER + 2 });
  const list = obj(out[0]).list as Record<string, unknown>[];
  expect(list.length).toBe(NPC_LADDER + 2);
  expect(list[NPC_LADDER].name).toBe(rival.p.name); // puesto 101
  expect(list[NPC_LADDER + 1].name).toBe(main.p.name); // puesto 102
  for (const e of list) {
    expect(typeof e.auid).toBe("string");
    expect(typeof e.rid).toBe("string");
    expect(typeof e.lv).toBe("number");
  }
  expect((obj((await main.send("GetPvPLeaderboardC2S", { start: 1, end: 51 }))[0]).list as unknown[]).length).toBe(51);
});

test("SetPvPRoleAIType y BulletinBattleFail", async () => {
  expect(obj((await main.send("SetPvPRoleAITypeC2S", { rid: main.p.last_use, pvp_ai_type: "1012" }))[0]).res).toBe(0);
  expect(main.p.roles[main.p.last_use].pvp_ai_type).toBe("1012");
  expect(await main.send("BulletinBattleFailC2S")).toEqual([]);
});

test("rankings genericos: info, lista, recompensas, propio puesto, total y ficha de rol", async () => {
  const info = obj((await main.send("getRankInfoC2S"))[0]);
  expect(info.size).toBe(0);
  const acts = info.rs as Record<string, unknown>[];
  expect(acts.length).toBeGreaterThan(0);
  expect(acts[0].type).toBe(700);

  const list = obj((await main.send("getRankListC2S", { activityId: acts[0].id, activityType: 700, start: 1, end: 30 }))[0]);
  const rows = list.rs as Record<string, unknown>[];
  expect(rows[0].rank).toBe(1);
  expect(rows[0].name).toBe(rival.p.name); // 1 victoria PvP
  expect(rows[0].rankRange).toEqual({ startRank: 1, endRank: 1 });

  const rw = obj((await main.send("getRankRewardListC2S", { activityId: acts[0].id, activityType: 700 }))[0]).rs as Record<string, unknown>[];
  expect(rw[0].startRank).toBe("1");
  expect((rw[0].reward as Record<string, number>).gcoin).toBe(100000);

  const mine = obj((await rival.send("getUserRankDataC2S", { activityId: acts[0].id, activityType: 700 }))[0]).rs as Record<string, unknown>[];
  expect(mine[0].rank).toBe(1);
  expect(obj((await main.send("getUserRankDataC2S", { activityId: acts[0].id, activityType: 700 }))[0]).rs).toEqual([]); // sin victorias

  expect(obj((await main.send("getPlayerCountC2S", { activityId: "1", activityType: 700 }))[0]).total as number).toBeGreaterThanOrEqual(2);

  const detail = obj((await main.send("getRoleDetailC2S", { auid: rival.p.roles[rival.p.last_use].auid, roleId: rival.p.last_use }))[0]);
  const eq = detail.roleInfo as Record<string, unknown>[];
  expect(eq.length).toBeGreaterThan(0);
  expect(Object.keys(eq[0])).toEqual(["equipId", "equipLv", "quality", "buff_item"]);
});

test("asesino: info, jugar, reportar victoria/derrota y rankings", async () => {
  let r = obj((await main.send("getPlayerAssassinInfoC2S"))[0]);
  expect(r.rs).toBe(0);
  expect(r.chapterId).toBe("8001010");
  expect(r.progressRate).toBe(0);

  expect(obj((await main.send("playAssassinC2S", { chapterId: "1234567" }))[0]).rs).toBe(1);
  const ap = main.p.ap;
  expect(obj((await main.send("playAssassinC2S", { chapterId: "8001010" }))[0]).rs).toBe(0);
  expect(main.p.ap).toBe(ap - 6);

  const items = { ...main.p.items };
  r = obj((await main.send("reportAssassinChapterC2S", { isWin: true, total_star: 3, total_hurt: 500, max_one_hit: 80, score: [1, 2, 3], rate: [] }))[0]);
  expect(r.rs).toBe(0);
  expect(r.progress).toBe("8001020");
  expect(r.player_lv as number).toBeGreaterThanOrEqual(1);
  expect(main.p.items["0511004"] ?? 0).toBe((items["0511004"] ?? 0) + 25);

  // derrota: devuelve AP menos el coste de fallo
  await main.send("playAssassinC2S", { chapterId: "8001020" });
  const ap2 = main.p.ap;
  r = obj((await main.send("reportAssassinChapterC2S", { isWin: false, total_star: 0, total_hurt: 100, max_one_hit: 10 }))[0]);
  expect(r.rs).toBe(-1);
  expect(main.p.ap).toBe(ap2 + 5);
  expect(obj((await main.send("getPlayerAssassinInfoC2S"))[0]).chapterId).toBe("8001020");

  const rank = obj((await main.send("getAssassinRankDataC2S", { type: 3 }))[0]);
  expect(rank.size).toBe(0);
  const rows = rank.rs as unknown[][];
  expect(rows[0]).toEqual([1, 600, main.p.roles[main.p.last_use].auid, main.p.name]);
  const byAuid = obj((await main.send("getAssassinRankDataByAuidC2S", { type: 1, auid: main.p.roles[main.p.last_use].auid }))[0]).data as unknown[];
  expect(byAuid[0]).toBe(1);
  expect(byAuid[1]).toBe(1); // 1 piso superado
  expect(obj((await main.send("getAssassinRankDataByAuidC2S", { type: 1, auid: "nadie" }))[0]).data).toEqual([]);
  const detail = obj((await main.send("getAssassinRoleDetailC2S", { type: 1, auid: main.p.roles[main.p.last_use].auid }))[0]).data as Record<string, unknown>;
  expect(detail.roleId).toBe(main.p.last_use);
  expect(Array.isArray(detail.equipInfo)).toBe(true);
});
