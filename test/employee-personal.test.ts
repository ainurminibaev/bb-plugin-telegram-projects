import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  employeeProfile,
  employeeUpdate,
  employeeWriteAllowed,
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
    await request(B, dm);
    date = "2026-11-26";
    revokeAtWrite = true;
    await assert.rejects(accept(sent.length), /revoked before write/);
    assert.equal(date, "2026-11-26");
  } finally {
    if (previous === undefined) delete process.env.BB_TELEGRAM_SOURCE_GRANTS;
    else process.env.BB_TELEGRAM_SOURCE_GRANTS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
