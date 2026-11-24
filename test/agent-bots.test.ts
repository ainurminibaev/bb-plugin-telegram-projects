import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate, routeUpdate} from "../ingress";
import {agentBotsKey, agentChainLimitKey, authorStatus, rulesNote} from "../rights";
import {bindGroupTopic} from "../group-worker";

// С74: a known agent bot of the organization is heard like a person; other bots are not; bot-to-bot chains are limited.
const OWNER = 7, BOT = 5, COLLEAGUE_BOT = 900, STRANGER_BOT = 901, PERSON = 21;
const forum = {id: -1001234567890, type: "supergroup"};
const policy = {chatId: forum.id, topicId: 3, threadId: "t", ownerOnly: true, requireMention: true, botId: BOT, botUsername: "test_bot", agentBots: [COLLEAGUE_BOT]};
const msg = (id: number, from: {id: number; is_bot?: boolean; username?: string}, text = "@test_bot проверь") =>
  ({update_id: id, message: {message_id: id, message_thread_id: 3, is_topic_message: true, chat: forum, date: 2_000_000_000, from, text,
    entities: text.startsWith("@test_bot") ? [{type: "mention", offset: 0, length: 9}] : []}});

test("a colleague agent bot is taken; a stranger bot is not", () => {
  assert.equal(routeUpdate(msg(1, {id: COLLEAGUE_BOT, is_bot: true}), OWNER, undefined, policy).kind, "group");
  assert.equal(routeUpdate(msg(2, {id: STRANGER_BOT, is_bot: true}), OWNER, undefined, policy).kind, "ignore");
});

test("the status says it is a colleague agent", () => {
  const rows = new Map<string, any>([[agentBotsKey, [COLLEAGUE_BOT]]]);
  const store = {get: <T>(k: string) => rows.get(k) as T, put: () => {}, del: () => {}, list: () => [], atomic: (f: () => void) => f()};
  assert.equal(authorStatus(store as never, BOT, OWNER, COLLEAGUE_BOT), "agent");
  assert.match(rulesNote({title: "Г", role: "access", senderName: "Бот", status: "agent"}), /коллега-агент/);
});

test("a chain of agent messages without a person stops at the limit; a person resets it", () => {
  const rows = new Map<string, any>();
  const store = {get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); }, del: (k: string) => { rows.delete(k); },
    list: <T>(p: string) => [...rows].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({key, value: value as T})), atomic: (f: () => void) => f()};
  rows.set(agentBotsKey, [COLLEAGUE_BOT]);
  bindGroupTopic(store as never, {...policy, revision: "r"} as never, "p");
  const jobs = () => store.list<any>(`group:in:${BOT}:`).map(r => r.value.route.text as string);
  rows.set(agentChainLimitKey, 3);
  acceptGroupUpdate(store as never, msg(10, {id: PERSON, username: "starter"}, "начнём дело"), OWNER, BOT);
  const before = jobs().length;
  for (const id of [11, 12, 13, 14]) acceptGroupUpdate(store as never, msg(id, {id: COLLEAGUE_BOT, is_bot: true}), OWNER, BOT);
  assert.equal(jobs().length - before, 3, "the fourth reply in a row is not taken");
  assert.match(jobs().at(-1)!, /3-я реплика агентов подряд без человека/);
  assert.match(jobs().at(-1)!, /спроси @starter, продолжать ли/, "soft limit: the agent asks the person who started the matter");
  acceptGroupUpdate(store as never, msg(15, {id: PERSON}, "обычная реплика человека"), OWNER, BOT);
  acceptGroupUpdate(store as never, msg(16, {id: COLLEAGUE_BOT, is_bot: true}), OWNER, BOT);
  assert.equal(jobs().length - before, 4, "after a person the agent is heard again");
});

test("with the setting empty (the default) no bot is taken: the agent path is not used", () => {
  const rows = new Map<string, any>();
  const store = {get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); }, del: (k: string) => { rows.delete(k); },
    list: <T>(p: string) => [...rows].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({key, value: value as T})), atomic: (f: () => void) => f()};
  const {agentBots: _, ...plain} = policy;
  bindGroupTopic(store as never, {...plain, revision: "r"} as never, "p");
  acceptGroupUpdate(store as never, msg(31, {id: COLLEAGUE_BOT, is_bot: true}), OWNER, BOT);
  assert.equal(store.list(`group:in:${BOT}:`).length, 0);
  assert.equal(rows.has(`group:agent-chain:${forum.id}:3`), false, "no chain counting either");
  assert.equal(routeUpdate(msg(32, {id: COLLEAGUE_BOT, is_bot: true}), OWNER, undefined, plain).kind, "ignore");
});
