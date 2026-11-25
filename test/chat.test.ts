import {createHash} from "node:crypto";
import {bindGroupTopic} from "../group-worker";
import { ReplyRoutes } from "../reply-routing";
import { routeUpdate } from "../ingress";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridge, inputSchema, setFollowupStartWait, splitText, type ChatInput } from "../chat";
import { TelegramFailure, type Store } from "../model";
const OWNER_ID = 259034221;
function fixture(receiveAttachment?: (input: ChatInput, threadId: string) => Promise<{path: string; name: string; bytes: number; sha256: string}>, transcribe?: () => Promise<string>, collectMs = 0, captureOwnerGroupPost?: (threadId:string, owner:number)=>boolean) {
  const data = new Map<string, any>();
  const calls: any[] = [];
  const sent: any[] = [];
  let message = 10;
  let deliveryFailure: TelegramFailure | undefined;
  let failedAttempts = 0;
  let albumFailure: TelegramFailure | undefined;
  let malformedAlbum = false;
  let lostReceiptMethod: string | undefined;
  let events: any[] = [];
  let interactions: any[] = [];
  const thread = {
    id: "thr_one",
    projectId: "proj_one",
    title: "Первый чат",
    status: "idle",
    providerId: "codex",
    visibility: "visible",
    environmentId: "env_one",
    archivedAt: null,
    deletedAt: null,
  };
  const store: Store = {
    get: (k) => structuredClone(data.get(k)),
    put: (k, v) => data.set(k, structuredClone(v)),
    del: (k) => {
      data.delete(k);
    },
    list: (p) =>
      [...data]
        .filter(([k]) => k.startsWith(p))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    atomic: (f) => f(),
  };
  store.put("topic:proj_one", {
    key: "proj_one",
    name: "Проект",
    threadId: 100,
  });
  const sdk: any = {
    projects: {
      list: async () => [{ id: "proj_one", name: "Проект", kind: "standard" }],
      get: async () => ({ id: "proj_one", name: "Проект" }),
    },
    environments: { get: async () => ({ path: "/work/project" }) },
    providers: {
      list: async () => [
        { id: "codex", displayName: "Codex", available: true },
      ],
      models: async () => ({
        models: [{ model: "model-a", displayName: "Модель A" }],
        modelLoadError: null,
      }),
    },
    plugins: {
      list: async () => ({ plugins: [] }),
      callRpc: async () => ({
        folders: [
          {
            id: "folder",
            projectId: "proj_one",
            hostId: "mini",
            parentId: null,
            name: "Раздел",
            path: "/work/project/section",
          },
        ],
        roots: [],
      }),
    },
    threads: {
      defaultExecutionOptions: async () => ({ model: "model-a" }),
      get: async ({ threadId }: any) => ({ ...thread, id: threadId }),
      list: async () => [thread],
      spawn: async (a: any) => {
        calls.push(["spawn", a]);
        return thread;
      },
      send: async (a: any) => {
        calls.push(["send", a]);
      },
      stop: async (a: any) => calls.push(["stop", a]),
      update: async (a: any) => calls.push(["update", a]),
      output: async () => ({ output: "Ответ из BB" }),
      events: {
        list: async (a: any) =>
          a.order === "desc"
            ? [{ seq: 99 }]
            : events.filter((e) => e.seq > Number(a.afterSeq)),
      },
      interactions: {
        list: async () => interactions,
        get: async ({ interactionId }: any) =>
          interactions.find((i) => i.id === interactionId),
        resolve: async (a: any) => {
          calls.push(["resolve", a]);
          interactions[0].status = "resolved";
        },
      },
    },
  };
  const controller = new AbortController();
  const dir = mkdtempSync(join(tmpdir(), "bb-chat-test-"));
  const makeBridge = () => new ChatBridge({
    captureOwnerGroupPost,
    store,
    sdk,
    tg: async (method, payload) => {
      if (deliveryFailure && failedAttempts > 0) {
        failedAttempts--;
        throw deliveryFailure;
      }
      sent.push({ method, ...payload });
      if (method===lostReceiptMethod) throw new TelegramFailure("telegram_network",30,true);
      if (method === "copyMessages") return [{message_id:++message},{message_id:++message}] as any;
      if (method === "sendMediaGroup") {
        if (albumFailure) { const error = albumFailure; albumFailure = undefined; throw error; }
        if (malformedAlbum) return [{message_id: ++message}] as any;
        return (payload.media as any[]).map((item) => ({message_id: ++message, media_group_id: "album-" + sent.length,
          chat:{id:payload.chat_id},message_thread_id:payload.message_thread_id,
          reply_to_message:payload.reply_parameters,
          ...(item.type==="photo" ? {photo:[{file_id:"synthetic"}]} : {document:{file_id:"synthetic"}})})) as any;
      }
      return { message_id: ++message } as any;
    },
    spool: dir,
    collectMs,
    owner: () => OWNER_ID,
    baseUrl: "https://bb.example",
    signal: controller.signal,
    rich: () => false,
    receiveAttachment,
    transcribe,
  });
  const bridge = makeBridge();
  let update = 0;
  const input = (text: string, topicId = 100): ChatInput => ({
    ownerId: OWNER_ID,
    chatId: OWNER_ID,
    topicId,
    messageId: ++update,
    updateId: update,
    text,
  });
  const press = async (kind: string) => {
    const action = [...data]
      .reverse()
      .find(([k, v]) => k.startsWith("chat:button:") && v.kind === kind);
    assert.ok(action, "button " + kind);
    await bridge.handle({
      ...input(""),
      callback: "bb:" + action[0].slice("chat:button:".length),
    });
  };
  return {
    data,
    abort: () => controller.abort(),
    store,
    calls,
    sent,
    sdk,
    thread,
    bridge,
    restart: makeBridge,
    input,
    press,
    malformedAlbum: () => { malformedAlbum = true; },
    loseReceiptFor: (method:string) => { lostReceiptMethod=method; },
    failNextAlbum: (error: TelegramFailure) => { albumFailure = error; },
    failNextDelivery: (error = new TelegramFailure("telegram_429", 20, false), attempts = 1) => {
      deliveryFailure = error;
      failedAttempts = attempts;
    },
    acceptTelegramTurn: (turnId: string, threadId = "thr_one") => {
      const routes = new ReplyRoutes(store);
      const marker = routes.ingress(threadId, {kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:1});
      routes.requested(threadId, {requestId:"fixture-"+turnId,originPluginId:"telegram-projects",input:[marker]});
      routes.accept(threadId,turnId,"fixture-"+turnId);
      store.put("reply:active-turn:"+threadId,turnId);
    },
    setEvents: (v: any[]) => {
      events = v;
    },
    setQuestions: (v: any[]) => {
      interactions = v;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("new message creates visible BB chat; subsequent message reuses it", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Первый запрос"));
    await f.bridge.handle(f.input("Продолжим"));
    assert.equal(f.calls[0][0], "spawn");
    assert.equal(f.calls[0][1].visibility, "visible");
    assert.deepEqual(f.calls[0][1].environment, { type: "project-default" });
    assert.equal(f.calls[1][0], "send");
    assert.equal(f.calls[1][1].threadId, "thr_one");
  } finally {
    f.cleanup();
  }
});

test("Telegram message stays durable during handoff and resumes once under the new binding after reload", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:100", {topicId: 100, projectId: "proj_one", threadId: "thr_one", revision: "before", ready: false, cursor: 0});
    const job = {id: "test-handoff", binding: {topicId: 100, projectId: "proj_one", threadId: "thr_one", revision: "before"},
      source: "thr_one", sourceSeq: 99, environmentId: "env_one", frozen: ["thr_one"], priorTargets: [],
      providerId: "claude-code", model: "model-a", at: Date.now(), phase: "uncertain"};
    f.store.put("chat:handoff:test-handoff", job);
    f.sdk.plugins.callRpc = async () => ({handoffs: []});
    const incoming = f.input("Поручение во время переключения");
    f.bridge.accept(incoming);
    await f.bridge.tick();
    await f.bridge.dispose();
    assert.equal(f.store.get<any>("chat:in:" + incoming.updateId)?.state, "pending");
    assert.equal(f.calls.filter(c => c[0] === "send" || c[0] === "spawn").length, 0);
    f.store.put("chat:binding:100", {topicId: 100, projectId: "proj_one", threadId: "thr_successor", revision: "after", ready: false, cursor: 99});
    f.store.put("chat:handoff:test-handoff", {...job, phase: "done"});
    const restored = new ChatBridge({store: f.store, sdk: f.sdk, owner: () => OWNER_ID,
      signal: new AbortController().signal, baseUrl: "https://bb.example", rich: () => false,
      tg: async () => ({message_id: 900}) as any});
    restored.recover();
    await restored.tick();
    await restored.dispose();
    const sends = f.calls.filter(c => c[0] === "send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0][1].threadId, "thr_successor");
    assert.equal(sends[0][1].input[0].text, incoming.text);
    assert.equal(f.store.get<any>("chat:in:" + incoming.updateId)?.state, "done");
  } finally {f.cleanup();}
});

test("retired delivery watcher cannot leave a stale error on a healthy successor", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:100", {topicId: 100, projectId: "proj_one", threadId: "thr_one", revision: "current", ready: false, cursor: 99});
    f.store.put("reply:watch:old", {owner: OWNER_ID, topicId: 100, projectId: "proj_one", threadId: "old", revision: "old", cursor: 99});
    const original = f.sdk.threads.get;
    f.sdk.threads.get = async (a: any) => {
      if (a.threadId === "old") throw Error("archived");
      return original(a);
    };
    await f.bridge.observe();
    assert.equal(f.bridge.status().lastError, "bound_thread_unavailable");
    f.store.del("reply:watch:old");
    await f.bridge.observe();
    assert.equal(f.bridge.status().lastError, null);
  } finally {f.cleanup();}
});
test("a delivery watch of an archived thread is finished, not an error; an error says what, where and when", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:100", {topicId: 100, projectId: "proj_one", threadId: "thr_one", revision: "current", ready: false, cursor: 99});
    f.store.put("reply:watch:arch", {owner: OWNER_ID, topicId: 100, projectId: "proj_one", threadId: "arch", revision: "arch", cursor: 99});
    f.store.put("reply:watch:gone", {owner: OWNER_ID, topicId: 100, projectId: "proj_one", threadId: "gone", revision: "gone", cursor: 99});
    const original = f.sdk.threads.get;
    let broken = false;
    f.sdk.threads.get = async (a: any) => {
      if (a.threadId === "arch") return {...(await original({threadId: "thr_one"})), id: "arch", archivedAt: 1};
      if (a.threadId === "gone") throw Object.assign(Error("HTTP 404: Thread not found"), {code: "thread_not_found"});
      if (a.threadId === "thr_one" && broken) throw Error("timeout");
      return original(a);
    };
    await f.bridge.observe();
    assert.equal(f.store.get("reply:watch:arch"), undefined);       // read once more, then finished
    assert.equal(f.store.get("reply:watch:gone"), undefined);       // a thread gone from BB: finished
    assert.equal(f.bridge.status().lastError, null);
    broken = true;
    await f.bridge.observe();
    const e = f.bridge.status().lastErrorDetail!;
    assert.equal(e.code, "bound_thread_unavailable");
    assert.equal(e.topicId, 100);
    assert.equal(e.threadId, "thr_one");
    assert.match(e.at, /^\d{4}-\d\d-\d\dT/);
    broken = false;
    (f.bridge as any).enqueue(100, "ответ");                          // the next delivery to the same conversation
    await f.bridge.flush();
    assert.equal(f.bridge.status().lastErrorDetail, null);
  } finally {f.cleanup();}
});
test("custom Telegram topic can bind a project before sending", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/project", 777));
    const [key] = [...f.data].find(
      ([k, v]) => k.startsWith("chat:button:") && v.kind === "project",
    )!;
    await f.bridge.handle({
      ...f.input("", 777),
      callback: "bb:" + key.slice(12),
    });
    await f.bridge.handle(f.input("Из новой темы", 777));
    assert.equal(f.calls[0][1].projectId, "proj_one");
    assert.equal(
      f.bridge.bindings().find((x) => x.topicId === 777)?.threadId,
      "thr_one",
    );
  } finally {
    f.cleanup();
  }
});
test("foreign identity rejected at ingress", () => {
  const f = fixture();
  try {
    assert.throws(() => f.bridge.accept({ ...f.input("hi"), ownerId: 22 }));
    assert.equal(f.data.size, 1);
  } finally {
    f.cleanup();
  }
});
test("new chat and disconnect never delete or stop original", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("hello"));
    await f.bridge.handle(f.input("/new"));
    assert.equal(f.bridge.bindings()[0].threadId, null);
    await f.bridge.handle(f.input("/disconnect"));
    await f.bridge.handle(f.input("must not send"));
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});
test("connecting an existing chat baselines old events and rejects stale controls", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/chats"));
    await f.press("inspect");
    const button = [...f.data].find(
      ([k, v]) => k.startsWith("chat:button:") && v.kind === "connect",
    )!;
    await f.press("connect");
    assert.equal(f.bridge.bindings()[0].cursor, 99);
    await f.bridge.handle({
      ...f.input(""),
      callback: "bb:" + button[0].slice(12),
    });
    assert.equal(f.calls.length, 0);
    assert.ok([...f.data.values()].some((v) => v.text?.includes("устарела")));
  } finally {
    f.cleanup();
  }
});
test("stop requires a specific confirmation", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("hello"));
    await f.bridge.handle(f.input("/stop"));
    assert.equal(f.calls.length, 1);
    await f.press("stop");
    assert.equal(f.calls[1][0], "stop");
  } finally {
    f.cleanup();
  }
});
test("section choice sets exact host and folder for native spawn", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/section"));
    const entry = [...f.data].find(
      ([k, v]) =>
        k.startsWith("chat:button:") &&
        v.kind === "folder" &&
        v.arg === "folder",
    )!;
    await f.bridge.handle({
      ...f.input(""),
      callback: "bb:" + entry[0].slice(12),
    });
    await f.bridge.handle(f.input("Run"));
    assert.deepEqual(f.calls[0][1].environment, {
      type: "host",
      hostId: "mini",
      workspace: { type: "unmanaged", path: "/work/project/section" },
    });
  } finally {
    f.cleanup();
  }
});
test("model menu uses BB catalog and does not alter other chats", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/model"));
    const p = [...f.data].find(
      ([k, v]) =>
        k.startsWith("chat:button:") &&
        v.kind === "provider" &&
        v.arg === "codex",
    )!;
    await f.bridge.handle({ ...f.input(""), callback: "bb:" + p[0].slice(12) });
    await f.press("model");
    await f.bridge.handle(f.input("Run"));
    assert.equal(f.calls[0][1].model, "model-a");
    assert.equal(f.calls[0][1].providerId, "codex");
  } finally {
    f.cleanup();
  }
});
test("only final agent text sent once, not tool commentary or previous turns", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('turn');

    f.setEvents([
      {
        seq: 1,
        type: "item/completed",
        scope: { kind: "turn", turnId: "turn" },
        data: { item: { type: "agentMessage", text: "Проверяю" } },
      },
      {
        seq: 2,
        type: "item/completed",
        scope: { kind: "turn", turnId: "turn" },
        data: { item: { type: "agentMessage", text: "Готовый ответ" } },
      },
      {
        seq: 3,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn" },
        data: { status: "completed" },
      },
    ]);
    await f.bridge.observe();
    await f.bridge.observe();
    await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Готовый ответ").length, 1);
    assert.equal(f.sent.filter((x) => x.text === "Проверяю").length, 0);
  } finally {
    f.cleanup();
  }
});
test("an archived thread's undelivered final still goes out once, then its watch is finished", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('turn');
    const [{key, value: bound}] = f.store.list<any>("chat:binding:");
    // The topic moved on to another thread; the old one keeps a delivery watch and is archived before its answer went out.
    f.store.put("reply:watch:" + bound.revision, {...bound, owner: OWNER_ID});
    f.store.put(key, {...bound, threadId: "thr_next", revision: "next"});
    const original = f.sdk.threads.get;
    f.sdk.threads.get = async (a: any) => {
      const t = await original(a.threadId === "thr_next" ? {...a, threadId: bound.threadId} : a);
      return a.threadId === bound.threadId ? {...t, archivedAt: 1, status: "idle"} : {...t, id: a.threadId};
    };
    f.setEvents([
      {seq: 1, type: "item/completed", scope: {kind: "turn", turnId: "turn"}, data: {item: {type: "agentMessage", text: "Итог из архива"}}},
      {seq: 2, type: "turn/completed", scope: {kind: "turn", turnId: "turn"}, data: {status: "completed"}},
    ]);
    await f.bridge.observe();
    await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Итог из архива").length, 1);
    await f.bridge.observe();                                         // nothing left to send: finished
    assert.equal(f.store.get("reply:watch:" + bound.revision), undefined);
    await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Итог из архива").length, 1);
    assert.equal(f.bridge.status().lastError, null);
  } finally {
    f.cleanup();
  }
});
test("С72: a quiet bridge reads a changed thread at once, a missed change on the safety pass; the feed down means 2 s", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('turn');
    const b = f.bridge as any;
    b.setChangeFeed(true);
    b.recentInputAt = 0;
    await f.bridge.observe();                                         // the first pass after the feed came up is full
    let reads = 0;
    const get = f.sdk.threads.get;
    f.sdk.threads.get = async (a: any) => { reads++; return get(a); };
    // Quiet: nothing changed — a focused pass reads nothing.
    await f.bridge.observe();
    assert.equal(reads, 0);
    assert.equal(b.observeInterval(), 12000);
    // A missed change: the answer is there, no thread:changed came. The safety pass (12 s) delivers it.
    f.setEvents([
      {seq: 1, type: "item/completed", scope: {kind: "turn", turnId: "turn"}, data: {item: {type: "agentMessage", text: "Ответ без события"}}},
      {seq: 2, type: "turn/completed", scope: {kind: "turn", turnId: "turn"}, data: {status: "completed"}},
    ]);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Ответ без события").length, 0);
    b.lastFull = Date.now() - 13_000;
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Ответ без события").length, 1);
    // The feed is down: every pass is full and the pace is 2 s.
    b.setChangeFeed(false);
    assert.equal(b.observeInterval(), 2000);
    reads = 0;
    await f.bridge.observe();
    assert.ok(reads > 0);
  } finally {
    f.cleanup();
  }
});
test("С72: thread:changed makes the next pass read that thread without waiting for the safety pass", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('turn');
    const b = f.bridge as any;
    b.setChangeFeed(true);
    await f.bridge.observe();
    const [{value: bound}] = f.store.list<any>("chat:binding:");
    f.setEvents([
      {seq: 1, type: "item/completed", scope: {kind: "turn", turnId: "turn"}, data: {item: {type: "agentMessage", text: "Ответ по событию"}}},
      {seq: 2, type: "turn/completed", scope: {kind: "turn", turnId: "turn"}, data: {status: "completed"}},
    ]);
    b.noteThreadChange(bound.threadId);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Ответ по событию").length, 1);
  } finally {
    f.cleanup();
  }
});
test("queued answer from old binding never enters new conversation", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.setEvents([
      {
        seq: 1,
        type: "item/completed",
        scope: { kind: "turn", turnId: "turn" },
        data: { item: { type: "agentMessage", text: "Старый ответ" } },
      },
      {
        seq: 2,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn" },
        data: { status: "completed" },
      },
    ]);
    await f.bridge.observe();
    await f.bridge.handle(f.input("/new"));
    await f.bridge.flush();
    assert.equal(f.sent.filter((x) => x.text === "Старый ответ").length, 0);
  } finally {
    f.cleanup();
  }
});
test("prebound migration accepts the first pending private message once without pairing or spawning", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:0", {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"migration",ready:true,cursor:99});
    const routed=routeUpdate({update_id:7,message:{message_id:8,text:"pending task",chat:{id:OWNER_ID,type:"private"},from:{id:OWNER_ID}}},OWNER_ID);
    assert.equal(routed.kind,"chat");
    if (routed.kind!=="chat") throw Error("not routed");
    f.bridge.accept(routed.input);
    await f.bridge.tick();
    f.bridge.accept(routed.input);
    await f.bridge.tick();
    await f.bridge.dispose();
    const sends=f.calls.filter(c=>c[0]==="send");
    assert.equal(sends.length,1);
    assert.equal(sends[0][1].threadId,"thr_one");
    assert.equal(f.calls.filter(c=>c[0]==="spawn").length,0);
    assert.equal(f.bridge.bindings()[0].threadId,"thr_one");
  } finally {f.cleanup();}
});
test("duplicate accepted update and recovery never replay unknown mutation", () => {
  const f = fixture();
  try {
    const input = f.input("Run");
    f.bridge.accept(input);
    f.bridge.accept(input);
    assert.equal(f.store.list("chat:in:").length, 1);
    f.store.put("chat:in:" + input.updateId, {
      input,
      state: "claimed",
      at: Date.now(),
    });
    f.bridge.recover();
    assert.equal(f.store.get<any>("chat:in:" + input.updateId).state, "done");
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});
test("approval callback survives navigation and resolves once; stale tap does not execute again", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('question-turn');

    f.setQuestions([
      {
        id: "ask", turnId: "question-turn",
        status: "pending",
        payload: {
          kind: "approval",
          reason: "Команда",
          subject: { kind: "command", command: "ls" },
          availableDecisions: ["allow_once", "deny"],
        },
      },
    ]);
    await f.bridge.observe();
    f.store.put("chat:binding:100", {...f.store.get<any>("chat:binding:100"), threadId:"thr_new", revision:"new-navigation"});
    await f.press("resolve");
    assert.equal(f.calls.filter((x) => x[0] === "resolve").length, 1);
    assert.equal(f.calls.find(x => x[0] === "resolve")[1].threadId,"thr_one");
    assert.equal(f.store.get<any>("chat:binding:100").threadId,"thr_new");
    await f.press("resolve");
    assert.equal(f.calls.filter((x) => x[0] === "resolve").length, 1);
  } finally {
    f.cleanup();
  }
});
test("pending BB question prevents normal text from steering past it", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.setQuestions([
      {
        id: "ask",
        status: "pending",
        payload: { kind: "plugin", title: "Form" },
      },
    ]);
    await f.bridge.handle(f.input("yes"));
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});
test("long text splitting preserves content and surrogate pairs", () => {
  const text = "a".repeat(3499) + "😀" + "b".repeat(4000);
  const chunks = splitText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(
    chunks.every((x) => x.length <= 3500 && !/[\uD800-\uDBFF]$/.test(x)),
  );
});

