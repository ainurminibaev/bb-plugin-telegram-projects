import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Store } from "../model";

function memStore(): Store {
  const rows = new Map<string, any>();
  return {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
}
import { openArchive } from "../archive";
import { acceptGroupUpdate, routeUpdate, type GroupTopicPolicy } from "../ingress";
import { processGroupInputs } from "../group-worker";
import { setAccess } from "../rights";
import {
  anyBotRepliedAfter,
  buildFastDecidePrompt,
  decideUnaddressed,
  fastDecideEnabled,
  fastDecideEnabledKey,
  noteBotMessageInTopic,
  type FastDecideContext,
} from "../fast-decide";

const OWNER = 1001;
const MEMBER = 2002;
const BOT = 9001;
const COLLEAGUE_BOT = 9002;
const CHAT = -5001;
const TOPIC = 42;

const basePolicy = (overrides: Partial<GroupTopicPolicy> = {}): GroupTopicPolicy => ({
  chatId: CHAT,
  topicId: TOPIC,
  projectId: "proj_fd",
  threadId: "thr_test_fd",
  ownerOnly: false,
  requireMention: true,
  leadMode: "lead",
  leadExplicit: true,
  botId: BOT,
  botUsername: "alpha_bot",
  ownerId: OWNER,
  revision: "rev1",
  allowedSenderIds: [MEMBER],
  ...overrides,
});

const msgUpdate = (text: string, fromId = MEMBER, extra: Record<string, unknown> = {}) => ({
  update_id: 500,
  message: {
    message_id: 100,
    date: 1700000000,
    chat: { id: CHAT, type: "supergroup", title: "Work Chat" },
    message_thread_id: TOPIC,
    is_topic_message: true,
    from: { id: fromId, is_bot: false, first_name: fromId === OWNER ? "Owner" : "Alex" },
    text,
    ...extra,
  },
});

const sampleCtx = (isLeader: boolean): FastDecideContext => ({
  chatTitle: "Work Chat",
  chatId: CHAT,
  topicTitle: "Sprint 1",
  topicId: TOPIC,
  messageText: "Кто-нибудь проверял сборку?",
  senderName: "Alex",
  senderKind: "участник",
  mentions: [],
  recentMessages: ["Обсуждаем релиз", "Нужно проверить тесты"],
  isLeader,
  agentName: "Alpha",
  agentRole: "Координатор задач",
  agentZones: ["релизы", "сборка"],
});

test("fast-decide: disabled setting preserves existing mode table exactly", () => {
  const store = memStore();
  assert.equal(fastDecideEnabled(store), false);
  const nonLeader = basePolicy({ leadMode: "mention", leadExplicit: false, fastDecideEnabled: false });
  assert.equal(routeUpdate(msgUpdate("Привет всем"), OWNER, undefined, nonLeader).kind, "ignore");
  const leader = basePolicy({ leadMode: "lead", leadExplicit: true, fastDecideEnabled: false });
  const r = routeUpdate(msgUpdate("Привет всем"), OWNER, undefined, leader);
  assert.equal(r.kind, "group");
  if (r.kind === "group") assert.equal(r.fastDecide, undefined);
});

test("fast-decide: direct mention to this bot or another bot never sets fastDecide", () => {
  const p = basePolicy({ leadMode: "mention", fastDecideEnabled: true });
  const direct = routeUpdate(
    msgUpdate("@alpha_bot помоги", MEMBER, {
      entities: [{ type: "mention", offset: 0, length: 10 }],
    }),
    OWNER,
    undefined,
    p,
  );
  assert.equal(direct.kind, "group");
  if (direct.kind === "group") assert.equal(direct.fastDecide, undefined);

  const toOther = routeUpdate(
    msgUpdate("@beta_bot помоги", MEMBER, {
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
    OWNER,
    undefined,
    p,
  );
  assert.equal(toOther.kind, "ignore");
});

test("fast-decide: decideUnaddressed rules for leader, non-leader and service fallback", async () => {
  assert.equal(await decideUnaddressed(sampleCtx(true), async () => "relevant", false), "pass");
  assert.equal(await decideUnaddressed(sampleCtx(true), async () => "my_zone_only", false), "pass");
  assert.equal(await decideUnaddressed(sampleCtx(true), async () => "ignore", true), "drop");

  assert.equal(await decideUnaddressed(sampleCtx(false), async () => "my_zone_only", false), "wait");
  assert.equal(await decideUnaddressed(sampleCtx(false), async () => "relevant", false), "drop");
  assert.equal(await decideUnaddressed(sampleCtx(false), async () => "ignore", false), "drop");

  assert.equal(await decideUnaddressed(sampleCtx(true), async () => undefined, true), "pass");
  assert.equal(await decideUnaddressed(sampleCtx(false), async () => undefined, false), "drop");
  assert.equal(await decideUnaddressed(sampleCtx(true), async () => { throw new Error("timeout"); }, true), "pass");
  assert.equal(await decideUnaddressed(sampleCtx(false), async () => { throw new Error("timeout"); }, false), "drop");

  const prompt = buildFastDecidePrompt(sampleCtx(false));
  assert.match(prompt, /Work Chat/);
  assert.match(prompt, /Sprint 1/);
  assert.match(prompt, /Координатор задач/);
  assert.match(prompt, /релизы, сборка/);
  assert.match(prompt, /не ведущий/);
});

test("fast-decide: processGroupInputs leader ignore does not start main model; relevant starts turn", async () => {
  const store = memStore();
  store.put(fastDecideEnabledKey, true);
  setAccess(store, BOT, [{ id: MEMBER, name: "Alex" }]);
  const policy = basePolicy({ leadMode: "lead", leadExplicit: true });
  store.put(`group:policy:${CHAT}:${TOPIC}`, policy);
  store.put("group:thread:thr_test_fd", `group:policy:${CHAT}:${TOPIC}`);
  store.put("group:project:proj_fd", true);

  const sentTurns: string[] = [];
  const fakeSdk = {
    threads: {
      get: async () => ({ id: "thr_test_fd", projectId: "proj_fd", visibility: "visible", status: "idle" }),
      send: async (arg: any) => { sentTurns.push(String(arg.input?.[0]?.text ?? "")); return { turnId: "t1" }; },
      events: { list: async () => [] },
    },
  } as any;
  const fakeTg = () => async () => ({ message_id: 999 });

  assert.equal(acceptGroupUpdate(store, msgUpdate("Просто болтаем"), OWNER, BOT), true);
  let calls = 0;
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => { calls++; return "ignore"; }, agentName: "Alpha", agentRole: "Lead" },
  );
  assert.equal(calls, 1);
  assert.equal(sentTurns.length, 0);
  assert.equal(store.list(`group:in:${BOT}:`).length, 0);

  const u2 = msgUpdate("Нужен план на завтра");
  u2.update_id = 501; u2.message.message_id = 101;
  assert.equal(acceptGroupUpdate(store, u2, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => { calls++; return "relevant"; }, agentName: "Alpha", agentRole: "Lead" },
  );
  assert.equal(calls, 2);
  assert.equal(sentTurns.length, 1);
});

test("fast-decide: non-leader waits on my_zone_only and cancels if a colleague agent replies", async () => {
  const store = memStore();
  store.put(fastDecideEnabledKey, true);
  setAccess(store, BOT, [{ id: MEMBER, name: "Alex" }]);
  const policy = basePolicy({ leadMode: "mention", leadExplicit: false });
  store.put(`group:policy:${CHAT}:${TOPIC}`, policy);
  store.put("group:thread:thr_test_fd", `group:policy:${CHAT}:${TOPIC}`);
  store.put("group:project:proj_fd", true);
  store.put(`topic:mode:${BOT}:${CHAT}:${TOPIC}`, { mode: "mention", by: OWNER, at: Date.now() });

  const sentTurns: string[] = [];
  const fakeSdk = {
    threads: {
      get: async () => ({ id: "thr_test_fd", projectId: "proj_fd", visibility: "visible", status: "idle" }),
      send: async (arg: any) => { sentTurns.push(String(arg.input?.[0]?.text ?? "")); return { turnId: "t1" }; },
      events: { list: async () => [] },
    },
  } as any;
  const fakeTg = () => async () => ({ message_id: 999 });

  assert.equal(acceptGroupUpdate(store, msgUpdate("Упал деплой"), OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => "my_zone_only", nonLeaderWaitMs: 60 },
  );
  assert.equal(sentTurns.length, 0);
  noteBotMessageInTopic(store, BOT, CHAT, TOPIC, 101);
  assert.equal(anyBotRepliedAfter(store, BOT, CHAT, TOPIC, 100), true);
  await new Promise(r => setTimeout(r, 80));
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => "my_zone_only", nonLeaderWaitMs: 60 },
  );
  assert.equal(sentTurns.length, 0);
  assert.equal(store.list(`group:in:${BOT}:`).length, 0);

  const u2 = msgUpdate("Снова упал деплой");
  u2.update_id = 502; u2.message.message_id = 105;
  assert.equal(acceptGroupUpdate(store, u2, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => "my_zone_only", nonLeaderWaitMs: 40 },
  );
  assert.equal(sentTurns.length, 0);
  await new Promise(r => setTimeout(r, 60));
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => "my_zone_only", nonLeaderWaitMs: 40 },
  );
  assert.equal(sentTurns.length, 1);
});

