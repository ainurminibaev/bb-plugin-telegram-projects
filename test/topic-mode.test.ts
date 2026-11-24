import test from "node:test";
import assert from "node:assert/strict";
import { routeUpdate, acceptGroupUpdate } from "../ingress";
import { bindGroupTopic } from "../group-worker";
import { agentBotsKey } from "../rights";
import { addressedToAgent, leadRefusal, canAssignLead, chatAgentsCheckedKey, chatAgentsKey, curatorsKey, leadsByDefaultKey, leadsChat,
  modeLine, noteAgentInChat, noteAgentsLeaving, noteColleagueLead, otherAgentsInChat, refreshChatAgents, setChatMode,
  setTopicMode, topicMode, topicNote, withTopicMode } from "../topic-mode";

// Agents in shared chats (agents-in-chats.md): the chat's default leader comes from the passport (leadsChatsByDefault).
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
/** One store per agent (each has its own bridge); the passport says who leads shared chats by default. */
function agent(bot: number, leadsByDefault?: boolean) {
  const store = memoryStore();
  if (leadsByDefault !== undefined) store.put(leadsByDefaultKey, leadsByDefault ? "yes" : "no");
  for (const other of [A, B, C]) noteAgentInChat(store as any, bot, CHAT, other, [A, B, C], usernames[other]);
  return { bot, store, policy: (topic = TOPIC) => withTopicMode(store as any, { ...base(bot), topicId: topic } as any, [A, B, C]) };
}
const at = (topic: number, m: ReturnType<typeof msg>) => { (m.message as any).message_thread_id = topic; return m; };

test("one agent, a second added: the one whose passport says «leads by default» answers in old and new topics, the other gets no turn", () => {
  const first = agent(A, true), second = agent(B, false);
  for (const topic of [0, TOPIC, 99]) {   // 99 — a new topic
    assert.equal(routeUpdate(at(topic, msg(OWNER, "Что по встрече?")), OWNER, undefined, first.policy(topic)).kind, "group", "first, " + topic);
    assert.equal(routeUpdate(at(topic, msg(OWNER, "Что по встрече?")), OWNER, undefined, second.policy(topic)).kind, "ignore", "second, " + topic);
  }
  assert.equal(leadsChat(first.store as any, A, CHAT), true);
  assert.equal(leadsChat(second.store as any, B, CHAT), false);
  // people call by a mention, as before; a mention of the second reaches it alone
  assert.equal(routeUpdate(msg(PERSON, "Когда релиз?"), OWNER, undefined, { ...first.policy(), allowedSenderIds: undefined }).kind, "ignore");
  const called = [first, second].map(a => routeUpdate(mention(B, "посмотри логи"), OWNER, undefined, a.policy()).kind);
  assert.deepEqual(called, ["ignore", "group"]);
});

test("no setting (an old installation, one agent): it leads, nothing changes", () => {
  const store = memoryStore();
  const policy = withTopicMode(store as any, base(A) as any, [A, B, C]);
  assert.equal(policy.leadMode, "lead");
  const owner = routeUpdate(msg(OWNER, "Что по задаче?"), OWNER, undefined, policy);
  assert.equal(owner.kind, "group");
  if (owner.kind === "group") { assert.equal(owner.ownerUnaddressed, true); assert.equal(owner.leaderUnaddressed, undefined); }
  assert.equal(topicNote(store as any, policy, [A, B, C], () => undefined, false), "", "no new lines in the turn");
});

test("a topic's own leader: named by the owner or a curator; the former leader reads the line and steps back there", () => {
  const first = agent(A, true), second = agent(B, false);
  second.store.put(curatorsKey, [CURATOR]);
  assert.equal(canAssignLead(second.store as any, OWNER, CURATOR), true);
  assert.equal(canAssignLead(second.store as any, OWNER, PERSON), false);
  assert.equal(setTopicMode(second.store as any, B, CHAT, TOPIC, "lead", CURATOR, [A, B, C]), true);
  assert.equal(setTopicMode(second.store as any, B, CHAT, TOPIC, "lead", CURATOR, [A, B, C]), false, "no second line");
  // the second's bridge posted modeLine("lead"); the first's bridge reads it among the colleague's messages
  assert.equal(noteColleagueLead(first.store as any, A, CHAT, TOPIC, B, modeLine("lead"), [A, B, C]), true);
  assert.equal(topicMode(first.store as any, A, CHAT, TOPIC).mode, "mention", "the former leader steps back in this topic");
  assert.equal(topicMode(first.store as any, A, CHAT, 0).mode, "lead", "…and keeps the rest of the chat");
  const person = [first, second].map(a => routeUpdate(msg(PERSON, "Когда релиз?"), OWNER, undefined, { ...a.policy(), allowedSenderIds: undefined }).kind);
  assert.deepEqual(person, ["ignore", "group"], "the named topic leader also hears people without a mention");
  // strangers' bots and people cannot do it
  assert.equal(noteColleagueLead(first.store as any, A, CHAT, 0, 999, modeLine("lead", true), [A, B, C]), false);
});