test("progress is transient, final is clean and acknowledgement is a reaction", async () => {
  const f = fixture();
  try {
    f.thread.status = "active";
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('t');

    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.method === "setMessageReaction").length, 1);
    assert.equal(f.sent.some(x => x.text?.includes("Сообщение принято")), false);
    assert.equal(f.sent.filter(x => x.method === "sendMessage" && x.text?.startsWith("⏳")).length, 1);
    f.setEvents([
      {seq:1,type:"item/completed",scope:{kind:"turn",turnId:"t"},data:{item:{type:"reasoning",text:"PRIVATE THOUGHT"}}},
      {seq:2,type:"item/completed",scope:{kind:"turn",turnId:"t"},data:{item:{type:"agentMessage",text:"Готово: [result.md](/srv/projects/test/result.md), @thread:thr_one. **Проверено**"}}},
      {seq:3,type:"turn/completed",scope:{kind:"turn",turnId:"t"},data:{status:"completed"}}
    ]);
    f.thread.status = "idle";
    await f.bridge.observe(); await f.bridge.flush(); await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.method === "deleteMessage").length,1);
    const final=f.sent.find(x=>x.text?.startsWith("Готово:"));
    assert.ok(final); assert.equal(final.parse_mode,"HTML");
    assert.equal(final.reply_markup,undefined);
    assert.equal(final.text.includes("/srv/"),false); assert.equal(final.text.includes("@thread:"),false);
    assert.equal(final.text.includes("<b>Проверено</b>"),true);
    assert.equal(JSON.stringify(f.sent).includes("PRIVATE THOUGHT"),false);
    assert.equal(f.sent.filter(x=>x.text?.startsWith("Готово:")).length,1);
  } finally { f.cleanup(); }
});
test("a final cancels progress still waiting later in the same flush", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn("race");
    f.thread.status = "active";
    f.setEvents([
      {seq:1,type:"item/completed",scope:{kind:"turn",turnId:"race"},data:{item:{type:"agentMessage",text:"Finished"}}},
      {seq:2,type:"turn/completed",scope:{kind:"turn",turnId:"race"},data:{status:"completed"}}
    ]);
    await f.bridge.observe();
    assert.ok(f.store.list("chat:out:progress:").length > 0);
    await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.text === "Finished").length, 1);
    assert.equal(f.sent.filter(x => x.text?.startsWith("⏳")).length, 0);
  } finally { f.cleanup(); }
});
test("429 retains message and confirmed receipts avoid replay", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/menu"));
    const entry = f.store.list<any>("chat:out:")[0];
    f.failNextDelivery();
    await f.bridge.flush();
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.get<any>(entry.key).error, "telegram_429");
    await f.bridge.flush();
    assert.equal(f.sent.length, 0);
    f.store.put(entry.key, { ...entry.value, retryAt: 0 });
    await f.bridge.flush();
    await f.bridge.flush();
    assert.equal(f.sent.length, 1);
  } finally {
    f.cleanup();
  }
});
test("free text answers exact pending question; closed question never reopens", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('question-turn');

    const q = {
      id: "q", turnId: "question-turn",
      status: "pending",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Ответ?",
            allowFreeText: true,
            multiSelect: false,
            options: [],
          },
        ],
      },
    };
    f.setQuestions([q]);
    await f.bridge.observe();
    await f.bridge.flush();
    const record = f.store.list<any>("chat:question:")[0];
    assert.ok(record);
    const replyTo = Number(record.key.split(":").at(-1));
    await f.bridge.handle({ ...f.input("Мой ответ"), replyTo });
    assert.equal(f.calls.filter((x) => x[0] === "resolve").length, 1);
    assert.equal(f.calls.at(-1)[1].resolution.answers.q1.freeText, "Мой ответ");
    await f.bridge.handle({ ...f.input("Ещё ответ"), replyTo });
    assert.equal(f.calls.filter((x) => x[0] === "resolve").length, 1);
  } finally {
    f.cleanup();
  }
});

test("folder button hides host path; callback menu edits original card", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("/section"));
    await f.bridge.flush();
    const labels = f.sent
      .at(-1)
      .reply_markup.inline_keyboard.flat()
      .map((b: any) => b.text);
    assert.ok(
      labels.every((s: string) => !s.includes("/")),
      JSON.stringify(labels),
    );
    const action = [...f.data]
      .reverse()
      .find(([k, v]) => k.startsWith("chat:button:") && v.kind === "menu")!;
    await f.bridge.handle({
      ...f.input(""),
      messageId: 12345,
      callback: "bb:" + action[0].slice(12),
    });
    await f.bridge.flush();
    assert.equal(f.sent.at(-1).method, "editMessageText");
    assert.equal(f.sent.at(-1).message_id, 12345);
  } finally {
    f.cleanup();
  }
});

test("CLI profile selection follows model and travels only in initial native prompt", async () => {
  const f = fixture();
  try {
    f.sdk.projects.get = async () => ({
      id: "proj_one",
      name: "Проект",
      sources: [{ hostId: "host_one", path: "/work/project", isDefault: true }],
    });
    f.sdk.plugins.list = async () => ({
      plugins: [{ id: "cli-agents", status: "running" }],
    });
    const previous = f.sdk.plugins.callRpc;
    f.sdk.plugins.callRpc = async (a: any) => {
      if (a.pluginId !== "cli-agents") return previous(a);
      if (a.method === "catalog")
        return {
          supported: true,
          warnings: [],
          agents: [{ id: "reviewer", description: "Review" }],
        };
      assert.equal(a.input.hostId, "host_one");
      assert.equal(a.input.projectId, "proj_one");
      assert.equal(a.input.agentId, "reviewer");
      return {
        token: "11111111-1111-4111-8111-111111111111",
        label: "Agent: reviewer",
      };
    };
    await f.bridge.handle(f.input("/model"));
    await f.press("provider");
    await f.press("model");
    assert.ok(
      [...f.data.values()].some(
        (v) => v.kind === "profile" && v.arg === "reviewer",
      ),
    );
    const reviewer = [...f.data].find(
      ([k, v]) =>
        k.startsWith("chat:button:") &&
        v.kind === "profile" &&
        v.arg === "reviewer",
    )!;
    await f.bridge.handle({
      ...f.input(""),
      callback: "bb:" + reviewer[0].slice(12),
    });
    await f.bridge.flush();
    assert.ok(f.sent.at(-1).text.includes("🎭 Профиль: reviewer"));
    assert.ok(f.sent.at(-1).text.includes("🧠 Модель: Модель A"));
    assert.ok(
      !f.sent
        .at(-1)
        .reply_markup.inline_keyboard.flat()
        .some((b: any) => b.text.includes("Остановить")),
    );
    await f.bridge.handle(f.input("Check this"));
    assert.equal(
      f.calls[0][1].input[0].text,
      "[cli-agents-selection:11111111-1111-4111-8111-111111111111]\nCheck this",
    );
    assert.equal(f.calls[0][1].model, "model-a");
    await f.bridge.handle(f.input("Next"));
    assert.equal(f.calls[1][1].input[0].text, "Next");
  } finally {
    f.cleanup();
  }
});

test("profile pages show eight agents, paired buttons, bounded navigation and default", async () => {
  const f = fixture();
  try {
    f.sdk.projects.get = async () => ({
      id: "proj_one",
      name: "Project",
      sources: [{ hostId: "host_one", path: "/work", isDefault: true }],
    });
    f.sdk.plugins.list = async () => ({
      plugins: [{ id: "cli-agents", status: "running" }],
    });
    f.sdk.plugins.callRpc = async () => ({
      supported: true,
      warnings: [],
      agents: Array.from({ length: 19 }, (_, i) => ({
        id: "role-" + i,
        description: "",
      })),
    });
    await f.bridge.handle(f.input("/model"));
    await f.press("provider");
    await f.press("model");
    await f.bridge.flush();
    const buttons = () => f.sent.at(-1).reply_markup.inline_keyboard;
    assert.deepEqual(
      buttons()
        .slice(0, 4)
        .map((r: any) => r.length),
      [2, 2, 2, 2],
    );
    assert.ok(f.sent.at(-1).text.includes("1 / 3"));
    assert.ok(!JSON.stringify(buttons()).includes("role-8"));
    const clickNext = async () => {
      const next = [...f.data]
        .reverse()
        .find(
          ([k, v]) =>
            k.startsWith("chat:button:") &&
            v.kind === "profiles" &&
            v.arg === String(f.sent.at(-1).text.includes("1 / 3") ? 8 : 16),
        );
      assert.ok(next);
      await f.bridge.handle({
        ...f.input(""),
        callback: "bb:" + next[0].slice(12),
      });
      await f.bridge.flush();
    };
    await clickNext();
    assert.ok(f.sent.at(-1).text.includes("2 / 3"));
    assert.equal(buttons()[0][0].text, "role-8");
    await clickNext();
    assert.ok(f.sent.at(-1).text.includes("3 / 3"));
    assert.equal(buttons()[0][0].text, "role-16");
    assert.ok(
      !buttons()
        .flat()
        .some((b: any) => b.text.includes("Далее")),
    );
    assert.ok(
      buttons()
        .flat()
        .some((b: any) => b.text === "По умолчанию BB"),
    );
  } finally {
    f.cleanup();
  }
});

test("Projects & Sections target is passed to CLI Agents; absent CLI Agents skips picker", async () => {
  const f = fixture();
  try {
    f.sdk.plugins.list = async () => ({
      plugins: [
        { id: "project-folders", status: "running" },
        { id: "cli-agents", status: "running" },
      ],
    });
    f.sdk.environments.list = async () => [
      {
        id: "env_section",
        hostId: "mini",
        projectId: "proj_one",
        path: "/work/project/section",
      },
    ];
    const original = f.sdk.plugins.callRpc;
    let seen: any;
    f.sdk.plugins.callRpc = async (a: any) => {
      if (a.pluginId === "project-folders") return original(a);
      seen = a.input;
      return {
        supported: true,
        warnings: [],
        agents: [{ id: "section-role", description: "" }],
      };
    };
    await f.bridge.handle(f.input("/section"));
    const section = [...f.data].find(
      ([k, v]) =>
        k.startsWith("chat:button:") &&
        v.kind === "folder" &&
        v.arg === "folder",
    )!;
    await f.bridge.handle({
      ...f.input(""),
      callback: "bb:" + section[0].slice(12),
    });
    await f.bridge.handle(f.input("/model"));
    await f.press("provider");
    await f.press("model");
    await f.bridge.flush();
    assert.equal(seen.hostId, "mini");
    assert.equal(seen.environmentId, "env_section");
    assert.equal(seen.cwd, "/work/project/section");
    assert.ok(f.sent.at(-1).text.includes("Выбери профиль"));
    f.sdk.plugins.list = async () => ({
      plugins: [{ id: "project-folders", status: "running" }],
    });
    seen = null;
    await f.bridge.handle(f.input("/model"));
    await f.press("provider");
    await f.press("model");
    await f.bridge.flush();
    assert.equal(seen, null);
    assert.ok(f.sent.at(-1).text.includes("Напиши первое сообщение"));
    assert.ok(!f.sent.at(-1).text.includes("Выбери профиль"));
  } finally {
    f.cleanup();
  }
});

test("server selection routes catalogs and new chat to that project's remote source", async () => {
  const f = fixture();
  try {
    f.sdk.hosts = {
      list: async () => [{ id: "ovh", name: "OVH", status: "connected" }],
      get: async () => ({ id: "ovh", name: "OVH", status: "connected" }),
    };
    f.sdk.projects.get = async () => ({
      id: "proj_one",
      sources: [{ hostId: "ovh", path: "/srv/project", isDefault: false }],
    });
    const routes: any[] = [];
    f.sdk.providers.list = async (a: any) => {
      routes.push(a);
      return [{ id: "codex", displayName: "Codex", available: true }];
    };
    await f.bridge.handle(f.input("/server"));
    await f.press("host");
    await f.press("provider");
    await f.press("model");
    await f.bridge.handle(f.input("Hello remote"));
    const spawn = f.calls.find((c) => c[0] === "spawn")[1];
    assert.deepEqual(spawn.environment, {
      type: "host",
      hostId: "ovh",
      workspace: { type: "unmanaged", path: "/srv/project" },
    });
    assert.ok(routes.some((r) => r.hostId === "ovh"));
  } finally {
    f.cleanup();
  }
});

test("empty native profile catalog explains fallback after model selection", async () => {
  const f = fixture();
  try {
    f.sdk.projects.get = async () => ({
      id: "proj_one",
      sources: [{ hostId: "mini", path: "/work/project", isDefault: true }],
    });
    f.sdk.plugins.list = async () => ({
      plugins: [{ id: "cli-agents", status: "running" }],
    });
    f.sdk.plugins.callRpc = async () => ({
      supported: true,
      agents: [],
      warnings: [],
    });
    await f.bridge.handle(f.input("/model"));
    await f.press("provider");
    await f.press("model");
    await f.bridge.flush();
    assert.ok(f.sent.at(-1).text.includes("профили не найдены"));
  } finally {
    f.cleanup();
  }
});

test("delegated work stays visible while parent is idle and ignores unrelated/hidden chats", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    f.acceptTelegramTurn('parent-turn');
    f.acceptTelegramTurn('child-turn', 'child');

    const child = {...f.thread, id:"child", parentThreadId:"thr_one", title:"Шаурма в Казани — исследование и PDF", status:"active"};
    f.sdk.threads.list = async (args:any) => {
      assert.equal(args.parentThreadId,"thr_one");
      return [child, {...child,id:"other",parentThreadId:"other-parent",title:"UNRELATED"}, {...child,id:"hidden",visibility:"hidden",title:"HIDDEN"}];
    };
    f.sdk.threads.events.list = async (args:any) => args.threadId === "thr_one" ? [] : [
      {seq:3,type:"item/started",data:{item:{type:"toolCall",arguments:"SECRET TOOL PAYLOAD"}}},
      {seq:2,type:"item/completed",data:{item:{type:"reasoning",text:"PRIVATE THOUGHT"}}},
      {seq:1,type:"item/completed",data:{item:{type:"agentMessage",text:"Сравниваю меню и свежие отзывы."}}},
    ].map(event => ({...event, scope:{kind:"turn",turnId:"child-turn"}}));
    await f.bridge.observe(); await f.bridge.flush();
    const progress=f.sent.find(x=>x.text?.startsWith("⏳"));
    assert.ok(progress?.text.includes(child.title));
    assert.ok(progress.text.includes("Сравниваю меню"));
    assert.equal(progress.reply_markup,undefined);
    assert.equal(f.sent.some(x=>x.method==="deleteMessage"),false);
    assert.equal(/UNRELATED|HIDDEN|PRIVATE THOUGHT|SECRET TOOL PAYLOAD/.test(JSON.stringify(f.sent)),false);
    child.status="idle";
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.method==="deleteMessage").length,1);
  } finally { f.cleanup(); }
});

test("a worker from another task in the same Telegram topic is not disclosed", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    f.acceptTelegramTurn("parent-turn");
    const routes = new ReplyRoutes(f.store);
    routes.record("child", "other-task", {kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:999});
    routes.accept("child", "child-turn", "other-task");
    f.sdk.threads.list = async () => [{...f.thread,id:"child",parentThreadId:"thr_one",status:"active",title:"PRIVATE CHILD TITLE"}];
    f.sdk.threads.events.list = async (args:any) => args.threadId === "thr_one" ? [] : [
      {seq:2,type:"item/completed",scope:{kind:"turn",turnId:"child-turn"},data:{item:{type:"agentMessage",text:"PRIVATE CHILD PROGRESS"}}},
      {seq:1,type:"turn/started",scope:{kind:"turn",turnId:"child-turn"}},
    ];
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(/PRIVATE CHILD/.test(JSON.stringify(f.sent)),false);
  } finally { f.cleanup(); }
});

test("accepted Telegram task still delivers after navigation and does not replace the new binding", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    f.acceptTelegramTurn("old-task");
    const old = f.store.get<any>("chat:binding:100");
    const next = {...old, threadId:"thr_new", revision:"new-navigation",cursor:0};
    f.store.put("chat:binding:100", next);
    f.sdk.threads.events.list = async (args:any) => args.threadId !== "thr_one" ? [] : [
      {seq:1,type:"item/completed",scope:{kind:"turn",turnId:"old-task"},data:{item:{type:"agentMessage",text:"ORIGINAL-TASK-RESULT"}}},
      {seq:2,type:"turn/completed",scope:{kind:"turn",turnId:"old-task"},data:{status:"completed"}},
    ].filter(e => e.seq > Number(args.afterSeq ?? 0));
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.text?.includes("ORIGINAL-TASK-RESULT")).length,1);
    assert.equal(f.store.get<any>("chat:binding:100").threadId,"thr_new");
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.text?.includes("ORIGINAL-TASK-RESULT")).length,1);
  } finally { f.cleanup(); }
});

test("dispatch queues steering and splits grouped tasks through the native queue", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    const ctx:any = {thread:{id:"thr_one"},originPluginId:null,attempt:"join-turn",initiator:"user",queuedMessages:[]};
    assert.equal((await f.bridge.admitDispatch(ctx)).action,"wait");
    assert.equal((await f.bridge.admitDispatch({...ctx,initiator:"system"})).action,"wait");
    const notice = {kind:"child-outcome-batch", subject:{kind:"thread-batch", outcomes:[{threadId:"child",status:"completed"}]}};
    const child = {...ctx, initiator:"system", queuedMessages:[{systemNotice:notice}]};
    assert.equal((await f.bridge.admitDispatch(child)).action,"proceed");
    assert.equal((await f.bridge.admitDispatch({...child, queuedMessages:[{systemNotice:{...notice,
      subject:{...notice.subject,outcomes:[{threadId:"child",turnId:"specific",status:"completed"}]}}}]})).action,"wait");
    assert.equal((await f.bridge.admitDispatch({...ctx,thread:{id:"unrelated"}})).action,"proceed");
    assert.equal((await f.bridge.admitDispatch({...ctx,attempt:"start-turn"})).action,"proceed");
    const boundaries:any[] = [];
    f.sdk.threads.queuedMessages = {list:async () => [{id:"bb-task"},{id:"telegram-task"}], setGroupBoundary:async (args:any) => boundaries.push(args)};
    const grouped = {...ctx,attempt:"start-turn",queuedMessages:[{id:"bb-task"},{id:"telegram-task"}]};
    assert.equal((await f.bridge.admitDispatch(grouped)).action,"wait");
    assert.equal(boundaries.length,0,"never mutate rows while dispatch owns their claim");
    await f.bridge.separateQueuedTasks();
    assert.deepEqual(boundaries,[{threadId:"thr_one",expectedGroupedPrefixQueuedMessageIds:["bb-task"],groupBoundaryQueuedMessageId:"bb-task"}]);
    assert.equal((await f.bridge.admitDispatch({...grouped,queuedMessages:[{id:"bb-task"}]})).action,"proceed");
    f.sdk.threads.queuedMessages.setGroupBoundary = async () => {throw Error("stale_neighbor");};
    assert.equal((await f.bridge.admitDispatch(grouped)).action,"wait");
    await f.bridge.separateQueuedTasks();
    assert.equal(f.store.list("reply:separate-queue:").length,1);
    assert.equal(f.calls.filter(x => x[0] === "send").length,0);
  } finally { f.cleanup(); }
});

function nativeDispatchHistory() {
  const sender="thr_coord";
  const scope={kind:"turn",turnId:"current-turn"};
  const previous={kind:"turn",turnId:"preceding-turn"};
  const completed={seq:1,type:"turn/completed",scope:previous,data:{status:"completed"}};
  const started={seq:3,type:"turn/started",scope,data:{}};
  const requested=(requestId:string,seq:number,data:object={})=>({seq,type:"client/turn/requested",
    scope:{kind:"thread"},data:{requestId,initiator:"agent",senderThreadId:sender,target:{kind:"new-turn"},...data}});
  const accepted=(requestId:string,seq:number)=>({seq,type:"turn/input/accepted",scope,data:{clientRequestId:requestId}});
  const queued={id:"queued",initiator:"agent",senderThreadId:sender,origin:null,originPluginId:null};
  const dispatch={thread:{id:"thr_one"},attempt:"join-turn",initiator:"agent",senderThreadId:sender,
    origin:null,originPluginId:null,queuedMessages:[],input:{blocks:[]}};
  return {sender,scope,completed,started,requested,accepted,queued,dispatch};
}

test("native coordinator input joins a running BB turn and autonomous continuation",async()=>{
  const f=fixture();
  try {
    await f.bridge.handle(f.input("Bind"));
    const sends=f.calls.filter(([kind])=>kind==="send").length;
    const h=nativeDispatchHistory();
    let events:any[]=[h.completed,h.started];
    f.sdk.threads.events.list=async()=>events;
    const decide=(ctx:object={})=>f.bridge.admitDispatch({...h.dispatch,...ctx} as any);
    assert.equal((await decide()).action,"proceed");
    assert.equal((await decide({queuedMessages:[h.queued]})).action,"proceed");
    events=[h.completed,h.requested("primary",2),h.started,h.accepted("primary",4)];
    assert.equal((await decide()).action,"proceed");
    assert.equal((await decide({origin:"plugin",originPluginId:"codex-delegation-watch"})).action,"wait");
    assert.equal((await decide({senderThreadId:"thr_other"})).action,"wait");
    assert.equal((await decide({queuedMessages:[{...h.queued,senderThreadId:"thr_other"}]})).action,"wait");

    const sibling={...h.queued,id:"parallel",senderThreadId:"thr_other"};
    const boundaries:unknown[]=[];
    f.sdk.threads.queuedMessages={list:async()=>[h.queued,sibling],
      setGroupBoundary:async(input:unknown)=>boundaries.push(input)};
    assert.equal((await decide({queuedMessages:[h.queued,sibling]})).action,"wait");
    assert.deepEqual(boundaries,[]);
    await f.bridge.separateQueuedTasks();
    assert.deepEqual(boundaries,[{threadId:"thr_one",expectedGroupedPrefixQueuedMessageIds:["queued"],
      groupBoundaryQueuedMessageId:"queued"}]);

    events.push(h.requested("pending",5,{target:{kind:"auto",expectedTurnId:h.scope.turnId}}));
    assert.equal((await decide()).action,"wait");
    events.push(h.accepted("pending",6));
    assert.equal((await decide()).action,"proceed");
    events.push({seq:7,type:"turn/completed",scope:h.scope,data:{status:"completed"}});
    assert.equal((await decide()).action,"wait");
    assert.equal((await decide({attempt:"start-turn",queuedMessages:[sibling]})).action,"proceed");
    f.sdk.threads.events.list=async()=>{throw new DOMException("timeout","TimeoutError");};
    assert.equal((await decide()).action,"wait");
    assert.equal(f.calls.filter(([kind])=>kind==="send").length,sends);
  } finally {f.cleanup();}
});

