import { test, expect } from "bun:test";
import { testSession } from "../testutil.ts";
import { onEvent, missionInfos, WELCOME_MAIL, MISSION_FINISH, MISSION_CLAIMED, MISSION_DOING } from "./missions.ts";

const find = (list: unknown, id: string) => (list as { id: string; status: number; progress: number }[]).find((m) => m.id === id);

test("GetMission devuelve todas las misiones de la tabla con status/progress", async () => {
  const { send } = await testSession();
  const [f] = await send("GetMissionC2S");
  expect(f.methodName).toBe("GetMissionS2C");
  expect(f.paramObject.res).toBe(0);
  expect(f.paramObject.size).toBe(0);
  const list = f.paramObject.list as { id: string; status: number; progress: number }[];
  expect(list.length).toBe(missionInfos().size);
  expect(missionInfos().has("30110")).toBe(false); // linea basura del gamedata original
  expect(find(list, "3016002")).toEqual({ id: "3016002", status: MISSION_DOING, progress: 0 }); // diaria: 1 gacha
  expect(find(list, "3006010")).toEqual({ id: "3006010", status: MISSION_FINISH, progress: 1 }); // nivel de gimnasio >= 1 (derivada del jugador)
  expect(find(list, "3006013")?.status).toBe(MISSION_DOING); // nivel 2 todavia no
});

test("onEvent completa la mision y ReceiveMissionReward la cobra una sola vez", async () => {
  const { send, p } = await testSession();
  const vcoinBefore = p.coin[1];
  const frames = onEvent(p, "gacha");
  expect(frames.length).toBe(1);
  expect(frames[0].methodName).toBe("NoticeUpdateMissionS2C");
  expect(find(frames[0].paramObject.list, "3016002")).toEqual({ id: "3016002", status: MISSION_FINISH, progress: 1 });
  expect(find(frames[0].paramObject.list, "3011008")?.progress).toBe(1); // 3 gachas: sigue en curso

  const [r] = await send("ReceiveMissionRewardC2S", { id: "3016002" });
  expect(r.paramObject.res).toBe(0);
  expect(r.paramObject.give_exp).toBe(60);
  expect(r.paramObject.coin).toEqual([0, 25, 0, 0]);
  expect(r.paramObject.lv).toBe(p.lv);
  expect(r.paramObject.exp).toBe(p.exp);
  expect(p.coin[1]).toBe(vcoinBefore + 25);
  expect(p.exp + (p.lv - 1) * 1000).toBeGreaterThan(0); // ha recibido exp (haya subido o no)

  const [again] = await send("ReceiveMissionRewardC2S", { id: "3016002" });
  expect(again.paramObject.res).toBe(1012); // ya cobrada
  const [list] = await send("GetMissionC2S");
  expect(find(list.paramObject.list, "3016002")?.status).toBe(MISSION_CLAIMED);

  const [notDone] = await send("ReceiveMissionRewardC2S", { id: "3011008" });
  expect(notDone.paramObject.res).toBe(1019);
  const [bad] = await send("ReceiveMissionRewardC2S", { id: "9999999" });
  expect(bad.paramObject.res).toBe(1003);
  const [noId] = await send("ReceiveMissionRewardC2S", {});
  expect(noId.paramObject.res).toBe(1002);
});

test("onEvent filtra por objetivo (capitulo concreto) y acumula progreso", async () => {
  const { p } = await testSession();
  expect(onEvent(p, "chapter_clear:1001033")).toHaveLength(1);
  const [f] = onEvent(p, "chapter_clear:1001033", 2);
  const m = find(f.paramObject.list, "3005005"); // 3 veces el capitulo 1001033
  expect(m).toEqual({ id: "3005005", status: MISSION_FINISH, progress: 3 });
  expect(find(f.paramObject.list, "3005010")).toBeUndefined(); // otro capitulo: no avanza
  expect(find(f.paramObject.list, "3011001")?.progress).toBe(3); // cualquier capitulo x3 (diaria)
  expect(() => onEvent(p, "no_existe")).toThrow();
});