test("the owner changes the chat's leader in words: the same command at the chat level, the same line", () => {
  const first = agent(A, true), second = agent(B, false);
  assert.equal(setChatMode(second.store as any, B, CHAT, "lead", OWNER), true);
  assert.equal(noteColleagueLead(first.store as any, A, CHAT, 0, B, modeLine("lead", true), [A, B, C]), true);
  assert.equal(leadsChat(first.store as any, A, CHAT), false);
  assert.equal(leadsChat(second.store as any, B, CHAT), true);
  assert.deepEqual([first, second].map(a => routeUpdate(msg(OWNER, "Что по встрече?"), OWNER, undefined, a.policy()).kind), ["ignore", "group"]);
  assert.equal(modeLine("lead", true), "Веду этот чат: отвечаю здесь без отметки. Позвать коллегу — отметьте его.");
});

test("organization's bots are noticed when they write or join, or by Telegram once a day in the background", async () => {
  const store = memoryStore();
  store.put(agentBotsKey, [B]);
  bindGroupTopic(store as any, { ...base(A), agentBots: undefined, revision: "r" } as any, "proj");
  store.put("ingress:offset", 0);
  acceptGroupUpdate(store as any, { update_id: 1, message: { message_id: 2, chat: forum, from: { id: PERSON },
    new_chat_members: [{ id: B, is_bot: true, username: "beta_bot" }, { id: 99, is_bot: true }] } }, OWNER, A);
  assert.deepEqual(store.get(chatAgentsKey(A, CHAT)), [B]);
  const asked = memoryStore();
  const t0 = 1_800_000_000_000, day = 24 * 3600_000;
  let calls = 0;
  const ask = async (user: number) => { calls++; return user === B ? { status: "member" } : { status: "left" }; };
  assert.equal(await refreshChatAgents(asked as any, A, CHAT, [A, B, C], ask, t0), true);
  assert.deepEqual(otherAgentsInChat(asked as any, A, CHAT, [A, B, C]), [B]);
  assert.equal(await refreshChatAgents(asked as any, A, CHAT, [A, B, C], ask, t0 + day - 1), false, "once a day");
  assert.equal(calls, 2);
  assert.equal(noteAgentsLeaving(asked as any, A, CHAT, { left_chat_member: { id: B, is_bot: true } }, [A, B, C]), true);
  assert.deepEqual(otherAgentsInChat(asked as any, A, CHAT, [A, B, C]), []);
  assert.equal(await refreshChatAgents(asked as any, A, 42, [A, B], ask, t0 + 9 * day), false, "never a private chat");
  assert.equal(asked.get(chatAgentsCheckedKey(A, 42)), undefined);
});

test("the turn says who leads, which colleagues are here, and that a colleague called once answers once", () => {
  const second = agent(B, false);
  const note = topicNote(second.store as any, second.policy(), [A, B, C], id => second.store.get<string>(`chat:agent-name:${id}`), true);
  assert.match(note, /по отметке/);
  assert.match(note, /Другие агенты организации в этом чате: alpha_bot|@alpha_bot/);
  assert.match(note, /позвали разово/);
  const first = agent(A, true);
  assert.match(topicNote(first.store as any, first.policy(), [A, B, C], () => undefined, false), /Ты ведёшь этот чат/);
});

test("a new topic: the chat's leader picks it up as before, another agent at the first message addressed to it", () => {
  assert.equal(addressedToAgent(mention(A, "привет").message, A, "alpha_bot"), true);
  assert.equal(addressedToAgent(mention(B, "привет").message, A, "alpha_bot"), false);
  assert.equal(addressedToAgent(msg(OWNER, "просто так").message, A, "alpha_bot"), false);
  assert.equal(addressedToAgent({ text: "Альфа, глянь", entities: [] }, A, "alpha_bot", "Альфа"), true);
  const root = { message_id: TOPIC, from: { id: A }, forum_topic_created: { name: "Маркетинг" } };
  assert.equal(addressedToAgent(msg(OWNER, "план", { reply_to_message: root }).message, A, "alpha_bot"), false,
    "a reply to the topic's root is not a call, even when this bot made the topic");
  assert.equal(addressedToAgent(msg(OWNER, "план", { reply_to_message: { message_id: 50, from: { id: A } } }).message, A, "alpha_bot"), true);
});

test("naming a leader is refused in words while the organization's bots do not see each other", () => {
  assert.match(leadRefusal([]) ?? "", /Сначала включите общение агентов/);
  assert.equal(leadRefusal([A, B]), undefined);
});

test("no word from the passport yet (auto): one agent leads as before; with the organization's bots listed — nobody answers twice", () => {
  const alone = memoryStore();
  alone.put(leadsByDefaultKey, "auto");
  assert.equal(leadsChat(alone as any, A, CHAT), true, "no other bots: as before");
  for (const bot of [A, B]) {
    const st = memoryStore();
    st.put(leadsByDefaultKey, "auto");
    st.put(agentBotsKey, [A, B]);
    assert.equal(leadsChat(st as any, bot, CHAT), false, "two agents without the passport's word: by mention, " + bot);
  }
  const named = memoryStore();
  named.put(leadsByDefaultKey, "yes"); named.put(agentBotsKey, [A, B]);
  assert.equal(leadsChat(named as any, A, CHAT), true, "the passport's yes");
});