test("joining requires the original coordinator for a Telegram delegation and preserves its exact route",async()=>{
  const f=fixture();
  try {
    await f.bridge.handle(f.input("Bind"));
    const h=nativeDispatchHistory();
    const routes=new ReplyRoutes(f.store);
    const original={kind:"telegram" as const,chatId:OWNER_ID,topicId:100,updateId:711};
    const marker=routes.ingress("thr_one",original,h.sender);
    const req=h.requested("delegated",2,{originPluginId:"telegram-projects",input:[marker]});
    f.sdk.threads.events.list=async()=>[h.completed,req,h.started,h.accepted("delegated",4)];
    routes.requested("thr_one",req.data);
    const decide=(ctx:object={})=>f.bridge.admitDispatch({...h.dispatch,...ctx} as any);
    assert.equal((await decide()).action,"wait","stale observer cannot authorize Telegram steering");
    routes.accept("thr_one",h.scope.turnId,"delegated");
    // С48: another thread may join a running Telegram task as a service message; its sender learns it was delivered, once.
    assert.equal((await decide({senderThreadId:"thr_other"})).action,"proceed");
    await new Promise(r=>setTimeout(r,10));
    const acks=()=>f.calls.filter(([kind,q]:any)=>kind==="send" && q.threadId==="thr_other" && /передано в идущее поручение/.test(q.input[0].text));
    assert.equal(acks().length,1);
    assert.equal((await decide({senderThreadId:"thr_other"})).action,"proceed");
    await new Promise(r=>setTimeout(r,10));
    assert.equal(acks().length,1,"no second acknowledgement within five minutes");
    assert.equal((await decide()).action,"proceed");
    const clarification=h.requested("clarification",5,{target:{kind:"auto",expectedTurnId:h.scope.turnId}});
    routes.requested("thr_one",clarification.data);
    routes.accept("thr_one",h.scope.turnId,"clarification");
    routes.accept("thr_one",h.scope.turnId,"clarification");
    assert.deepEqual(routes.destination("thr_one",h.scope.turnId),original);
    assert.deepEqual(routes.routeOf("thr_one","clarification"),{kind:"bb"});
  } finally {f.cleanup();}
});

for (const exactIdentity of [false, true]) test(`native child completion requires proven run identity (exact identity: ${exactIdentity})`, async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    const marker = f.calls.find(c => c[0] === "spawn")[1].input[1];
    const token = marker.text.match(/route:([^\]]+)/)[1];
    const threadScope={kind:"thread"};
    f.setEvents([
      {seq:1,type:"client/turn/requested",scope:threadScope,data:{requestId:"original",originPluginId:"telegram-projects",input:[marker]}},
      {seq:2,type:"turn/input/accepted",scope:{kind:"turn",turnId:"parent-turn"},data:{clientRequestId:"original"}},
    ]);
    await f.bridge.observe();
    const child={...f.thread,id:"child",parentThreadId:"thr_one"};
    f.sdk.threads.get=async ({threadId}:any)=>threadId==="child"?child:f.thread;
    f.sdk.threads.events.list=async(q:any)=>q.threadId === "thr_one" ? [
      {seq:1,type:"client/turn/requested",data:{requestId:"original",originPluginId:"telegram-projects",input:[marker]}}
    ] : [];
    const args={parentThreadId:"thr_one",threadId:"child",routeToken:token,text:"Research details",deliveryId:"delegation-test-001"};
    await f.bridge.sendDelegated(args);
    await f.bridge.sendDelegated(args);
    const sends=f.calls.filter(c=>c[0]==="send");assert.equal(sends.length,1);
    const childMarker=sends[0][1].input[1];
    f.sdk.threads.list=async()=>[child];
    const childEvents=[
      {seq:1,type:"client/turn/requested",scope:threadScope,data:{requestId:"child-work",originPluginId:"telegram-projects",input:[childMarker]}},
      {seq:2,type:"turn/input/accepted",scope:{kind:"turn",turnId:"child-turn"},data:{clientRequestId:"child-work"}},
      {seq:3,type:"turn/completed",scope:{kind:"turn",turnId:"child-turn"},data:{status:"completed"}},
    ];
    if (exactIdentity) {
      const routes = new ReplyRoutes(f.store);
      routes.record("child", "old-bb", {kind:"bb"});
      routes.accept("child", "old-turn", "old-bb");
      routes.complete("child", "old-turn", "completed");
    }
    const parentEvents=[
      {seq:3,type:"client/turn/requested",scope:threadScope,data:{requestId:"notice",initiator:"system",systemMessageKind:"child-completed",systemMessageSubject:{kind:"thread",threadId:"child",threadName:"Worker", ...(exactIdentity ? {outcomes:[{threadId:"child",status:"completed",turnId:"child-turn"}]} : {})}}},
      {seq:4,type:"turn/input/accepted",scope:{kind:"turn",turnId:"parent-final"},data:{clientRequestId:"notice"}},
      {seq:5,type:"item/completed",scope:{kind:"turn",turnId:"parent-final"},data:{item:{type:"agentMessage",text:"DELEGATED-ROUTE-PASS"}}},
      {seq:6,type:"turn/completed",scope:{kind:"turn",turnId:"parent-final"},data:{status:"completed"}},
    ];
    f.sdk.threads.events.list=async (q:any)=>(q.threadId==="child"?childEvents:parentEvents).filter(e=>e.seq>Number(q.afterSeq??0));
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.text?.includes("DELEGATED-ROUTE-PASS")).length,exactIdentity ? 1 : 0);
    if (!exactIdentity) {
      await f.bridge.observe();
      await f.bridge.observe();
      const reports = f.calls.filter(c => c[0] === "send" && c[1].threadId === "thr_one" &&
        c[1].input[0].text.includes("конкретный ход child-turn"));
      assert.equal(reports.length,1);
      const receipt = reports[0][1].input[1];
      const parentScope = {kind:"turn",turnId:"receipt-turn"};
      const extra = [
        {seq:7,type:"client/turn/requested",scope:threadScope,data:{requestId:"receipt",originPluginId:"telegram-projects",input:[receipt]}},
        {seq:8,type:"turn/input/accepted",scope:parentScope,data:{clientRequestId:"receipt"}},
        {seq:9,type:"item/completed",scope:parentScope,data:{item:{type:"agentMessage",text:"EXACT-CHILD-RESULT"}}},
        {seq:10,type:"turn/completed",scope:parentScope,data:{status:"completed"}},
      ];
      f.sdk.threads.events.list=async(q:any)=>(q.threadId==="child"?childEvents:[...parentEvents,...extra]).filter(e=>e.seq>Number(q.afterSeq??0));
      await f.bridge.observe();await f.bridge.flush();
      await f.bridge.observe();await f.bridge.flush();
      assert.equal(f.sent.filter(x=>x.text==="EXACT-CHILD-RESULT").length,1);
    }
  } finally {f.cleanup();}
});

test("late child acknowledgement is silent until it actually performs work", async () => {
 const f=fixture();try{
  await f.bridge.handle(f.input("Research"));
  f.acceptTelegramTurn("parent");f.acceptTelegramTurn("child-turn","child");
  const routes=new ReplyRoutes(f.store);routes.complete("child","child-turn","completed");
  f.thread.status="active";
  const scope={kind:"turn",turnId:"late-notice"};
  const events:any[]=[
   {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"notice",initiator:"system",systemMessageKind:"child-completed",systemMessageSubject:{kind:"thread",threadId:"child",outcomes:[{threadId:"child",status:"completed",turnId:"child-turn"}]}}},
   {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"notice"}},
   {seq:3,type:"turn/started",scope,data:{}},
  ];
  f.setEvents(events);await f.bridge.observe();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.text?.startsWith("⏳")).length,0);
  events.push({seq:4,type:"item/started",scope,data:{item:{type:"commandExecution"}}});
  f.setEvents(events);await f.bridge.observe();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.text?.startsWith("⏳")).length,1);
  events.push({seq:5,type:"item/completed",scope,data:{item:{type:"agentMessage",text:"FOLLOW-UP-RESULT"}}},
   {seq:6,type:"turn/completed",scope,data:{status:"completed"}});
  f.thread.status="idle";f.setEvents(events);await f.bridge.observe();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.text==="FOLLOW-UP-RESULT").length,1);
 }finally{f.cleanup();}
});
test("confirmed stop suppresses a delayed child result only for the stopped Telegram request", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    f.acceptTelegramTurn("parent");
    f.acceptTelegramTurn("work", "child");
    await f.bridge.handle(f.input("/stop"));
    await f.press("stop");
    const routes = new ReplyRoutes(f.store);
    routes.complete("child", "work", "completed");
    routes.inheritOutcomes("thr_one", "notice", [{threadId:"child", turnId:"work", status:"completed"}]);
    routes.accept("thr_one", "late", "notice");
    routes.record("thr_one", "next", {kind:"telegram", chatId:OWNER_ID, topicId:100, updateId:42});
    routes.accept("thr_one", "fresh", "next");
    const events = ["late", "fresh"].flatMap((turnId, i) => [
      {seq:2*i+1,type:"item/completed",scope:{kind:"turn",turnId},data:{item:{type:"agentMessage",text:turnId}}},
      {seq:2*i+2,type:"turn/completed",scope:{kind:"turn",turnId},data:{status:"completed"}},
    ]);
    f.setEvents(events);
    await f.bridge.observe();
    await f.bridge.flush();
    assert.deepEqual(f.sent.filter(m => ["late","fresh"].includes(m.text)).map(m => m.text), ["fresh"]);
  } finally { f.cleanup(); }
});

test("stop before flush suppresses a queued result", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    f.acceptTelegramTurn("parent");
    const scope = {kind:"turn", turnId:"parent"};
    f.setEvents([
      {seq:1,type:"item/completed",scope,data:{item:{type:"agentMessage",text:"queued final"}}},
      {seq:2,type:"turn/completed",scope,data:{status:"completed"}},
    ]);
    await f.bridge.observe();
    assert.ok(f.store.list("chat:out:event:").some(row => row.value.text === "queued final"));
    await f.bridge.handle(f.input("/stop"));
    await f.press("stop");
    await f.bridge.flush();
    assert.equal(f.sent.filter(row => row.text === "queued final").length, 0);
  } finally { f.cleanup(); }
});

test("delegated spawn uses native project/environment and keeps one worker on RPC replay", async () => {
  const f=fixture();
  try {
    await f.bridge.handle(f.input("Work"));
    const marker=f.calls.find(c=>c[0]==="spawn")[1].input[1];
    const token=marker.text.match(/route:([^\]]+)/)[1];
    const routes=new ReplyRoutes(f.store);
    routes.requested("thr_one",{requestId:"original",originPluginId:"telegram-projects",input:[marker]});
    f.sdk.threads.events.list=async()=>[
      {seq:1,type:"client/turn/requested",data:{requestId:"original",originPluginId:"telegram-projects",input:[marker]}}
    ];
    const nativeCalls:any[]=[];
    f.sdk.threads.spawn=async (args:any)=>{nativeCalls.push(args);return {...f.thread,id:"new-child",parentThreadId:"thr_one"};};
    const args={parentThreadId:"thr_one",routeToken:token,projectId:"target-project",environmentId:"target-environment",
      text:"Do work",title:"Worker",deliveryId:"new-worker-001",providerId:"codex"};
    assert.deepEqual(await f.bridge.spawnDelegated(args),{threadId:"new-child"});
    assert.deepEqual(await f.bridge.spawnDelegated(args),{threadId:"new-child"});
    assert.equal(nativeCalls.length,1);
    assert.equal(nativeCalls[0].projectId,"target-project");
    assert.deepEqual(nativeCalls[0].environment,{type:"reuse",environmentId:"target-environment"});
    assert.equal(nativeCalls[0].parentThreadId,"thr_one");
    const {environmentId, ...withoutEnvironment} = args;
    const projectSource = {hostId:"tru",path:"/srv/projects/new-project"};
    f.sdk.projects.get = async () => ({sources:[projectSource]});
    const fromSource = {...withoutEnvironment,deliveryId:"first-project-worker",projectSource};
    await assert.rejects(f.bridge.spawnDelegated({...fromSource,environmentId}),/choose_environment/);
    await assert.rejects(f.bridge.spawnDelegated({...fromSource,projectSource:{...projectSource,path:"/elsewhere"}}),/project_source_mismatch/);
    await f.bridge.spawnDelegated(fromSource);
    await f.bridge.spawnDelegated(fromSource);
    assert.equal(nativeCalls.length,2);
    assert.deepEqual(nativeCalls[1].environment,{type:"host",hostId:"tru",workspace:{type:"unmanaged",path:projectSource.path}});
    routes.requested("new-child",{requestId:"work",originPluginId:"telegram-projects",input:nativeCalls[0].input});
    routes.accept("new-child","work-turn","work");
    assert.equal(routes.destination("new-child","work-turn")?.kind,"telegram");
    await assert.rejects(f.bridge.spawnDelegated({...args,text:"Different work"}),/conflict/);
    f.sdk.threads.spawn=async()=>{throw Error("connection_lost");};
    await assert.rejects(f.bridge.spawnDelegated({...args,deliveryId:"new-worker-002"}),/connection_lost/);
    await assert.rejects(f.bridge.spawnDelegated({...args,deliveryId:"new-worker-002"}),/uncertain/);
    f.sdk.threads.events.list=async()=>[
      {seq:2,type:"client/turn/requested",data:{requestId:"new-bb-task",initiator:"user",input:[{type:"text",text:"New task from BB"}]}}
    ];
    await assert.rejects(f.bridge.spawnDelegated({...args,deliveryId:"new-worker-003"}),/does_not_match_current/);
    assert.equal(f.store.get("reply:delegation-spawn:new-worker-003"),undefined);
  } finally {f.cleanup();}
});

test("a Telegram child question resolves in that worker after navigation without forwarding BB questions", async () => {
  const f=fixture();
  try {
    await f.bridge.handle(f.input("Work"));
    f.acceptTelegramTurn("child-turn","child");
    f.store.put("reply:child-cursor:child",0);
    const q={id:"child-question",turnId:"child-turn",status:"pending",payload:{kind:"approval",
      reason:"Choose for this worker",subject:{kind:"command",command:"ls"},availableDecisions:["allow_once","deny"]}};
    f.setQuestions([q]);
    f.sdk.threads.list=async()=>[{...f.thread,id:"child",parentThreadId:"thr_one"}];
    f.sdk.threads.events.list=async()=>[];
    f.sdk.threads.interactions.list=async({threadId}:any)=>threadId==="child"?[q]:[];
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.text?.includes("Choose for this worker")).length,1);
    const current=f.store.get<any>("chat:binding:100");
    f.store.put("chat:binding:100",{...current,threadId:"different-thread",revision:"new-navigation"});
    await f.press("resolve");
    assert.equal(f.calls.find(c=>c[0]==="resolve")[1].threadId,"child");
    assert.equal(f.store.get<any>("chat:binding:100").threadId,"different-thread");
    const routes=new ReplyRoutes(f.store);routes.record("child","bb-request",{kind:"bb"});routes.accept("child","bb-turn","bb-request");
    q.id="bb-child-question";q.turnId="bb-turn";q.status="pending";q.payload.reason="PRIVATE BB QUESTION";
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.some(x=>x.text?.includes("PRIVATE BB QUESTION")),false);
  } finally {f.cleanup();}
});

test("public parent commentary survives a tool start: the agent's line and the step, never the command", async () => {
  const f=fixture();
  try {
    f.thread.status="active";
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('t');

    f.setEvents([
      {seq:1,type:"item/completed",scope:{kind:"turn",turnId:"t"},data:{item:{type:"agentMessage",text:"Проверяю адреса и часы работы."}}},
      {seq:2,type:"item/started",scope:{kind:"turn",turnId:"t"},data:{item:{type:"commandExecution",command:"SECRET COMMAND"}}},
    ]);
    await f.bridge.observe(); await f.bridge.flush();
    const progress=f.sent.find(x=>x.text?.startsWith("⏳"));
    assert.ok(progress?.text.includes("Проверяю адреса"));
    assert.equal(progress.text.includes("Выполняю шаг"),false);  // С46: a command is no plain-words step
    assert.equal(progress.text.includes("SECRET"),false);
  } finally {f.cleanup();}
});

import { localArtifacts, renderTelegramParts } from "../telegram-ux";
import { writeFileSync } from "node:fs";
test("Telegram rendering preserves links, escaping, lists, code and long text", () => {
  const source = '# Заголовок\n**Жирный** и *курсив*\n- [Источник](https://example.org/?a=1&b=2)\n`x < y`\n' + '**' + 'Длинный ответ '.repeat(800) + '**';
  const parts = renderTelegramParts(source);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(p => p.length < 4096));
  const all = parts.join('');
  assert.ok(all.includes('<a href="https://example.org/?a=1&amp;b=2">Источник</a>'));
  assert.ok(all.includes('<code>x &lt; y</code>'));
  assert.ok(all.includes('• '));
  for (const p of parts) assert.equal((p.match(/<b>/g)||[]).length, (p.match(/<\/b>/g)||[]).length);
  assert.equal((all.replace(/<[^>]+>/g, '').match(/Длинный ответ /g)||[]).length, 800);
  assert.deepEqual(localArtifacts('[PDF](</tmp/a b.pdf>)'), [{markdown:'[PDF](</tmp/a b.pdf>)',path:'/tmp/a b.pdf',label:'PDF'}]);
});
test("artifact delivered once before final, unavailable path explicitly reported", async () => {
  const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'artifact-'));
  try {
    writeFileSync(join(dir,'report.pdf'), '%PDF-1.4 test');
    f.sdk.environments.get=async()=>({path:dir});
    await f.bridge.handle(f.input('Run'));
    f.acceptTelegramTurn('t');

    f.setEvents([
      {seq:1,type:'item/completed',scope:{kind:'turn',turnId:'t'},data:{item:{type:'agentMessage',text:`Готово: [PDF](${dir}/report.pdf). [Нет](${dir}/missing.pdf). [Источник](https://example.org)`}}},
      {seq:2,type:'turn/completed',scope:{kind:'turn',turnId:'t'},data:{status:'completed'}}
    ]);
    await f.bridge.observe(); await f.bridge.flush(); await f.bridge.flush();
    const docs=f.sent.filter(x=>x.method==='sendDocument');
    assert.equal(docs.length,1); assert.equal(docs[0].document_filename,'report.pdf');
    assert.equal(await docs[0].document.text(),'%PDF-1.4 test');
    const final=f.sent.find(x=>x.text?.startsWith('Готово:'));
    assert.ok(final.text.includes('файл отправлен выше')); assert.ok(final.text.includes('missing.pdf') && !final.text.includes('не удалось'));
    assert.ok(f.calls.some(c=>c[0]==='send' && /Файл не приложен: missing\.pdf/.test(c[1].input[0].text)),'the agent is told why');
    assert.ok(final.text.includes('<a href="https://example.org">Источник</a>'));
    assert.ok(f.sent.indexOf(docs[0]) < f.sent.indexOf(final));
  } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("failed child notifies parent chat with actual retry time, deduplicates and updates cancellation", async()=>{
 const f=fixture();try{
  await f.bridge.handle(f.input('Run'));
    f.acceptTelegramTurn('parent-turn');

  f.acceptTelegramTurn("child-turn","thr_failed");
  const child={...f.thread,id:'thr_failed',parentThreadId:'thr_one',title:'Исследование',status:'error'};
  f.sdk.threads.list=async()=>[child];
  let retries:any[]=[{id:'retry1',state:'scheduled',payload:{kind:'retry',retryOfTurnRequestId:'fixture-child-turn'},sendAt:Date.now()+60000}];
  f.sdk.threads.queue={list:async()=>retries};
  const oldList=f.sdk.threads.events.list;
  f.sdk.threads.events.list=async(a:any)=>a.threadId==='thr_failed'?[
   {seq:10,type:'turn/started'},
   {seq:11,type:'provider/error',data:{errorInfo:{category:'rate-limit'},detail:'PRIVATE TOKEN MUST NOT LEAK'}},
   {seq:12,type:'turn/completed',scope:{kind:'turn',turnId:'child-turn'},data:{status:'failed'}}
  ]:oldList(a);
  await f.bridge.observe();await f.bridge.flush();await f.bridge.observe();await f.bridge.flush();
  let errors=f.sent.filter(x=>x.text?.startsWith('⚠️ Исследование'));
  assert.equal(errors.length,1);assert.ok(errors[0].text.includes('достигнут лимит'));assert.ok(errors[0].text.includes('МСК'));assert.ok(!JSON.stringify(f.sent).includes('PRIVATE TOKEN'));
  retries=[];await f.bridge.observe();await f.bridge.flush();
  errors=f.sent.filter(x=>x.text?.startsWith('⚠️ Исследование'));assert.equal(errors.length,2);assert.ok(errors[1].text.includes('не запланирован'));
  child.status='idle';await f.bridge.observe();await f.bridge.flush();assert.equal(f.sent.filter(x=>x.text?.startsWith('⚠️ Исследование')).length,2);
 }finally{f.cleanup();}
});
test("failure does not promise another task's retry or an exhausted retry", async () => {
 const f=fixture();try{
  await f.bridge.handle(f.input("Run")); f.acceptTelegramTurn("failed-turn");
  f.thread.status="error";
  const routes=new ReplyRoutes(f.store);
  routes.record("thr_one","bb-request",{kind:"bb"});
  const other=routes.ingress("thr_one",{kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:2});
  routes.requested("thr_one",{requestId:"other-tg",originPluginId:"telegram-projects",input:[other]});
  let queue:any[]=[];
  f.sdk.threads.queue={list:async()=>queue};
  const fail=[{seq:2,type:"turn/completed",scope:{kind:"turn",turnId:"failed-turn"},data:{status:"failed"}}];
  const oldList=f.sdk.threads.events.list;
  f.sdk.threads.events.list=async(a:any)=>a.order==="desc"?fail:oldList(a);
  queue=[
   {id:"bb",state:"scheduled",payload:{kind:"retry",retryOfTurnRequestId:"bb-request"},sendAt:Date.now()+1000},
   {id:"other",state:"scheduled",payload:{kind:"retry",retryOfTurnRequestId:"other-tg"},sendAt:Date.now()+2000},
   {id:"spent",state:"failed_exhausted",payload:{kind:"retry",retryOfTurnRequestId:"fixture-failed-turn"},sendAt:Date.now()+3000},
  ];
  await f.bridge.observe();await f.bridge.flush();
  const first=f.sent.filter(x=>x.text?.startsWith("⚠️ Помощник"));
  assert.equal(first.length,1);assert.match(first[0].text,/не запланирован/);
  queue.push({id:"matching",state:"scheduled",payload:{kind:"retry",retryOfTurnRequestId:"fixture-failed-turn"},sendAt:Date.now()+60000});
  await f.bridge.observe();await f.bridge.flush();
  const next=f.sent.filter(x=>x.text?.startsWith("⚠️ Помощник"));
  assert.equal(next.length,2);assert.match(next[1].text,/Автоматическая повторная попытка:/);
 }finally{f.cleanup();}
});
test("main failure reports no retry honestly, later successful final arrives once",async()=>{
 const f=fixture();try{
  await f.bridge.handle(f.input('Run'));
    f.acceptTelegramTurn('t');
    f.acceptTelegramTurn('r');
 f.thread.status='error';
  f.sdk.threads.queue={list:async()=>[]};
  const fail=[{seq:1,type:'provider/error',scope:{kind:'turn',turnId:'t'},data:{errorInfo:{category:'unauthorized'}}},{seq:2,type:'turn/completed',scope:{kind:'turn',turnId:'t'},data:{status:'failed'}}];
  const oldList=f.sdk.threads.events.list;
  f.sdk.threads.events.list=async(a:any)=>a.order==='desc'?fail:oldList(a);
  f.setEvents(fail);await f.bridge.observe();await f.bridge.flush();
  const msg=f.sent.find(x=>x.text?.startsWith('⚠️ Помощник'));assert.ok(msg.text.includes('авторизации'));assert.ok(msg.text.includes('не запланирован'));
  f.thread.status='idle';f.setEvents([{seq:3,type:'item/completed',scope:{kind:'turn',turnId:'r'},data:{item:{type:'agentMessage',text:'Восстановился, результат готов'}}},{seq:4,type:'turn/completed',scope:{kind:'turn',turnId:'r'},data:{status:'completed'}}]);
  await f.bridge.observe();await f.bridge.flush();await f.bridge.observe();await f.bridge.flush();assert.equal(f.sent.filter(x=>x.text==='Восстановился, результат готов').length,1);
 }finally{f.cleanup();}
});