test("fast-decide: archive.anySenderWroteAfter detects colleague bot reply", () => {
  const db = new Database(":memory:");
  const archive = openArchive(db);
  archive.record(BOT, {
    update_id: 1,
    message: {
      message_id: 10, date: 1000, chat: { id: CHAT, type: "supergroup", title: "Work Chat" },
      message_thread_id: TOPIC, is_topic_message: true,
      from: { id: MEMBER, is_bot: false, first_name: "Alex" }, text: "вопрос",
    },
  });
  assert.equal(archive.anySenderWroteAfter(BOT, CHAT, TOPIC, 10, [BOT, COLLEAGUE_BOT]), false);
  archive.record(BOT, {
    update_id: 2,
    message: {
      message_id: 11, date: 1002, chat: { id: CHAT, type: "supergroup", title: "Work Chat" },
      message_thread_id: TOPIC, is_topic_message: true,
      from: { id: COLLEAGUE_BOT, is_bot: true, first_name: "Beta" }, text: "беру в работу",
    },
  });
  assert.equal(archive.anySenderWroteAfter(BOT, CHAT, TOPIC, 10, [BOT, COLLEAGUE_BOT]), true);
  assert.equal(archive.anySenderWroteAfter(BOT, CHAT, TOPIC, 11, [BOT, COLLEAGUE_BOT]), false);
});