test("GetMail trae el correo de bienvenida y ReceiveMailAnnex cobra el anexo una sola vez", async () => {
  const { send, p } = await testSession();
  const [g] = await send("GetMailC2S", { serial: 0 });
  expect(g.paramObject.res).toBe(0);
  const list = g.paramObject.list as Record<string, unknown>[];
  expect(list.length).toBe(1);
  const mail = list[0];
  expect(mail.title).toBe(WELCOME_MAIL.title);
  expect(mail.read_flag).toBe(0);
  expect(mail.annex).toEqual(WELCOME_MAIL.annex);
  expect(mail.notified).toBeUndefined();
  expect(Number(mail.expiryTime)).toBeGreaterThan(Number(mail.sendTime));

  const [rd] = await send("ReadMailC2S", { serial: mail.serial });
  expect(rd.paramObject.res).toBe(0);

  const g0 = p.coin[0], v0 = p.coin[1];
  const [a] = await send("ReceiveMailAnnexC2S", { serial: mail.serial });
  expect(a.methodName).toBe("ReceiveMailAnnexS2C");
  expect(a.paramObject.res).toBe(0);
  expect(a.paramObject.gcoin).toBe(3000);
  expect(a.paramObject.vcoin).toBe(50);
  expect(a.paramObject.reward).toEqual([["0202005", 2]]);
  expect(p.coin[0]).toBe(g0 + 3000);
  expect(p.coin[1]).toBe(v0 + 50);
  expect(p.items["0202005"]).toBe(2);

  const [twice] = await send("ReceiveMailAnnexC2S", { serial: mail.serial });
  expect(twice.paramObject.res).toBe(1003);
  const [empty] = await send("GetMailC2S", { serial: 0 });
  expect((empty.paramObject.list as unknown[]).length).toBe(0);
});

test("EntertainID premia al que introduce el codigo y al invitador por correo", async () => {
  const a = await testSession();
  const b = await testSession();
  const code = Object.values(a.p.roles)[0].auid;

  const [own] = await a.send("EntertainIDC2S", { id: code });
  expect(own.paramObject.res).toBe(1003); // su propio codigo
  const [wrong] = await b.send("EntertainIDC2S", { id: "0000000000" });
  expect(wrong.paramObject.res).toBe(1005);

  const v0 = b.p.coin[1];
  const out = await b.send("EntertainIDC2S", { id: code });
  expect(out[0].methodName).toBe("EntertainIDS2C");
  expect(out[0].paramObject.res).toBe(0);
  expect(b.p.entertain_flag).toBe(code);
  expect(b.p.coin[1]).toBe(v0 + 250); // entertain_info fila 0
  expect(out.some((f) => f.methodName === "NoticeUpdateS2C" && f.paramObject.cmd === "coin")).toBe(true);
  expect(a.p.entertain_times).toBe(1);

  const [used] = await b.send("EntertainIDC2S", { id: code });
  expect(used.paramObject.res).toBe(1020);

  // el invitador recibe el aviso pendiente con su siguiente mensaje del dominio
  const frames = await a.send("NoticeUpdateEntertainC2S");
  expect(frames[0].paramObject.entertain_times).toBe(1);
  expect(frames.some((f) => f.methodName === "NoticeUpdateEntertainS2C")).toBe(true);

  // con 3 invitados llega el correo del umbral 3
  for (let i = 0; i < 2; i++) {
    const c = await testSession();
    const [r] = await c.send("EntertainIDC2S", { id: code });
    expect(r.paramObject.res).toBe(0);
  }
  expect(a.p.entertain_times).toBe(3);
  const [mails] = await a.send("GetMailC2S", { serial: 0 });
  const reward = (mails.paramObject.list as { title: string; annex: unknown }[]).find((m) => m.title.includes("3 friends"));
  expect(reward).toBeDefined();
  expect(reward!.annex).toEqual([{ id: "gcoin", amount: 10000 }, { id: "vcoin", amount: 50 }]);
});

test("actividades responden vacias y con el nombre de receptor que espera el cliente", async () => {
  const { send } = await testSession();
  const [act] = await send("GetActivityC2S");
  expect(act.paramObject).toMatchObject({ res: 0, list: [] });
  const [recs] = await send("GetActivityRecordC2S");
  expect(recs.paramObject).toMatchObject({ res: 0, size: 0, list: [] });
  const [rw] = await send("ReceiveActivityRewardC2S", { type: 13 });
  expect(rw.paramObject.res).toBe(1003);
  const [ex] = await send("getItemActivityRewardC2S", { activity_id: "2011", activity_type: 500, index: 0 });
  expect(ex.methodName).toBe("getItemActivityRewardS2C");
  expect(ex.paramObject).toMatchObject({ rs: -2, rewadList: [] });
  const [ur] = await send("getUserItemActivityRecordC2S", { activityIdList: [] });
  expect(ur.paramObject.rs).toEqual([]);
  const [add] = await send("getAdditionalRewardC2S");
  expect(add.methodName).toBe("getAdditionalReward");
  expect(add.paramObject.rewadList).toEqual([]);
  const [rec] = await send("addItemActivityRecordC2S");
  expect(rec.methodName).toBe("addItemActivityRecord");
  const [nm] = await send("NoticeNewMailC2S");
  expect(nm.methodName).toBe("NoticeNewMailS2C");
  expect((nm.paramObject.list as unknown[]).length).toBe(1); // bienvenida aun no anunciada
});
