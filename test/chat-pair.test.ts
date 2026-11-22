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
  title: string; parentThreadId: string | null; model: string; originPluginId?: string | null;
  lifecycleOwnerThreadId?: string | null; archivedAt?: number | null};

function world() {
  const now0 = Date.now();
  const threads = new Map<string, T>([
    ["claude", {id: "claude", projectId: "p", environmentId: "e", providerId: "claude-code", status: "idle",
      title: "Личный помощник", parentThreadId: null, model: "claude-opus-5-5"}],
    ["codex", {id: "codex", projectId: "p", environmentId: "e", providerId: "codex", status: "idle",
      title: "Личный помощник", parentThreadId: null, model: "gpt-6.2-sol"}],
    ["kid", {id: "kid", projectId: "p", environmentId: "e2", providerId: "claude-code", status: "idle",
      title: "Отчёт", parentThreadId: "claude", model: "claude-opus-5-5", originPluginId: null}],
  ]);
  const queues = new Map<string, {id: string; payload: {kind: string; retryOfTurnRequestId?: string}; state: string; sendAt: number | null}[]>();
  const events = new Map<string, {seq: number; type: string; createdAt: number; data: unknown; scope?: unknown}[]>();
  const sent: {threadId: string; text: string; marker: string}[] = [];
  const notices: string[] = [];
  const handoffs: unknown[] = [];
  const archived: string[] = [];
  let handoffInstalled = true;
  let failHandoff = false;
  const madeHandoffs: {sourceThreadId: string; targetThreadId: string; at: number}[] = [];
  let schedules: {enabled: boolean; execution: {targetThreadId?: string | null}}[] = [];
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
      list: async (a: {parentThreadId?: string}) => [...threads.values()].filter(t => t.parentThreadId === a.parentThreadId && !t.archivedAt)
        .map(({originPluginId: _o, lifecycleOwnerThreadId: _l, ...rest}) => rest),
      archive: async ({threadId}: {threadId: string}) => { archived.push(threadId); threads.get(threadId)!.archivedAt = Date.now(); return {}; },
      interactions: {list: async () => []},
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
      list: async () => ({plugins: handoffInstalled ? [{id: "handoff", enabled: true}] : []}),
      callRpc: async (a: {pluginId: string; method: string; input: {threadId: string}}) => {
        if (a.method === "automations_list") return schedules;
        if (a.method === "history") return {handoffs: madeHandoffs};
        if (failHandoff) { failHandoff = false; throw Error("network"); }
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
  /** Подтред: последний ход завершён `hoursAgo` назад (или упал). */
  const child = (id: string, extra: Partial<T>, end: "completed" | "failed", hoursAgo = 7) => {
    threads.set(id, {id, projectId: "p", environmentId: "e", providerId: "claude-code", status: end === "failed" ? "error" : "idle",
      title: "Задача " + id, parentThreadId: "claude", model: "claude-opus-5-5", ...extra});
    const at = Date.now() - hoursAgo * 3600_000;
    events.set(id, [
      {seq: 1, type: "client/turn/requested", createdAt: at - 1000, data: {input: [{type: "text", text: "Сделай задачу " + id}]}},
      {seq: 2, type: "turn/started", createdAt: at - 500, data: {}},
      {seq: 3, type: "turn/completed", createdAt: at, data: {status: end}},
    ]);
  };
  /** У пары был завершённый ход после итогов подтредов. */
  const pairDigested = () => {
    const list = events.get("claude") ?? [];
    list.push({seq: list.length + 100, type: "turn/completed", createdAt: Date.now() - 60_000, data: {status: "completed"}});
    events.set("claude", list);
  };
  return {threads, queues, events, sent, notices, handoffs, store, deps, limitTurn, now0, archived, child, pairDigested,
    setSchedules: (v: typeof schedules) => { schedules = v; },
    setHandoff: (v: boolean) => { handoffInstalled = v; },
    failNextHandoff: () => { failHandoff = true; },
    recordHandoff: (h: {sourceThreadId: string; targetThreadId: string; at: number}) => madeHandoffs.push(h),
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
  assert.equal(w.threads.get("kid")!.parentThreadId, "claude", "законченный подтред не переезжает: перенос будил бы действующий тред");
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


test("признак «создан помощником» — только штатные поля и запись моста", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  const p = await pairs.configure(0, "claude", "codex");
  const row = (x: Partial<T>) => ({id: "x", projectId: "p", environmentId: "e", providerId: "codex", status: "idle",
    title: "t", parentThreadId: null, ...x}) as never;
  assert.equal(pairs.createdByAssistant(row({originPluginId: "telegram-projects", parentThreadId: "claude"}), p), true);
  assert.equal(pairs.createdByAssistant(row({lifecycleOwnerThreadId: "codex"}), p), true);
  assert.equal(pairs.createdByAssistant(row({originPluginId: null, parentThreadId: "claude"}), p), false, "только родитель — не доказательство");
  assert.equal(pairs.createdByAssistant(row({originPluginId: "automations", parentThreadId: "claude"}), p), false, "тред расписания");
  assert.equal(pairs.createdByAssistant(row({originPluginId: "telegram-projects", parentThreadId: "foreign"}), p), false);
  w.store.put("reply:delegation-spawn:d1", {state: "accepted", threadId: "x"});
  assert.equal(pairs.createdByAssistant(row({originPluginId: null, parentThreadId: "foreign"}), p), true, "запись моста о создании");
  assert.equal(pairs.createdByAssistant(row({id: "claude"}), p), false);
});

test("уборка: архивируются только завершённые созданные помощником, прочитанные и 6 ч без движения", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  const p = await pairs.configure(0, "claude", "codex");
  w.child("done", {originPluginId: "telegram-projects"}, "completed");
  w.child("fresh", {originPluginId: "telegram-projects"}, "completed", 1);
  w.child("scheduled", {originPluginId: "telegram-projects"}, "completed");
  w.child("foreign", {originPluginId: null}, "completed");
  w.child("cron", {originPluginId: "automations"}, "completed");
  w.child("broken", {originPluginId: "telegram-projects"}, "failed");
  w.setSchedules([{enabled: true, execution: {targetThreadId: "scheduled"}}]);
  assert.deepEqual(await pairs.cleanup(p), [], "итог ещё не прочитан помощником — ничего не трогаем");
  w.pairDigested();
  assert.deepEqual(await pairs.cleanup(p), ["done"]);
  assert.deepEqual(w.archived, ["done"]);
  assert.ok(w.threads.has("done"), "архив, не удаление");
});

test("уборка не идёт, если не удалось проверить расписания", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs({...w.deps, sdk: {...(w.deps.sdk as object), plugins: {callRpc: async () => { throw Error("down"); }}} as never});
  const p = await pairs.configure(0, "claude", "codex");
  w.child("done", {originPluginId: "telegram-projects"}, "completed");
  w.pairDigested();
  await assert.rejects(() => pairs.cleanup(p));
  assert.deepEqual(w.archived, []);
});

