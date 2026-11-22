import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatPairs, baseTitle, type PairDeps } from "../chat-pair";
import type { Store } from "../model";

function memStore(): Store {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : undefined),
    put: (k, v) => void m.set(k, JSON.stringify(v)),
    del: k => void m.delete(k),
    list: <T>(prefix: string) => [...m.keys()].filter(k => k.startsWith(prefix)).sort()
      .map(k => ({key: k, value: JSON.parse(m.get(k)!) as T})),
    atomic: fn => fn(),
  };
}

type T = {id: string; projectId: string; environmentId: string; providerId: string; status: string;
  title: string; parentThreadId: string | null; model: string};

function world() {
  const now0 = Date.now();
  const threads = new Map<string, T>([
    ["claude", {id: "claude", projectId: "p", environmentId: "e", providerId: "claude-code", status: "idle",
      title: "Личный помощник", parentThreadId: null, model: "claude-opus-5-5"}],
    ["codex", {id: "codex", projectId: "p", environmentId: "e", providerId: "codex", status: "idle",
      title: "Личный помощник", parentThreadId: null, model: "gpt-6.2-sol"}],
    ["kid", {id: "kid", projectId: "p", environmentId: "e2", providerId: "claude-code", status: "idle",
      title: "Отчёт", parentThreadId: "claude", model: "claude-opus-5-5"}],
  ]);
  const queues = new Map<string, {id: string; payload: {kind: string; retryOfTurnRequestId?: string}; state: string; sendAt: number | null}[]>();
  const events = new Map<string, {seq: number; type: string; createdAt: number; data: unknown; scope?: unknown}[]>();
  const sent: {threadId: string; text: string; marker: string}[] = [];
  const notices: string[] = [];
  const handoffs: unknown[] = [];
  let spawned = 0;
  const store = memStore();
  let binding = {topicId: 0, projectId: "p", threadId: "claude" as string | null, revision: "r0"};
  const routes = new Map<string, string[]>();
  const sdk = {
    threads: {
      get: async ({threadId}: {threadId: string}) => ({thread: {...threads.get(threadId)!}}),
      update: async (a: {threadId: string; title?: string; parentThreadId?: string}) => {
        const t = threads.get(a.threadId)!;
        if (a.title) t.title = a.title;
        if (a.parentThreadId) t.parentThreadId = a.parentThreadId;
        return {thread: t};
      },
      list: async (a: {parentThreadId?: string}) => [...threads.values()].filter(t => t.parentThreadId === a.parentThreadId),
      defaultExecutionOptions: async ({threadId}: {threadId: string}) => ({model: threads.get(threadId)!.model}),
      queuedMessages: {
        list: async ({threadId}: {threadId: string}) => queues.get(threadId) ?? [],
        delete: async ({threadId, queuedMessageId}: {threadId: string; queuedMessageId: string}) => {
          queues.set(threadId, (queues.get(threadId) ?? []).filter(r => r.id !== queuedMessageId));
        },
      },
      events: {
        list: async (a: {threadId: string; types?: string[]; order?: string; limit?: string; afterSeq?: string}) => {
          let rows = (events.get(a.threadId) ?? []).filter(e => !a.types || a.types.includes(e.type));
          if (a.afterSeq) rows = rows.filter(e => e.seq > Number(a.afterSeq));
          rows = [...rows].sort((x, y) => a.order === "desc" ? y.seq - x.seq : x.seq - y.seq);
          return rows.slice(0, Number(a.limit ?? 100));
        },
      },
      send: async (a: {threadId: string; input: {text: string}[]}) => {
        sent.push({threadId: a.threadId, text: a.input[0].text, marker: a.input[1]?.text ?? ""});
        return {delivery: "sent"};
      },
      spawn: async () => { spawned++; return {id: "new"}; },
    },
    plugins: {
      callRpc: async (a: {method: string; input: {threadId: string}}) => {
        handoffs.push(a);
        threads.set("kid2", {...threads.get(a.input.threadId)!, id: "kid2", parentThreadId: null, providerId: "codex"});
        return {newThreadId: "kid2"};
      },
    },
  };
  const deps: PairDeps = {
    store, sdk: sdk as never, signal: new AbortController().signal,
    binding: () => binding as never,
    save: b => { binding = b as never; },
    fresh: () => "r" + Math.random().toString(16).slice(2, 8),
    busy: () => false,
    notify: (_t, text) => void notices.push(text),
    destination: (thread, turn) => routes.has(thread + ":" + turn)
      ? {kind: "telegram", chatId: 1, topicId: 0, updateId: 5, messageId: 7} : undefined,
    requestIds: (thread, turn) => routes.get(thread + ":" + turn) ?? [],
    retryBelongsToTurn: (thread, turn, retryOf) => (routes.get(thread + ":" + turn) ?? []).includes(retryOf),
    ingress: (thread) => ({type: "text", text: "[bb-telegram-reply-route:x]" + thread, mentions: []}) as never,
  };
  /** Ход владельца упал на лимите; штатный повтор стоит на `resetIn`. */
  const limitTurn = (thread: string, turn: string, text: string, resetIn: number) => {
    routes.set(thread + ":" + turn, ["req-" + turn]);
    const list = events.get(thread) ?? [];
    list.push({seq: list.length + 1, type: "client/turn/requested", createdAt: Date.now(),
      data: {requestId: "req-" + turn, originPluginId: "telegram-projects",
        input: [{type: "text", text}, {type: "text", text: "[bb-telegram-reply-route:abc]\nmeta"}]}});
    events.set(thread, list);
    queues.set(thread, [...(queues.get(thread) ?? []), {id: "retry-" + turn,
      payload: {kind: "retry", retryOfTurnRequestId: "req-" + turn}, state: "waiting", sendAt: Date.now() + resetIn}]);
    threads.get(thread)!.status = "error";
  };
  return {threads, queues, events, sent, notices, handoffs, store, deps, limitTurn, now0,
    get binding() { return binding; }, get spawned() { return spawned; }};
}