const attachment = {fileId: "file-large", name: "video.mp4", mime: "video/mp4", size: 2_000_000_000, kind: "document" as const};
test("attachment reaches the bound thread only after storage succeeds; duplicate update is ignored", async () => {
  let copies = 0;
  const f = fixture(async (input, threadId) => {
    copies++;
    assert.equal(threadId, "thr_one");
    assert.equal(input.attachment?.size, 2_000_000_000);
    return {path: "/inbox/video.mp4", name: "video.mp4", bytes: 2_000_000_000, sha256: "a".repeat(64)};
  });
  try {
    await f.bridge.handle(f.input("hello"));
    const input = {...f.input("Проанализируй"), attachment};
    f.bridge.accept(input);
    await f.bridge.tick();
    await f.bridge.dispose();
    assert.equal(copies, 1);
    const sends = f.calls.filter(c => c[0] === "send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0][1].threadId, "thr_one");
    assert.match(sends[0][1].input[0].text, /Проанализируй/);
    assert.match(sends[0][1].input[0].text, /\/inbox\/video.mp4/);
    assert.match(sends[0][1].input[0].text, /2000000000/);
    f.bridge.accept(input);
    assert.equal([...f.data.values()].filter(v => v?.state === "pending").length, 0);
  } finally {f.cleanup();}
});
test("attachment storage failure never invokes the agent and gives a bounded error", async () => {
  const f = fixture(async () => {throw new Error("attachment_disk_space_low");});
  try {
    await f.bridge.handle(f.input("hello"));
    await f.bridge.handle({...f.input("Разбери"), attachment});
    await f.bridge.tick();
    await f.bridge.dispose();
    assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    assert.ok(f.sent.some(s => String(s.text).includes("недостаточно места")));
  } finally {f.cleanup();}
});

test("shutdown during attachment download preserves input and resumes once before dispatch", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(r => entered = r);
  const released = new Promise<void>(r => finish = r);
  const saved = {path: "/inbox/video.mp4", name: "video.mp4", bytes: 2_000_000_000, sha256: "b".repeat(64)};
  const f = fixture(async () => {entered(); await released; return saved;});
  let resumed = 0;
  const g = fixture(async () => {resumed++; return saved;});
  try {
    await f.bridge.handle(f.input("hello"));
    const input = {...f.input("Разбери файл"), attachment};
    f.bridge.accept(input);
    await f.bridge.tick();
    await started;
    await f.bridge.observe(); await f.bridge.flush();
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(s => String(s.text).includes("Получаю файл из Telegram")).length, 1);
    f.abort(); finish(); await f.bridge.dispose();
    assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    const row = f.store.get<any>("chat:in:" + input.updateId);
    assert.equal(row.state, "claimed");
    assert.equal(row.phase, "attachment-download");
    assert.equal(row.input.text, "Разбери файл");
    for (const [k,v] of f.data) g.store.put(k, v);
    g.bridge.recover();
    assert.equal(g.store.get<any>("chat:in:" + input.updateId).state, "pending");
    await g.bridge.tick(); await g.bridge.dispose();
    assert.equal(resumed, 1);
    assert.equal(g.calls.filter(c => c[0] === "send").length, 1);
    assert.equal(g.store.get<any>("chat:in:" + input.updateId).state, "done");
    g.bridge.recover();
    assert.equal(g.store.get<any>("chat:in:" + input.updateId).state, "done");
  } finally {f.cleanup(); g.cleanup();}
});
test("claimed input after the download boundary is not replayed on recovery", async () => {
  const f = fixture();
  try {
    const input = {...f.input("Уже мог отправить"), attachment};
    f.store.put("chat:in:" + input.updateId, {input, state: "claimed", at: Date.now()});
    f.bridge.recover();
    await f.bridge.tick(); await f.bridge.dispose();
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.get<any>("chat:in:" + input.updateId).state, "done");
    assert.ok(f.sent.some(s => String(s.text).includes("Исход действия не подтверждён")));
  } finally {f.cleanup();}
});

test("pending question rejects unrelated attachment before downloading it", async () => {
  let copies = 0;
  const f = fixture(async () => {copies++; throw Error("should not run");});
  try {
    await f.bridge.handle(f.input("hello"));
    f.setQuestions([{id: "q", status: "pending"}]);
    await f.bridge.handle({...f.input("Файл"), attachment});
    await f.bridge.flush();
    assert.equal(copies, 0);
    assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    assert.ok(f.sent.some(s => String(s.text).includes("Файл пока не передан")));
  } finally {f.cleanup();}
});

test("native request attribution delivers Telegram output but keeps BB output and questions local", async () => {
  const f=fixture(); try {
    await f.bridge.handle(f.input("Telegram task"));
    const input=f.calls.find(c=>c[0]==="spawn")[1].input;
    f.setEvents([
      {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"tg-native",originPluginId:"telegram-projects",input}},
      {seq:2,type:"turn/input/accepted",scope:{kind:"turn",turnId:"tg-turn"},data:{clientRequestId:"tg-native"}},
      {seq:3,type:"item/completed",scope:{kind:"turn",turnId:"tg-turn"},data:{item:{type:"agentMessage",text:"TG-RESULT"}}},
      {seq:4,type:"turn/completed",scope:{kind:"turn",turnId:"tg-turn"},data:{status:"completed"}},
      {seq:5,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"bb-native",input:[{type:"text",text:"BB task"}]}},
      {seq:6,type:"turn/input/accepted",scope:{kind:"turn",turnId:"bb-turn"},data:{clientRequestId:"bb-native"}},
      {seq:7,type:"item/completed",scope:{kind:"turn",turnId:"bb-turn"},data:{item:{type:"agentMessage",text:"BB-PRIVATE-RESULT"}}},
      {seq:8,type:"turn/completed",scope:{kind:"turn",turnId:"bb-turn"},data:{status:"completed"}},
    ]);
    f.setQuestions([{id:"bb-question",turnId:"bb-turn",status:"pending",payload:{kind:"user_question",questions:[]}}]);
    await f.bridge.observe();await f.bridge.flush();await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.filter(s=>s.text==="TG-RESULT").length,1);
    assert.equal(f.sent.some(s=>String(s.text).includes("BB-PRIVATE")),false);
    assert.equal([...f.data.keys()].some(k=>k.startsWith("chat:question-out:")),false);
    f.thread.status="active";
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.some(s=>String(s.text).startsWith("⏳")),false);
  } finally {f.cleanup();}
});
test("explicit Telegram delivery is deduplicated and does not change future task routing", async () => {
  const f=fixture();try {
    await f.bridge.handle(f.input("bind"));
    const args={threadId:"thr_one",topicId:100,text:"Explicitly requested",deliveryId:"explicit_test_001"};
    f.bridge.sendExplicit(args);
    assert.equal(f.bridge.explicitDeliveryStatus(args.deliveryId).state,"queued");
    await f.bridge.flush();
    assert.equal(f.bridge.explicitDeliveryStatus(args.deliveryId).state,"delivered");
    f.bridge.sendExplicit(args);await f.bridge.flush();
    assert.equal(f.sent.filter(s=>s.text===args.text).length,1);
    assert.throws(()=>f.bridge.sendExplicit({...args,text:"changed"}),/conflict/);
    assert.throws(()=>f.bridge.sendExplicit({...args,threadId:"different"}),/mismatch/);
    assert.equal([...f.data.keys()].some(k=>k.startsWith("reply:request:")),false);
  }finally{f.cleanup();}
});


test("images default to photos; explicit per-artifact documents do not affect following photos", async () => {
  const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'photos-'));
  try {
    for (const name of ['a.png','b.png','c.jpg']) writeFileSync(join(dir,name),'fixture-image');
    f.sdk.environments.get=async()=>({path:dir});
    await f.bridge.handle(f.input('Run')); f.acceptTelegramTurn('t');
    const text=`[A](${dir}/a.png) [B](<${dir}/b.png> "telegram:document") [C](${dir}/c.jpg)`;
    f.setEvents([
      {seq:1,type:'item/completed',scope:{kind:'turn',turnId:'t'},data:{item:{type:'agentMessage',text}}},
      {seq:2,type:'turn/completed',scope:{kind:'turn',turnId:'t'},data:{status:'completed'}}
    ]);
    await f.bridge.observe(); await f.bridge.flush(); await f.bridge.flush();
    assert.deepEqual(f.sent.filter(x=>x.method==='sendPhoto').map(x=>x.photo_filename),['a.png','c.jpg']);
    assert.deepEqual(f.sent.filter(x=>x.method==='sendDocument').map(x=>x.document_filename),['b.png']);
    assert.ok(!f.sent.some(x=>x.text?.includes('telegram:document')));
  } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("oversized photos never silently fall back to documents", async () => {
  const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'photos-limit-'));
  try {
    writeFileSync(join(dir,'big.png'),Buffer.alloc(10*1024*1024+1));
    f.sdk.environments.get=async()=>({path:dir});
    await f.bridge.handle(f.input('Run')); f.acceptTelegramTurn('t');
    f.setEvents([
      {seq:1,type:'item/completed',scope:{kind:'turn',turnId:'t'},data:{item:{type:'agentMessage',text:`[Image](${dir}/big.png)`}}},
      {seq:2,type:'turn/completed',scope:{kind:'turn',turnId:'t'},data:{status:'completed'}}
    ]);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x=>['sendPhoto','sendDocument'].includes(x.method)).length,0);
    assert.ok(!f.sent.some(x=>x.text?.includes('не удалось')),'no service words to the person');
    assert.ok(f.calls.some(c=>c[0]==='send' && /Файл не приложен: big\.png/.test(c[1].input[0].text)),'the agent is told why');
  } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});


test("image-only final has a media receipt, no caption or extra text, and deduplicates", async () => {
 const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'image-only-'));
 try {
  writeFileSync(join(dir,'a.png'),'image');f.sdk.environments.get=async()=>({path:dir});
  await f.bridge.handle(f.input('bind')); await f.bridge.flush(); f.sent.length=0;
  const args={threadId:'thr_one',topicId:100,text:`![a.png](${dir}/a.png)\n<!-- bb-telegram-child-result:thr_worker:turn-1 -->`,deliveryId:'image_only_001'};
  f.bridge.sendExplicit(args);await f.bridge.flush();
  const photos=f.sent.filter(x=>x.method==='sendPhoto');assert.equal(photos.length,1);
  assert.equal(photos[0].caption,undefined);
  assert.equal(f.sent.filter(x=>x.method==='sendMessage').length,0);
  const receipt=f.bridge.explicitDeliveryStatus(args.deliveryId);
  assert.equal(receipt.state,'delivered');assert.ok(receipt.messageId!>0);
  f.bridge.sendExplicit(args);await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.method==='sendPhoto').length,1);
  assert.deepEqual(f.bridge.explicitDeliveryStatus(args.deliveryId),receipt);
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("explicit delivery sends images without alt text and reports each file", async () => {
 const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'image-empty-alt-'));
 try {
  writeFileSync(join(dir,'a.png'),'image');f.sdk.environments.get=async()=>({path:dir});
  await f.bridge.handle(f.input('bind')); await f.bridge.flush(); f.sent.length=0;
  const args={threadId:'thr_one',topicId:100,text:`Готово.\n\n![](${dir}/a.png)\n\n[Отчёт](${dir}/missing.pdf)`,deliveryId:'image_empty_alt_001'};
  f.bridge.sendExplicit(args);await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.method==='sendPhoto').length,1);
  assert.ok(!f.sent.some(x=>String(x.text??'').includes('a.png)')));
  const receipt=f.bridge.explicitDeliveryStatus(args.deliveryId);
  assert.equal(receipt.state,'delivered');
  assert.deepEqual(receipt.files.map(x=>[x.name,x.state]).sort(),[['a.png','delivered'],['missing.pdf','failed']]);
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("a bound private chat reports ready in status", async () => {
  const f=fixture();try {
    await f.bridge.handle(f.input("bind"));
    assert.ok(f.bridge.status().bindings.every(b=>!b.threadId || b.ready));
  }finally{f.cleanup();}
});

test("multiple images use Russian link captions; document image retains explicit format", async () => {
 const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'image-captions-'));
 try {
  for(const name of ['a.png','b.png','c.png'])writeFileSync(join(dir,name),'image');
  f.sdk.environments.get=async()=>({path:dir});await f.bridge.handle(f.input('bind'));
  const text=`[Зелёный треугольник](${dir}/a.png)\n[b.png](${dir}/b.png)\n[Вариант с рамкой](<${dir}/c.png> "telegram:document")`;
  f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text,deliveryId:'image_many_001'});await f.bridge.flush();
  assert.deepEqual(f.sent.find(x=>x.method==='sendMediaGroup').media.map((x:any)=>x.caption),['Зелёный треугольник','Вариант 2']);
  assert.equal(f.sent.find(x=>x.method==='sendDocument').caption,'Вариант с рамкой');
  assert.equal(f.bridge.explicitDeliveryStatus('image_many_001').state,'delivered');
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

for (const count of [2, 5, 10, 11, 21]) test(`photo album preserves order and receipts for ${count} images`, async () => {
 const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'album-'));
 try {
  f.sdk.environments.get=async()=>({path:dir}); await f.bridge.handle(f.input('bind'));await f.bridge.flush();f.sent.length=0;
  const links=Array.from({length:count},(_,i)=>{writeFileSync(join(dir,`${i}.png`),`image-${i}`);return `[Снимок ${i} <&>](${dir}/${i}.png)`;});
  const args={threadId:'thr_one',topicId:100,text:links.join('\n'),deliveryId:`album_count_${count}`};
  f.bridge.sendExplicit(args);await f.bridge.flush();
  const media=f.sent.filter(x=>['sendMediaGroup','sendPhoto'].includes(x.method));
  assert.deepEqual(media.map(x=>x.method==='sendMediaGroup'?x.media.length:1),count===21?[10,10,1]:count===11?[10,1]:[count]);
  const names=media.flatMap(x=>x.method==='sendMediaGroup'?x.media.map((_:any,i:number)=>x[`media${i}_filename`]):[x.photo_filename]);
  assert.deepEqual(names,Array.from({length:count},(_,i)=>`${i}.png`));
  for(const album of media.filter(x=>x.method==='sendMediaGroup')) {
   assert.equal(album.media[0].parse_mode,undefined); // captions are literal text, not HTML
   assert.ok(album.media[0].caption.includes('<&>'));
  }
  assert.equal(f.sent.filter(x=>['sendDocument','sendMessage'].includes(x.method)).length,0);
  assert.equal(f.bridge.explicitDeliveryStatus(args.deliveryId).state,'delivered');
  const receipts=[...f.data.entries()].filter(([k])=>k.startsWith('chat:album:')).map(([,v])=>v);
  assert.equal(receipts.length,Math.floor(count/10)+(count%10>1?1:0));
  assert.ok(receipts.every(r=>r.state==='delivered'&&r.mediaGroupId&&r.messageIds.length===r.paths.length));
  const sends=f.sent.length;f.bridge.sendExplicit(args);await f.bridge.flush();assert.equal(f.sent.length,sends);
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});
test('uncertain album does not retry or fall back to individual photos',async()=>{
 const f=fixture();const dir=mkdtempSync(join(tmpdir(),'album-unknown-'));
 try {
  for(const name of ['a.png','b.png'])writeFileSync(join(dir,name),'image');
  f.sdk.environments.get=async()=>({path:dir});await f.bridge.handle(f.input('bind'));await f.bridge.flush();f.sent.length=0;
  f.failNextAlbum(new TelegramFailure('telegram_network',30,true));
  f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:`[Первый](${dir}/a.png) [Второй](${dir}/b.png)`,deliveryId:'album_unknown_001'});
  await f.bridge.flush();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.method==='sendMediaGroup').length,1);
  assert.equal(f.sent.filter(x=>['sendPhoto','sendDocument'].includes(x.method)).length,0);
  assert.ok(!f.sent.some(x=>x.text?.includes('не удалось')),'no service words to the person');
  assert.ok([...f.data.entries()].filter(([k])=>k.startsWith('chat:file:')).every(([,v])=>v==='uncertain'));
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});
test('album validates all paths before sending any bytes',async()=>{
 const f=fixture();const dir=mkdtempSync(join(tmpdir(),'album-invalid-'));
 try {
  writeFileSync(join(dir,'a.png'),'image');f.sdk.environments.get=async()=>({path:dir});await f.bridge.handle(f.input('bind'));await f.bridge.flush();f.sent.length=0;
  f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:`[Первый](${dir}/a.png) [Нет файла](${dir}/missing.png)`,deliveryId:'album_missing_001'});
  await f.bridge.flush();
  assert.equal(f.sent.filter(x=>['sendMediaGroup','sendPhoto','sendDocument'].includes(x.method)).length,0);
  assert.ok(f.sent.some(x=>x.text?.includes('missing.png') && !x.text.includes('не удалось')));
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});
test('confirmed album rate limit retries the group once without duplicate photos',async()=>{
 const f=fixture();const dir=mkdtempSync(join(tmpdir(),'album-rate-'));
 try {
  for(const name of ['a.png','b.png'])writeFileSync(join(dir,name),'image');
  f.sdk.environments.get=async()=>({path:dir});await f.bridge.handle(f.input('bind'));await f.bridge.flush();f.sent.length=0;
  f.failNextAlbum(new TelegramFailure('telegram_429',20,false));
  f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:`[Первый](${dir}/a.png) [Второй](${dir}/b.png)`,deliveryId:'album_rate_001'});
  await f.bridge.flush();
  assert.equal([...f.data.keys()].filter(k=>k.startsWith('chat:file:')).length,0);
  for(const [k,v] of f.data)if(k.startsWith('chat:out:')&&!v.sentId)f.data.set(k,{...v,retryAt:0});
  await f.bridge.flush();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.method==='sendMediaGroup').length,2);
  assert.equal(f.sent.filter(x=>x.method==='sendPhoto').length,0);
  assert.equal(f.bridge.explicitDeliveryStatus('album_rate_001').state,'delivered');
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('incomplete album acknowledgement stays uncertain and is never replayed',async()=>{
 const f=fixture();const dir=mkdtempSync(join(tmpdir(),'album-receipt-'));
 try {
  for(const name of ['a.png','b.png'])writeFileSync(join(dir,name),'image');
  f.sdk.environments.get=async()=>({path:dir});await f.bridge.handle(f.input('bind'));await f.bridge.flush();f.sent.length=0;
  f.malformedAlbum();
  f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:`[Первый](${dir}/a.png) [Второй](${dir}/b.png)`,deliveryId:'album_invalid_receipt'});
  await f.bridge.flush();await f.bridge.flush();
  assert.equal(f.sent.filter(x=>x.method==='sendMediaGroup').length,1);
  assert.ok([...f.data.entries()].filter(([k])=>k.startsWith('chat:file:')).every(([,v])=>v==='uncertain'));
 } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("concurrent delegations cannot skip a completed turn during worker cursor setup", async () => {
  const f = fixture();
  try {
    const parent = f.thread.id;
    const routes = new ReplyRoutes(f.store);
    const marker = routes.ingress(parent, {kind:"telegram", chatId:OWNER_ID, topicId:0, updateId:12});
    const request = {requestId:"parent-request", originPluginId:"telegram-projects", input:[marker]};
    routes.requested(parent, request);
    const child = {...f.thread, id:"reused-worker", parentThreadId:parent};
    f.sdk.threads.get = async () => child;
    let signalRead!: () => void;
    let resolveRead!: (events:any[]) => void;
    const pending = new Promise<void>(resolve => {signalRead = resolve;});
    const snapshot = new Promise<any[]>(resolve => {resolveRead = resolve;});
    let firstRead = true;
    f.sdk.threads.events.list = async (q:any) => {
      if (q.threadId === parent) return [{type:"client/turn/requested",data:request}];
      if (!firstRead) return [];
      firstRead = false;
      signalRead();
      return snapshot;
    };
    const args = {parentThreadId:parent, threadId:child.id, routeToken:marker.text.split(":")[1].split("]")[0], text:"research"};
    const delayed = f.bridge.sendDelegated({...args,deliveryId:"task-one"});
    await pending;
    await f.bridge.sendDelegated({...args,deliveryId:"task-two"});
    resolveRead([{seq:3,type:"turn/completed",scope:{kind:"turn",turnId:"two"},data:{status:"completed"}}]);
    await delayed;
    assert.equal(f.store.get("reply:child-cursor:" + child.id), 0);
    assert.equal(f.calls.filter(c => c[0] === "send").length, 2);
  } finally {f.cleanup();}
});

test("voice at the transcription limit preserves the final words in BB and Telegram", async () => {
  const transcript = "пример ".repeat(600) + "последние слова";
  const f = fixture(undefined, async () => transcript);
  try {
    await f.bridge.handle(f.input("hello"));
    const voice = {file_id:"audio",duration:600,file_size:15_000_000};
    const routed = routeUpdate({update_id:2,message:{message_id:2,message_thread_id:100,
      chat:{type:"private",id:OWNER_ID},from:{id:OWNER_ID},voice}},OWNER_ID);
    assert.ok(routed.kind === "chat" && routed.input.voice);
    await f.bridge.handle(routed.input);
    await f.bridge.flush();
    assert.equal(f.calls.find(c => c[0] === "send")[1].input[0].text,"Голосовое (10 мин 0 с): "+transcript);   // С56: length
    assert.ok(f.sent.some(m => m.text?.includes("последние слова")));
  } finally {f.cleanup();}
});