test("переключение: владельцу — нумерованный список незаконченного на модели в лимите, действующему — сводка с номерами", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.child("stuck", {originPluginId: "telegram-projects", title: "Отчёт по рекламе"}, "failed");
  w.queues.set("stuck", [{id: "r", payload: {kind: "retry", retryOfTurnRequestId: "x"}, state: "waiting", sendAt: Date.now() + 3600_000}]);
  w.child("codexjob", {originPluginId: "telegram-projects", providerId: "codex", title: "Задача на Codex"}, "failed");
  w.child("foreign", {originPluginId: null, title: "Чужой тред"}, "failed");
  w.limitTurn("claude", "t1", "Привет", 2 * 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  const list = w.notices.find(n => n.startsWith("Незаконченные задачи"));
  assert.ok(list, w.notices.join(" | "));
  assert.match(list!, /на Claude, который сейчас в лимите:\n1\. ⏳ Отчёт по рекламе — Сделай задачу stuck — ждёт лимита до .*, Claude/);
  assert.doesNotMatch(list!, /Чужой тред/, "чужие треды не показываются");
  assert.doesNotMatch(list!, /Задача на Codex/, "на действующей модели решать нечего");
  assert.match(list!, /Ответь номерами: что перенести на действующую модель, что оставить ждать, что закрыть\./);
  const replay = w.sent.find(x => x.threadId === "codex")!;
  assert.match(replay.text, /Сводка при переключении/);
  assert.match(replay.text, /1 = stuck/);
  assert.match(replay.text, /continueChildOnActive/);
  assert.deepEqual(pairs.get(0)!.roster?.items, [{n: 1, threadId: "stuck"}]);
  assert.deepEqual(w.archived, [], "незаконченное не архивируется");
});