test("baseTitle снимает пометку состояния", () => {
  assert.equal(baseTitle("🟢 Действующий · Личный помощник · Claude"), "Личный помощник · Claude");
  assert.equal(baseTitle("⏳ Ждёт лимита · Личный помощник · Codex"), "Личный помощник · Codex");
  assert.equal(baseTitle("Личный помощник"), "Личный помощник");
});

test("настройка пары ставит пометки обоим тредам", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  assert.equal(w.threads.get("claude")!.title, "🟢 Действующий · Личный помощник · Claude");
  assert.equal(w.threads.get("codex")!.title, "⏸ Резерв · Личный помощник · Codex");
});

test("лимит действующего: переключение, переотправка с маршрутом, без «⚠️»", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Сколько стоит билет?", 2 * 3600_000);
  const handled = await pairs.onLimit(w.binding as never, "claude", "t1");
  assert.equal(handled, true);
  assert.equal(w.binding.threadId, "codex");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].threadId, "codex");
  assert.match(w.sent[0].text, /Сколько стоит билет\?/);
  assert.doesNotMatch(w.sent[0].text, /bb-telegram-reply-route:abc/);
  assert.match(w.sent[0].marker, /^\[bb-telegram-reply-route:x\]codex/);
  assert.equal((w.queues.get("claude") ?? []).length, 0, "повтор на старом треде снят — ответа не будет дважды");
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0], /^Claude в лимите до .*Пока отвечает Codex\.$/);
  assert.equal(w.threads.get("codex")!.title, "🟢 Действующий · Личный помощник · Codex");
  assert.equal(w.threads.get("claude")!.title, "⏳ Ждёт лимита · Личный помощник · Claude");
  assert.equal(w.threads.get("kid")!.parentThreadId, "codex", "свободный подтред переехал к действующему");
  assert.equal(await pairs.onLimit(w.binding as never, "claude", "t1"), true, "повторный разбор того же сбоя — без действий");
  assert.equal(w.sent.length, 1);
});