test("oversized voice stays a file and the owner is told after it is saved", async () => {
  const f = fixture(async () => ({path:"/inbox/voice.ogg",name:"voice.ogg",bytes:4242,sha256:"a".repeat(64)}));
  try {
    await f.bridge.handle(f.input("hello"));
    const routed = routeUpdate({update_id:2,message:{message_id:2,message_thread_id:100,
      chat:{type:"private",id:OWNER_ID},from:{id:OWNER_ID},voice:{file_id:"audio",duration:601,file_size:4242}}},OWNER_ID);
    assert.ok(routed.kind === "chat" && !routed.input.voice && routed.input.attachment?.kind === "voice");
    await f.bridge.handle(routed.input);
    await f.bridge.flush();
    assert.match(f.calls.find(c => c[0] === "send")[1].input[0].text,/\/inbox\/voice.ogg/);
    assert.equal(f.sent.filter(m => m.text?.includes("сохранено целиком")).length,1);
  } finally {f.cleanup();}
});

test("С79: a child report BB gave up on is handed over again silently; the person hears only when it surely will not come", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    const key = 'reply:child-report:' + JSON.stringify(['thr_one','worker','original-turn']);
    const marker = {type:"text",text:"fixture-receipt",visibility:"agent-only"};
    const route = {kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:19};
    f.store.put(key,{state:"submitting",startedAt:0,route,marker,turnId:"original-turn",threadId:"worker"});
    let state = "failed_retrying";
    f.sdk.threads.queuedMessages = {list:async()=>[{state,originPluginId:"telegram-projects",content:[marker]}]};
    await f.bridge.observe();
    assert.equal(f.data.get(key).state,"submitted");
    state = "failed_exhausted";
    for (let i=0;i<10;i++) {
      if (f.data.get(key)?.state==="failed-reported") break;
      f.store.put(key,{...f.data.get(key),startedAt:0});
      await f.bridge.observe();await f.bridge.flush();
    }
    const service = f.sent.filter(x=>/BB|тред|очеред|исчерпал/.test(x.text ?? ""));
    assert.equal(service.length,0,"no service words reach the person");
    assert.ok(f.calls.filter(c=>c[0]==="send").length>=1,"the result is handed over again");
    const lost = f.sent.filter(x=>x.text?.includes("Не получилось довести эту задачу"));
    assert.equal(lost.length,1);
    assert.equal(lost[0].message_thread_id,100);
    assert.equal(f.data.get(key).state,"failed-reported");
  } finally {f.cleanup();}
});

test("С79: a child report handed to the agent without a receipt stays silent", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    const key = 'reply:child-report:' + JSON.stringify(['thr_one','worker','original-turn']);
    const marker = {type:"text",text:"fixture-receipt",visibility:"agent-only"};
    const route = {kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:19};
    f.store.put(key,{state:"submitted",startedAt:0,route,marker,turnId:"original-turn",threadId:"worker"});
    f.sdk.threads.queuedMessages = {list:async()=>[]};
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.filter(x=>/BB|тред|Подтверждение/.test(x.text ?? "")).length,0);
    assert.equal(f.data.get(key).state,"uncertain-reported");
  } finally {f.cleanup();}
});

test("distinct completed turns may send identical text even under the same Telegram request", async () => {
  const f=fixture();
  try {
    await f.bridge.handle(f.input("Ask the worker"));
    const routes=new ReplyRoutes(f.store);
    const events=[];
    for (const [turnId,updateId] of [["initial",11],["receipt",11],["next",12]] as const) {
      routes.record("thr_one",turnId,{kind:"telegram",chatId:OWNER_ID,topicId:100,updateId});
      routes.accept("thr_one",turnId,turnId);
      const scope={kind:"turn",turnId};
      events.push({seq:events.length+1,type:"item/completed",scope,data:{item:{type:"agentMessage",text:"Worker result"}}});
      events.push({seq:events.length+1,type:"turn/completed",scope,data:{status:"completed"}});
      f.setEvents(events);
      await f.bridge.observe();await f.bridge.flush();
      assert.equal(f.sent.filter(m=>m.text==="Worker result").length,events.length / 2);
    }
  } finally {f.cleanup();}
});

for (const scenario of ["parent wait", "early acknowledgement", "another update", "reordered recovery",
    "cancelled delivery", "rejected delivery", "empty final", "interrupted turn", "premature claim", "no claim",
    "another child turn", "part receipt recovery", "another project worker"]) {
  test("delegated Telegram result: " + scenario, async () => {
    const f = fixture();
    try {
      const input = f.input("Delegate this request");
      await f.bridge.handle(input);
      const original = f.calls.find(c => c[0] === "spawn")[1].input[1];
      assert.match(original.text, /If your final answer includes the completed result/);
      const routes = new ReplyRoutes(f.store);
      const foreign = scenario === "another project worker";
      const child = {...f.thread, id:"thr_worker", parentThreadId:foreign ? null : f.thread.id, ...(foreign && {projectId:"proj_other"})};
      const threadScope = {kind:"thread"};
      const turnScope = (turnId: string) => ({kind:"turn", turnId});
      const parentScope = turnScope("parent-turn");
      const request = (seq: number, requestId: string, marker: object) => ({
        seq, type:"client/turn/requested", scope:threadScope,
        data:{requestId, originPluginId:"telegram-projects", input:[marker]},
      });
      const accept = (seq: number, requestId: string, scope: object) => ({
        seq, type:"turn/input/accepted", scope, data:{clientRequestId:requestId},
      });
      const answer = (seq: number, scope: object, text: string, createdAt = 250) => ({
        seq, createdAt, type:"item/completed", scope, data:{item:{type:"agentMessage", text}},
      });
      const complete = (seq: number, scope: object, createdAt: number, status = "completed") => ({
        seq, createdAt, type:"turn/completed", scope, data:{status},
      });
      const ownerEvents: any[] = [request(1,"owner",original), accept(2,"owner",parentScope)];
      const childEvents: any[] = [];
      f.sdk.threads.get = async ({threadId}: any) => threadId === child.id ? child : f.thread;
      f.sdk.threads.list = async () => foreign ? [] : [child];
      f.sdk.threads.events.list = async (q: any) => {
        const events = q.threadId === child.id ? childEvents : ownerEvents;
        const filtered = events.filter(e => (!q.types || q.types.includes(e.type)) && e.seq > Number(q.afterSeq ?? 0));
        return q.order === "desc" ? filtered.reverse().slice(0, Number(q.limit)) : filtered;
      };

      await f.bridge.observe();
      await f.bridge.sendDelegated({parentThreadId:f.thread.id, threadId:child.id,
        routeToken:original.text.match(/route:([^\]]+)/)[1], text:"Do the work", deliveryId:"delegation"});
      const delegated = f.calls.find(c => c[0] === "send" && c[1].threadId === child.id)[1].input[1];
      if (foreign) await assert.rejects(f.bridge.sendDelegated({parentThreadId:"thr_not_owner", threadId:child.id,
        routeToken:original.text.match(/route:([^\]]+)/)[1], text:"Do the work", deliveryId:"delegation-2"}),/delegation_parent_mismatch/,
        "only the owner's own conversation hands work to a thread that is not its child");
      const workerTurn = turnScope("worker-turn");
      childEvents.push(request(1,"worker",delegated), accept(2,"worker",workerTurn));

      const reports = () => f.calls.filter(c => c[0] === "send" && c[1].threadId === f.thread.id &&
        c[1].input[0].text.includes("конкретный ход"));
      let bridge = f.bridge;
      const childCompletes = () => childEvents.push(complete(3,workerTurn,200));
      if (scenario === "parent wait" || scenario === "another child turn") {
        childCompletes();
        if (scenario === "another child turn") {
          const another = routes.delegatedIngress(f.thread.id, original.text.match(/route:([^\]]+)/)[1], child.id);
          const secondTurn = turnScope("second-worker-turn");
          childEvents.push(request(4,"second-work",another),accept(5,"second-work",secondTurn),complete(6,secondTurn,210));
        }
        await bridge.observe();
        assert.equal(reports().length,0,"child event can arrive while coordinator is still waiting");
      }
      if (scenario === "another update") {
        ownerEvents.push(complete(3,parentScope,150));
        const next = routes.ingress(f.thread.id,{kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:2,messageId:2});
        ownerEvents.push(request(4,"different-owner-request",next),accept(5,"different-owner-request",turnScope("different-turn")));
      }
      const finalScope = scenario === "another update" ? turnScope("different-turn") : parentScope;
      const early = scenario === "early acknowledgement";
      const hasClaim = !early && scenario !== "no claim" && !foreign;
      ownerEvents.push(answer(ownerEvents.length+1,finalScope,
        (early ? "Work started" : scenario === "empty final" ? "" : "Coordinator wording") +
        (hasClaim ? "\n<!-- bb-telegram-child-result:thr_worker:worker-turn -->" : ""),
        early || scenario === "premature claim" ? 140 : 250));
      ownerEvents.push(complete(ownerEvents.length+1,finalScope,early ? 150 : 300,
        scenario === "interrupted turn" ? "interrupted" : "completed"));
      await bridge.observe();

      if (scenario === "reordered recovery" || scenario === "part receipt recovery") {
        const [outbox] = f.store.list<any>("chat:out:event:");
        await bridge.flush();
        assert.equal(f.sent.filter(m => m.text === "Coordinator wording").length, 1);
        if (scenario === "part receipt recovery") {
          // Simulate exit after saving the Telegram part receipt and before
          // committing the overall final receipt.
          f.store.put(outbox.key,outbox.value);
          f.store.del("reply:final-delivered:" + outbox.key);
        }
        await bridge.dispose();
        bridge = f.restart();
      }
      if (!childEvents.some(e => e.type === "turn/completed")) childCompletes();
      if (scenario === "parent wait") {
        f.failNextDelivery();
        await bridge.flush();
        await bridge.dispose();
        bridge = f.restart();
        await bridge.observe();
        assert.equal(reports().length,0,"a retrying delivery owns the same final");
      }
      for (const {key, value} of f.store.list<any>("chat:out:event:")) {
        if (scenario === "cancelled delivery") f.store.put(key,{...value,sentId:-1});
        else if (!value.sentId) f.store.put(key,{...value,retryAt:0});
      }
      if (scenario === "rejected delivery") f.failNextDelivery(new TelegramFailure("telegram_400"),2);
      await bridge.flush();
      if (scenario === "parent wait") {
        const seq = ownerEvents.length+1;
        ownerEvents.push({seq,type:"client/turn/requested",scope:threadScope,data:{
          requestId:"late-native-notice",initiator:"system",systemMessageKind:"child-completed",
          systemMessageSubject:{kind:"thread",threadId:child.id,outcomes:[{
            threadId:child.id,turnId:"worker-turn",status:"completed",
          }]},
        }},accept(seq+1,"late-native-notice",turnScope("late-notice-turn")),
        answer(seq+2,turnScope("late-notice-turn"),"Late duplicate wording"),
        complete(seq+3,turnScope("late-notice-turn"),350));
      }
      await bridge.observe(); await bridge.flush(); await bridge.observe();
      assert.ok(!f.sent.some(m => m.text === "Late duplicate wording"));
      assert.ok(f.sent.every(m => !m.text?.includes("bb-telegram-child-result")));
      if (["parent wait", "reordered recovery", "part receipt recovery"].includes(scenario)) {
        assert.equal(reports().length,0);
        assert.equal(f.sent.filter(m => m.text === "Coordinator wording" && m.reply_parameters?.message_id === 1).length,1);
      } else {
        assert.equal(reports().length,1);
        const report = reports()[0][1];
        assert.match(report.input[0].text, scenario === "another child turn" ? /ход second-worker-turn/ : /ход worker-turn/);
        const reportScope = turnScope("report-result");
        ownerEvents.push(request(ownerEvents.length+1,"synthetic",report.input[1]),
          accept(ownerEvents.length+2,"synthetic",reportScope),answer(ownerEvents.length+3,reportScope,"Worker wording"),
          complete(ownerEvents.length+4,reportScope,400));
        await bridge.observe(); await bridge.flush(); await bridge.observe(); await bridge.flush();
        assert.equal(f.sent.filter(m => m.text === "Worker wording" && m.reply_parameters?.message_id === 1).length,1);
      }
    } finally { f.cleanup(); }
  });
}

test("private project picker rejects a former group project even through a previously issued button",async()=>{
  const f=fixture();
  try {
    await f.bridge.handle(f.input("/project",777));
    const [key]=[...f.data].find(([k,v])=>k.startsWith("chat:button:") && v.kind==="project")!;
    f.store.put("group:project:proj_one",true);
    await f.bridge.handle({...f.input("",777),callback:"bb:"+key.slice(12)});
    assert.equal(f.store.get("chat:binding:777"),undefined);
    await f.bridge.handle(f.input("/project",778));
    assert.equal([...f.data.values()].some(v=>v?.kind==="project" && v.topicId===778),false);
    await f.bridge.handle(f.input("вопрос из личного чата",100));
    assert.equal(f.store.get("chat:binding:100"),undefined);
    assert.equal(f.calls.length,0);
  } finally {f.cleanup();}
});

for (const forwardFirst of [false,true]) test("quiet window bundles calendar request and forward: " + forwardFirst, async () => {
  const f=fixture(undefined,undefined,4000);
  try {
    const parts=forwardFirst ? ["Объявление 24 ноября","Поставь в календарь"] : ["Поставь в календарь","Объявление 24 ноября"];
    for (const text of parts) {
      const part={...f.input(text),forwarded:text.startsWith("Объявление")};
      f.bridge.accept(part);
      f.bridge.accept(part);
      await f.bridge.tick();
      assert.equal(f.calls.length,0);
    }
    for (const row of f.store.list<any>("chat:in:")) f.store.put(row.key,{...row.value,at:Date.now()-10_100});
    await f.bridge.tick(); await f.bridge.dispose();
    const tasks=f.calls.filter(c=>c[0]==="spawn");
    assert.equal(tasks.length,1);
    const prompt=tasks[0][1].input[0].text;
    assert.match(prompt,/^Пересланное:\nОбъявление 24 ноября\n\nВопрос пользователя:\nПоставь в календарь$/);
  } finally {f.cleanup();}
});

test("photos, files and recorded comment are prepared before a single agent request", async () => {
  const f=fixture(async input=>({path:"/inbox/"+input.attachment!.name,name:input.attachment!.name,bytes:8,sha256:"a".repeat(64)}),
    async()=>"Сравни оба материала",4000);
  try {
    await f.bridge.handle(f.input("start"));
    for (const name of ["photo.jpg","notes.pdf"])
      f.bridge.accept({...f.input(""),attachment:{fileId:name,name,mime:"application/octet-stream",size:8,kind:name==="photo.jpg"?"photo":"document"}});
    f.bridge.accept({...f.input(""),voice:{fileId:"v",mime:"audio/ogg",size:10,duration:60}});
    for (const row of f.store.list<any>("chat:in:")) f.store.put(row.key,{...row.value,at:Date.now()-4100});
    await f.bridge.tick(); await f.bridge.dispose();
    const sends=f.calls.filter(c=>c[0]==="send");
    assert.equal(sends.length,1);
    assert.match(sends[0][1].input[0].text,/photo\.jpg[\s\S]*notes\.pdf[\s\S]*Сравни оба материала/);
  } finally {f.cleanup();}
});

for (const explicit of [false,true]) test("a promise to send a file never holds the next message: " + explicit, async () => {
  const f=fixture(undefined,async()=>"Комментарий к посту",4000);
  try {
    await f.bridge.handle(f.input("start"));
    const first={...f.input(explicit ? "Подожди, сейчас пришлю аудио" : "Ссылка на материал"),sentAt:100};
    f.bridge.accept(first);
    const key="chat:in:"+first.updateId;
    f.store.put(key,{...f.store.get<any>(key),at:Date.now()-65_000});
    await f.bridge.tick();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.calls.filter(c=>c[0]==="send").length,1);
    const next={...f.input(""),voice:{fileId:"voice",mime:"audio/ogg",size:20,duration:60},sentAt:160};
    f.bridge.accept(next);
    const nextKey="chat:in:"+next.updateId;
    f.store.put(nextKey,{...f.store.get<any>(nextKey),at:Date.now()-4100});
    await f.bridge.tick(); await f.bridge.dispose();
    const sends=f.calls.filter(c=>c[0]==="send");
    assert.equal(sends.length,2);
    assert.ok(sends.every(s=>s[1].threadId==="thr_one"));
    assert.ok(sends.at(-1)[1].input[0].text.includes("Комментарий к посту"));
  } finally {f.cleanup();}
});

test("restart during batched voice preparation keeps both inputs and dispatches once", async () => {
  let release!: (value:string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;});
  const paused = new Promise<string>(resolve => {release=resolve;});
  const save = async () => ({path:"/inbox/p.jpg",name:"p.jpg",bytes:8,sha256:"a".repeat(64)});
  const f=fixture(save, async () => {entered(); return paused;}, 4000);
  const restored=fixture(save, async () => "Проверь фото",4000);
  try {
    await f.bridge.handle(f.input("start"));
    const photo={...f.input(""),attachment:{fileId:"p",name:"p.jpg",kind:"photo" as const,mime:"image/jpeg",size:8}};
    const voice={...f.input(""),voice:{fileId:"v",duration:60,size:10,mime:"audio/ogg"}};
    f.bridge.accept(photo);
    f.bridge.accept(voice);
    for (const row of f.store.list<any>("chat:in:")) f.store.put(row.key,{...row.value,at:Date.now()-4100});
    await f.bridge.tick();
    await started;
    f.abort(); release("Проверь фото");
    await f.bridge.dispose();
    assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
    for (const [k,v] of f.data) restored.store.put(k,v);
    restored.bridge.recover();
    restored.bridge.accept(voice);
    await restored.bridge.tick(); await restored.bridge.dispose();
    const tasks=restored.calls.filter(c=>c[0]==="send");
    assert.equal(tasks.length,1);
    assert.match(tasks[0][1].input[0].text,/p\.jpg[\s\S]*Проверь фото/);
    assert.equal(restored.store.list("chat:out:transcript:").length,1);
    assert.ok(restored.store.list<any>("chat:in:").every(row=>row.value.state==="done" && !row.value.parts));
  } finally {f.cleanup();restored.cleanup();}
});

test("later reply carries the selected Telegram quote from its own topic", async () => {
  const f=fixture();
  try {
    const chat={id:OWNER_ID,type:"private"};
    const msg={message_id:55,chat,from:{id:OWNER_ID},message_thread_id:100,text:"Запомни дату",quote:{text:"24 ноября"},
      reply_to_message:{message_id:32,chat,message_thread_id:100,text:"Вебинар 24 ноября в 19:30"}};
    const routed=routeUpdate({update_id:100,message:msg},OWNER_ID);
    assert.equal(routed.kind,"chat");
    if (routed.kind!=="chat") throw Error("missing input");
    await f.bridge.handle(routed.input);
    const task=f.calls.find(c=>c[0]==="spawn")[1].input[0].text;
    assert.ok(task.includes("Запомни дату") && task.includes("№ 32") && task.includes("search-history --message 32"));
    assert.ok(!task.includes("Вебинар") && !task.includes("24 ноября"), "С81: no quote text");
    const other=routeUpdate({update_id:101,message:{...msg,message_thread_id:200}},OWNER_ID);
    assert.ok(other.kind==="chat" && !other.input.replyExcerpt);
  } finally {f.cleanup();}
});