test("решения владельца: «перенести» — handoff на действующую модель, «закрыть» — архив; чужие отклоняются", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.child("stuck", {originPluginId: "telegram-projects"}, "failed");
  w.child("other", {originPluginId: "telegram-projects"}, "failed");
  w.child("foreign", {originPluginId: null}, "failed");
  w.threads.get("claude")!.status = "idle";
  await pairs.manualSwitch(0, "claude", "codex");
  const moved = await pairs.continueOnActive(0, "stuck");
  assert.equal(moved, "kid2");
  assert.equal((w.handoffs[0] as {input: {providerId: string; workspace: string}}).input.providerId, "codex");
  assert.equal(w.threads.get("kid2")!.parentThreadId, "codex");
  assert.equal(await pairs.archiveCreated(0, "other"), true);
  assert.deepEqual(w.archived, ["other"]);
  await assert.rejects(() => pairs.archiveCreated(0, "foreign"), /thread_not_created_by_assistant/);
  await assert.rejects(() => pairs.continueOnActive(0, "foreign"), /thread_not_created_by_assistant/);
});

test("повтор BB ещё не появился: сбой разбирается позже, с настоящим временем; запоздавший повтор снимается", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Раз", 2 * 3600_000);
  const retry = w.queues.get("claude")!;
  w.queues.set("claude", []);
  assert.equal(await pairs.onLimit(w.binding as never, "claude", "t1", Date.now() - 2000), true, "«⚠️» не нужен");
  assert.equal(w.binding.threadId, "claude", "ждём повтор, не переключаемся вслепую");
  w.queues.set("claude", retry);
  await pairs.onLimit(w.binding as never, "claude", "t1", Date.now() - 2000);
  assert.equal(w.binding.threadId, "codex");
  assert.ok(pairs.get(0)!.blockedUntil.claude > Date.now() + 3600_000, "время из штатного повтора");
  // BB поставил ещё один повтор того же хода уже после переотправки.
  w.queues.set("claude", [{id: "late", payload: {kind: "retry", retryOfTurnRequestId: "req-t1"}, state: "waiting", sendAt: Date.now() + 60_000}]);
  await pairs.tick();
  assert.equal(w.queues.get("claude")!.length, 0, "запоздавший повтор снят — второго ответа не будет");
});

test("отказ основного после успешного хода на нём — с уведомлением", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Раз", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  const p = pairs.get(0)!;
  w.store.put("chat:pair:0", {...p, blockedUntil: {}});
  w.threads.get("codex")!.status = "idle";
  await pairs.tick();
  assert.equal(w.binding.threadId, "claude");
  w.events.get("claude")!.push({seq: 500, type: "turn/completed", createdAt: Date.now() + 1, data: {status: "completed"}});
  const before = w.notices.length;
  w.limitTurn("claude", "t9", "Два", 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t9");
  assert.equal(w.binding.threadId, "codex");
  assert.equal(w.notices.length, before + 1);
  assert.match(w.notices.at(-1)!, /^Claude в лимите до/);
});

test("лимит снят вручную: возврат на ближайшем такте, сводка сохраняется", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Раз", 5 * 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  w.threads.get("codex")!.status = "idle";
  assert.throws(() => pairs.clearLimit(0, "kid"));
  assert.equal(pairs.clearLimit(0, "claude"), true);
  await pairs.tick();
  assert.equal(w.binding.threadId, "claude");
  assert.ok(pairs.get(0)!.inactiveSince.codex, "сводка пропущенного не потеряна");
});

