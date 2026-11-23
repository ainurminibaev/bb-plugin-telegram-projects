import test from "node:test";
import assert from "node:assert/strict";
import {settled, setSlowWorkGrace} from "../group-worker";

// С50: slow work in one chat never holds the worker; quick work is used in the same pass.
test("quick work is taken at once; slow work returns later without blocking", async () => {
  setSlowWorkGrace(20);
  const quick = await settled("q", async () => "готово");
  assert.deepEqual(quick, {value: "готово"});
  let release!: (v: string) => void;
  const slow = new Promise<string>(r => { release = r; });
  const t0 = Date.now();
  assert.equal(await settled("s", () => slow), undefined);
  assert.ok(Date.now() - t0 < 500, "the worker is not held");
  assert.equal(await settled("s", () => { throw Error("not started twice"); }), undefined);
  release("расшифровка");
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(await settled("s", () => { throw Error("not started twice"); }), {value: "расшифровка"});
  const failed = await settled("f", async () => { throw Error("network"); });
  assert.ok(failed && "error" in failed);
  setSlowWorkGrace(1500);
});
