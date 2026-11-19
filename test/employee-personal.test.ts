import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  employeeProfile,
  employeeUpdate,
  employeeWriteAllowed,
  reconcileEmployeeTicket,
} from "../employee-policy";
import type { Store, Telegram } from "../model";

test("one subject, two groups, private action scope and independent recipient grants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "personal-scope-")),
    file = join(dir, "audiences.json");
  const previous = process.env.BB_TELEGRAM_SOURCE_GRANTS;
  process.env.BB_TELEGRAM_SOURCE_GRANTS = file;
  const disclose = (on: boolean) =>
    writeFileSync(file, JSON.stringify(on ? { "5:-1001:7": ["dates"] } : {}));
  const op = {
    id: "move",
    connection: "tracker",
    resource: "board-one",
    approval: true,
    resultHost: "board.invalid",
    sources: ["dates"],
    socket: "/action",
  };
  const grant = {
    subject: 3,
    operations: ["move", "close"],
    conversationSocket: "/leader",
    allowHere: true,
  };
  const p = employeeProfile.parse({
    schema: 1,
    botId: 5,
    username: "sample_bot",
    owner: 1,
    admins: [1],
    members: [2, 3],
    approvers: [3],
    role: "coordinator",
    events: [],
    connections: ["tracker"],
    sources: ["dates"],
    operations: [op, { ...op, id: "close" }],
    conversationSocket: "/ordinary",
    personalGrants: [grant],
  });
  const rows = new Map<string, any>(),
    sent: any[] = [],
    calls: any[] = [];
  const store: Store = {
    get: (k) => structuredClone(rows.get(k)),
    put: (k, v) => rows.set(k, structuredClone(v)),
    del: (k) => rows.delete(k),
    list: (prefix) =>
      [...rows]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    atomic: (f) => f(),
  };
  const send =
    (chat: number): Telegram =>
    async <T>(method: string, payload: any) => {
      sent.push({ chat, method, ...payload });
      return { message_id: sent.length } as T;
    };
  let seq = 50,
    hold: Promise<void> | undefined,
    lost = false,
    direct = false,
    revokeAtWrite = false,
    date = "2026-11-26";
  const run = (msg: any) =>
    employeeUpdate(
      store,
      () => p,
      { update_id: seq++, message: msg },
      send,
      async (path, body: any) => {
        calls.push({ path, body });
        if (path === "/ordinary") return { kind: "answer", text: "ordinary" };
        if (path === "/leader") {
          assert.equal(body.principal, 3);
          assert.deepEqual(body.sources, ["dates"]);
          assert.deepEqual(
            body.operations.map((x: any) => x.id),
            ["move", "close"],
          );
          if (direct)
            return {
              kind: "direct",
              operation: "move",
              revision: 1,
              item: "Card 17 → 2026-11-28",
            };
          return {
            kind: "selection",
            operation: "move",
            revision: 1,
            items: ["Card 17 → 2026-11-28"],
          };
        }
        assert.equal(path, "/action");
        if (revokeAtWrite) p.personalGrants = [];
        const allowed = employeeWriteAllowed(store, p, {
          ...body.choice,
          item: 1,
          operation: body.operation,
          resource: body.resource,
          connection: body.connection,
          idempotencyKey: body.idempotencyKey,
        });
        if (!allowed) throw Error("revoked before write");
        assert.equal(body.selectedItems[0], "Card 17 → 2026-11-28");
        date = "2026-11-28";
        if (hold) await hold;
        if (lost) throw Error("completion lost");
        return { ...body.choice, links: ["https://board.invalid/cards/17"] };
      },
    );
  const request = (chat: number, text: string, actor = 3, extra = {}) =>
    run({
      message_id: seq,
      from: { id: actor },
      chat: { id: chat, type: "supergroup" },
      message_thread_id: 7,
      text: "@sample_bot " + text,
      entities: [{ type: "mention", offset: 0, length: 11 }],
      ...extra,
    });
  const accept = (mid: number) =>
    run({
      from: { id: 3 },
      chat: { id: 3, type: "private" },
      message_id: seq,
      text: "первый",
      reply_to_message: { from: { id: 5 }, chat: { id: 3 }, message_id: mid },
    });
  const A = -1001,
    B = -1002;
  try {
    const legacy = { botId: 5, chatId: -300, topicId: 20, ownerId: 1 };
    rows.set("group:policy:-300:20", legacy);
    await run({
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      text: "Мои группы",
    });
    assert.match(sent.at(-1).text, /-300 · тема 20 .*только просмотр/);
    assert.equal(rows.size, 1);
    assert.deepEqual(rows.get("group:policy:-300:20"), legacy);
    disclose(false);
    for (const chat of [A, B]) {
      rows.set("employee:5:directory:" + chat, { chat, title: String(chat) });
      rows.set("employee:5:group:" + chat + ":topics", [7]);
      rows.set("employee:5:group:" + chat, {
        version: 1,
        note: "",
        rules: {
          topics: ["7"],
          members: ["2"],
          sources: [],
          operations: [],
          approvers: [],
          requireApproval: [],
          triggers: ["mention"],
          events: [],
        },
      });
    }
    const dm = "перенеси срок карточки 17 на 28 ноября, ответь мне в личку";
    await request(A, dm);
    assert.equal(calls.length, 0);
    await run({
      from: { id: 3 },
      chat: { id: 3, type: "private" },
      text: "/start",
    });
    await request(A, dm, 2);
    await request(A, dm, 3, { forward_origin: {} });
    await request(A, "цитата: «" + dm + "»");
    await request(A, dm, 3, { quote: { text: dm } });
    await request(A, dm + ", ответь сюда");
    assert.equal(calls.filter((x) => x.path === "/leader").length, 0);
    for (const chat of [A, B]) {
      const before = sent.length;
      await request(chat, dm);
      await accept(sent.length);
      assert.equal(date, "2026-11-28");
      assert.equal(sent.at(-1).text, "https://board.invalid/cards/17");
      assert.ok(sent.slice(before).every((m) => m.chat === 3));
    }
    const here = dm.replace("мне в личку", "сюда");
    const before = calls.length;
    await request(A, here);
    assert.equal(calls.length, before);
    disclose(true);
    await request(B, here);
    assert.equal(calls.length, before);
    await request(A, here);
    const mid = sent.length;
    disclose(false);
    await accept(mid);
    assert.equal(calls.filter((x) => x.path === "/action").length, 2);
    disclose(true);
    await request(A, here);
    const orig = seq - 1;
    await accept(sent.length);
    assert.equal(sent.at(-1).chat, A);
    assert.equal(sent.at(-1).message_thread_id, 7);
    assert.equal(sent.at(-1).reply_parameters.message_id, orig);
    direct = true;
    const writes = () => calls.filter((x) => x.path === "/action").length;
    const beforeDirect = writes();
    await request(A, here);
    assert.equal(writes(), beforeDirect); // The operation still requires approval.
    p.operations[0].approval = false;
    p.approvers = [];
    for (const [target, text, recipient] of [
      [A, here, A],
      [B, dm, 3],
    ] as const) {
      const before = sent.length;
      await request(target, text);
      assert.deepEqual(
        sent.slice(before).map((m) => [m.chat, m.text]),
        [[recipient, "https://board.invalid/cards/17"]],
      );
    }
    assert.equal(writes(), beforeDirect + 2);
    await request(A, here, 2);
    await request(B, here);
    assert.equal(writes(), beforeDirect + 2);
    revokeAtWrite = true;
    date = "2026-11-26";
    await assert.rejects(request(A, here), /revoked before write/);
    assert.equal(date, "2026-11-26");
    p.personalGrants = [grant];
    p.approvers = [3];
    p.operations[0].approval = true;
    revokeAtWrite = false;
    direct = false;
    await request(B, dm);
    date = "2026-11-26";
    revokeAtWrite = true;
    await assert.rejects(accept(sent.length), /revoked before write/);
    assert.equal(date, "2026-11-26");
    // Enable the new binary access explicitly. The group still has zero operations.
    revokeAtWrite = false;
    p.personalAccess = { subjects: [3], conversationSocket: "/leader" };
    disclose(false);
    for (const chat of [A, B]) {
      await request(chat, here);
      const confirmation = sent.length;
      await accept(confirmation);
      assert.equal(sent.at(-1).chat, chat);
      assert.equal(sent.at(-1).text, "https://board.invalid/cards/17");
      const count = sent.length;
      await accept(confirmation);
      assert.equal(sent.length, count);
    }
    await run({
      from: { id: 3 },
      chat: { id: 3, type: "private" },
      message_id: seq,
      text: "Перенеси срок карточки 17",
    });
    await accept(sent.length);
    assert.equal(sent.at(-1).chat, 3);
    assert.equal(sent.at(-1).text, "https://board.invalid/cards/17");
    await request(A, here);
    lost = true;
    await assert.rejects(accept(sent.length), /completion lost/);
    lost = false;
    let original = calls.at(-1).body;
    let token = original.idempotencyKey;
    const reconcile = () =>
      reconcileEmployeeTicket(
        store,
        () => p,
        token,
        send,
        async (path, body) => {
          assert.equal(path, "/action");
          assert.deepEqual(body, { ...original, kind: "reconcile" });
          return {
            ...original.choice,
            links: ["https://board.invalid/cards/17"],
          };
        },
      );
    const count = sent.length;
    const [first] = await Promise.all([reconcile(), reconcile()]);
    assert.equal(first.state, "sent");
    assert.equal(sent.length, count + 1);
    assert.equal(sent.at(-1).chat, A);
    assert.deepEqual(await reconcile(), first);
    assert.equal(sent.length, count + 1);
    await request(A, here);
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = accept(sent.length);
    await new Promise((resolve) => setImmediate(resolve));
    original = calls.at(-1).body;
    token = original.idempotencyKey;
    const beforeRace = sent.length;
    try {
      assert.equal((await reconcile()).state, "sent");
    } finally {
      release();
      await late;
      hold = undefined;
    }
    assert.equal(sent.length, beforeRace + 1);
    // Saved 0.9.25 limits have no personal field. An upgrade cannot enable new subjects.
    const previousLimits = {
      role: p.role,
      admins: ["1"],
      members: ["2", "3"],
      sources: p.sources,
      connections: p.connections,
      operations: p.operations.map((x) => x.id),
      approvers: ["3"],
      events: [],
      confirm: [],
    };
    rows.set("employee:5:limits", { revision: 4, selected: previousLimits });
    const beforeUpgrade = calls.length;
    await request(A, dm);
    assert.equal(calls.length, beforeUpgrade);
    rows.set("employee:5:limits", {
      revision: 5,
      selected: { ...previousLimits, personal: ["3"] },
    });
    await request(A, dm);
    const pending = sent.length;
    rows.set("employee:5:limits", {
      revision: 6,
      selected: { ...previousLimits, personal: [] },
    });
    const beforeRevokedChoice = calls.length;
    await accept(pending);
    assert.equal(calls.length, beforeRevokedChoice);
    const beforeOrdinary = writes();
    await request(A, here, 2);
    assert.equal(sent.at(-1).text, "ordinary");
    assert.equal(writes(), beforeOrdinary);
  } finally {
    if (previous === undefined) delete process.env.BB_TELEGRAM_SOURCE_GRANTS;
    else process.env.BB_TELEGRAM_SOURCE_GRANTS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
