import { ReplyRoutes } from "../reply-routing";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridge, inputSchema, splitText, type ChatInput } from "../chat";
import { TelegramFailure, type Store } from "../model";
const OWNER_ID = 259034221;
function fixture(receiveAttachment?: (input: ChatInput, threadId: string) => Promise<{path: string; name: string; bytes: number; sha256: string}>) {
  const data = new Map<string, any>();
  const calls: any[] = [];
  const sent: any[] = [];
  let message = 10;
  let failDelivery = false;
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
  const bridge = new ChatBridge({
    store,
    sdk,
    tg: async (method, payload) => {
      if (failDelivery) {
        failDelivery = false;
        throw new TelegramFailure("telegram_429", 20, false);
      }
      sent.push({ method, ...payload });
      return { message_id: ++message } as any;
    },
    spool: dir,
    owner: () => OWNER_ID,
    baseUrl: "https://bb.example",
    signal: controller.signal,
    rich: () => false,
    receiveAttachment,
  });
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
    input,
    press,
    failNextDelivery: () => {
      failDelivery = true;
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

test("native child completion continues its original Telegram task without broadcasting other work", async () => {
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
    const parentEvents=[
      {seq:3,type:"client/turn/requested",scope:threadScope,data:{requestId:"notice",initiator:"system",systemMessageKind:"child-completed",systemMessageSubject:{kind:"thread",threadId:"child",threadName:"Worker"}}},
      {seq:4,type:"turn/input/accepted",scope:{kind:"turn",turnId:"parent-final"},data:{clientRequestId:"notice"}},
      {seq:5,type:"item/completed",scope:{kind:"turn",turnId:"parent-final"},data:{item:{type:"agentMessage",text:"DELEGATED-ROUTE-PASS"}}},
      {seq:6,type:"turn/completed",scope:{kind:"turn",turnId:"parent-final"},data:{status:"completed"}},
    ];
    f.sdk.threads.events.list=async (q:any)=>(q.threadId==="child"?childEvents:parentEvents).filter(e=>e.seq>Number(q.afterSeq??0));
    await f.bridge.observe();await f.bridge.flush();
    assert.equal(f.sent.filter(x=>x.text?.includes("DELEGATED-ROUTE-PASS")).length,1);
  } finally {f.cleanup();}
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

test("public parent commentary survives subsequent generic tool start", async () => {
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
    assert.equal(progress.text.includes("Выполняю шаг"),false);
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
  assert.deepEqual(localArtifacts('[PDF](</tmp/a b.pdf>)'), [{markdown:'[PDF](</tmp/a b.pdf>)',path:'/tmp/a b.pdf'}]);
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
    assert.ok(final.text.includes('файл отправлен выше')); assert.ok(final.text.includes('не удалось отправить файл'));
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
  let retries:any[]=[{id:'retry1',payload:{kind:'retry'},sendAt:Date.now()+60000}];
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