test("fast-decide: processGroupInputs fallback on service failure and direct mention skips service", async () => {
  const store = memStore();
  store.put(fastDecideEnabledKey, true);
  setAccess(store, BOT, [{ id: MEMBER, name: "Alex" }]);
  const policy = basePolicy({ leadMode: "lead", leadExplicit: true });
  store.put(`group:policy:${CHAT}:${TOPIC}`, policy);
  store.put("group:thread:thr_test_fd", `group:policy:${CHAT}:${TOPIC}`);
  store.put("group:project:proj_fd", true);

  const sentTurns: string[] = [];
  const fakeSdk = {
    threads: {
      get: async () => ({ id: "thr_test_fd", projectId: "proj_fd", visibility: "visible", status: "idle" }),
      send: async (arg: any) => { sentTurns.push(String(arg.input?.[0]?.text ?? "")); return { turnId: "t1" }; },
      events: { list: async () => [] },
    },
  } as any;
  const fakeTg = () => async () => ({ message_id: 999 });

  // Direct mention skips fast-decision service completely
  let calls = 0;
  const uDirect = msgUpdate("@alpha_bot привет", MEMBER, {
    entities: [{ type: "mention", offset: 0, length: 10 }],
  });
  uDirect.update_id = 600; uDirect.message.message_id = 200;
  assert.equal(acceptGroupUpdate(store, uDirect, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => { calls++; return "ignore"; } },
  );
  assert.equal(calls, 0);
  assert.equal(sentTurns.length, 1);

  // Clear previous submitted job and explicitly mark this bot as topic leader
  store.del(`group:in:${BOT}:600`);
  store.put(`topic:mode:${BOT}:${CHAT}:${TOPIC}`, { mode: "lead", by: OWNER, at: Date.now() });
  // Leader fallback on service error (returns undefined) → passes (leadExplicit=true)
  const uLeadFail = msgUpdate("Без отметки при сбое службы");
  uLeadFail.update_id = 601; uLeadFail.message.message_id = 201;
  assert.equal(acceptGroupUpdate(store, uLeadFail, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => { calls++; return undefined; } },
  );
  assert.equal(calls, 1);
  assert.equal(sentTurns.length, 2);

  // Non-leader fallback on service error → drops (requireMention=true)
  store.put(`topic:mode:${BOT}:${CHAT}:${TOPIC}`, { mode: "mention", by: OWNER, at: Date.now() });
  const uNonLeadFail = msgUpdate("Без отметки для не-ведущего при сбое");
  uNonLeadFail.update_id = 602; uNonLeadFail.message.message_id = 202;
  assert.equal(acceptGroupUpdate(store, uNonLeadFail, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => { calls++; return undefined; } },
  );
  assert.equal(calls, 2);
  assert.equal(sentTurns.length, 2);
});

