import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
test("local API preparation checks identity, returns no secret and does not repeat logout", async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").at(-1)!; methods.push(method);
    return new Response(JSON.stringify({ok: true, result: method === "getMe" ?
      {id: 123, username: "test_assistant_bot"} : true}), {status: 200});
  };
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", settings: {
    enabled: false, chatEnabled: false, botToken: "123:fake-token"}});
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", {expectedUsername: "different_bot", confirm: true}));
    assert.deepEqual(methods, ["getMe"]);
    const args = {expectedUsername: "test_assistant_bot", confirm: true};
    assert.deepEqual(await harness.behavior.callRpc("prepareLocalApi", args), {loggedOut: true, botId: 123});
    await harness.behavior.callRpc("prepareLocalApi", args);
    assert.deepEqual(methods, ["getMe", "getMe", "logOut"]);
    await harness.behavior.setSettings({enabled: true});
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    assert.equal(methods.length, 3);
  } finally {await harness.lifecycle.dispose(); globalThis.fetch = original;}
});

test("ambiguous cloud logout is never automatically repeated", async () => {
  const original = globalThis.fetch;
  let logouts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/logOut")) {logouts++; throw Error("connection lost");}
    return new Response(JSON.stringify({ok: true, result: {id: 123, username: "test_assistant_bot"}}), {status: 200});
  };
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", settings: {
    enabled: false, chatEnabled: false, botToken: "123:fake-token"}});
  try {
    await plugin(bb);
    const args = {expectedUsername: "test_assistant_bot", confirm: true};
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    assert.equal(logouts, 1);
  } finally {await harness.lifecycle.dispose(); globalThis.fetch = original;}
});
test("disabled install has no external effects; CLI/RPC survive reload", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "telegram-projects",
  });
  await plugin(bb);
  const prefs = (await harness.behavior.callRpc("preferences", null)) as any;
  assert.equal(prefs.language, "ru");
  assert.ok(!("token" in prefs));
  const { tokenPresent, tokenSource, tokenEnv, ...editable } = prefs;
  await harness.behavior.callRpc("savePreferences", {
    ...editable,
    language: "en",
  });
  assert.equal(
    ((await harness.behavior.callRpc("preferences", null)) as any).language,
    "en",
  );
  const initial = (await harness.behavior.callRpc("status", null)) as any;
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.topics, []);
  await harness.behavior.callRpc("sync", null);
  assert.equal(harness.inspection.sdk.calls.length, 0);
  const cli = await harness.behavior.runCli(["status", "--json"]);
  assert.equal(cli.exitCode, 0);
  const next = await harness.lifecycle.reload(plugin);
  await next.harness.behavior.callRpc("status", null);
  await next.harness.lifecycle.dispose();
});
