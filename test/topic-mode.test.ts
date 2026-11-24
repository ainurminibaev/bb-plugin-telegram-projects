import test from "node:test";
import assert from "node:assert/strict";
import { routeUpdate, acceptGroupUpdate } from "../ingress";
import { bindGroupTopic } from "../group-worker";
import { agentBotsKey } from "../rights";
import { addressedToAgent, leadsChat, setChatMode, noteColleagueLead, noteOwnActivity, migrateTopicModes, DEFAULT_LEAD_LINE, announceKey, canAssignLead, chatAgentsCheckedKey, chatAgentsKey, noteAgentsLeaving, refreshChatAgents, curatorsKey, modeLine, noteAgentInChat, otherAgentsInChat,
  setTopicMode, topicMode, topicNote, withTopicMode } from "../topic-mode";

// Agents in shared chats (agents-in-chats.md, «Проверка»): three agents of one organization in a forum.
const OWNER = 11, PERSON = 22, CURATOR = 33, A = 70, B = 71, C = 72, CHAT = -1001, TOPIC = 3;
const forum = { id: CHAT, type: "supergroup", is_forum: true };
const usernames: Record<number, string> = { [A]: "alpha_bot", [B]: "beta_bot", [C]: "gamma_bot" };
function memoryStore() {
  const rows = new Map<string, any>();
  return { rows, get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(p: string) => [...rows].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value: value as T })),
    atomic: (fn: () => void) => fn() };
}
const base = (bot: number) => ({ chatId: CHAT, topicId: TOPIC, threadId: "thr_" + bot, ownerOnly: false, requireMention: true,
  botId: bot, botUsername: usernames[bot], agentBots: [A, B, C] });
const msg = (from: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: 5, message: { message_id: 9, message_thread_id: TOPIC, is_topic_message: true, chat: forum,
    from: { id: from, ...(from === A || from === B || from === C ? { is_bot: true, username: usernames[from] } : {}) }, text, ...extra } });
const mention = (bot: number, rest: string) => {
  const handle = "@" + usernames[bot];
  return msg(OWNER, handle + " " + rest, { entities: [{ type: "mention", offset: 0, length: handle.length }] });
};
/** One store per agent: each agent has its own bridge. All three were seen in the chat. */
function agents() {
  return [A, B, C].map(bot => {
    const store = memoryStore();
    for (const other of [A, B, C]) noteAgentInChat(store as any, bot, CHAT, other, [A, B, C], usernames[other]);
    return { bot, store, policy: () => withTopicMode(store as any, base(bot) as any, [A, B, C]) };
  });
}

test("three agents: the owner without a mention reaches only the topic's leader", () => {
  const all = agents();
  setTopicMode(all[0].store as any, A, CHAT, TOPIC, "lead", OWNER, [A, B, C]);
  const routes = all.map(a => routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, a.policy()));
  assert.deepEqual(routes.map(r => r.kind), ["group", "ignore", "ignore"]);
  // a person without a mention reaches the explicit leader too, marked so the agent may stay silent
  const person = all.map(a => routeUpdate(msg(PERSON, "Когда релиз?"), OWNER, undefined, { ...a.policy(), allowedSenderIds: undefined }));
  assert.deepEqual(person.map(r => r.kind), ["group", "ignore", "ignore"]);
  if (person[0].kind === "group") assert.equal(person[0].leaderUnaddressed, true);
});

test("three agents: a mention of the second reaches it alone; without a new mention it stays silent", () => {
  const all = agents();
  setTopicMode(all[0].store as any, A, CHAT, TOPIC, "lead", OWNER, [A, B, C]);
  const routes = all.map(a => routeUpdate(mention(B, "посмотри логи"), OWNER, undefined, a.policy()));
  assert.deepEqual(routes.map(r => r.kind), ["ignore", "group", "ignore"]);
  const next = all.map(a => routeUpdate(msg(OWNER, "Спасибо"), OWNER, undefined, a.policy()));
  assert.equal(next[1].kind, "ignore", "the called colleague does not stay in the topic");
});

test("three agents, a topic without a leader: a message without a mention starts no turn at all", () => {
  const all = agents();
  const routes = all.map(a => routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, a.policy()));
  assert.deepEqual(routes.map(r => r.kind), ["ignore", "ignore", "ignore"]);
});

test("one agent in the chat: nothing changes", () => {
  const store = memoryStore();
  const policy = withTopicMode(store as any, base(A) as any, [A, B, C]);
  assert.equal(policy.leadMode, "lead");
  assert.equal(policy.leadExplicit, false);
  const owner = routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, policy);
  assert.equal(owner.kind, "group");
  if (owner.kind === "group") { assert.equal(owner.ownerUnaddressed, true); assert.equal(owner.leaderUnaddressed, undefined); }
  assert.equal(routeUpdate(msg(PERSON, "Когда релиз?"), OWNER, undefined, { ...policy, allowedSenderIds: undefined }).kind, "ignore",
    "people still call it by a mention");
  assert.equal(topicNote(store as any, policy, [A, B, C], () => undefined, false), "", "no new lines in the turn");
});