test("сводка не вкладывается сама в себя: берётся только сообщение владельца", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  w.events.set("codex", [{seq: 1, type: "client/turn/requested", createdAt: Date.now(), data: {originPluginId: "telegram-projects",
    input: [{type: "text", text: "Пока ты был в резерве … длинная старая сводка …\n\nСообщение владельца:\nНовая просьба"}]}}]);
  const s = await pairs.summary("codex", Date.now() - 60_000);
  assert.match(s, /Владелец: Новая просьба/);
  assert.doesNotMatch(s, /старая сводка/);
});


test("нет плагина handoff: «перенести» отказывает понятно и не блокирует повтор после установки", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.child("stuck", {originPluginId: "telegram-projects"}, "failed");
  w.threads.get("claude")!.status = "idle";
  await pairs.manualSwitch(0, "claude", "codex");
  w.setHandoff(false);
  await assert.rejects(() => pairs.continueOnActive(0, "stuck"), /handoff_plugin_missing/);
  w.setHandoff(true);
  assert.equal(await pairs.continueOnActive(0, "stuck"), "kid2");
});


test("неизвестный исход переноса: по истории handoff — без второго треда; если треда нет — повтор", async () => {
  const w = world();
  w.threads.delete("kid");
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.child("a", {originPluginId: "telegram-projects"}, "failed");
  w.child("b", {originPluginId: "telegram-projects"}, "failed");
  w.threads.get("claude")!.status = "idle";
  await pairs.manualSwitch(0, "claude", "codex");
  w.failNextHandoff();
  await assert.rejects(() => pairs.continueOnActive(0, "a"));
  w.recordHandoff({sourceThreadId: "a", targetThreadId: "a2", at: Date.now()});
  w.threads.set("a2", {...w.threads.get("a")!, id: "a2", parentThreadId: null});
  assert.equal(await pairs.continueOnActive(0, "a"), "a2", "тред уже создан — второй не делаем");
  assert.equal(w.threads.get("a2")!.parentThreadId, "codex");
  w.failNextHandoff();
  await assert.rejects(() => pairs.continueOnActive(0, "b"));
  assert.equal(await pairs.continueOnActive(0, "b"), "kid2", "треда не было — повтор");
});


test("пакет исходов подтредов: все — лимит с повтором → ждёт; есть готовый результат → сразу родителю", async () => {
  const w = world();
  const pairs = new ChatPairs(w.deps);
  for (const id of ["k1", "k2"]) {
    w.child(id, {originPluginId: "telegram-projects"}, "failed");
    w.events.get(id)!.push({seq: 9, type: "provider/error", createdAt: Date.now(), data: {errorInfo: {category: "rate-limit"}}});
    w.queues.set(id, [{id: "r" + id, payload: {kind: "retry", retryOfTurnRequestId: "x"}, state: "waiting", sendAt: Date.now() + 3600_000}]);
  }
  const ctx = (outcomes: {threadId: string; status: string}[]) => ({thread: {id: "claude"}, initiator: "system",
    queuedMessages: [{id: "q", systemNotice: {kind: "child-outcome-batch", subject: {kind: "thread-batch", outcomes}}}]}) as never;
  const held = await pairs.admitChildNotice(ctx([{threadId: "k1", status: "failed"}, {threadId: "k2", status: "failed"}]));
  assert.equal(held?.action, "wait");
  assert.match((held as {reason: string}).reason, /^Подтреды «Задача k1», «Задача k2» ждут сброса лимита до .* МСК, повторы поставлены\.$/);
  assert.equal(await pairs.admitChildNotice(ctx([{threadId: "k1", status: "failed"}, {threadId: "kid", status: "completed"}])), undefined);
});

test("переключение: работающий подтред переезжает к действующему, законченные остаются", async () => {
  const w = world();
  w.threads.set("busy", {...w.threads.get("kid")!, id: "busy", title: "Расчёт", status: "active"});
  const pairs = new ChatPairs(w.deps);
  await pairs.configure(0, "claude", "codex");
  w.limitTurn("claude", "t1", "Сколько стоит билет?", 2 * 3600_000);
  await pairs.onLimit(w.binding as never, "claude", "t1");
  assert.equal(w.threads.get("busy")!.parentThreadId, "codex", "итог работающего подтреда придёт действующему");
  assert.equal(w.threads.get("kid")!.parentThreadId, "claude");
});