test("fast-decide: visibility chatTitle, /cmd@other_bot ignored, third-party bot does not cancel non-leader wait", async () => {
  const p = basePolicy({ leadMode: "mention", fastDecideEnabled: true });
  // /cmd@beta_bot goes to another bot → ignored without fastDecide
  const cmdOther = routeUpdate(
    msgUpdate("/status@beta_bot", MEMBER, {
      entities: [{ type: "bot_command", offset: 0, length: 16 }],
    }),
    OWNER,
    undefined,
    p,
  );
  assert.equal(cmdOther.kind, "ignore");

  // Third-party bot (not in agentBots) must NOT cancel non-leader wait, and chatTitle comes from visibility key
  const store = memStore();
  store.put(fastDecideEnabledKey, true);
  store.put(`visibility:${BOT}:group:${CHAT}`, { title: "Общая группа" });
  store.put("rights:agent-bots", [COLLEAGUE_BOT]);
  setAccess(store, BOT, [{ id: MEMBER, name: "Alex" }]);
  const policy = basePolicy({ leadMode: "mention", leadExplicit: false });
  store.put(`group:policy:${CHAT}:${TOPIC}`, policy);
  store.put("group:thread:thr_test_fd", `group:policy:${CHAT}:${TOPIC}`);
  store.put("group:project:proj_fd", true);
  store.put(`topic:mode:${BOT}:${CHAT}:${TOPIC}`, { mode: "mention", by: COLLEAGUE_BOT, at: Date.now() });
  store.put(`chat:agent-name:${COLLEAGUE_BOT}`, "@beta_bot");

  const sentTurns: string[] = [];
  const prompts: string[] = [];
  const fakeSdk = {
    threads: {
      get: async () => ({ id: "thr_test_fd", projectId: "proj_fd", visibility: "visible", status: "idle" }),
      send: async (arg: any) => { sentTurns.push(String(arg.input?.[0]?.text ?? "")); return { turnId: "t1" }; },
      events: { list: async () => [] },
    },
  } as any;
  const fakeTg = () => async () => ({ message_id: 999 });

  const u1 = msgUpdate("Нужно проверить смету");
  u1.update_id = 700; u1.message.message_id = 300;
  assert.equal(acceptGroupUpdate(store, u1, OWNER, BOT), true);
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async (input) => { prompts.push(input); return "my_zone_only"; }, nonLeaderWaitMs: 40 },
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Чат: Общая группа/);
  assert.match(prompts[0], /@beta_bot/);

  // Unrelated third-party bot (id=77777, not in agentBots) posts message 301 → must NOT cancel wait
  acceptGroupUpdate(store, {
    update_id: 701,
    message: {
      message_id: 301, date: 1700000010, chat: { id: CHAT, type: "supergroup", title: "Общая группа" },
      message_thread_id: TOPIC, is_topic_message: true,
      from: { id: 77777, is_bot: true, first_name: "CI Bot" }, text: "build green",
    },
  }, OWNER, BOT);
  assert.equal(anyBotRepliedAfter(store, BOT, CHAT, TOPIC, 300), false);

  await new Promise(r => setTimeout(r, 60));
  await processGroupInputs(
    store, fakeSdk, OWNER, BOT, fakeTg, new AbortController().signal,
    undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { choose: async () => "my_zone_only", nonLeaderWaitMs: 40 },
  );
  assert.equal(sentTurns.length, 1);
});