test("who may make an agent lead: the owner and its curators, nobody else", () => {
  const store = memoryStore();
  store.put(curatorsKey, [CURATOR]);
  assert.equal(canAssignLead(store as any, OWNER, OWNER), true);
  assert.equal(canAssignLead(store as any, OWNER, CURATOR), true);
  assert.equal(canAssignLead(store as any, OWNER, PERSON), false);
  assert.equal(canAssignLead(store as any, OWNER, A), false);
  assert.equal(modeLine("lead"), "Веду эту тему. Позвать коллегу — отметьте его.");
  assert.equal(modeLine("mention"), "Вышел из темы, зовите отметкой.");
  assert.equal(setTopicMode(store as any, A, CHAT, TOPIC, "lead", OWNER, []), true);
  assert.equal(setTopicMode(store as any, A, CHAT, TOPIC, "lead", OWNER, []), false, "no second line for the same mode");
  assert.equal(topicMode(store as any, A, CHAT, TOPIC, []).mode, "lead");
});

test("an agent of the organization is noticed when it writes or joins; strangers' bots are not", () => {
  const store = memoryStore();
  store.put(agentBotsKey, [B]);
  bindGroupTopic(store as any, { ...base(A), agentBots: undefined, revision: "r" } as any, "proj");
  store.put("ingress:offset", 0);
  acceptGroupUpdate(store as any, { update_id: 1, message: { message_id: 2, chat: forum, from: { id: PERSON },
    new_chat_members: [{ id: B, is_bot: true, username: "beta_bot" }, { id: 99, is_bot: true }] } }, OWNER, A);
  assert.deepEqual(store.get(chatAgentsKey(A, CHAT)), [B]);
  assert.deepEqual(otherAgentsInChat(store as any, A, CHAT, [B]), [B]);
});

test("the turn says who leads, which colleagues are here, and that a called colleague answers once", () => {
  const store = memoryStore();
  noteAgentInChat(store as any, B, CHAT, A, [A, B], "@alpha_bot");
  const policy = withTopicMode(store as any, base(B) as any, [A, B]);
  const note = topicNote(store as any, policy, [A, B], id => store.get<string>(`chat:agent-name:${id}`), true);
  assert.match(note, /по отметке/);
  assert.match(note, /Другие агенты организации в этом чате: @alpha_bot/);
  assert.match(note, /позвали разово/);
  setTopicMode(store as any, B, CHAT, TOPIC, "lead", OWNER, [A, B]);
  const lead = topicNote(store as any, withTopicMode(store as any, base(B) as any, [A, B]), [A, B], () => undefined, false);
  assert.match(lead, /Ты ведёшь эту тему/);
  assert.doesNotMatch(lead, /разово/);
});

test("a new topic gets this agent's conversation only at a message addressed to it", () => {
  assert.equal(addressedToAgent(mention(A, "привет").message, A, "alpha_bot"), true);
  assert.equal(addressedToAgent(mention(B, "привет").message, A, "alpha_bot"), false);
  assert.equal(addressedToAgent(msg(OWNER, "просто так").message, A, "alpha_bot"), false);
  assert.equal(addressedToAgent(msg(OWNER, "да", { reply_to_message: { from: { id: A } } }).message, A, "alpha_bot"), true);
  assert.equal(addressedToAgent({ text: "Альфа, глянь", entities: [] }, A, "alpha_bot", "Альфа"), true);
  assert.equal(addressedToAgent(undefined, A, "alpha_bot"), false);
});

