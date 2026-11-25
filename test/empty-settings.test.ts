import test from "node:test";
import assert from "node:assert/strict";
import { routeUpdate, acceptGroupUpdate } from "../ingress";
import { bindGroupTopic } from "../group-worker";
import { leadsByDefaultKey, leadsChat, noteAgentInChat, noteColleagueLead, modeLine, refreshChatAgents, topicNote,
  withTopicMode, NO_LEADER_LINE, leadsByDefault } from "../topic-mode";
import { ownFolderProject } from "../conversation-folder";

// 0.9.69 goes to working installations with own folders off and an empty list of the organization's bots: with the
// settings empty no new path of code may act — no folders, no topic modes, no questions to Telegram about members.
const OWNER = 11, PERSON = 22, BOT = 70, OTHER = 71, CHAT = -1001, TOPIC = 3;
const forum = { id: CHAT, type: "supergroup", is_forum: true };
function memoryStore() {
  const rows = new Map<string, any>();
  return { rows, get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(p: string) => [...rows].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value: value as T })),
    atomic: (fn: () => void) => fn() };
}
const policy = { chatId: CHAT, topicId: TOPIC, threadId: "thr", ownerOnly: false, requireMention: true, botId: BOT,
  botUsername: "alpha_bot" };
const msg = (from: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: 5, message: { message_id: 9, message_thread_id: TOPIC, is_topic_message: true, chat: forum, from: { id: from }, text, ...extra } });

test("empty settings: every message is routed exactly as before", t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);   // 0.9.75: a route carries arrivedAt
  const store = memoryStore();
  store.put(leadsByDefaultKey, "auto");   // what the bridge stores from an empty setting
  const withModes = withTopicMode(store as any, policy as any, []);
  const cases = [
    msg(OWNER, "Что по задаче?"),
    msg(PERSON, "Когда релиз?"),
    msg(OWNER, "@alpha_bot глянь", { entities: [{ type: "mention", offset: 0, length: 10 }] }),
    msg(PERSON, "@alpha_bot глянь", { entities: [{ type: "mention", offset: 0, length: 10 }] }),
    msg(OWNER, "@oleg посмотри", { entities: [{ type: "mention", offset: 0, length: 5 }] }),
    msg(OWNER, "да", { reply_to_message: { message_id: 50, message_thread_id: TOPIC, chat: forum, from: { id: BOT } } }),
  ];
  for (const m of cases) {
    for (const p of [policy, { ...policy, allowedSenderIds: undefined }]) {
      const before = routeUpdate(m, OWNER, undefined, p as any);
      const after = routeUpdate(m, OWNER, undefined, { ...withModes, allowedSenderIds: p.allowedSenderIds } as any);
      assert.deepEqual(after, before, JSON.stringify(m.message.text));
    }
  }
  assert.equal(leadsChat(store as any, BOT, CHAT), true);
  assert.equal(leadsByDefault(store as any, BOT), true, "no line to the owner about nobody leading");
  assert.equal(topicNote(store as any, withModes, [], () => undefined, false), "", "no new lines in the turn");
  assert.ok(NO_LEADER_LINE.length > 0);
});

test("empty settings: no bot is noted, no member is asked, no colleague's line is taken, nothing is written", async () => {
  const store = memoryStore();
  bindGroupTopic(store as any, { ...policy, revision: "r" } as any, "proj");
  store.put("ingress:offset", 0);
  const before = new Set(store.rows.keys());
  acceptGroupUpdate(store as any, { update_id: 1, message: { message_id: 2, chat: forum, from: { id: PERSON },
    new_chat_members: [{ id: OTHER, is_bot: true, username: "beta_bot" }] } }, OWNER, BOT);
  acceptGroupUpdate(store as any, { update_id: 2, message: { message_id: 3, chat: forum, message_thread_id: TOPIC, is_topic_message: true,
    from: { id: OTHER, is_bot: true, username: "beta_bot" }, text: modeLine("lead", true) } }, OWNER, BOT);
  assert.equal(noteAgentInChat(store as any, BOT, CHAT, OTHER, [], "beta_bot"), false);
  assert.equal(noteColleagueLead(store as any, BOT, CHAT, TOPIC, OTHER, modeLine("lead"), []), false);
  let asked = 0;
  assert.equal(await refreshChatAgents(store as any, BOT, CHAT, [], async () => { asked++; return { status: "member" }; }), false);
  assert.equal(asked, 0, "no getChatMember");
  const added = [...store.rows.keys()].filter(k => !before.has(k) && /^(chat:|topic:mode|rights:no-leader)/.test(k));
  assert.deepEqual(added, [], "no chat or topic-mode records");
  assert.equal(leadsChat(store as any, BOT, CHAT), true, "a colleague's line from an unlisted bot changes nothing");
});

test("empty settings: own folders are off — nothing is made, the conversation stays where it was", async () => {
  const made: unknown[] = [];
  const id = await ownFolderProject({ root: "", rulesFile: "", home: "/nonexistent", store: memoryStore() as any,
    projects: { get: async () => { made.push("get"); return { id: "x" }; }, list: async () => [], create: async (a: any) => { made.push(a); return { id: "p" }; } },
    ownerProjectId: "proj_owner" }, { chatId: CHAT, title: "Группа" });
  assert.equal(id, undefined);
  assert.deepEqual(made, [], "not even a question to BB about projects");
});
