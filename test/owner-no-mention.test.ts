import test from "node:test";
import assert from "node:assert/strict";
import { routeUpdate } from "../ingress";
import { effectiveGroupPolicy, saveGroupSettings, rulesNote, defaultGroupSettings } from "../rights";

// С55: the owner reaches the agent in a group without a mention; others still follow the group's rules.
const OWNER = 11, COLLEAGUE = 22, BOT = 70;
const forum = { id: -1001, type: "supergroup" };
const policy = { chatId: forum.id, topicId: 3, threadId: "t", ownerOnly: false, requireMention: true, botId: BOT, botUsername: "test_bot" };
const msg = (from: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: 5, message: { message_id: 9, message_thread_id: 3, chat: forum, from: { id: from }, text, ...extra } });

test("the owner without a mention reaches the agent, marked as unaddressed", () => {
  const r = routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, policy);
  assert.equal(r.kind, "group");
  if (r.kind === "group") assert.equal(r.ownerUnaddressed, true);
});

test("a mention of the bot is an ordinary addressed message", () => {
  const r = routeUpdate(msg(OWNER, "@test_bot что по задаче?", { entities: [{ type: "mention", offset: 0, length: 9 }] }), OWNER, undefined, policy);
  assert.equal(r.kind, "group");
  if (r.kind === "group") assert.equal(r.ownerUnaddressed, undefined);
});

test("the owner talking to someone else does not reach the agent", () => {
  const reply = { message_id: 8, message_thread_id: 3, chat: forum, from: { id: COLLEAGUE } };
  assert.equal(routeUpdate(msg(OWNER, "Согласен", { reply_to_message: reply }), OWNER, undefined, policy).kind, "ignore");
  assert.equal(routeUpdate(msg(OWNER, "@oleg посмотри", { entities: [{ type: "mention", offset: 0, length: 5 }] }), OWNER, undefined, policy).kind, "ignore");
  // A reply to the topic root is not a reply to a person.
  const root = { message_id: 3, message_thread_id: 3, chat: forum, from: { id: COLLEAGUE } };
  assert.equal(routeUpdate(msg(OWNER, "Что по задаче?", { reply_to_message: root }), OWNER, undefined, policy).kind, "group");
});

test("another member without a mention is ignored in a mention group", () => {
  assert.equal(routeUpdate(msg(COLLEAGUE, "Что по задаче?"), OWNER, undefined, policy).kind, "ignore");
});

test("the group setting switches it off; the rules tell the agent", () => {
  const rows = new Map<string, any>();
  const store = { get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); }, list: () => [], atomic: (fn: () => void) => fn() };
  saveGroupSettings(store as never, BOT, forum.id, { who: "access" });
  const on = effectiveGroupPolicy(store as never, policy as never, OWNER);
  assert.equal(on.ownerWithoutMention, true);
  assert.match(rulesNote({ title: "Г", settings: defaultGroupSettings(), role: "access", senderName: "В" }), /без отметки/);
  const s = saveGroupSettings(store as never, BOT, forum.id, { ownerNoMention: false });
  const off = effectiveGroupPolicy(store as never, policy as never, OWNER);
  assert.equal(off.ownerWithoutMention, false);
  assert.equal(routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, off).kind, "ignore");
  assert.doesNotMatch(rulesNote({ title: "Г", settings: s, role: "access", senderName: "В" }), /без отметки/);
});