test("оба в лимите: одна строка с временем, сообщение ждёт, переключения нет", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Первое", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  w.threads.get("codex")!.status = "idle";
  w.limitTurn("codex", "t2", "Второе", 5 * 3600_000);
  await pairs.onLimit(w.binding as never, "codex", "t2");
  assert.equal(w.binding.threadId, "codex");
  assert.match(w.notices.at(-1)!, /^Лимит исчерпан на всех аккаунтах\. Продолжу в .* по Москве, сообщение сохранено\.$/);
  assert.equal(w.queues.get("codex")!.length, 1, "штатный повтор остаётся");
  assert.equal(pairs.get(0)!.waiting?.turnId, "t2");
  assert.equal(w.threads.get("codex")!.title, "🟢 Действующий · Личный помощник · Codex");
  assert.equal(w.threads.get("claude")!.title, "⏳ Ждёт лимита · Личный помощник · Claude");
});

test("ожидание: второй тред освободился раньше — сообщение уходит туда", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Первое", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  w.threads.get("codex")!.status = "idle";
  w.limitTurn("codex", "t2", "Второе", 5 * 3600_000);
  await pairs.onLimit(w.binding as never, "codex", "t2");
  const p = pairs.get(0)!;
  w.store.put("chat:pair:0", {...p, blockedUntil: {...p.blockedUntil, claude: Date.now() - 1}});
  w.threads.get("claude")!.status = "error";
  await pairs.tick();
  assert.equal(w.binding.threadId, "claude");
  assert.match(w.sent.at(-1)!.text, /Второе/);
  assert.equal(w.sent.at(-1)!.threadId, "claude");
  assert.equal(w.queues.get("codex")!.length, 0);
});

test("возврат на основной на границе хода, со сводкой пропущенного в первом сообщении", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Кодовое слово — ласточка", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  const ev = w.events.get("codex") ?? [];
  ev.push({seq: 50, type: "item/completed", createdAt: Date.now(), data: {item: {type: "agentMessage", text: "Запомнил: ласточка."}}});
  w.events.set("codex", ev);
  w.threads.get("codex")!.status = "active";
  const p = pairs.get(0)!;
  w.store.put("chat:pair:0", {...p, blockedUntil: {...p.blockedUntil, claude: Date.now() - 1}});
  await pairs.tick();
  assert.equal(w.binding.threadId, "codex", "ход резерва не обрывается");
  w.threads.get("codex")!.status = "idle";
  await pairs.tick();
  assert.equal(w.binding.threadId, "claude");
  assert.equal(w.notices.at(-1), "Снова отвечает Claude.");
  const prefix = await pairs.catchUpPrefix("claude");
  assert.match(prefix, /Пока ты был в резерве/);
  assert.match(prefix, /ласточка/);
  assert.equal(await pairs.catchUpPrefix("claude"), "", "сводка отдаётся один раз");
  assert.equal(w.threads.get("claude")!.title, "🟢 Действующий · Личный помощник · Claude");
  assert.equal(w.threads.get("codex")!.title, "⏸ Резерв · Личный помощник · Codex");
});

test("десять переключений подряд: новых тредов нет, пометки верные", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  const before = w.threads.size;
  for (let i = 0; i < 10; i++) {
    const from = w.binding.threadId!;
    w.threads.get(from)!.status = "idle";
    await pairs.manualSwitch(0, from, from === "claude" ? "codex" : "claude");
    const active = w.binding.threadId!;
    const other = active === "claude" ? "codex" : "claude";
    assert.ok(w.threads.get(active)!.title.startsWith("🟢 Действующий · "));
    assert.ok(w.threads.get(other)!.title.startsWith("⏸ Резерв · "));
  }
  assert.equal(w.threads.size, before);
  assert.equal(w.spawned, 0);
  assert.equal(w.binding.threadId, "claude");
});

