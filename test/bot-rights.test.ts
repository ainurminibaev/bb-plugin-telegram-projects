import test from "node:test";
import assert from "node:assert/strict";
import {
  checkBotGroupRights,
  evaluateBotGroupRights,
  formatBotRightsReport,
  formatMissingBotRights,
} from "../bot-rights";
import { notifyGroupsAdded } from "../setup-screens";

const BOT = 5;
const OWNER = 7;
const CHAT = -1005001;

test("bot-rights: evaluateBotGroupRights checks admin, delete, pin, and forum manage_topics", () => {
  const nonAdmin = evaluateBotGroupRights({
    chatId: CHAT, title: "Склад", botUsername: "helper_bot", isForum: false,
    member: { status: "member" },
  });
  assert.equal(nonAdmin.ok, false);
  assert.deepEqual(nonAdmin.missing, ["administrator", "can_delete_messages", "can_pin_messages"]);
  assert.match(nonAdmin.hint, /Добавить администратора/);
  assert.match(nonAdmin.hint, /@helper_bot/);
  assert.match(nonAdmin.hint, /Удаление сообщений/);
  assert.match(nonAdmin.hint, /Закрепление сообщений/);
  assert.doesNotMatch(nonAdmin.hint, /Управление темами/);
  assert.doesNotMatch(nonAdmin.hint, /\d{4,}|ID|версия/);

  const noDelete = evaluateBotGroupRights({
    chatId: CHAT, title: "Склад", botUsername: "helper_bot", isForum: false,
    member: { status: "administrator", can_delete_messages: false, can_pin_messages: true },
  });
  assert.equal(noDelete.ok, false);
  assert.deepEqual(noDelete.missing, ["can_delete_messages"]);
  assert.doesNotMatch(noDelete.hint, /Добавить администратора/);
  assert.match(noDelete.hint, /«Администраторы» → @helper_bot → включите: Удаление сообщений/);

  const forumMissing = evaluateBotGroupRights({
    chatId: CHAT, title: "Форум", botUsername: "helper_bot", isForum: true,
    member: { status: "administrator", can_delete_messages: true, can_pin_messages: true, can_manage_topics: false },
  });
  assert.equal(forumMissing.ok, false);
  assert.deepEqual(forumMissing.missing, ["can_manage_topics"]);
  assert.match(forumMissing.hint, /Управление темами/);

  const forumOk = evaluateBotGroupRights({
    chatId: CHAT, title: "Форум", botUsername: "helper_bot", isForum: true,
    member: { status: "administrator", can_delete_messages: true, can_pin_messages: true, can_manage_topics: true },
  });
  assert.equal(forumOk.ok, true);
  assert.deepEqual(forumOk.missing, []);
  assert.equal(forumOk.hint, "");

  const creatorOk = evaluateBotGroupRights({
    chatId: CHAT, title: "Форум", botUsername: "helper_bot", isForum: true,
    member: { status: "creator" },
  });
  assert.equal(creatorOk.ok, true);
  assert.equal(formatMissingBotRights("Форум", "helper_bot", []), "");
});

test("bot-rights: checkBotGroupRights queries getChat + getChatMember and handles API failure", async () => {
  const calls: string[] = [];
  const tg = (async (method: string) => {
    calls.push(method);
    if (method === "getChat") return { title: "Рабочая группа", is_forum: true };
    if (method === "getChatMember") return { status: "administrator", can_delete_messages: true, can_pin_messages: true, can_manage_topics: true };
    return {};
  }) as any;
  const okRes = await checkBotGroupRights(tg, BOT, "helper_bot", CHAT);
  assert.deepEqual(calls, ["getChat", "getChatMember"]);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.title, "Рабочая группа");
  assert.equal(okRes.isForum, true);
  assert.match(formatBotRightsReport([okRes]), /✅ «Рабочая группа»: прошло/);

  const failTg = (async () => { throw new Error("telegram_403"); }) as any;
  const failRes = await checkBotGroupRights(failTg, BOT, "helper_bot", CHAT, { title: "Рабочая группа" });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.status, "unknown");
  assert.match(formatBotRightsReport([failRes]), /❌ «Рабочая группа»: не прошло/);
});

test("bot-rights: notifyGroupsAdded tells owner missing delete right at connection and re-checks cleanly after grant", async () => {
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put(`visibility:${BOT}:group:${CHAT}`, { chat: CHAT, title: "Команда", administrator: true, inviter: OWNER, event: 1 });
  store.put(`visibility:${BOT}:privacy`, false);
  store.put("rights:install-kind", "employee");

  let canDelete = false;
  const sent: any[] = [];
  const tg = (chat: number) => (async (method: string, p: any) => {
    sent.push({ chat, method, ...p });
    if (method === "getChat") return { title: "Команда", is_forum: false };
    if (method === "getChatMember") return { status: "administrator", can_delete_messages: canDelete, can_pin_messages: true };
    if (method === "getChatMemberCount") return 4;
    return { message_id: sent.length };
  }) as any;

  const ctx = { store: store as any, bot: BOT, owner: OWNER, botUsername: "helper_bot", tg, zones: [], role: "Помощник", sdk: {} as any };
  await notifyGroupsAdded(ctx);
  const ownerMsg = sent.find((x) => x.method === "sendMessage" && x.chat_id === OWNER);
  assert.ok(ownerMsg);
  assert.match(ownerMsg.text, /Удаление сообщений/);
  assert.match(ownerMsg.text, /«Администраторы» → @helper_bot/);

  canDelete = true;
  const after = await checkBotGroupRights(tg(CHAT), BOT, "helper_bot", CHAT, { title: "Команда" });
  assert.equal(after.ok, true);
  assert.equal(after.missing.length, 0);
});

test("bot-rights: empty title never leaks numeric chatId into hint, and notifyGroupsAdded does not spam API on repeat", async () => {
  const noTitle = evaluateBotGroupRights({
    chatId: CHAT, title: "", botUsername: "helper_bot", isForum: false,
    member: { status: "member" },
  });
  assert.doesNotMatch(noTitle.hint, /\d{4,}/);
  assert.match(noTitle.hint, /«группа»/);

  const failTg = (async () => { throw new Error("network"); }) as any;
  const failRes = await checkBotGroupRights(failTg, BOT, "helper_bot", CHAT);
  assert.doesNotMatch(failRes.hint, /\d{4,}/);
  assert.match(failRes.hint, /«группа»/);

  // notifyGroupsAdded deduplicates before calling getChat/getChatMember
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put(`visibility:${BOT}:group:${CHAT}`, { chat: CHAT, title: "Команда", administrator: true, inviter: OWNER, event: 10 });
  store.put(`visibility:${BOT}:privacy`, false);
  store.put("rights:install-kind", "employee");
  let apiCalls = 0;
  const tg = () => (async (method: string) => {
    if (method === "getChat" || method === "getChatMember") apiCalls++;
    if (method === "getChat") return { title: "Команда", is_forum: false };
    if (method === "getChatMember") return { status: "administrator", can_delete_messages: true, can_pin_messages: true };
    if (method === "getChatMemberCount") return 4;
    return { message_id: 1 };
  }) as any;
  const ctx = { store: store as any, bot: BOT, owner: OWNER, botUsername: "helper_bot", tg, zones: [], role: "Помощник", sdk: {} as any };
  await notifyGroupsAdded(ctx);
  const callsFirst = apiCalls;
  assert.ok(callsFirst > 0);
  await notifyGroupsAdded(ctx);
  assert.equal(apiCalls, callsFirst, "second tick with same event must not call getChat/getChatMember again");
});
