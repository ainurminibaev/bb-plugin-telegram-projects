// Сквозная проверка пары тредов через ChatBridge: цикл наблюдения, отправка входящих, хук очереди.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridge } from "../chat";
import { ReplyRoutes } from "../reply-routing";
import type { Store } from "../model";

const OWNER = 259034221;

function setup() {
  const data = new Map<string, any>();
  const store: Store = {
    get: k => structuredClone(data.get(k)), put: (k, v) => void data.set(k, structuredClone(v)),
    del: k => void data.delete(k),
    list: p => [...data].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({key, value: structuredClone(value)})),
    atomic: f => f(),
  };
  const threads: Record<string, any> = {
    thr_claude: {id: "thr_claude", projectId: "proj_one", title: "Личный помощник", status: "idle", providerId: "claude-code",
      visibility: "visible", environmentId: "env_one", archivedAt: null, deletedAt: null, parentThreadId: null},
    thr_codex: {id: "thr_codex", projectId: "proj_one", title: "Личный помощник", status: "idle", providerId: "codex",
      visibility: "visible", environmentId: "env_one", archivedAt: null, deletedAt: null, parentThreadId: null},
  };
  const events: Record<string, any[]> = {thr_claude: [], thr_codex: []};
  const queues: Record<string, any[]> = {thr_claude: [], thr_codex: []};
  const sends: any[] = [];
  const sent: any[] = [];
  let message = 10;
  const sdk: any = {
    projects: {list: async () => [{id: "proj_one", name: "Проект", kind: "standard"}], get: async () => ({id: "proj_one"})},
    environments: {get: async () => ({path: "/work", hostId: "host"})},
    system: {usageLimits: async () => ({"claude-code": {status: "ok", windows: [{usedPercent: 100}]}})},
    plugins: {list: async () => ({plugins: []}), callRpc: async () => ({})},
    threads: {
      defaultExecutionOptions: async ({threadId}: any) => ({model: threadId === "thr_codex" ? "gpt" : "opus"}),
      get: async ({threadId}: any) => ({...threads[threadId]}),
      list: async (a: any) => a.parentThreadId ? Object.values(threads).filter((t: any) => t.parentThreadId === a.parentThreadId) : [],
      update: async (a: any) => { if (a.title) threads[a.threadId].title = a.title; if (a.parentThreadId) threads[a.threadId].parentThreadId = a.parentThreadId; return {}; },
      send: async (a: any) => { sends.push(a); return {delivery: "sent"}; },
      spawn: async () => { throw Error("no spawn in pair"); },
      output: async () => ({output: ""}),
      queue: {list: async ({threadId}: any) => queues[threadId]},
      queuedMessages: {
        list: async ({threadId}: any) => queues[threadId],
        delete: async ({threadId, queuedMessageId}: any) => { queues[threadId] = queues[threadId].filter(r => r.id !== queuedMessageId); },
        setGroupBoundary: async () => ({}),
      },
      events: {list: async (a: any) => {
        let rows = (events[a.threadId] ?? []).map(e => ({scope: {kind: "thread"}, ...e})).filter(e => !a.types || a.types.includes(e.type));
        if (a.afterSeq) rows = rows.filter(e => e.seq > Number(a.afterSeq));
        rows = [...rows].sort((x, y) => a.order === "desc" ? y.seq - x.seq : x.seq - y.seq);
        return rows.slice(0, Number(a.limit ?? 100));
      }},
      interactions: {list: async () => []},
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "bb-pair-test-"));
  const bridge = new ChatBridge({store, sdk, owner: () => OWNER, baseUrl: "https://bb.example",
    signal: new AbortController().signal, rich: () => false, spool: dir,
    tg: async (method, payload) => { sent.push({method, ...payload}); return {message_id: ++message} as any; }});
  store.put("chat:binding:0", {topicId: 0, projectId: "proj_one", threadId: "thr_claude", revision: "r1", ready: false, cursor: 0});
  store.put("private:project:proj_one", true);
  /** Сообщение владельца принято тредом и упало на лимите; повтор стоит в очереди. */
  const ownerTurnLimited = (threadId: string, turnId: string, text: string) => {
    const routes = new ReplyRoutes(store);
    const marker = routes.ingress(threadId, {kind: "telegram", chatId: OWNER, topicId: 0, updateId: 7, messageId: 7});
    routes.requested(threadId, {requestId: "req-" + turnId, originPluginId: "telegram-projects", input: [{type: "text", text}, marker]});
    routes.accept(threadId, turnId, "req-" + turnId);
    const e = events[threadId], n = e.length;
    e.push({seq: n + 1, type: "client/turn/requested", createdAt: Date.now(),
      data: {requestId: "req-" + turnId, originPluginId: "telegram-projects", input: [{type: "text", text}, marker]}});
    e.push({seq: n + 2, type: "turn/started", scope: {kind: "turn", turnId}, data: {}});
    e.push({seq: n + 3, type: "provider/error", data: {errorInfo: {category: "rate-limit"}}});
    e.push({seq: n + 4, type: "turn/completed", scope: {kind: "turn", turnId}, data: {status: "failed"}});
    queues[threadId].push({id: "retry-" + turnId, state: "scheduled", sendAt: Date.now() + 2 * 3600_000,
      payload: {kind: "retry", retryOfTurnRequestId: "req-" + turnId}});
    threads[threadId].status = "error";
  };
  return {store, sdk, threads, events, queues, sends, sent, bridge, ownerTurnLimited,
    cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

test("мост: лимит Claude — сообщение уходит в Codex без «⚠️», владельцу одна строка; возврат — со сводкой", async () => {
  const f = setup();
  try {
    await f.bridge.pairs.configure(0, "thr_claude", "thr_codex");
    f.ownerTurnLimited("thr_claude", "t1", "Кодовое слово — ласточка. Запомни.");
    await f.bridge.observe(); await f.bridge.flush();
    const texts = f.sent.map(s => String(s.text ?? ""));
    assert.ok(!texts.some(t => t.startsWith("⚠️")), "нет сообщения о сбое: " + texts.join(" | "));
    assert.ok(texts.some(t => /^Claude в лимите до .*Пока отвечает Codex\.$/.test(t)), texts.join(" | "));
    assert.equal(f.store.get<any>("chat:binding:0").threadId, "thr_codex");
    const replay = f.sends.find(s => s.threadId === "thr_codex");
    assert.ok(replay, "сообщение переотправлено в Codex");
    assert.match(replay.input[0].text, /ласточка/);
    assert.match(replay.input[1].text, /^\[bb-telegram-reply-route:/);
    assert.equal(f.queues.thr_claude.length, 0);
    assert.equal(f.threads.thr_codex.title, "🟢 Действующий · Личный помощник · Codex");
    assert.equal(f.threads.thr_claude.title, "⏳ Ждёт лимита · Личный помощник · Claude");

    // Codex ответил; лимит Claude снялся; на границе хода — возврат.
    f.events.thr_codex.push({seq: 1, type: "item/completed", createdAt: Date.now(),
      data: {item: {type: "agentMessage", text: "Запомнил кодовое слово: ласточка."}}});
    f.sdk.system.usageLimits = async () => ({"claude-code": {status: "ok", windows: [{usedPercent: 3}]}});
    f.threads.thr_codex.status = "idle";
    f.threads.thr_claude.status = "error";
    await f.bridge.pairs.tick(); await f.bridge.flush();
    assert.equal(f.store.get<any>("chat:binding:0").threadId, "thr_claude");
    assert.ok(f.sent.some(s => s.text === "Снова отвечает Claude."));

    // Следующее сообщение владельца идёт в Claude со сводкой пропущенного.
    await f.bridge.handle({ownerId: OWNER, chatId: OWNER, topicId: 0, messageId: 20, updateId: 20, text: "Какое кодовое слово?"} as any);
    const next = f.sends.filter(s => s.threadId === "thr_claude").at(-1);
    assert.ok(next, "сообщение ушло в Claude");
    assert.match(next.input[0].text, /Пока ты был в резерве[\s\S]*ласточка[\s\S]*Какое кодовое слово\?/);
    assert.equal(f.threads.thr_claude.title, "🟢 Действующий · Личный помощник · Claude");
    assert.equal(f.threads.thr_codex.title, "⏸ Резерв · Личный помощник · Codex");
  } finally { f.cleanup(); }
});

test("мост: подтред в лимите — нет «⚠️» владельцу, уведомление родителю ждёт с временем", async () => {
  const f = setup();
  try {
    await f.bridge.pairs.configure(0, "thr_claude", "thr_codex");
    f.threads.kid = {...f.threads.thr_claude, id: "kid", title: "Отчёт", parentThreadId: "thr_claude", status: "error"};
    f.events.kid = [];
    f.queues.kid = [];
    f.ownerTurnLimited("kid", "k1", "задача");
    f.threads.thr_claude.status = "idle";
    await f.bridge.observe(); await f.bridge.flush();
    assert.ok(!f.sent.some(s => String(s.text ?? "").startsWith("⚠️")), f.sent.map(s => s.text).join(" | "));
    const decision = await f.bridge.admitDispatch({thread: {id: "thr_claude", status: "idle"}, initiator: "system",
      attempt: "new-turn", input: {blocks: []},
      queuedMessages: [{id: "q", systemNotice: {kind: "child-failed", subject: {kind: "thread", threadId: "kid"}}}]} as any);
    assert.equal(decision.action, "wait");
    assert.match((decision as any).reason, /Подтред «Отчёт» ждёт сброса лимита до/);
  } finally { f.cleanup(); }
});
