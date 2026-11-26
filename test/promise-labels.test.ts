import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMISE_LABEL_TTL_MS,
  extractPromiseAnswer,
  formatRecentLabelsNote,
  markPromiseDelivered,
  promiseWatchKey,
  recentPromiseLabels,
  recordPromiseLabel,
  resolvePromiseLabel,
} from "../promise-labels";
import { processGroupInputs } from "../group-worker";

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

test("0.9.81: promise labels expire after 24h and stay strictly isolated across threads and chats", () => {
  const store = memStore();
  const t0 = 1_700_000_000_000;
  const label = recordPromiseLabel(store as any, {
    threadId: "thr_a", chatId: -1001, topicId: 5, messageId: 42, updateId: 100,
    botId: 9, ownerId: 7, senderName: "Олег", excerpt: "уточни статус", afterSeq: 10, kind: "group", now: t0,
  });

  const ok = resolvePromiseLabel(store as any, "thr_a", label, { chatId: -1001, topicId: 5, botId: 9, ownerId: 7, kind: "group" }, t0 + PROMISE_LABEL_TTL_MS - 1);
  assert.equal(ok?.messageId, 42);

  assert.equal(resolvePromiseLabel(store as any, "thr_b", label, { chatId: -1001, topicId: 5, botId: 9, ownerId: 7, kind: "group" }, t0 + 1000), undefined);
  assert.equal(resolvePromiseLabel(store as any, "thr_a", label, { chatId: -1002, topicId: 5, botId: 9, ownerId: 7, kind: "group" }, t0 + 1000), undefined);
  assert.equal(resolvePromiseLabel(store as any, "thr_a", label, { chatId: -1001, topicId: 6, botId: 9, ownerId: 7, kind: "group" }, t0 + 1000), undefined);
  assert.equal(resolvePromiseLabel(store as any, "thr_a", label, { chatId: -1001, topicId: 5, botId: 9, ownerId: 7, kind: "owner" }, t0 + 1000), undefined);

  assert.equal(resolvePromiseLabel(store as any, "thr_a", label, { chatId: -1001, topicId: 5, botId: 9, ownerId: 7, kind: "group" }, t0 + PROMISE_LABEL_TTL_MS), undefined);
  assert.equal(recentPromiseLabels(store as any, "thr_a", t0 + PROMISE_LABEL_TTL_MS).length, 0);
});

test("0.9.81: formatRecentLabelsNote lists up to 5 recent human requests with labels", () => {
  const store = memStore();
  const t0 = 1_700_000_000_000;
  for (let i = 1; i <= 7; i++) {
    recordPromiseLabel(store as any, {
      threadId: "thr_x", chatId: -1001, topicId: 3, messageId: i, updateId: i,
      botId: 5, ownerId: 7, senderName: "Виктор", excerpt: `вопрос ${i}`, afterSeq: i, kind: "group", now: t0 + i * 1000,
    });
  }
  const recent = recentPromiseLabels(store as any, "thr_x", t0 + 10_000);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].messageId, 7);
  const note = formatRecentLabelsNote(recent);
  assert.match(note, /\[bb-telegram-promise-note\]/);
  assert.match(note, /№7 от Виктор: «вопрос 7»/);
  assert.doesNotMatch(note, /вопрос 1/);
});