test("a colleague that never wrote counts: Telegram is asked once a day per chat; joining and leaving refresh it", async () => {
  const store = memoryStore();
  const asked: number[] = [];
  const members: Record<number, any> = { [B]: { status: "member" }, [C]: { status: "left" } };
  const ask = async (user: number) => { asked.push(user); return members[user]; };
  const day = 24 * 3600_000, t0 = 1_800_000_000_000;
  assert.equal(await refreshChatAgents(store as any, A, CHAT, [A, B, C], ask, t0), true);
  assert.deepEqual(asked, [B, C], "one question per other bot of the organization, never about itself");
  assert.deepEqual(otherAgentsInChat(store as any, A, CHAT, [A, B, C]), [B]);
  assert.equal(withTopicMode(store as any, base(A) as any, [A, B, C]).leadMode, "mention", "a silent colleague changes the default");
  assert.equal(await refreshChatAgents(store as any, A, CHAT, [A, B, C], ask, t0 + day - 1), false, "not more than once a day");
  assert.equal(asked.length, 2);
  members[B] = { status: "kicked" }; members[C] = { status: "restricted", is_member: true };
  assert.equal(await refreshChatAgents(store as any, A, CHAT, [A, B, C], ask, t0 + day), true);
  assert.deepEqual(otherAgentsInChat(store as any, A, CHAT, [A, B, C]), [C]);
  // a failed answer keeps what was known
  assert.equal(await refreshChatAgents(store as any, A, CHAT, [A, B, C], async () => { throw Error("network"); }, t0 + 3 * day), true);
  assert.deepEqual(otherAgentsInChat(store as any, A, CHAT, [A, B, C]), [C]);
  // a bot leaving the chat leaves the list at once
  assert.equal(noteAgentsLeaving(store as any, A, CHAT, { left_chat_member: { id: C, is_bot: true } }, [A, B, C]), true);
  assert.deepEqual(otherAgentsInChat(store as any, A, CHAT, [A, B, C]), []);
  assert.equal(withTopicMode(store as any, base(A) as any, [A, B, C]).leadMode, "lead", "alone again: as before");
  // no organization or a private chat: nothing is asked
  assert.equal(await refreshChatAgents(store as any, A, CHAT, [A], ask, t0 + 9 * day), false);
  assert.equal(await refreshChatAgents(store as any, A, 42, [A, B], ask, t0 + 9 * day), false);
  assert.equal(store.get(chatAgentsCheckedKey(A, 42)), undefined);
});

test("one agent, then a second: the first leads the chat — old and new topics; the second gets no turn", async () => {
  const first = memoryStore();
  for (const topic of [0, TOPIC]) bindGroupTopic(first as any, { ...base(A), topicId: topic, threadId: "thr_" + topic, revision: "r" } as any, "proj");
  migrateTopicModes(first as any, A);   // the update starts: the first agent already talked here
  const second = memoryStore();
  migrateTopicModes(second as any, B);  // a fresh installation: nothing yet
  bindGroupTopic(second as any, { ...base(B), revision: "r" } as any, "proj_b");   // the newcomer's first mention made it
  noteOwnActivity(second as any, B, CHAT, [A, B]);   // …a moment before it learned about the colleague
  noteAgentInChat(first as any, A, CHAT, B, [A, B], "@beta_bot");
  noteAgentInChat(second as any, B, CHAT, A, [A, B], "@alpha_bot");
  assert.equal(leadsChat(first as any, A, CHAT), true, "the agent that was here first leads the chat");
  assert.equal(leadsChat(second as any, B, CHAT), false, "the newcomer was not here before: by mention");
  for (const topic of [0, TOPIC, 99]) {   // 99: a new topic, no binding yet
    const p1 = withTopicMode(first as any, { ...base(A), topicId: topic } as any, [A, B]);
    const p2 = withTopicMode(second as any, { ...base(B), topicId: topic } as any, [A, B]);
    const m = { ...msg(OWNER, "Что по встрече?") };
    (m.message as any).message_thread_id = topic;
    assert.equal(routeUpdate(m, OWNER, undefined, p1).kind, "group", "the first answers, topic " + topic);
    assert.equal(routeUpdate(m, OWNER, undefined, p2).kind, "ignore", "the second gets no turn, topic " + topic);
    assert.equal(routeUpdate({ ...msg(PERSON, "Когда релиз?") }, OWNER, undefined, { ...p1, allowedSenderIds: undefined }).kind,
      "ignore", "people call by a mention, as before");
  }
  assert.match(topicNote(first as any, withTopicMode(first as any, base(A) as any, [A, B]), [A, B], () => "@beta_bot", false), /Ты ведёшь этот чат/);
});

test("the owner names another leader: the colleague announces it and the former one steps back", () => {
  const a = memoryStore(), b = memoryStore();
  bindGroupTopic(a as any, { ...base(A), revision: "r" } as any, "proj");
  migrateTopicModes(a as any, A);
  noteAgentInChat(a as any, A, CHAT, B, [A, B]);
  assert.equal(leadsChat(a as any, A, CHAT), true);
  assert.equal(setChatMode(b as any, B, CHAT, "lead", OWNER), true);
  assert.equal(setChatMode(b as any, B, CHAT, "lead", OWNER), false);
  // B's bridge posted the line; A's bridge reads it among the colleague's messages
  assert.equal(noteColleagueLead(a as any, A, CHAT, TOPIC, B, modeLine("lead", true), [A, B]), true);
  assert.equal(leadsChat(a as any, A, CHAT), false);
  assert.equal(withTopicMode(a as any, base(A) as any, [A, B]).leadMode, "mention");
  // a topic leader the same way, only in that topic
  setTopicMode(a as any, A, CHAT, 5, "lead", OWNER, [A, B]);
  assert.equal(noteColleagueLead(a as any, A, CHAT, 5, B, modeLine("lead"), [A, B]), true);
  assert.equal(topicMode(a as any, A, CHAT, 5, [A, B]).mode, "mention");
  // a stranger's bot or a person cannot do it
  assert.equal(noteColleagueLead(a as any, A, CHAT, 5, 999, modeLine("lead", true), [A, B]), false);
  assert.equal(noteColleagueLead(a as any, A, CHAT, 5, A, modeLine("lead", true), [A, B]), false);
});