test("/work lists visible active children of the current binding without a model turn", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:100", {topicId:100, projectId:"proj_one", threadId:"thr_one", revision:"r", ready:true, cursor:0});
    const child = {...f.thread, parentThreadId:"thr_one", status:"active", id:"child", title:"PDF"};
    f.sdk.threads.list = async (args: any) => {
      assert.equal(args.parentThreadId, "thr_one");
      if (args.offset === 0) return Array.from({length:100}, (_, i) => ({...child, id:"idle"+i, status:"idle"}));
      assert.equal(args.offset, 100);
      return [child, {...child, id:"follow", status:"pending", title:"Follow-up"}, {...child, visibility:"hidden", title:"Hidden"},
        {...child, parentThreadId:"other", title:"Other"}, {...child, status:"idle", title:"Idle"}];
    };
    await f.bridge.handle(f.input("/work"));
    const queued = f.store.list<any>("chat:out:").map(row => row.value.text);
    assert.deepEqual(queued, ["В работе — PDF\nВ очереди — Follow-up"]);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("two rate-limited Telegram requests each get an addressed status; only the retried request gets its final",async()=>{
  const f=fixture();
  try {
    const requests=["A","B"];
    const originals=[];
    const events:any[]=[];
    const add=(type:string,turnId:string,data:any)=>events.push({seq:100+events.length,type,scope:{kind:"turn",turnId},data});
    for (const id of requests) {
      const input={...f.input(id),messageId:id==="A"?510:820};
      originals.push(input.messageId);
      await f.bridge.handle(input);
      const submitted=f.calls.at(-1)![1];
      add("client/turn/requested",id,{requestId:id,originPluginId:"telegram-projects",input:submitted.input});
      add("turn/input/accepted",id,{clientRequestId:id});
      add("provider/error",id,{errorInfo:{category:"rate-limit"}});
      add("turn/completed",id,{status:"failed"});
    }
    const submittedCalls=f.calls.length;
    f.sdk.threads.queue={list:async()=>[{id:"retry-B",state:"scheduled",sendAt:Date.now()+60000,
      payload:{kind:"retry",retryOfTurnRequestId:"B"}}]};
    add("client/turn/requested","B-retry",{requestId:"retry-B",retryOfRequestId:"B"});
    add("turn/input/accepted","B-retry",{clientRequestId:"retry-B"});
    add("item/completed","B-retry",{item:{type:"agentMessage",text:"A-INTERMEDIATE"}});
    add("item/completed","B-retry",{item:{type:"agentMessage",text:"B-FINAL"}});
    add("turn/completed","B-retry",{status:"completed"});
    f.setEvents(events);
    await f.bridge.observe(); await f.bridge.flush();
    await f.bridge.observe(); await f.bridge.flush();
    const statuses=f.sent.filter(m=>m.text?.startsWith("⚠️ Помощник"));
    assert.deepEqual(statuses.map(m=>m.reply_parameters?.message_id),originals);
    assert.match(statuses[0].text,/не запланирован/);
    assert.match(statuses[1].text,/МСК/);
    assert.ok(statuses.every(m=>m.text.includes("лимит модели")));
    assert.deepEqual(f.sent.filter(m=>m.text==="B-FINAL").map(m=>m.reply_parameters.message_id),[820]);
    assert.ok(!f.sent.some(m=>m.text?.includes("A-INTERMEDIATE")));
    assert.equal(f.calls.length,submittedCalls);
  } finally {f.cleanup();}
});

test("delegated worker result returns to Telegram after its own child notices and follow-ups join the turn", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Research"));
    const marker = f.calls.find(c => c[0] === "spawn")[1].input[1];
    const token = marker.text.match(/route:([^\]]+)/)[1];
    const threadScope={kind:"thread"};
    f.setEvents([
      {seq:1,type:"client/turn/requested",scope:threadScope,data:{requestId:"original",originPluginId:"telegram-projects",input:[marker]}},
      {seq:2,type:"turn/input/accepted",scope:{kind:"turn",turnId:"parent-turn"},data:{clientRequestId:"original"}},
    ]);
    await f.bridge.observe();
    const child={...f.thread,id:"child",parentThreadId:"thr_one"};
    f.sdk.threads.get=async ({threadId}:any)=>threadId==="child"?child:f.thread;
    f.sdk.threads.events.list=async(q:any)=>q.threadId === "thr_one" ? [
      {seq:1,type:"client/turn/requested",data:{requestId:"original",originPluginId:"telegram-projects",input:[marker]}}
    ] : [];
    const base={parentThreadId:"thr_one",threadId:"child",routeToken:token};
    await f.bridge.sendDelegated({...base,text:"Research",deliveryId:"work-1"});
    await f.bridge.sendDelegated({...base,text:"Addition A",deliveryId:"work-2"});
    await f.bridge.sendDelegated({...base,text:"Addition B",deliveryId:"work-3"});
    const sends=f.calls.filter(c=>c[0]==="send" && c[1].threadId==="child");
    assert.equal(sends.length,3);
    const m=(i:number)=>sends[i][1].input[1];
    const grandchildNotice=(seq:number,id:string)=>({seq,type:"client/turn/requested",scope:threadScope,data:{requestId:id,
      initiator:"system",systemMessageKind:"child-completed",senderThreadId:null,
      systemMessageSubject:{kind:"thread",threadId:"helper-"+id,threadName:"Helper",outcomes:[{threadId:"helper-"+id,turnId:"h",status:"completed"}]}}});
    f.sdk.threads.list=async()=>[child];
    const t7={kind:"turn",turnId:"t7"};
    const childEvents=[
      {seq:1,type:"client/turn/requested",scope:threadScope,data:{requestId:"work",originPluginId:"telegram-projects",input:[m(0)]}},
      {seq:2,type:"turn/input/accepted",scope:t7,data:{clientRequestId:"work"}},
      grandchildNotice(3,"g1"),{seq:4,type:"turn/input/accepted",scope:t7,data:{clientRequestId:"g1"}},
      grandchildNotice(5,"g2"),{seq:6,type:"turn/input/accepted",scope:t7,data:{clientRequestId:"g2"}},
      {seq:7,type:"client/turn/requested",scope:threadScope,data:{requestId:"tell",initiator:"agent",senderThreadId:"thr_one",input:[{type:"text",text:"owner answered"}]}},
      {seq:8,type:"turn/input/accepted",scope:t7,data:{clientRequestId:"tell"}},
      {seq:9,type:"turn/completed",scope:t7,data:{status:"completed"}},
      {seq:10,type:"client/turn/requested",scope:threadScope,data:{requestId:"add-a",originPluginId:"telegram-projects",input:[m(1)]}},
      {seq:11,type:"turn/input/accepted",scope:{kind:"turn",turnId:"t25"},data:{clientRequestId:"add-a"}},
      {seq:12,type:"turn/completed",scope:{kind:"turn",turnId:"t25"},data:{status:"completed"}},
    ];
    const parentCompleted = [{seq:3,type:"turn/completed",scope:{kind:"turn",turnId:"parent-turn"},data:{status:"completed"}}];
    f.sdk.threads.events.list=async (q:any)=>(q.threadId==="child"?childEvents:parentCompleted).filter(e=>e.seq>Number(q.afterSeq??0));
    await f.bridge.observe(); await f.bridge.observe(); await f.bridge.observe();
    const reports = f.calls.filter(c => c[0] === "send" && c[1].threadId === "thr_one" && c[1].input[0].text.includes("конкретный ход"));
    assert.deepEqual(reports.map(r => r[1].input[0].text.match(/ход (\S+)/)[1]).sort(), ["t25","t7"]);
    assert.ok(reports.every(r => !r[1].input[0].text.includes("несколько отдельных сообщений")));
    const receipt = reports.find(r => r[1].input[0].text.includes("ход t7"))[1].input[1];
    const scope = {kind:"turn",turnId:"receipt-turn"};
    const parentEvents = [
      {seq:4,type:"client/turn/requested",scope:threadScope,data:{requestId:"receipt",originPluginId:"telegram-projects",input:[receipt]}},
      {seq:5,type:"turn/input/accepted",scope,data:{clientRequestId:"receipt"}},
      {seq:6,type:"item/completed",scope,data:{item:{type:"agentMessage",text:"WORKER-T7-RESULT"}}},
      {seq:7,type:"turn/completed",scope,data:{status:"completed"}},
    ];
    f.sdk.threads.events.list=async(q:any)=>(q.threadId==="child"?childEvents:parentEvents).filter(e=>e.seq>Number(q.afterSeq??0));
    await f.bridge.observe(); await f.bridge.flush();
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.text?.includes("WORKER-T7-RESULT")).length,1);
  } finally {f.cleanup();}
});

for (const order of ["forward-first","question-first"]) test("forwarded photo post and the owner's question typed 5 s later form one task: " + order, async () => {
  const f=fixture(async input=>({path:"/inbox/"+input.attachment!.name,name:input.attachment!.name,bytes:8,sha256:"a".repeat(64)}),undefined,4000);
  try {
    await f.bridge.handle(f.input("start"));
    const forward={...f.input("Новость канала о бета-версии"),forwarded:true,sentAt:order==="forward-first"?100:105,
      attachment:{fileId:"p",name:"photo-1.jpg",mime:"image/jpeg",size:8,kind:"photo" as const}};
    const question={...f.input("Как это попробовать?"),sentAt:order==="forward-first"?105:100};
    const [a,b]=order==="forward-first"?[forward,question]:[question,forward];
    f.bridge.accept(a);
    // 4.1 s after a forward the bridge still waits for the owner's comment.
    f.store.put("chat:in:"+a.updateId,{...f.store.get<any>("chat:in:"+a.updateId),at:Date.now()-4100});
    await f.bridge.tick();
    if (order==="forward-first") assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
    if (order==="forward-first") {
      f.bridge.accept(b);
      for (const row of f.store.list<any>("chat:in:")) if (row.value.state==="pending") f.store.put(row.key,{...row.value,at:Date.now()-4100});
      await f.bridge.tick(); await f.bridge.dispose();
      const sends=f.calls.filter(c=>c[0]==="send");
      assert.equal(sends.length,1);
      assert.match(sends[0][1].input[0].text,/^Пересланное:\nНовость канала о бета-версии[\s\S]*photo-1\.jpg[\s\S]*\n\nВопрос пользователя:\nКак это попробовать\?$/);
    } else {
      // The question went alone after its 4 s window; the forward arrives while
      // that turn is running and joins it under the question's route.
      await f.bridge.dispose();
      const first=f.calls.filter(c=>c[0]==="send");
      assert.equal(first.length,1);
      assert.equal(first[0][1].mode,"queue-if-active");
      const marker=first[0][1].input[1];
      f.sdk.threads.events.list=async()=>[
        {seq:12,type:"turn/input/accepted",scope:{kind:"turn",turnId:"q-turn"},data:{clientRequestId:"q-req"}},
        {seq:11,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"q-req",originPluginId:"telegram-projects",input:[marker]}},
      ];
      await f.bridge.handle(b);
      const sends=f.calls.filter(c=>c[0]==="send");
      assert.equal(sends.length,2);
      assert.equal(sends[1][1].mode,"steer-if-active");
      assert.match(sends[1][1].input[0].text,/^Пересланное \(дополнение к сообщению пользователя выше, это одно поручение\):\n/);
      const id=sends[1][1].input[1].text.match(/route:([^\]]+)/)[1];
      assert.equal(f.store.get<any>("reply:ingress:"+id).route.updateId,question.updateId);
    }
  } finally {f.cleanup();}
});

for (const running of [true,false]) test("late question joins the running forward turn only while it runs: " + running, async () => {
  const f=fixture();
  try {
    await f.bridge.handle(f.input("start"));
    const forward={...f.input("Пост канала"),forwarded:true,sentAt:200};
    await f.bridge.handle(forward);
    const marker=f.calls.filter(c=>c[0]==="send").at(-1)[1].input[1];
    f.sdk.threads.events.list=async()=>[
      {seq:21,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"f-req",originPluginId:"telegram-projects",input:[marker]}},
      {seq:22,type:"turn/input/accepted",scope:{kind:"turn",turnId:"f-turn"},data:{clientRequestId:"f-req"}},
      ...(running ? [] : [{seq:23,type:"turn/completed",scope:{kind:"turn",turnId:"f-turn"},data:{status:"completed"}}]),
    ];
    const question={...f.input("Как это попробовать?"),sentAt:215};
    await f.bridge.handle(question);
    const send=f.calls.filter(c=>c[0]==="send").at(-1)[1];
    assert.equal(send.mode,running ? "steer-if-active" : "queue-if-active");
    assert.equal(send.input[0].text.startsWith("Вопрос пользователя к пересланному выше"),running);
    const id=send.input[1].text.match(/route:([^\]]+)/)[1];
    assert.equal(f.store.get<any>("reply:ingress:"+id).route.updateId,running ? forward.updateId : question.updateId);
    // An unrelated message long after the forward is never merged.
    await f.bridge.handle({...f.input("Другая задача"),sentAt:400});
    assert.equal(f.calls.filter(c=>c[0]==="send").at(-1)[1].mode,"queue-if-active");
  } finally {f.cleanup();}
});

test("П5: a message that follows the owner's text while that turn runs joins it, not a second request", async () => {
  const f=fixture();
  try {
    await f.bridge.handle(f.input("start"));
    const first={...f.input("Посмотри, что не так на странице"),sentAt:300};
    await f.bridge.handle(first);
    const marker=f.calls.filter(c=>c[0]==="send").at(-1)[1].input[1];
    f.sdk.threads.events.list=async()=>[
      {seq:31,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"t-req",originPluginId:"telegram-projects",input:[marker]}},
      {seq:32,type:"turn/input/accepted",scope:{kind:"turn",turnId:"t-turn"},data:{clientRequestId:"t-req"}},
    ];
    await f.bridge.handle({...f.input("вот снимок"),sentAt:309});
    const send=f.calls.filter(c=>c[0]==="send").at(-1)[1];
    assert.equal(send.mode,"steer-if-active");
    assert.match(send.input[0].text,/^Дополнение к сообщению пользователя выше \(пришло следом/);
    // The bridge's own admission hook lets its follow-up join the running turn (it used to queue it as a new turn).
    const ctx:any={thread:f.thread,attempt:"join-turn",initiator:"user",originPluginId:"telegram-projects",queuedMessages:[],input:{blocks:send.input}};
    assert.equal((await f.bridge.admitDispatch(ctx)).action,"proceed");
  } finally {f.cleanup();}
});

test("С48: an agent's message joining a group thread busy with a Telegram task is acknowledged to its sender", async () => {
  const f=fixture();
  try {
    f.store.put("group:in:5:900",{state:"submitted",route:{threadId:"thr_group"}});
    const ctx:any={thread:{id:"thr_group",title:"Тема"},attempt:"join-turn",initiator:"agent",senderThreadId:"thr_sender",origin:null,originPluginId:null,queuedMessages:[],input:{blocks:[]}};
    assert.equal((await f.bridge.admitDispatch(ctx)).action,"proceed");
    await new Promise(r=>setTimeout(r,10));
    assert.equal(f.calls.filter(([k,q]:any)=>k==="send" && q.threadId==="thr_sender").length,1);
  } finally {f.cleanup();}
});

test("П5: a follow-up waits for the first message's turn that is still starting, then joins it", async () => {
  setFollowupStartWait(5);
  const f=fixture();
  try {
    await f.bridge.handle(f.input("start"));
    const first={...f.input("Выполни шаги"),sentAt:500};
    await f.bridge.handle(first);
    const marker=f.calls.filter(c=>c[0]==="send").at(-1)[1].input[1];
    f.thread.status="active";
    let calls=0;
    f.sdk.threads.events.list=async()=>(++calls<2) ? [
      {seq:41,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"s-req",originPluginId:"telegram-projects",input:[marker]}},
    ] : [
      {seq:41,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"s-req",originPluginId:"telegram-projects",input:[marker]}},
      {seq:42,type:"turn/input/accepted",scope:{kind:"turn",turnId:"s-turn"},data:{clientRequestId:"s-req"}},
    ];
    await f.bridge.handle({...f.input("и ещё одно"),sentAt:506});
    const send=f.calls.filter(c=>c[0]==="send").at(-1)[1];
    assert.equal(send.mode,"steer-if-active");
    assert.match(send.input[0].text,/^Дополнение к сообщению пользователя выше/);
  } finally {f.cleanup(); setFollowupStartWait(2500);}
});

test("explicit delivery sends relative and empty-label images, videos and files[] like a routed answer", async () => {
  const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'explicit-media-'));
  try {
    writeFileSync(join(dir,'mac-overlay-v3-typing.jpg'),'image');
    writeFileSync(join(dir,'demo.mp4'),'video');
    writeFileSync(join(dir,'report.pdf'),'pdf');
    f.sdk.environments.get=async()=>({path:dir});
    await f.bridge.handle(f.input('bind')); await f.bridge.flush(); f.sent.length=0;
    const text='Итог проверки.\n\n![](mac-overlay-v3-typing.jpg)\n\n[Запись экрана](demo.mp4)\n\n[README](missing.md) и [сайт](https://example.com/a.png)';
    const args={threadId:'thr_one',topicId:100,text,files:[join(dir,'report.pdf')],deliveryId:'explicit_media_001'};
    f.bridge.sendExplicit(args); await f.bridge.flush();
    assert.deepEqual(f.sent.filter(x=>x.method==='sendPhoto').map(x=>x.photo_filename),['mac-overlay-v3-typing.jpg']);
    const videos=f.sent.filter(x=>x.method==='sendVideo');
    assert.deepEqual(videos.map(x=>[x.video_filename,x.caption,x.supports_streaming]),[['demo.mp4','Запись экрана',true]]);
    assert.deepEqual(f.sent.filter(x=>x.method==='sendDocument').map(x=>x.document_filename),['report.pdf']);
    const message=f.sent.filter(x=>x.method==='sendMessage').map(x=>x.text).join('\n');
    assert.match(message,/Итог проверки/);
    assert.ok(!message.includes('mac-overlay-v3-typing.jpg') && !message.includes('demo.mp4') && !message.includes('!['));
    assert.match(message,/README/);
    assert.equal(f.bridge.explicitDeliveryStatus(args.deliveryId).state,'delivered');
    // Idempotent by deliveryId: a retry sends nothing again; different files conflict.
    const before=f.sent.length;
    f.bridge.sendExplicit(args); await f.bridge.flush();
    assert.equal(f.sent.length,before);
    assert.throws(()=>f.bridge.sendExplicit({...args,files:[join(dir,'demo.mp4')]}),/conflict/);
  } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test("explicit files[] alone form an album; unsafe or unknown paths are refused or reported", async () => {
  const f=fixture(); const dir=mkdtempSync(join(tmpdir(),'explicit-files-')); const outside=mkdtempSync(join(tmpdir(),'outside-'));
  try {
    for (const name of ['a.png','b.png']) writeFileSync(join(dir,name),'image');
    mkdirSync(join(outside,'.secrets'));writeFileSync(join(outside,'.secrets','secret.png'),'image');
    f.sdk.environments.get=async()=>({path:dir});
    await f.bridge.handle(f.input('bind')); await f.bridge.flush(); f.sent.length=0;
    f.bridge.sendExplicit({threadId:'thr_one',topicId:100,files:[join(dir,'a.png'),join(dir,'b.png')],deliveryId:'explicit_files_001'});
    await f.bridge.flush();
    assert.equal(f.sent.find(x=>x.method==='sendMediaGroup').media.length,2);
    assert.equal(f.sent.filter(x=>x.method==='sendMessage').length,0);
    assert.throws(()=>f.bridge.sendExplicit({threadId:'thr_one',topicId:100,deliveryId:'explicit_files_002'}),/invalid/);
    assert.throws(()=>f.bridge.sendExplicit({threadId:'thr_one',topicId:100,files:['relative.png'],deliveryId:'explicit_files_003'}),/invalid/);
    // Any file type goes as a document; the workspace and size checks decide at delivery.
    assert.doesNotThrow(()=>f.bridge.sendExplicit({threadId:'thr_one',topicId:100,files:[join(dir,'run.sh')],deliveryId:'explicit_files_004'}));
    f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:'Вот',files:[join(outside,'.secrets','secret.png')],deliveryId:'explicit_files_005'});
    f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:'И это ![](../'+outside.split('/').pop()+'/.secrets/secret.png)',deliveryId:'explicit_files_006'});
    await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.method==='sendPhoto').length,0);
    assert.ok(f.sent.some(x=>x.method==='sendMessage' && x.text.includes('secret.png') && !x.text.includes('не удалось')),'only the name; a secret place is never attached');
  } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("a relative name matching files in two workspaces is left as text", async () => {
  const f=fixture(); const a=mkdtempSync(join(tmpdir(),'ws-a-')); const b=mkdtempSync(join(tmpdir(),'ws-b-'));
  try {
    writeFileSync(join(a,'shot.png'),'image'); writeFileSync(join(b,'shot.png'),'image');
    f.sdk.environments.get=async({environmentId}:any)=>({path:environmentId==='env_child'?b:a});
    await f.bridge.handle(f.input('bind')); await f.bridge.flush(); f.sent.length=0;
    f.sdk.threads.list=async()=>[{...f.thread,id:'child',parentThreadId:'thr_one',environmentId:'env_child'}];
    f.bridge.sendExplicit({threadId:'thr_one',topicId:100,text:'Скрин: ![](shot.png)',deliveryId:'explicit_ambiguous_1'});
    await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.method==='sendPhoto').length,0);
  } finally {f.cleanup();rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
});

test("Codex async forms reach the owner from the root, worker and nested worker", async () => {
  const f = fixture();
  try {
    const original = f.input("Choose an approach");
    await f.bridge.handle(original);
    const rootInput = f.calls.find(([name]) => name === "spawn")![1].input;
    const parentIds = new Map([["thr_one", null]]);
    const history = new Map<string, any[]>();
    const interactions = new Map<string, any[]>();
    const timestamp = Date.now() - 2000;
    const recordTurn = (threadId: string, input: any[], seq = 1, pluginId = "telegram-projects") => {
      const turnId = "turn-" + threadId + "-" + seq;
      const requestId = "request-" + turnId;
      const scope = {kind: "turn", turnId};
      const events = history.get(threadId) ?? [];
      events.push(
        {seq, createdAt: timestamp + seq, type: "client/turn/requested", data: {requestId, originPluginId:pluginId, input}},
        {seq:seq + 1, createdAt:timestamp + seq + 1, type:"turn/started", scope},
        {seq:seq + 2, createdAt:timestamp + seq + 2, type:"turn/input/accepted", scope, data:{clientRequestId:requestId}},
      );
      history.set(threadId, events);
      return {events, scope};
    };
    const showForm = (threadId: string, id: string, title: string, options: string[] | null, seq: number,
      {status = "pending", expiresAt = Date.now() + 60_000} = {}) => {
      const questions = [{title, options}];
      const form = {id, threadId, status, expiresAt, createdAt:timestamp + seq + 1, turnId:null,
        origin:{kind:"plugin", pluginId:"provider-codex", rendererId:"async-question"},
        payload:{kind:"plugin", title, data:{questions}}};
      history.get(threadId)!.push({seq, createdAt:timestamp + seq, type:"thread/extensionState/updated",
        scope:{kind:"thread"}, data:{kind:"provider-codex/async-question", payload:{itemId:"item-" + id, questions}}});
      interactions.set(threadId, [...(interactions.get(threadId) ?? []), form]);
      return form;
    };
    const thread = (id: string) => ({...f.thread, id, parentThreadId:parentIds.get(id)});
    f.sdk.threads.list = async ({parentThreadId}: any) =>
      [...parentIds].filter(([, parent]) => parent === parentThreadId).map(([id]) => thread(id));
    f.sdk.threads.get = async ({threadId}: any) => thread(threadId);
    f.sdk.threads.events.list = async ({threadId, types, afterSeq, beforeSeq, order, limit}: any) => {
      const events = (history.get(threadId) ?? []).filter(e => types.includes(e.type) &&
        e.seq > Number(afterSeq ?? 0) && e.seq < Number(beforeSeq ?? Infinity)).sort((a, b) => a.seq - b.seq);
      if (order === "desc") events.reverse();
      return events.slice(0, Number(limit));
    };
    f.sdk.threads.interactions.list = async ({threadId}: any) => interactions.get(threadId) ?? [];
    f.sdk.threads.interactions.get = async ({threadId, interactionId}: any) =>
      interactions.get(threadId)!.find(form => form.id === interactionId);
    f.sdk.threads.interactions.respond = async (args: any) => {
      const form = await f.sdk.threads.interactions.get(args);
      assert.equal(form.status, "pending");
      form.status = "resolved";
      f.calls.push(["respond", args]);
    };
    f.sdk.threads.spawn = async (args: any) => {
      const id = args.title;
      parentIds.set(id, args.parentThreadId);
      recordTurn(id, args.input);
      f.calls.push(["spawn", args]);
      return thread(id);
    };
    const token = (input: any[]) => input[1].text.match(/route:([^\]]+)/)[1];
    recordTurn("thr_one", rootInput);
    await f.bridge.spawnDelegated({parentThreadId:"thr_one", routeToken:token(rootInput),
      projectId:"proj_one", environmentId:"env_one", providerId:"codex",
      title:"worker", text:"Do work", deliveryId:"worker-form-test"});
    const workerInput = f.calls.filter(([name]) => name === "spawn").at(-1)![1].input;
    await f.bridge.spawnDelegated({parentThreadId:"worker", routeToken:token(workerInput),
      projectId:"proj_one", environmentId:"env_one", providerId:"codex",
      title:"nested", text:"Do nested work", deliveryId:"nested-form-test"});

    showForm("thr_one", "root", "Choose a direct answer", ["Alpha", "Beta"], 4);
    showForm("worker", "worker-form", "Choose a worker answer", ["Alpha", "Beta"], 4);
    showForm("nested", "nested-form", "Describe the nested result", null, 4);
    showForm("worker", "already-answered", "Already answered by coordinator", null, 6, {status:"resolved"});
    showForm("worker", "expired", "Expired question", null, 8, {expiresAt:Date.now() - 1});
    const aboutToClose = showForm("worker", "will-close", "Closed before delivery", null, 10);
    const willExpire = showForm("worker", "will-expire", "Expired before delivery", null, 12);
    const worker = history.get("worker")!;
    worker.push({seq:20, createdAt:timestamp + 20, type:"turn/completed", scope:{kind:"turn", turnId:"turn-worker-1"},
      data:{status:"completed"}});
    recordTurn("worker", [{type:"text", text:"Private BB work"}], 21, "provider-codex");
    showForm("worker", "private-bb", "A question from BB", ["private", "details"], 24);
    showForm("worker", "ambiguous-bb", "Repeated prompt", null, 26, {status:"resolved"});
    const rootAmbiguous = showForm("thr_one", "ambiguous-root", "Repeated prompt", null, 30);
    history.get("thr_one")!.push({seq:29, createdAt:timestamp + 29, type:"thread/extensionState/updated",
      scope:{kind:"thread"}, data:{kind:"provider-codex/async-question",
        payload:{itemId:"different-item", questions:rootAmbiguous.payload.data.questions}}});
    interactions.get("worker")!.push({id:"plugin-approval", threadId:"worker", status:"pending", turnId:null,
      origin:{kind:"plugin", pluginId:"provider-codex", rendererId:"macos-permission"},
      payload:{kind:"plugin", data:{questions:[{title:"Fake approval", options:["Allow"]}]}}});

    await f.bridge.observe();
    aboutToClose.status = "resolved";
    willExpire.expiresAt = Date.now() - 1;
    await f.bridge.flush();
    const cards = f.sent.filter(x => x.text?.includes("❓ Вопрос"));
    assert.equal(cards.length, 3);
    for (const card of cards) {
      assert.equal(card.message_thread_id, original.topicId);
      assert.equal(card.reply_parameters.message_id, original.messageId);
    }
    const restarted = f.restart();
    await restarted.observe();
    await restarted.flush();
    assert.equal(f.sent.filter(x => x.text?.includes("❓ Вопрос")).length, 3);

    // An ordinary Telegram message is still accepted while the root form is open.
    await restarted.handle(f.input("A separate message"));
    assert.ok(f.calls.some(([name, args]) => name === "send" && args.threadId === "thr_one"));
    const pressOption = async (prompt: string, label: string) => {
      const card = cards.find(x => x.text.includes(prompt));
      const button = card.reply_markup.inline_keyboard.flat().find((key: any) => key.text === label);
      await restarted.handle({...f.input(""), callback:button.callback_data});
    };
    await pressOption("Choose a direct answer", "Alpha");
    await pressOption("Choose a worker answer", "Beta");
    const nestedCard = f.store.list<any>("chat:question:100:").find(row => row.value.interactionId === "nested-form")!;
    await restarted.handle({...f.input("Use the existing plan"), replyTo:Number(nestedCard.key.split(":").at(-1))});
    assert.deepEqual(f.calls.filter(([name]) => name === "respond").map(([, args]) => args), [
      {threadId:"thr_one", interactionId:"root", value:{answers:{"question-1":{selected:["option-1"]}}}},
      {threadId:"worker", interactionId:"worker-form", value:{answers:{"question-1":{selected:["option-2"]}}}},
      {threadId:"nested", interactionId:"nested-form", value:{answers:{"question-1":{selected:[], freeText:"Use the existing plan"}}}},
    ]);
    await pressOption("Choose a worker answer", "Alpha");
    assert.equal(f.calls.filter(([name]) => name === "respond").length, 3);
    assert.equal(f.calls.filter(([name]) => name === "resolve").length, 0);
  } finally {f.cleanup();}
});