test("быстрый возврат туда, откуда ушли, — без второго уведомления", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Раз", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  const p = pairs.get(0)!;
  w.store.put("chat:pair:0", {...p, blockedUntil: {...p.blockedUntil, claude: Date.now() - 1}});
  w.threads.get("codex")!.status = "idle";
  await pairs.tick();
  const count = w.notices.length;
  w.limitTurn("claude", "t3", "Два", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t3");
  assert.equal(w.binding.threadId, "codex");
  assert.equal(w.notices.length, count, "Claude снова отказал — тихо остаёмся на резерве");
});

test("подтред в лимите: уведомление родителю ждёт с временем; после повтора снимается", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  w.events.set("kid", [
    {seq: 1, type: "turn/started", createdAt: 1, data: {}},
    {seq: 2, type: "provider/error", createdAt: 2, data: {errorInfo: {category: "rate-limit"}}},
    {seq: 3, type: "turn/completed", createdAt: 3, data: {status: "failed"}},
  ]);
  w.queues.set("kid", [{id: "r", payload: {kind: "retry", retryOfTurnRequestId: "x"}, state: "waiting", sendAt: Date.now() + 3600_000}]);
  const ctx = {thread: {id: "claude"}, initiator: "system",
    queuedMessages: [{id: "q1", systemNotice: {kind: "child-failed", subject: {kind: "thread", threadId: "kid"}}}]};
  const d1 = await pairs.admitChildNotice(ctx as never);
  assert.equal(d1?.action, "wait");
  assert.match((d1 as {reason: string}).reason, /^Подтред «Отчёт» ждёт сброса лимита до .* МСК, повтор поставлен\.$/);
  w.events.get("kid")!.push({seq: 4, type: "turn/started", createdAt: 4, data: {}},
    {seq: 5, type: "turn/completed", createdAt: 5, data: {status: "completed"}});
  const d2 = await pairs.admitChildNotice(ctx as never);
  assert.equal(d2?.action, "wait");
  const other = {...ctx, queuedMessages: [{id: "q2", systemNotice: {kind: "child-completed", subject: {kind: "thread", threadId: "kid"}}}]};
  assert.equal(await pairs.admitChildNotice(other as never), undefined, "прочие уведомления не трогаются");
});

test("срочный подтред: handoff reuse на другой провайдер, родитель возвращён, старый остаётся", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  pairs.setUrgent("kid", true);
  w.threads.get("kid")!.status = "error";
  w.queues.set("kid", [{id: "r", payload: {kind: "retry", retryOfTurnRequestId: "x"}, state: "waiting", sendAt: Date.now() + 3600_000}]);
  const target = await pairs.continueUrgent("kid");
  assert.equal(target, "kid2");
  const call = w.handoffs[0] as {method: string; input: {workspace: string; providerId: string}};
  assert.equal(call.method, "startHandoff");
  assert.equal(call.input.workspace, "reuse");
  assert.equal(call.input.providerId, "codex");
  assert.equal(w.threads.get("kid2")!.parentThreadId, "claude");
  assert.ok(w.threads.has("kid"), "старый подтред не удалён");
  assert.equal(w.queues.get("kid")!.length, 0, "его повтор снят, работа не пойдёт дважды");
  assert.equal(await pairs.continueUrgent("kid"), "kid2", "повторный вызов не создаёт второй тред");
  assert.equal(w.handoffs.length, 1);
  assert.equal(await pairs.continueUrgent("claude"), undefined, "не срочный — не переносится");
});

test("лимит основного сняли досрочно: возврат по фактическому остатку", async () => {
  const w = world();
  let avail: boolean | undefined = false;
  const pairs = new ChatPairs({...w.deps, available: async () => avail});
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Раз", 24 * 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  w.threads.get("codex")!.status = "idle";
  await pairs.tick();
  assert.equal(w.binding.threadId, "codex", "лимит ещё исчерпан — остаёмся");
  avail = true;
  await pairs.tick();
  assert.equal(w.binding.threadId, "codex", "проверка не чаще раза в 5 минут");
  (pairs as unknown as {probed: Map<string, number>}).probed.clear();
  await pairs.tick();
  assert.equal(w.binding.threadId, "claude");
});
