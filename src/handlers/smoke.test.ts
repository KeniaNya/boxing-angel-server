import { test, expect } from "bun:test";
import { testSession } from "../testutil.ts";

test("mensaje sin handler responde res 0", async () => {
  const { send } = await testSession();
  const out = await send("testC2S", {});
  expect(out[0].methodName).toBe("testS2C");
  expect(out[0].paramObject.res).toBe(0);
});