test("a reply to the topic's root is not a call, even when this bot made the topic", () => {
  const root = { message_id: TOPIC, from: { id: A }, forum_topic_created: { name: "Маркетинг" } };
  assert.equal(addressedToAgent(msg(OWNER, "план", { reply_to_message: root }).message, A, "alpha_bot"), false);
  assert.equal(addressedToAgent(msg(OWNER, "план", { reply_to_message: { message_id: 50, from: { id: A } } }).message, A, "alpha_bot"), true);
});

test("a newcomer that learned about the colleague first is late and never claims the chat", () => {
  const b = memoryStore();
  noteAgentInChat(b as any, B, CHAT, A, [A, B]);
  noteOwnActivity(b as any, B, CHAT, [A, B]);
  bindGroupTopic(b as any, { ...base(B), revision: "r" } as any, "proj_b");
  noteAgentInChat(b as any, B, CHAT, C, [A, B, C]);
  assert.equal(leadsChat(b as any, B, CHAT), false);
  // an agent alone for more than an hour when the colleague comes is the chat's first agent
  const a = memoryStore();
  bindGroupTopic(a as any, { ...base(A), revision: "r" } as any, "proj");
  noteOwnActivity(a as any, A, CHAT, [A, B], Date.now() - 2 * 3600_000);
  noteAgentInChat(a as any, A, CHAT, B, [A, B]);
  assert.equal(leadsChat(a as any, A, CHAT), true);
});

test("an update with the colleague already known: the agent that talked here leads; the claim is announced once", () => {
  const a = memoryStore();
  bindGroupTopic(a as any, { ...base(A), revision: "r" } as any, "proj");
  a.put(chatAgentsKey(A, CHAT), [B]);           // the previous version already knew the colleague
  migrateTopicModes(a as any, A);
  assert.equal(leadsChat(a as any, A, CHAT), false, "nothing yet: the next message decides");
  noteOwnActivity(a as any, A, CHAT, [A, B]);
  assert.equal(leadsChat(a as any, A, CHAT), true);
  assert.notEqual(a.get(announceKey(A, CHAT)), undefined, "people are told once who leads");
  // a colleague that comes in the first hour after the update does not take it away either
  const c = memoryStore();
  bindGroupTopic(c as any, { ...base(A), revision: "r" } as any, "proj");
  migrateTopicModes(c as any, A);
  noteAgentInChat(c as any, A, CHAT, B, [A, B]);
  assert.equal(leadsChat(c as any, A, CHAT), true);
});

test("both claimed by default (both were here before the update): the earlier claim leads, a tie — the smaller id", () => {
  const a = memoryStore(), b = memoryStore();
  for (const [st, bot] of [[a, A], [b, B]] as const) {
    bindGroupTopic(st as any, { ...base(bot), revision: "r" } as any, "proj" + bot);
    st.put(chatAgentsKey(bot, CHAT), [A, B]);
    migrateTopicModes(st as any, bot);
  }
  noteOwnActivity(a as any, A, CHAT, [A, B], 1_800_000_000_000);
  noteOwnActivity(b as any, B, CHAT, [A, B], 1_800_000_005_000);
  assert.equal(leadsChat(a as any, A, CHAT) && leadsChat(b as any, B, CHAT), true, "both claimed");
  // each reads the other's announcement
  noteColleagueLead(a as any, A, CHAT, 0, B, DEFAULT_LEAD_LINE, [A, B], 1_800_000_005);
  noteColleagueLead(b as any, B, CHAT, 0, A, DEFAULT_LEAD_LINE, [A, B], 1_800_000_000);
  assert.equal(leadsChat(a as any, A, CHAT), true, "the earlier claim keeps the chat");
  assert.equal(leadsChat(b as any, B, CHAT), false, "the later one steps back");
  // a chat named by the owner is not given away by a default claim
  setChatMode(b as any, B, CHAT, "lead", OWNER);
  noteColleagueLead(b as any, B, CHAT, 0, A, DEFAULT_LEAD_LINE, [A, B], 1_700_000_000);
  assert.equal(leadsChat(b as any, B, CHAT), true);
});