test("0.9.81: non-Telegram turn with [telegram-answer:<label>] delivers as reply to original message; unlabelled final stays out of Telegram", async () => {
  const store = memStore();
  store.put("group:project:p1", true);
  store.put("group:thread:t1", "group:policy:-1001:3");
  store.put("group:policy:-1001:3", {
    chatId: -1001, topicId: 3, threadId: "t1", projectId: "p1",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: false, requireMention: false, revision: "r1",
  });
  const label = recordPromiseLabel(store as any, {
    threadId: "t1", chatId: -1001, topicId: 3, messageId: 55, updateId: 200,
    botId: 5, ownerId: 7, revision: "r1", senderName: "Олег", excerpt: "уточни у коллеги", afterSeq: 10, kind: "group",
  });
  markPromiseDelivered(store as any, "t1", label, "Уточню и вернусь.");

  store.put(promiseWatchKey(5, "t1"), {
    threadId: "t1", chatId: -1001, topicId: 3, botId: 5, ownerId: 7, cursor: 10, at: Date.now(),
  });
  const events = [
    { seq: 11, type: "item/completed", scope: { kind: "turn", turnId: "T2" }, data: { item: { type: "agentMessage", text: `[telegram-answer:${label}]\nУточню и вернусь.\n[/telegram-answer]` } } },
    { seq: 12, type: "item/completed", scope: { kind: "turn", turnId: "T2" }, data: { item: { type: "agentMessage", text: "Служебный итог хода без метки — не должен уйти в чат." } } },
    { seq: 13, type: "item/completed", scope: { kind: "turn", turnId: "T2" }, data: { item: { type: "agentMessage", text: `[telegram-answer:${label}]\nКоллега подтвердил: готово к пятнице.\n[/telegram-answer]` } } },
    { seq: 14, type: "turn/completed", scope: { kind: "turn", turnId: "T2" }, data: { status: "completed" } },
  ];
  const sdk = {
    threads: {
      get: async () => ({ id: "t1", projectId: "p1", visibility: "visible", status: "idle" }),
      events: { list: async (q: any) => events.filter(e => e.seq > Number(q.afterSeq ?? 0) && (!q.types || q.types.includes(e.type))) },
      send: async () => {},
    },
  };
  const sent: any[] = [];
  const tick = () => processGroupInputs(
    store as any, sdk as any, 7, 5,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 90 } as T; },
    new AbortController().signal,
  );
  await tick();
  await tick();
  assert.equal(sent.length, 1, "only the new labelled result reaches Telegram");
  assert.match(String(sent[0].text), /Коллега подтвердил: готово к пятнице/);
  assert.equal(sent[0].reply_parameters?.message_id, 55, "delivered as reply to original message #55");
  assert.equal(store.get(promiseWatchKey(5, "t1")), undefined, "watch cleaned up after turn completion");
});

test("0.9.81: non-Telegram turn without any label sends nothing to Telegram", async () => {
  const store = memStore();
  store.put("group:project:p1", true);
  store.put("group:thread:t1", "group:policy:-1001:3");
  store.put("group:policy:-1001:3", {
    chatId: -1001, topicId: 3, threadId: "t1", projectId: "p1",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: false, requireMention: false, revision: "r1",
  });
  recordPromiseLabel(store as any, {
    threadId: "t1", chatId: -1001, topicId: 3, messageId: 55, updateId: 200,
    botId: 5, ownerId: 7, revision: "r1", senderName: "Олег", excerpt: "уточни", afterSeq: 10, kind: "group",
  });
  store.put(promiseWatchKey(5, "t1"), {
    threadId: "t1", chatId: -1001, topicId: 3, botId: 5, ownerId: 7, cursor: 10, at: Date.now(),
  });
  const events = [
    { seq: 11, type: "item/completed", scope: { kind: "turn", turnId: "T3" }, data: { item: { type: "agentMessage", text: "Принял к сведению, спасибо." } } },
    { seq: 12, type: "turn/completed", scope: { kind: "turn", turnId: "T3" }, data: { status: "completed" } },
  ];
  const sdk = {
    threads: {
      get: async () => ({ id: "t1", projectId: "p1", visibility: "visible", status: "idle" }),
      events: { list: async (q: any) => events.filter(e => e.seq > Number(q.afterSeq ?? 0) && (!q.types || q.types.includes(e.type))) },
      send: async () => {},
    },
  };
  const sent: any[] = [];
  const tick = () => processGroupInputs(
    store as any, sdk as any, 7, 5,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 91 } as T; },
    new AbortController().signal,
  );
  await tick();
  await tick();
  assert.equal(sent.length, 0, "unlabelled non-Telegram turn never posts to Telegram");
});

test("0.9.81: extractPromiseAnswer rejects nested markers", () => {
  assert.deepEqual(extractPromiseAnswer("[telegram-answer:a1b2c3d4]\nГотово.\n[/telegram-answer]"), { label: "a1b2c3d4", body: "Готово." });
  assert.deepEqual(extractPromiseAnswer("[telegram-answer:a1b2c3d4]Готово на одной строке.[/telegram-answer]"), { label: "a1b2c3d4", body: "Готово на одной строке." });
  assert.equal(extractPromiseAnswer("[telegram-answer:a1b2c3d4]\n[telegram-answer:00000000]\n[/telegram-answer]"), undefined);
});
