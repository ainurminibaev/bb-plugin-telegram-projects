import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { HandoffChildren } from "../handoff-children";
import type { Store } from "../model";

function fixture() {
  const rows = [
    makeThreadResponse({id: "claude", projectId: "assistant", environmentId: "env", providerId: "claude-code"}),
    makeThreadResponse({id: "codex", projectId: "assistant", environmentId: "env", providerId: "codex"}),
    makeThreadResponse({id: "finance", projectId: "money", environmentId: "finance-env", parentThreadId: "claude", parentNotifications: "stuck"}),
    makeThreadResponse({id: "research", projectId: "assistant", environmentId: "env", parentThreadId: "claude", parentNotifications: "auto"}),
  ].map(r => ({...r, model: "original-model", status: "idle", hasPendingInteraction: false,
    activity: {activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0,
      activePlanModeCount: 0, activeWorkflowCount: 0}}));
  const writes: unknown[] = [];
  let lostReply = false, fence = true;
  const queued = new Set<string>();
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", sdk: {threads: {
    defaultExecutionOptions: async ({threadId}: any) => ({model: rows.find(r => r.id === threadId)!.model}) as any,
    list: async (args: any) => structuredClone(rows.filter(r =>
      (!args.threadIds || args.threadIds.includes(r.id)) &&
      (!args.parentThreadId || r.parentThreadId === args.parentThreadId))) as any,
    queuedMessages: {list: async (args: any) => queued.has(args.threadId) ? [{}] as any : []},
    update: async (args: any) => {
      writes.push(args);
      const row = rows.find(r => r.id === args.threadId)!;
      row.parentThreadId = args.parentThreadId;
      if (lostReply) { lostReply = false; throw Error("connection_lost_after_commit"); }
      return row as any;
    },
  }}});
  // Real temporary SQLite from the official harness; reopening the transaction
  // object uses persisted JSON, rather than retaining its in-memory plan.
  const db = bb.storage.database();
  db.exec("CREATE TABLE handoff_test (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store: Store = {
    get: key => {
      const r = db.prepare("SELECT value FROM handoff_test WHERE key=?").get(key) as {value: string} | undefined;
      return r ? JSON.parse(r.value) : undefined;
    },
    put: (key, value) => { db.prepare("INSERT OR REPLACE INTO handoff_test VALUES (?,?)").run(key, JSON.stringify(value)); },
    del: key => { db.prepare("DELETE FROM handoff_test WHERE key=?").run(key); },
    list: () => [],
    atomic: fn => { db.transaction(fn)(); },
  };
  const create = () => new HandoffChildren(store, bb.sdk.threads, async () => {if (!fence) throw Error("fence_lost");});
  return {rows, writes, queued, create, harness, loseReply: () => {lostReply = true;}, loseFence: () => {fence = false;}};
}

test("handoff keeps worker IDs, projects, models and notifications, including return to Claude", async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.rows.slice(2));
    await f.create().prepare("one", "claude", "codex");
    await f.create().move("one");
    await f.create().move("one");
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.rows.slice(2), before.map(r => ({...r, parentThreadId: "codex"})));
    // Returning creates another Claude coordinator with fresh handoff history.
    // It does not reopen the old Claude snapshot.
    f.rows.push({...f.rows[0], id: "claude-next"});
    await f.create().prepare("two", "codex", "claude-next");
    await f.create().move("two");
    assert.deepEqual(f.rows.slice(2, 4), before.map(r => ({...r, parentThreadId: "claude-next"})));
    for (const write of f.writes) assert.deepEqual(Object.keys(write as object).sort(), ["parentThreadId", "threadId"]);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("lost update reply is reconciled after restart without duplicate parent writes", async () => {
  const f = fixture();
  try {
    await f.create().prepare("one", "claude", "codex");
    f.loseReply();
    await assert.rejects(f.create().move("one"), /connection_lost/);
    assert.equal(f.create().get("one")?.phase, "moving");
    await f.create().move("one");
    assert.equal(f.writes.length, 2);
    assert.equal(f.create().get("one")?.phase, "moved");
  } finally { await f.harness.lifecycle.dispose(); }
});

test("partial move can be rolled back after reload; rollback cannot resume forward", async () => {
  const f = fixture();
  try {
    await f.create().prepare("one", "claude", "codex");
    f.loseReply();
    await assert.rejects(f.create().move("one"));
    await f.create().rollback("one");
    await f.create().rollback("one");
    assert.equal(f.writes.length, 2);
    assert.ok(f.rows.slice(2).every(r => r.parentThreadId === "claude"));
    await assert.rejects(f.create().move("one"), /rollback_started/);
  } finally { await f.harness.lifecycle.dispose(); }
});

for (const kind of ["active", "queue", "background", "question", "model", "parent", "roster", "fence"] as const) {
  test(`refuses concurrent ${kind} change before moving any child`, async () => {
    const f = fixture();
    try {
      await f.create().prepare("one", "claude", "codex");
      const child = f.rows[2];
      if (kind === "active") child.status = "active";
      if (kind === "queue") f.queued.add(child.id);
      if (kind === "background") child.activity.activeBackgroundAgentCount = 1;
      if (kind === "question") child.hasPendingInteraction = true;
      if (kind === "model") child.model = "changed-model";
      if (kind === "parent") child.parentThreadId = "unrelated";
      if (kind === "roster") f.rows.push({...child, id: "new-child"});
      if (kind === "fence") f.loseFence();
      await assert.rejects(f.create().move("one"));
      assert.equal(f.writes.length, 0);
    } finally { await f.harness.lifecycle.dispose(); }
  });
}