test("private chat and menu still work alongside shared forum roots and prove only the current original owner request",async()=>{
  const f=fixture();
  try {
    const projectId="proj_one";
    f.store.put("chat:binding:100",{topicId:100,projectId,threadId:"thr_one",revision:"private",ready:true,cursor:0});
    bindGroupTopic(f.store,{chatId:-1009876543,topicId:8,threadId:"forum-root",
      botId:2,botUsername:"fixture_bot",ownerId:OWNER_ID,ownerOnly:true,ownerSharedProject:true,requireMention:false},projectId);
    f.sdk.threads.experimental_listAncestors=async({threadIds}:any)=>({threads:threadIds.map((id:string)=>({
      threadId:id,ancestorIds:id==="forum-child"?["forum-root"]:[],
    }))});
    f.sdk.threads.list=async()=>[f.thread,{...f.thread,id:"forum-root"},{...f.thread,id:"forum-child"}];
    await f.bridge.projects(100);
    assert.ok(f.store.list<any>("chat:button:").some(({value})=>value.kind==="project" && value.arg===projectId));
    await f.bridge.handle(f.input("/menu"));
    await f.bridge.handle(f.input("/chats"));
    const inspect=f.store.list<any>("chat:button:").filter(({value})=>value.kind==="inspect");
    assert.deepEqual(inspect.map(({value})=>value.arg),["thr_one"]);
    const text="Создай тему Приёмка и напиши туда Начинаем.";
    const dm=routeUpdate({update_id:900,message:{message_id:900,chat:{id:OWNER_ID,type:"private"},
      from:{id:OWNER_ID},message_thread_id:100,text}},OWNER_ID);
    assert.equal(dm.kind,"chat");
    if (dm.kind!=="chat") throw Error("private ingress rejected");
    await f.bridge.handle(dm.input);
    const [,send]=f.calls.find(([kind])=>kind==="send");
    assert.equal(send.threadId,"thr_one");
    const token=send.input[1].text.match(/bb-telegram-reply-route:([a-f0-9-]+)/)[1];
    const request={type:"client/turn/requested",seq:1,data:{originPluginId:"telegram-projects",requestId:"req",input:send.input}};
    const accepted={type:"turn/input/accepted",seq:2,data:{clientRequestId:"req"},scope:{kind:"turn",turnId:"turn"}};
    const events:any[]=[accepted,request];
    f.sdk.threads.events.list=async(options:any)=>events.filter(e=>!options.types || options.types.includes(e.type));
    assert.deepEqual(await f.bridge.proveOwnerForumRequest("thr_one",token,OWNER_ID),{key:"private:"+token,text});
    events.unshift({type:"turn/completed",seq:3,scope:accepted.scope,data:{status:"completed"}});
    await assert.rejects(f.bridge.proveOwnerForumRequest("thr_one",token,OWNER_ID),/current_owner_request_required/);
    events.shift();
    const forged=new ReplyRoutes(f.store).ingress("thr_one",{kind:"telegram",chatId:OWNER_ID,topicId:100,updateId:88});
    const forgedToken=forged.text.match(/bb-telegram-reply-route:([a-f0-9-]+)/)![1];
    await assert.rejects(f.bridge.proveOwnerForumRequest("thr_one",forgedToken,OWNER_ID),/original_owner_text_required/);
  } finally {f.cleanup();}
});

for (const primary of ["bb", "telegram"]) test("busy owner can receive a reply during " + primary + " work", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Start"));
    const scope = {kind:"turn", turnId:"long-turn"};
    const routes = new ReplyRoutes(f.store);
    if (primary === "telegram") f.acceptTelegramTurn(scope.turnId);
    else {
      routes.requested("thr_one", {requestId:"original", initiator:"user"});
      routes.accept("thr_one", scope.turnId, "original");
    }
    f.thread.status = "active";
    const question = f.input("What has finished?");
    await f.bridge.handle(question);
    const send = f.calls.filter(c => c[0] === "send").at(-1)[1];
    assert.equal(send.mode, "steer-if-active");
    const label = /\[telegram-answer:([a-f0-9-]+)\]/.exec(send.input.at(-1).text)![1];
    const ctx:any = {thread:f.thread, attempt:"join-turn", initiator:"user", originPluginId:"telegram-projects",
      queuedMessages:[], input:{blocks:send.input}};
    assert.equal((await f.bridge.admitDispatch(ctx)).action, "proceed");
    assert.equal((await f.bridge.admitDispatch({...ctx, originPluginId:null})).action, "wait");
    const reply = (text:string, seq:number, turn=scope) =>
      ({seq, type:"item/completed", scope:turn, data:{item:{type:"agentMessage", text}}});
    f.setEvents([
      {seq:1, type:"client/turn/requested", scope:{kind:"thread"}, data:{
        requestId:"owner-question", originPluginId:"telegram-projects", input:send.input}},
      {seq:2, type:"turn/input/accepted", scope, data:{clientRequestId:"owner-question"}},
      reply("[telegram-answer:" + label + "]\nUnrelated turn\n[/telegram-answer]", 3, {kind:"turn",turnId:"other"}),
      reply("[telegram-answer:" + label + "]\nYour answer\n[/telegram-answer]", 4),
      reply("Original result", 5),
    ]);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.text === "Your answer").length, 1);
    assert.equal(f.sent.find(x => x.text === "Your answer")?.reply_parameters?.message_id, question.messageId);
    assert.equal(f.sent.some(x => x.text?.includes("Unrelated turn")), false);
    assert.equal(routes.destination("thr_one", scope.turnId)?.kind, primary);
    f.setEvents([{seq:6, type:"turn/completed", scope, data:{status:"completed"}}]);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.filter(x => x.text === "Original result").length, primary === "telegram" ? 1 : 0);
    assert.equal(f.sent.filter(x => x.text === "Your answer").length, 1);
  } finally { f.cleanup(); }
});

for (const final of ["NO_REPLY", " \nNO_REPLY\t ", "\n \t"]) {
  test(`paired busy reply survives a silent final and restart: ${JSON.stringify(final)}`, async () => {
    const f = fixture();
    try {
      f.store.put("chat:binding:0", {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
      f.thread.status = "active";
      const question = f.input("Как продвигается работа?", 0);
      await f.bridge.handle(question);
      const dispatch = f.calls.filter(c => c[0] === "send").at(-1)?.[1];
      assert.equal(dispatch.mode, "steer-if-active");
      const label = /\[telegram-answer:([a-f0-9-]+)\]/.exec(dispatch.input.at(-1).text)![1];
      const scope = {kind:"turn",turnId:"busy-final"};
      const assistant = (seq:number, text:string) => ({seq,type:"item/completed",scope,data:{item:{type:"agentMessage",text}}});
      const wrapped = (body:string) => `[telegram-answer:${label}]\n${body}\n[/telegram-answer]`;
      const answer = "Последняя проверка закончилась.";
      f.thread.status = "idle";
      f.setEvents([
        {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"busy-check",originPluginId:"telegram-projects",input:dispatch.input}},
        {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"busy-check"}},
        ...(!final.trim() ? [assistant(3, wrapped(" NO_REPLY "))] : []),
        assistant(4, wrapped(answer)),
      ]);
      await f.bridge.observe();
      await f.bridge.flush();

      f.setEvents([
        assistant(5, final),
        {seq:6,type:"turn/completed",scope,data:{status:"completed"}},
      ]);
      const restarted = f.restart();
      await restarted.observe();
      await restarted.flush();
      await restarted.observe();
      await restarted.flush();
      const sent = f.sent.filter(m => m.method === "sendMessage");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, answer);
      const outbox = f.store.list<{taskRoute?:{chatId:number;messageId?:number};sentId?:number}>("chat:out:event:paired:");
      assert.equal(outbox.length, 1);
      assert.ok(outbox[0].value.sentId);
      assert.equal(outbox[0].value.taskRoute?.chatId, OWNER_ID);
      assert.equal(outbox[0].value.taskRoute?.messageId, question.messageId);
      assert.equal(sent[0].message_thread_id, undefined);
      assert.equal(sent[0].reply_parameters?.message_id, question.messageId);
    } finally { f.cleanup(); }
  });
}

for (const final of ["NO_REPLY", " \nNO_REPLY\t ", "\n \t", "В логе указан NO_REPLY."]) {
  test(`paired idle reply preserves meaningful text only: ${JSON.stringify(final)}`, async () => {
    const f = fixture();
    try {
      f.store.put("chat:binding:0", {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
      const input = f.input("NO_REPLY", 0);
      await f.bridge.handle(input);
      const dispatch = f.calls.filter(c => c[0] === "send").at(-1)?.[1];
      assert.equal(dispatch.mode, "queue-if-active");
      assert.ok(dispatch.input.some((block: {text?:string}) => block.text === input.text));
      const scope = {kind:"turn",turnId:"ordinary-final"};
      f.setEvents([
        {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"idle-check",originPluginId:"telegram-projects",input:dispatch.input}},
        {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"idle-check"}},
        {seq:3,type:"item/completed",scope,data:{item:{type:"agentMessage",text:final}}},
      ]);
      await f.bridge.observe();
      f.setEvents([{seq:4,type:"turn/completed",scope,data:{status:"completed"}}]);
      const restarted = f.restart();
      await restarted.observe();
      await restarted.flush();
      await restarted.observe();
      await restarted.flush();
      const sent = f.sent.filter(m => m.method === "sendMessage");
      const expected = final.startsWith("В логе") ? [final] : [];
      assert.deepEqual(sent.map(m => m.text), expected);
      if (expected.length)
        assert.equal(sent[0].reply_parameters?.message_id, input.messageId);
    } finally { f.cleanup(); }
  });
}

for (const busy of [false,true]) for (const kind of ["html","photo-caption","photo-bare"] as const) {
  test(`one addressed private artifact (${busy?"busy":"ordinary"}, ${kind}) keeps reply and caption`,async()=>{
    const f=fixture();
    const dir=mkdtempSync(join(tmpdir(),"paired-addressed-file-"));
    try {
      const isPhoto=kind!=="html", name=isPhoto?"sample.png":"sample.html", path=join(dir,name);
      const data=isPhoto
        ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64")
        : Buffer.from("<!doctype html>\n<p>Synthetic sample</p>\n");
      writeFileSync(path,data);
      f.sdk.environments.get=async()=>({path:dir});
      f.store.put("chat:binding:0",{topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
      const scope={kind:"turn",turnId:"current"};
      const routes=new ReplyRoutes(f.store);
      const oldRoute={kind:"telegram" as const,chatId:OWNER_ID,topicId:0,updateId:70,messageId:80};
      if (busy) {
        f.thread.status="active";
        const original=routes.ingress("thr_one",oldRoute);
        routes.requested("thr_one",{requestId:"earlier",originPluginId:"telegram-projects",input:[original]});
        routes.accept("thr_one",scope.turnId,"earlier");
      }

      const input=f.input("Return the sample.",0);
      await f.bridge.handle(input);
      const dispatch=f.calls.filter(c=>c[0]==="send").at(-1)?.[1];
      assert.ok(dispatch);
      assert.equal(dispatch.mode,busy?"steer-if-active":"queue-if-active");
      const caption=kind==="photo-caption"?"Нейтральная подпись":undefined;
      const markup=kind==="html"?`[${name}](${path} "telegram:document")`:
        caption?(busy?`[${caption}](${path})`:`${caption}\n\n![](${path})`):`![](${path})`;
      const wrapped=busy?dispatch.input.at(-1).text.match(/telegram-answer:([a-f0-9-]+)/)?.[1]:undefined;
      if (busy) assert.ok(wrapped);
      const response=wrapped?`[telegram-answer:${wrapped}]\n${markup}\n[/telegram-answer]`:markup;
      const events=[
        {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"probe",originPluginId:"telegram-projects",input:dispatch.input}},
        {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"probe"}},
        {seq:3,type:"item/completed",scope,data:{item:{type:"agentMessage",text:response}}},
        ...(busy?[
          {seq:4,type:"item/completed",scope,data:{item:{type:"agentMessage",text:response}}}
        ]:[{seq:4,type:"turn/completed",scope,data:{status:"completed"}}]),
      ];
      f.setEvents(events);
      await f.bridge.observe();
      await f.bridge.flush();
      await f.restart().flush();
      const sent=f.sent.filter(event=>["sendMessage","sendPhoto","sendDocument"].includes(event.method));
      assert.equal(sent.length,1);
      const outgoing=sent[0], field=isPhoto?"photo":"document";
      assert.equal(outgoing.method,isPhoto?"sendPhoto":"sendDocument");
      assert.equal(outgoing.chat_id,OWNER_ID);
      assert.equal(outgoing.message_thread_id,undefined);
      assert.deepEqual(outgoing.reply_parameters,{message_id:input.messageId,allow_sending_without_reply:false});
      assert.equal(outgoing.caption,caption);
      assert.equal(outgoing[field+"_filename"],name);
      assert.deepEqual(Buffer.from(await outgoing[field].arrayBuffer()),data);
      if (!isPhoto) assert.equal(outgoing.disable_content_type_detection,true);
      if (busy) assert.deepEqual(routes.destination("thr_one",scope.turnId),oldRoute);
      const receipts=[...f.data].filter(([key,value])=>key.startsWith("chat:file:") && typeof value==="number");
      assert.equal(receipts.length,1);
    } finally {f.cleanup();rmSync(dir,{recursive:true,force:true});}
  });
}

test("a busy reply can recover an exact selector with two pending requests and one receipt after restart", async () => {
  const f = fixture();
  try {
    f.store.put("chat:binding:0", {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
    f.thread.status = "active";
    const inputs = [f.input("Что со сборкой?", 0), f.input("Что с отчётом?", 0)];
    for (const input of inputs) await f.bridge.handle(input);
    const dispatches = f.calls.filter(call => call[0] === "send").map(call => call[1]);
    assert.deepEqual(dispatches.map(d => d.mode), ["steer-if-active", "steer-if-active"]);
    const selectors = dispatches.map(d => /\[telegram-answer:([a-f0-9]{8})\]/.exec(d.input.at(-1).text)![1]);
    assert.notEqual(selectors[0], selectors[1]);

    const routes = new ReplyRoutes(f.store);
    const foreign = "1decbe44-a1d3-43ed-b714-6bc35e6f5871";
    routes.record("thr_one", "another-request", {kind:"telegram",chatId:OWNER_ID,topicId:0,updateId:88,messageId:99});
    routes.accept("thr_one", "another-turn", "another-request");
    f.store.put("reply:busy-answer:" + foreign, "another-request");
    assert.ok(routes.busyAnswer("thr_one", "another-turn", foreign));

    const scope = {kind:"turn",turnId:"current"};
    const assistant = (seq:number, selector:string, body:string) => ({
      seq,type:"item/completed",scope,
      data:{item:{type:"agentMessage",text:`[telegram-answer:${selector}]\n${body}\n[/telegram-answer]`}},
    });
    // Pick a real one-character typo that cannot equal either pending code.
    const typo = [..."0123456789abcdef"].map(digit => selectors[1].slice(0, 7) + digit)
      .find(candidate => !selectors.includes(candidate))!;
    const events = [
      ...dispatches.flatMap((d, index) => [
        {seq:index*2+1,type:"client/turn/requested",scope:{kind:"thread"},
          data:{requestId:"check-"+index,originPluginId:"telegram-projects",input:d.input}},
        {seq:index*2+2,type:"turn/input/accepted",scope,data:{clientRequestId:"check-"+index}},
      ]),
      assistant(5, typo, "Отчёт готов."),
      assistant(6, foreign, "Отчёт готов."),
    ];
    f.thread.status = "idle";
    f.setEvents(events);
    await f.bridge.observe();
    await f.bridge.flush();
    assert.equal(f.sent.filter(m => m.method === "sendMessage").length, 0);
    assert.equal(f.store.list("chat:out:event:paired:busy-request:").length, 0);

    const exact = assistant(7, selectors[1], "Отчёт готов.");
    f.setEvents([...events, exact, {seq:8,type:"turn/completed",scope,data:{status:"completed"}}]);
    await f.restart().observe();
    await f.restart().flush();
    const deliveryWatch = f.store.get<{cursor:number}>("reply:watch:paired")!;
    f.store.put("reply:watch:paired", {...deliveryWatch,cursor:6});
    await f.restart().observe(); // Re-observe the same event from the persisted ledger.
    await f.restart().flush();

    const sends = f.sent.filter(m => m.method === "sendMessage");
    assert.deepEqual(sends.map(m => [m.text, m.reply_parameters?.message_id]), [["Отчёт готов.", inputs[1].messageId]]);
    const outboxKey = "chat:out:event:paired:busy-request:" + selectors[1];
    const receipt = f.store.get<{sentId:number;taskRoute:{updateId:number;messageId:number}}>(outboxKey)!;
    assert.ok(receipt.sentId > 0);
    assert.equal(f.store.get("chat:receipt:" + outboxKey + ":0"), receipt.sentId);
    assert.equal(receipt.taskRoute.updateId, inputs[1].updateId);
    assert.equal(receipt.taskRoute.messageId, inputs[1].messageId);
    assert.equal(f.store.list("chat:out:event:paired:busy-request:").length, 1);
  } finally { f.cleanup(); }
});

test("a UUID issued before the short-selector upgrade remains deliverable in exactly its accepted turn", async () => {
  const f = fixture();
  try {
    const binding = {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0};
    f.store.put("chat:binding:0", binding);
    const routes = new ReplyRoutes(f.store);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const token = "22222222-2222-4222-8222-222222222222";
    const input = f.input("Какой статус?", 0);
    const marker = routes.ingress("thr_one", {kind:"telegram",chatId:OWNER_ID,topicId:0,
      updateId:input.updateId,messageId:input.messageId}, undefined, undefined, undefined, token);
    f.store.put("reply:busy-ingress:" + token, uuid);
    const root = {kind:"turn",turnId:"legacy-turn"};
    const result = `[telegram-answer:${uuid}]\nСборка закончилась.\n[/telegram-answer]`;
    f.setEvents([
      {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"legacy",originPluginId:"telegram-projects",input:[marker]}},
      {seq:2,type:"turn/input/accepted",scope:root,data:{clientRequestId:"legacy"}},
      {seq:3,type:"item/completed",scope:{...root,turnId:"foreign-turn"},data:{item:{type:"agentMessage",text:result}}},
      {seq:4,type:"item/completed",scope:root,
        data:{item:{type:"agentMessage",text:result.replace(uuid, uuid.slice(0,-1)+"0")}}},
    ]);
    await f.bridge.observe();
    await f.bridge.flush();
    assert.equal(f.sent.filter(m => m.method === "sendMessage").length, 0);
    f.setEvents([{seq:5,type:"item/completed",scope:root,data:{item:{type:"agentMessage",text:result}}}]);
    await f.restart().observe();
    await f.restart().flush();
    assert.deepEqual(f.sent.filter(m => m.method === "sendMessage").map(m => [m.text, m.reply_parameters?.message_id]),
      [["Сборка закончилась.", input.messageId]]);
  } finally { f.cleanup(); }
});

for (const outcome of ["saved", "wrong-selector", "conflicting", "unknown-receipt", "rebound"] as const) {
  test(`native completion recovers a saved busy reply without starting a turn: ${outcome}`, async () => {
    const f = fixture();
    try {
      const binding = {topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0};
      f.store.put("owner:id", OWNER_ID);
      f.store.put("chat:binding:0", binding);
      f.thread.status = "active";
      const inputs = [f.input("Статус сборки?", 0),f.input("Статус отчёта?", 0)];
      for (const input of inputs) await f.bridge.handle(input);
      const dispatched = f.calls.filter(call => call[0] === "send").map(call => call[1]);
      const labels = dispatched.map(d => /\[telegram-answer:([a-f0-9]{8})\]/.exec(d.input.at(-1).text)![1]);
      const scope = {kind:"turn",turnId:"original"};
      const output = (seq:number, label:string, body:string) => ({
        seq,type:"item/completed",scope,data:{item:{type:"agentMessage",text:
          `[telegram-answer:${label}]\n${body}\n[/telegram-answer]`}},
      });
      const before = [
        ...dispatched.flatMap((d,index) => [
          {seq:2*index+1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"ack-"+index,
            originPluginId:"telegram-projects",target:{kind:"steer",expectedTurnId:scope.turnId},input:d.input}},
          {seq:2*index+2,type:"turn/input/accepted",scope,data:{clientRequestId:"ack-"+index}},
        ]),
        output(5,labels[0],"Сборка готова."),
      ];
      f.thread.status = "idle";
      f.setEvents(before);
      await f.bridge.observe();
      await f.bridge.flush();
      const label = outcome === "wrong-selector" ? "33333333-3333-4333-8333-333333333333" : labels[1];
      const completed = [output(6,label,"Отчёт готов."),
        ...(outcome === "conflicting" ? [output(7,label,"Отчёт ещё готовится.")] : []),
        {seq:8,type:"turn/completed",scope,data:{status:"completed"}}];
      if (outcome === "rebound") f.store.put("chat:binding:0",{...binding,revision:"changed"});
      f.setEvents([...before,...completed]);
      const restarted=f.restart();
      await restarted.observe();
      if (outcome === "unknown-receipt") f.failNextDelivery(new TelegramFailure("telegram_network",0,true));
      await restarted.flush();
      const watch=f.store.get<{cursor:number}>("reply:watch:paired")!;
      f.store.put("reply:watch:paired",{...watch,cursor:0});
      await f.restart().observe();
      await f.restart().flush();
      const sends=f.sent.filter(m => m.method==="sendMessage");
      const uncertain=outcome==="unknown-receipt", rebound=outcome==="rebound";
      const status=outcome==="wrong-selector" || outcome==="conflicting";
      assert.deepEqual(sends.map(m=>[m.reply_parameters?.message_id,m.text]),[
        [inputs[0].messageId,"Сборка готова."],
        ...(uncertain || rebound ? [] : [[inputs[1].messageId,status ?
          "Не уверен, что ответ дошёл, — проверьте, пожалуйста." : "Отчёт готов."]]),
      ]);
      const rows=f.store.list<{taskRoute:{messageId:number};busyExact:string;evidence:{completedSeq?:number;itemSeq?:number}}>("chat:out:busy-exact:");
      assert.equal(rows.length,rebound?1:2);
      const recovered=rows.find(row=>row.value.taskRoute.messageId===inputs[1].messageId)?.value;
      if (!rebound) {
        assert.equal(recovered?.busyExact,uncertain?"unknown":"sent");
        assert.equal(recovered?.evidence.completedSeq,8);
        assert.equal(recovered?.evidence.itemSeq,status?undefined:6);
      }
      assert.equal(f.calls.filter(call=>call[0]==="send").length,2);
    } finally {f.cleanup();}
  });
}

