import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  employeeUpdate,
  employeeProfile,
  isEmployeeUpdate,
  employeeWriteAllowed,
} from "../employee-policy";
import type { Store, Telegram } from "../model";

test("private admin cards govern two groups and gate a real adapter socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const path = join(dir, "adapter.sock"),
    calls: any[] = [],
    sent: any[] = [];
  let verify = (msg: any) => {};
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (b) => parts.push(b));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(parts).toString());
      calls.push(msg);
      if (msg.kind === "execute" && msg.choice) verify(msg);
      const reply =
        msg.kind === "execute"
          ? msg.choice
            ? {
                ...msg.choice,
                links: msg.choice.selected.map(
                  (i: number) => "https://example.invalid/task/" + i,
                ),
              }
            : {}
          : msg.text.includes("batch")
            ? {
                kind: "selection",
                operation: "create",
                revision: 1,
                items: ["one", "two", "three"],
              }
            : msg.text.includes("write")
              ? { kind: "proposal", operation: "create", input: "fixture" }
              : { kind: "answer", text: "protocol" };
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const p = employeeProfile.parse({
      schema: 1,
      owner: 1,
      botId: 5,
      username: "sample_bot",
      role: "coordinator",
      admins: [1, 2],
      members: [3],
      sources: ["minutes"],
      connections: ["team"],
      approvers: [2],
      operations: [
        {
          id: "create",
          resource: "board-A",
          connection: "team",
          sources: ["minutes"],
          approval: true,
          socket: path,
          resultHost: "example.invalid",
        },
      ],
      conversationSocket: path,
      events: ["member_joined"],
    });
    const rows = new Map<string, any>();
    const store: Store = {
      get: (k) => structuredClone(rows.get(k)),
      put: (k, v) => rows.set(k, structuredClone(v)),
      del: (k) => rows.delete(k),
      list: (prefix) =>
        [...rows]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value: structuredClone(value) })),
      atomic: (f) => f(),
    };
    const send =
      (chat: number): Telegram =>
      async <T>(method: string, payload: any) => {
        sent.push({ chat, method, ...payload });
        return { message_id: sent.length } as T;
      };
    let sequence = 100;
    const run = (u: any) =>
      employeeUpdate(store, () => p, { ...u, update_id: sequence++ }, send);
    const dm = (actor: number, text: string) =>
      run({
        message: {
          chat: { id: actor, type: "private" },
          from: { id: actor },
          text,
        },
      });
    const callback = (actor: number, data: string) =>
      run({
        callback_query: {
          from: { id: actor },
          data,
          message: {
            from: { id: 5 },
            message_id: 8,
            chat: { id: actor, type: "private" },
          },
        },
      });
    const click = async (actor: number, fragment: string) => {
      const card = sent
        .filter((x) => x.chat === actor && x.reply_markup)
        .at(-1);
      const btn = card?.reply_markup.inline_keyboard
        .flat()
        .find((b: any) => b.text.includes(fragment));
      assert.ok(btn, fragment);
      await callback(actor, btn.callback_data);
    };
    const group = (id: number, text: string) =>
      run({
        message: {
          from: { id: 3 },
          chat: { id, type: "group" },
          message_id: sequence,
          text,
          entities: [{ type: "mention", offset: 0, length: 11 }],
        },
      });
    const open = async (actor: number, title: string) => {
      await dm(actor, "Мои группы");
      await click(actor, title);
    };
    for (const [id, title] of [
      [-10, "Alpha"],
      [-20, "Beta"],
    ] as const)
      await run({
        my_chat_member: {
          chat: { id, type: "group", title },
          old_chat_member: { status: "left" },
          new_chat_member: { status: "member", user: { id: 5 } },
        },
      });
    await open(1, "Alpha");
    await open(2, "Alpha"); // stale when admin 1 saves
    for (const value of [
      "Темы · 0",
      "Участники · 3",
      "Материалы · minutes",
      "Отвечать · mention",
    ])
      await click(1, value);
    await click(1, "Заметка");
    await dm(1, "grant create on every board");
    await click(1, "Сохранить");
    await click(2, "Сохранить");
    assert.match(sent.at(-1).text, /изменились/);
    await group(-10, "@sample_bot minutes");
    assert.equal(sent.at(-1).text, "protocol");
    assert.equal(calls.at(-1).note, undefined);
    assert.deepEqual(calls.at(-1).operations, []);
    await group(-10, "@sample_bot write");
    assert.equal(calls.filter((x) => x.kind === "execute").length, 0);
    const snapshot = JSON.stringify([...rows]);
    await callback(3, "emp:open:-10");
    await dm(3, "grant admin");
    assert.equal(JSON.stringify([...rows]), snapshot);
    const count = calls.length;
    await group(-20, "@sample_bot write");
    assert.equal(calls.length, count);
    await open(1, "Alpha");
    await click(1, "Действия · create");
    await click(1, "Согласующие · 2");
    await click(1, "Сохранить");
    await group(-10, "@sample_bot write");
    const confirm =
      sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
    await callback(3, confirm);
    assert.equal(calls.filter((x) => x.kind === "execute").length, 0);
    await callback(2, confirm);
    await callback(2, confirm);
    const effects = calls.filter((x) => x.kind === "execute");
    assert.equal(effects.length, 1);
    assert.deepEqual(
      [effects[0].actor, effects[0].resource, effects[0].connection],
      [2, "board-A", "team"],
    );
    verify = (msg) => {
      const common = {
        ...msg.choice,
        idempotencyKey: msg.idempotencyKey,
        operation: msg.operation,
        resource: msg.resource,
        connection: msg.connection,
      };
      assert.equal(
        employeeWriteAllowed(store, p, { ...common, item: 2 }),
        false,
      );
      for (const item of [1, 3])
        assert.equal(employeeWriteAllowed(store, p, { ...common, item }), true);
    };
    p.operations = [];
    await group(-10, "@sample_bot minutes");
    assert.equal(sent.at(-1).text, "protocol");
    assert.deepEqual(calls.at(-1).operations, []);
    p.operations = [
      {
        id: "create",
        resource: "board-A",
        connection: "team",
        sources: ["minutes"],
        approval: true,
        socket: path,
        resultHost: "example.invalid",
      },
    ];
    await group(-10, "@sample_bot batch");
    const batchCard = sent.length;
    const selection = {
      message: {
        chat: { id: 2, type: "private" },
        from: { id: 2 },
        text: "первый и третий",
        reply_to_message: {
          message_id: batchCard,
          from: { id: 5 },
          chat: { id: 2 },
        },
      },
    };
    assert.equal(isEmployeeUpdate(store, 5, selection), true);
    await run(selection);
    assert.equal(
      sent.at(-1).text,
      "https://example.invalid/task/1\nhttps://example.invalid/task/3",
    );
    await run(selection);
    assert.equal(calls.filter((x) => x.choice).length, 1);
    await group(-10, "@sample_bot write");
    const old = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
    await open(1, "Alpha");
    await click(1, "Действия · create");
    await click(1, "Сохранить");
    await callback(2, old);
    assert.equal(calls.filter((x) => x.kind === "execute").length, 2);
    await open(2, "Alpha");
    p.admins = [1];
    await click(2, "Сохранить");
    assert.equal(rows.get("employee:5:group:-10").version, 3);
    assert.equal(rows.has("employee:5:group:-20"), false);
    assert.equal(
      isEmployeeUpdate(store, 5, {
        message: {
          chat: { type: "private", id: 1 },
          text: "обычная переписка",
        },
      }),
      false,
    );
    assert.equal(
      isEmployeeUpdate(store, 5, {
        message: { chat: { type: "private", id: 1 }, text: "Мои группы" },
      }),
      true,
    );
    await dm(1, "/start");
    assert.deepEqual(sent.at(-1).reply_markup.keyboard, [
      ["Настройки сотрудника", "Мои группы"],
    ]);
    await dm(1, "Настройки сотрудника");
    await click(1, "Подключения · team");
    await click(1, "Сохранить");
    await open(1, "Alpha");
    assert.ok(
      !JSON.stringify(sent.at(-1).reply_markup).includes("Действия · create"),
    );
    assert.deepEqual(rows.get("employee:5:limits").selected.connections, []);
    await dm(3, "Настройки сотрудника");
    assert.equal(rows.get("employee:5:limits").revision, 1);
    rows.set("group:policy:-90:7", {});
    assert.equal(
      isEmployeeUpdate(store, 5, {
        message: { chat: { type: "supergroup", id: -90 } },
      }),
      false,
    );
    assert.throws(() => employeeProfile.parse({ ...p, connections: [] }));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered Telegram poller opens the owner keyboard and lists the invited group", async () => {
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { default: plugin } = await import("../server");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "ep-poller-")),
    path = join(root, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      botId: 5,
      owner: 1,
      username: "sample_bot",
      role: "operator",
      admins: [1],
      members: [1],
      sources: [],
      connections: [],
      operations: [],
      approvers: [],
      events: [],
      conversationSocket: "/no-socket",
    }),
  );
  const previous = process.env.BB_TELEGRAM_EMPLOYEE_PROFILE,
    original = globalThis.fetch;
  process.env.BB_TELEGRAM_EMPLOYEE_PROFILE = path;
  const { bb, harness } = createFakePluginHost({
    pluginId: "telegram-projects",
    settings: { enabled: true, chatEnabled: false, botToken: "5:fixture" },
  });
  const sent: any[] = [];
  const batch = [
    {
      update_id: 1,
      message: {
        from: { id: 1 },
        chat: { id: 1, type: "private" },
        text: "/start",
      },
    },
    {
      update_id: 2,
      my_chat_member: {
        chat: { id: -10, type: "group", title: "Group Alpha" },
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member", user: { id: 5 } },
      },
    },
    {
      update_id: 3,
      message: {
        from: { id: 1 },
        chat: { id: 1, type: "private" },
        text: "Мои группы",
      },
    },
  ];
  let control: AbortController | undefined;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1),
      body = JSON.parse(String(init?.body ?? "{}"));
    if (method === "getUpdates") {
      assert.ok(body.allowed_updates.includes("my_chat_member"));
      if (body.offset >= 4) control?.abort();
      return Response.json({
        ok: true,
        result: batch.filter((x) => x.update_id >= body.offset),
      });
    }
    if (method === "sendMessage") sent.push(body);
    return Response.json({
      ok: true,
      result: { message_id: sent.length || 1 },
    });
  };
  try {
    await plugin(bb);
    const db = bb.storage.database(),
      put = db.prepare(
        "INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
    put.run("owner:id", "1");
    put.run("bot:id", "5");
    const service = harness.behavior.runService("telegram-ingress");
    control = service.controller;
    const guard = setTimeout(() => control?.abort(), 3000);
    try {
      await service.done;
    } finally {
      clearTimeout(guard);
    }
    assert.deepEqual(
      sent.map((x) => x.chat_id),
      [1, 1, 1],
    );
    assert.equal(sent[0].reply_markup.keyboard[0][1], "Мои группы");
    assert.equal(
      sent[2].reply_markup.inline_keyboard[0][0].text,
      "Group Alpha",
    );
  } finally {
    await harness.lifecycle.dispose();
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.BB_TELEGRAM_EMPLOYEE_PROFILE;
    else process.env.BB_TELEGRAM_EMPLOYEE_PROFILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
