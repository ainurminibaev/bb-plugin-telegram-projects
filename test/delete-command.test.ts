import test from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../adapters";
import { TelegramFailure } from "../model";
import { authorOfTurn, deleteRefusal, turnAuthorKey, turnMixedKey, turnStartedByMessage } from "../delete-command";
import { ReplyRoutes } from "../reply-routing";
import { missingRightRefusal } from "../forum-commands";

const OWNER = 1001, BOT = 2002, TEAM = -100700, OTHER = -100800, PERSON = 3003;
const group = { kind: "group" as const, chat: TEAM };

test("С80: the bot's own message in its own chat is deleted without asking", () => {
  assert.equal(deleteRefusal({ caller: group, owner: OWNER, bot: BOT, chat: TEAM, sender: BOT, author: PERSON }), undefined);
});

test("С80: someone else's message needs the owner's word", () => {
  assert.match(deleteRefusal({ caller: group, owner: OWNER, bot: BOT, chat: TEAM, sender: PERSON, author: PERSON })!,
    /^delete_others_only_by_owner: .*--ask/);
  assert.match(deleteRefusal({ caller: group, owner: OWNER, bot: BOT, chat: TEAM, sender: undefined, author: undefined })!,
    /delete_others_only_by_owner/);
  assert.equal(deleteRefusal({ caller: group, owner: OWNER, bot: BOT, chat: TEAM, sender: PERSON, author: OWNER }), undefined);
});

test("С80: only in the conversation's own chat", () => {
  assert.match(deleteRefusal({ caller: group, owner: OWNER, bot: BOT, chat: OTHER, sender: BOT, author: OWNER })!, /^delete_only_in_own_chat/);
  assert.match(deleteRefusal({ caller: undefined, owner: OWNER, bot: BOT, chat: TEAM, sender: BOT, author: OWNER })!, /^delete_only_from_a_telegram_conversation/);
  assert.equal(deleteRefusal({ caller: { kind: "person", subject: PERSON }, owner: OWNER, bot: BOT, chat: PERSON, sender: BOT, author: PERSON }), undefined);
});

test("С80: no right or past the term — the reason and how to ask the owner", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 400,
      description: "Bad Request: message can't be deleted" }), { status: 400 });
    const api = telegram(async () => "test-token", new AbortController().signal, 1000, () => TEAM);
    await assert.rejects(api("deleteMessage", { chat_id: TEAM, message_id: 90 }),
      (e: unknown) => e instanceof TelegramFailure && e.code === "telegram_cannot_delete");
  } finally { globalThis.fetch = original; }
  const text = missingRightRefusal("deleteMessage", "Команда");
  assert.match(text, /«Удаление сообщений» в группе «Команда»/);
  assert.match(text, /--person owner --ask/);
});

test("С80: the owner's word lives only in a turn his Telegram message started", () => {
  const data = new Map<string, unknown>();
  const store: any = { get: (k: string) => data.get(k), put: (k: string, v: unknown) => { data.set(k, v); }, del: (k: string) => { data.delete(k); },
    list: (p: string) => [...data].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })), atomic: (fn: () => void) => fn() };
  const routes = new ReplyRoutes(store);
  routes.record("t", "tg", { kind: "telegram", chatId: TEAM, topicId: 0, updateId: 1 });
  routes.accept("t", "turn1", "tg");
  routes.record("t", "task", { kind: "bb" });
  routes.accept("t", "turn2", "task");
  store.put(turnAuthorKey("t", 1), OWNER);
  assert.equal(authorOfTurn(store, "t", "turn1"), OWNER);
  assert.equal(authorOfTurn(store, "t", "turn2"), undefined, "a task from BB after the owner's message does not inherit his word");
  assert.equal(authorOfTurn(store, "t", undefined), undefined);
  // 0.9.77 review: a guest's turn runs, the owner writes in the same chat and his message joins it — the turn stays the guest's.
  routes.record("t", "guest", { kind: "telegram", chatId: TEAM, topicId: 0, updateId: 2 });
  routes.accept("t", "turn3", "guest");
  store.put(turnAuthorKey("t", 2), 555);
  routes.record("t", "owner-busy", { kind: "telegram", chatId: TEAM, topicId: 0, updateId: 3 });
  store.put(turnAuthorKey("t", 3), OWNER);
  routes.accept("t", "turn3", "owner-busy");
  assert.notEqual(authorOfTurn(store, "t", "turn3"), OWNER, "the owner's message joining a guest's turn lends it no word");
  // The mirror case: the owner's turn, a guest's message joins it — the turn is the guest's in rights.
  assert.equal(authorOfTurn(store, "t", "turn1"), OWNER);
  store.put(turnMixedKey("t", "turn1"), 555);
  assert.equal(authorOfTurn(store, "t", "turn1"), 555, "a guest's message joining the owner's turn takes the owner's word away");
  // The owner's answer to a group's question is a turn the bridge gives (negative update): not his own message.
  routes.record("t", "answer", { kind: "telegram", chatId: TEAM, topicId: 0, updateId: -4, messageId: 10 } as any);
  routes.accept("t", "turn4", "answer");
  assert.equal(turnStartedByMessage(store, "t", "turn4"), false);
  assert.equal(turnStartedByMessage(store, "t", "turn1"), true);
  assert.equal(turnStartedByMessage(store, "t", "turn2"), false, "a turn from BB");
});
