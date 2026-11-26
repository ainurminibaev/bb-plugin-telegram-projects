import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptActionButtonCallback,
  buildActionKeyboard,
  parseActionButtons,
  rememberActionButtons,
} from "../action-buttons";

function memStore() {
  const rows = new Map<string, any>();
  return {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
}

test("С118: parseActionButtons validates labels, optional data and 6-button limit", () => {
  const ok = parseActionButtons(["Не показывать=mute:42", "Отложить"]);
  assert.ok("buttons" in ok);
  assert.deepEqual(ok.buttons, [{ label: "Не показывать", data: "mute:42" }, { label: "Отложить" }]);

  assert.ok("error" in parseActionButtons(["1", "2", "3", "4", "5", "6", "7"]));
  assert.ok("error" in parseActionButtons(["=onlydata"]));

  const kb = buildActionKeyboard("a1b2c3d4", ok.buttons);
  assert.equal(kb.inline_keyboard.flat().length, 2);
  assert.equal(kb.inline_keyboard.flat()[0].callback_data, "ab:a1b2c3d4:0");
  assert.equal(kb.inline_keyboard.flat()[1].callback_data, "ab:a1b2c3d4:1");
});

test("С118: allowed clicker in group topic marks message, keeps buttons and queues ordinary turn; unauthorized clicker gets hint only", async () => {
  const store = memStore();
  store.put("group:policy:-1001:5", {
    chatId: -1001, topicId: 5, threadId: "thr_topic", projectId: "p1",
    botId: 9, botUsername: "bot", ownerId: 7, ownerOnly: true, requireMention: false, revision: "r1",
  });
  rememberActionButtons(store as any, {
    token: "deadbeef", botId: 9, ownerId: 7, chatId: -1001, topicId: 5, messageId: 88,
    buttons: [{ label: "Не показывать", data: "event=99" }, { label: "Ок" }],
    text: "Напоминание о созвоне в 15:00",
  });

  const tgCalls: { method: string; body: any }[] = [];
  const tgFor = () => async <T>(method: string, body: any) => { tgCalls.push({ method, body }); return {} as T; };
  let woke = 0;

  // 1) Unauthorized user (id=55, ownerOnly=true) -> hint only, no edit, no job
  const handledDenied = await acceptActionButtonCallback({
    store: store as any, bot: 9, owner: 7, tgFor,
    deliverOwner: async () => { throw Error("should not call owner"); },
    wake: () => { woke++; },
  }, {
    update_id: 501,
    callback_query: {
      id: "cb1", data: "ab:deadbeef:0",
      from: { id: 55, is_bot: false, first_name: "Гость" },
      message: { message_id: 88, chat: { id: -1001 }, text: "Напоминание о созвоне в 15:00" },
    },
  });
  assert.equal(handledDenied, true);
  assert.equal(tgCalls.length, 1);
  assert.equal(tgCalls[0].method, "answerCallbackQuery");
  assert.match(tgCalls[0].body.text, /нет права/i);
  assert.equal(store.list("group:in:").length, 0);
  assert.equal(woke, 0);

  // 2) Owner (id=7) -> answered, message edited with ✓ mark AND buttons kept, ordinary job queued
  tgCalls.length = 0;
  const handledOk = await acceptActionButtonCallback({
    store: store as any, bot: 9, owner: 7, tgFor,
    deliverOwner: async () => { throw Error("should not call owner"); },
    wake: () => { woke++; },
  }, {
    update_id: 502,
    callback_query: {
      id: "cb2", data: "ab:deadbeef:0",
      from: { id: 7, is_bot: false, first_name: "Виктор" },
      message: { message_id: 88, chat: { id: -1001 }, text: "Напоминание о созвоне в 15:00" },
    },
  });
  assert.equal(handledOk, true);
  assert.equal(woke, 1);
  const edit = tgCalls.find(c => c.method === "editMessageText");
  assert.ok(edit, "message edited with click mark");
  assert.match(edit.body.text, /✓ Не показывать — Виктор/);
  assert.equal(edit.body.reply_markup.inline_keyboard.flat().length, 2, "buttons preserved");

  const job = store.get<any>("group:in:9:502");
  assert.ok(job, "ordinary group job queued");
  assert.equal(job.route.senderId, 7);
  assert.equal(job.route.messageId, 88);
  assert.match(job.route.text, /Виктор нажал «Не показывать» под сообщением №88: «Напоминание о созвоне в 15:00»; данные: event=99/);
});

test("С118: owner DM button click delivers to owner DM conversation", async () => {
  const store = memStore();
  rememberActionButtons(store as any, {
    token: "cafe1234", botId: 9, ownerId: 7, chatId: 7, topicId: 0, messageId: 12,
    buttons: [{ label: "Скрыть", data: "hide" }],
    text: "Сводка за день",
  });
  const ownerDelivered: any[] = [];
  const handled = await acceptActionButtonCallback({
    store: store as any, bot: 9, owner: 7,
    tgFor: () => async <T>() => ({} as T),
    deliverOwner: async (args) => { ownerDelivered.push(args); },
  }, {
    update_id: 600,
    callback_query: {
      id: "cb3", data: "ab:cafe1234:0",
      from: { id: 7, is_bot: false, first_name: "Виктор" },
      message: { message_id: 12, chat: { id: 7 }, text: "Сводка за день" },
    },
  });
  assert.equal(handled, true);
  assert.equal(ownerDelivered.length, 1);
  assert.match(ownerDelivered[0].text, /Виктор нажал «Скрыть» под сообщением №12: «Сводка за день»; данные: hide/);
});