test("an existing busy reply from 0.9.44 prevents replay under a new event sequence",async()=>{
  const f=fixture();
  try {
    f.store.put("chat:binding:0",{topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
    const routes=new ReplyRoutes(f.store);
    const scope={kind:"turn",turnId:"ongoing"};
    f.thread.status="active";
    routes.requested("thr_one",{requestId:"bb-task"});
    routes.accept("thr_one",scope.turnId,"bb-task");
    const input=f.input("Check file.",0);
    await f.bridge.handle(input);
    const dispatch=f.calls.filter(c=>c[0]==="send").at(-1)?.[1];
    const label=dispatch.input.at(-1).text.match(/telegram-answer:([a-f0-9-]+)/)[1];
    f.store.put("chat:out:event:paired:busy:30",{ownerId:OWNER_ID,topicId:0,text:"",sentId:388,at:1,retryAt:0,
      taskRoute:{kind:"telegram",chatId:OWNER_ID,topicId:0,updateId:input.updateId,messageId:input.messageId}});
    f.setEvents([
      {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"probe",originPluginId:"telegram-projects",input:dispatch.input}},
      {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"probe"}},
      {seq:31,type:"item/completed",scope,data:{item:{type:"agentMessage",
        text:`[telegram-answer:${label}]\nDuplicate response\n[/telegram-answer]`}}},
    ]);
    await f.bridge.observe(); await f.bridge.flush();
    assert.equal(f.sent.some(x=>x.text?.includes("Duplicate response")),false);
    assert.equal(f.store.list("chat:out:event:paired:").length,1);
  } finally {f.cleanup();}
});

test("a configured private thread captures only original owner input for group publication",async()=>{
  const f=fixture(undefined,undefined,0,(thread,owner)=>thread==="thr_one" && owner===OWNER_ID);
  try {
    f.store.put("chat:binding:100",{topicId:100,projectId:"proj_one",threadId:"thr_one",revision:"private",ready:true,cursor:0});
    const original=(id:number,extra:Record<string,unknown>={})=>routeUpdate({update_id:id,message:{
      message_id:id,chat:{id:OWNER_ID,type:"private"},from:{id:OWNER_ID},message_thread_id:100,
      text:"Предложи ответ в рабочей группе.",...extra,
    }},OWNER_ID);
    const handle=async(route:ReturnType<typeof original>)=>{
      assert.equal(route.kind,"chat");
      if (route.kind!=="chat") throw Error("private ingress rejected");
      await f.bridge.handle(route.input);
      const [,send]=f.calls.findLast(([kind])=>kind==="send")!;
      const token=send.input[1].text.match(/bb-telegram-reply-route:([a-f0-9-]+)/)[1];
      const request={type:"client/turn/requested",seq:1,data:{originPluginId:"telegram-projects",requestId:"req",input:send.input}};
      const accepted={type:"turn/input/accepted",seq:2,data:{clientRequestId:"req"},scope:{kind:"turn",turnId:"turn"}};
      f.sdk.threads.events.list=async(options:any)=>[accepted,request].filter(e=>!options.types || options.types.includes(e.type));
      return token;
    };
    const token=await handle(original(120));
    const proof=await f.bridge.proveOwnerForumRequest("thr_one",token,OWNER_ID);
    assert.equal(proof.text,"Предложи ответ в рабочей группе.");
    const forwarded=await handle(original(121,{forward_origin:{type:"user",sender_user:{id:8},date:1}}));
    await assert.rejects(f.bridge.proveOwnerForumRequest("thr_one",forwarded,OWNER_ID),/original_owner_text_required/);
  } finally {f.cleanup();}
});

for (const busy of [false,true]) for (const kind of ["photo","document"] as const) {
  test(`paired ${kind} album in ${busy?"busy":"ordinary"} turn has three ordered positions and one addressed result`,async t=>{
    let now=Date.now();
    t.mock.method(Date,"now",()=>now);
    const root=mkdtempSync(join(tmpdir(),"paired-album-"));
    const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
    const bytesFor=(index:number)=>kind==="photo" ? pixel : Buffer.from("inert fixture "+index);
    const ext=kind==="photo"?"png":"txt";
    const receives:number[]=[];
    const f=fixture(async input=>{
      const bytes=bytesFor(input.messageId);
      const name="asset-"+input.messageId+"."+ext;
      const path=join(root,name);
      writeFileSync(path,bytes);
      receives.push(input.messageId);
      return {name,path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    });
    try {
      f.store.put("bot:id",5);
      f.store.put("chat:binding:0",{topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
      f.sdk.environments.get=async()=>({path:root});
      const scope={kind:"turn",turnId:"current"};
      const routes=new ReplyRoutes(f.store);
      if (busy) {
        f.thread.status="active";
        const original=routes.ingress("thr_one",{
          kind:"telegram",chatId:OWNER_ID,topicId:0,messageId:8,updateId:8,
        });
        routes.requested("thr_one",{requestId:"prior",originPluginId:"telegram-projects",input:[original]});
        routes.accept("thr_one",scope.turnId,"prior");
      }
      const message=(id:number,updateId:number)=>({
        update_id:updateId,message:{chat:{type:"private",id:OWNER_ID},from:{id:OWNER_ID},message_id:id,
          media_group_id:"demo-album",...(id===11 && {caption:"Compare the three items."}),
          ...(kind==="photo" ? {photo:[{file_id:id===12?"distinct":"same",width:40,height:30}]} :
            {document:{file_id:id===12?"distinct":"same",file_name:"input.txt",file_size:5}})},
      });
      const accept=(id:number,updateId:number)=>{
        const parsed=routeUpdate(message(id,updateId),OWNER_ID);
        assert.equal(parsed.kind,"chat");
        f.bridge.accept(parsed.input);
      };
      accept(13,103);accept(11,101);accept(13,103);
      now+=2700; // No consumer has run, so the album remains open.
      accept(12,102);
      const ordinary=f.input("Adjacent stand-alone message",0);
      f.bridge.accept(ordinary);
      await f.bridge.tick();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(f.calls.filter(c=>c[0]==="send").length,1);
      now+=3000;
      await f.bridge.tick();
      for(let attempt=0;attempt<30 && f.calls.filter(c=>c[0]==="send").length<2;attempt++)
        await new Promise(resolve=>setTimeout(resolve,5));
      const dispatches=f.calls.filter(c=>c[0]==="send").map(c=>c[1]);
      assert.equal(dispatches.length,2);
      assert.deepEqual(receives,[11,12,13]);
      const dispatch=dispatches[1];
      assert.equal(dispatch.mode,busy?"steer-if-active":"queue-if-active");
      assert.match(dispatch.input[0].text,/Элемент 1[\s\S]*asset-11[\s\S]*Элемент 2[\s\S]*asset-12[\s\S]*Элемент 3[\s\S]*asset-13/);
      assert.equal(dispatch.input.filter((block:any)=>block.type==="image").length,kind==="photo"?3:0);
      assert.doesNotMatch(dispatch.input[0].text,/Adjacent/);

      // In the fixture the model's answer is injected as a BB event. Actual model
      // acceptance and ordinal reasoning are checked separately on the local stand.
      const markdown=[11,12,13].map(id=>`[Caption ${id}](${root}/asset-${id}.${ext})`).join("\n")+"\nNeighboring text.";
      const label=busy ? dispatch.input.at(-1).text.match(/telegram-answer:([a-f0-9-]+)/)?.[1] : undefined;
      const text=label?`[telegram-answer:${label}]\n${markdown}\n[/telegram-answer]`:markdown;
      f.setEvents([
        {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"album-request",originPluginId:"telegram-projects",input:dispatch.input}},
        {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"album-request"}},
        {seq:3,type:"item/completed",scope,data:{item:{type:"agentMessage",text}}},
        ...(busy ? [{seq:4,type:"item/completed",scope,data:{item:{type:"agentMessage",text}}}]
          : [{seq:4,type:"turn/completed",scope,data:{status:"completed"}}]),
      ]);
      await f.bridge.observe();await f.bridge.flush();
      const restarted=f.restart();
      if (busy) {
        // The album response is already confirmed when the original turn finishes.
        f.thread.status="idle";
        const final=kind==="photo" ? " \nNO_REPLY\t " : "\n \t";
        f.setEvents([
          {seq:5,type:"item/completed",scope,data:{item:{type:"agentMessage",text:final}}},
          {seq:6,type:"turn/completed",scope,data:{status:"completed"}},
        ]);
        await restarted.observe();
      }
      await restarted.flush();
      const sends=f.sent.filter(event=>["sendMediaGroup","sendMessage"].includes(event.method));
      assert.equal(sends.length,2);
      const [album,neighbor]=sends;
      assert.equal(album.method,"sendMediaGroup");
      assert.equal(album.chat_id,OWNER_ID);
      assert.deepEqual(album.reply_parameters,{message_id:11,allow_sending_without_reply:false});
      assert.deepEqual(album.media.map((m:any)=>[m.type,m.caption]),[11,12,13].map(id=>[kind,"Caption "+id]));
      for(const [index,id] of [11,12,13].entries())
        assert.deepEqual(Buffer.from(await album["media"+index].arrayBuffer()),bytesFor(id));
      assert.equal(neighbor.text,"Neighboring text.");
      accept(13,103);accept(14,104);
      await f.bridge.tick(); await f.bridge.flush(); await f.restart().flush();
      assert.equal(f.sent.filter(event=>event.method==="sendMediaGroup").length,1);
      const warning=f.sent.filter(event=>event.text?.includes("дополнительный элемент"));
      assert.equal(warning.length,1);
      assert.equal(warning[0].reply_parameters?.message_id,11);
    } finally {f.cleanup();rmSync(root,{recursive:true,force:true});}
  });
}

test("paired copy commands pin the source topic and never replay a partial copy",async()=>{
  const f=fixture();
  try {
    f.store.put("bot:id",5);
    f.store.put("chat:binding:100",{topicId:100,projectId:"proj_one",threadId:"thr_one",revision:"r",cursor:0,ready:true});
    const at=Date.now();
    f.store.put(`paired:album-copy:5:${OWNER_ID}:100:r:11`,{
      messageIds:[11,12,13],albumKey:"sealed-album",expires:at+60_000,
      files:[{kind:"photo",data:"same",caption:"First"},{kind:"photo",data:"other"},{kind:"photo",data:"same"}],
    });
    const cmd={...f.input("/copyalbum",100),replyTo:12};
    await f.bridge.handle(cmd);
    await f.restart().handle({...cmd});
    await f.bridge.flush();
    const copies=f.sent.filter(row=>row.method==="copyMessages");
    assert.equal(copies.length,1);
    assert.equal(copies[0].from_chat_id,OWNER_ID);
    assert.equal(copies[0].chat_id,OWNER_ID);
    assert.equal(copies[0].message_thread_id,100);
    assert.deepEqual(copies[0].message_ids,[11,12,13]);
    assert.equal(copies[0].reply_parameters,undefined);
    assert.match(f.sent.find(row=>row.method==="sendMessage").text,/только часть/);
    const addressed={...f.input("/replyalbum",100),replyTo:12};
    await f.bridge.handle(addressed); await f.bridge.handle(addressed);
    const replies=f.sent.filter(row=>row.method==="sendMediaGroup");
    assert.equal(replies.length,1);
    assert.deepEqual(replies[0].media.map((item:any)=>item.media),["same","other","same"]);
    assert.equal(replies[0].reply_parameters.message_id,12);
    assert.equal(replies[0].message_thread_id,100);
    f.store.put("chat:binding:101",{topicId:101,projectId:"proj_one",threadId:"thr_one",revision:"r",cursor:0,ready:true});
    await f.bridge.handle({...f.input("/replyalbum",101),replyTo:12});
    assert.equal(f.sent.filter(row=>row.method==="sendMediaGroup").length,1);
  } finally {f.cleanup();}
});

test("late unique occurrence suppresses an album result still waiting in the outbox",async t=>{
  let now=Date.now();
  t.mock.method(Date,"now",()=>now);
  const f=fixture();
  try {
    f.store.put("bot:id",5);
    f.store.put("chat:binding:0",{topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"scope",ready:true,cursor:0});
    const part=(id:number):ChatInput=>({ownerId:OWNER_ID,chatId:OWNER_ID,topicId:0,messageId:id,updateId:id,
      albumId:"source-album",attachment:{fileId:"same",mime:"text/plain",name:"input.txt",kind:"document",size:2}});
    f.bridge.accept(part(31));f.bridge.accept(part(32));
    now+=2700;
    await f.bridge.tick();
    f.store.put("chat:out:event:scope:completed",{ownerId:OWNER_ID,topicId:0,text:"Apparently already finished",at:now,retryAt:0,
      taskRoute:{kind:"telegram",chatId:OWNER_ID,topicId:0,updateId:31,messageId:31}});
    f.bridge.accept(part(32)); // Ordinary replay.
    f.bridge.accept(part(33)); // A new occurrence; the file ID is deliberately unchanged.
    await f.bridge.flush();await f.restart().flush();
    assert.ok(!f.sent.some(event=>event.text==="Apparently already finished"));
    const warning=f.sent.filter(row=>row.text?.includes("дополнительный элемент"));
    assert.equal(warning.length,1);
    assert.equal(warning[0].reply_parameters.message_id,31);
    assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
  } finally {f.cleanup();}
});

async function nativeBusyEvents(f:ReturnType<typeof fixture>, input:ChatInput, result:string) {
  f.store.put("owner:id",OWNER_ID);
  f.store.put("chat:binding:0",{topicId:0,projectId:"proj_one",threadId:"thr_one",revision:"paired",ready:true,cursor:0});
  f.thread.status="active";
  await f.bridge.handle(input);
  const send=f.calls.find(call=>call[0]==="send")[1];
  const tag=send.input.at(-1).text.match(/telegram-answer:([a-f0-9]{8})/)?.[1];
  assert.ok(tag);
  const scope={kind:"turn",turnId:"native-busy"};
  f.thread.status="idle";
  const response=`[telegram-answer:${tag}]\n${result}\n[/telegram-answer]`;
  const events=[
    {seq:1,type:"client/turn/requested",scope:{kind:"thread"},data:{
      requestId:"test-native-request",originPluginId:"telegram-projects",input:send.input,
      target:{kind:"steer",expectedTurnId:scope.turnId},
    }},
    {seq:2,type:"turn/input/accepted",scope,data:{clientRequestId:"test-native-request"}},
    {seq:3,type:"item/completed",scope,data:{item:{type:"agentMessage",text:response}}},
    {seq:4,type:"turn/completed",scope,data:{status:"completed"}},
  ];
  f.setEvents(events);
  return events;
}

for (const kind of ["photo","document"] as const) test(`lost ${kind} receipt stays on the normal file route through recovery and restart`,async()=>{
  const f=fixture();
  const root=mkdtempSync(join(tmpdir(),"native-busy-file-"));
  try {
    const name=kind==="photo"?"fixture.png":"fixture.txt";
    const file=join(root,name);
    const bytes=kind==="photo"
      ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64")
      : Buffer.from("Inert document.\n");
    writeFileSync(file,bytes);
    f.sdk.environments.get=async()=>({path:root});
    const method=kind==="photo"?"sendPhoto":"sendDocument";
    f.loseReceiptFor(method);
    const input=f.input("Верни приложенный образец.",0);
    await nativeBusyEvents(f,input,`[Fixture](${file})`);
    await f.bridge.observe();await f.bridge.flush();
    const restarted=f.restart();
    await restarted.observe();await restarted.flush();await restarted.flush();
    const files=f.sent.filter(row=>row.method===method);
    assert.equal(files.length,1);
    assert.equal(files[0].reply_parameters.message_id,input.messageId);
    assert.deepEqual(Buffer.from(await files[0][kind].arrayBuffer()),bytes);
    assert.equal(f.store.list("chat:out:busy-exact:").length,0);
    assert.ok(f.store.list("chat:file:").some(row=>row.value==="uncertain"));
    assert.equal(f.calls.filter(call=>call[0]==="send" && !/Файл не приложен/.test(call[1].input?.[0]?.text ?? "")).length,1);
    assert.ok(f.calls.some(call=>call[0]==="send" && /доставка не подтверждена/.test(call[1].input?.[0]?.text ?? "")),"the agent learns the delivery is unconfirmed");
  } finally {f.cleanup();rmSync(root,{recursive:true,force:true});}
});

test("a native busy request with an explicit silent reply does not create a recovery notice",async()=>{
  const f=fixture();
  try {
    const input=f.input("Не отвечай.",0);
    await nativeBusyEvents(f,input," NO_REPLY ");
    await f.bridge.observe();await f.bridge.flush();await f.restart().flush();
    assert.equal(f.sent.filter(row=>row.method==="sendMessage").length,0);
    assert.equal(f.store.list("chat:out:busy-exact:").length,0);
  } finally {f.cleanup();}
});

test("a late album part stops saved busy text already queued in the shared outbox",async()=>{
  const f=fixture();
  try {
    const input=f.input("Проверь порядок вложений.",0);
    const albumKey="fixture-late-album";
    f.store.put("chat:in:"+input.updateId,{input:{...input,albumKey},state:"done",at:Date.now()});
    await nativeBusyEvents(f,input,"Порядок проверен.");
    await f.bridge.observe();
    const exact=f.store.list<{busyExact:string}>("chat:out:busy-exact:");
    assert.equal(exact.length,1);
    assert.equal(exact[0].value.busyExact,"queued");
    f.store.put(albumKey,{changed:true});
    await f.bridge.flush();await f.restart().flush();
    assert.equal(f.sent.filter(row=>row.method==="sendMessage").length,0);
    assert.equal(f.store.get<{busyExact:string}>(exact[0].key)?.busyExact,"cancelled");
    assert.equal(f.calls.filter(call=>call[0]==="send" && !/Файл не приложен/.test(call[1].input?.[0]?.text ?? "")).length,1);
  } finally {f.cleanup();}
});

test("С79: a message BB queues behind a busy turn gets no service line in the chat", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("first"));
    f.sdk.threads.send = async (a: any) => { f.calls.push(["send", a]); return {delivery:"queued"}; };
    await f.bridge.handle({...f.input("second"),updateId:2,messageId:2});
    await f.bridge.flush();
    assert.equal(f.sent.filter(x=>/очеред|BB/.test(x.text ?? "")).length,0);
  } finally {f.cleanup();}
});

test("#5: a free answer to a form question reaches the agent; an option named in words is chosen", async () => {
  const f = fixture();
  try {
    await f.bridge.handle(f.input("Run"));
    f.acceptTelegramTurn('question-turn');
    const q = {
      id: "q", turnId: "question-turn", status: "pending",
      payload: {kind: "user_question", questions: [
        {id: "q1", prompt: "Когда созвон?", allowFreeText: true, multiSelect: false, options: [{label: "До обеда", value: "am"}, {label: "После обеда", value: "pm"}]},
        {id: "q2", prompt: "Кого позвать?", allowFreeText: false, multiSelect: false, options: [{label: "Анну", value: "anna"}]},
      ]},
    };
    f.setQuestions([q]);
    await f.bridge.observe();
    await f.bridge.flush();
    const record = f.store.list<any>("chat:question:")[0];
    assert.ok(record);
    const replyTo = Number(record.key.split(":").at(-1));
    await f.bridge.handle({ ...f.input("Давай завтра в три, Анну не зовём"), replyTo });
    const resolved = f.calls.filter((x) => x[0] === "resolve");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0][1].resolution.answers.q1.freeText, "Давай завтра в три, Анну не зовём");
    assert.deepEqual(resolved[0][1].resolution.answers.q2, {selected: []}, "a choice-only question does not get the words");
    assert.ok(!f.sent.some((m: any) => /выбери кнопку/.test(m.text ?? "")));
  } finally {
    f.cleanup();
  }
});
