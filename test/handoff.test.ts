import test from "node:test";
import assert from "node:assert/strict";
import {createFakePluginHost, makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import {TelegramHandoff, type HandoffJob} from "../handoff";
import type {Store} from "../model";

function fixture() {
  const row = (id: string, providerId = "claude-code", parentThreadId: string | null = null) => ({
    ...makeThreadResponse({id, projectId: "assistant", environmentId: "env", providerId, parentThreadId}),
    title: "Личный помощник", status: "idle", model: providerId + "-model", hasPendingInteraction: false,
    activity: {activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0},
  });
  const rows = [row("source"), {...row("worker", "codex", "source"), projectId: "finance", environmentId: "finance-env"}];
  const queues = new Set<string>(), calls: any[] = [], histories: any[] = [], notices: HandoffJob[] = [], retired: string[] = [];
  const seqs = new Map<string, number>([["source", 10]]), outputs = new Map<string, string>();
  let lostCreate = false, noCreate = false, lostUpdate = false, queueAfterUpdate = false, ownershipOnUpdate = false;
  const ownershipQueues = new Set<string>();
  const environment = {managed: false, isWorktree: false};
  const cascadeIds: string[] = [];
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", sdk: {
    environments: {get: async () => environment as any},
    providers: {
      list: async () => ["codex", "claude-code"].map(id => ({id, available: true})) as any,
      models: async ({providerId}: any) => ({modelLoadError: null, models: [{model: providerId + "-model"}]}) as any,
    },
    plugins: {callRpc: async (args: any) => {
      if (args.method === "history") return {handoffs: structuredClone(histories)};
      assert.equal(args.method, "startHandoff"); calls.push(args.input);
      if (noCreate) throw Error("network_unknown");
      const id = "target-" + calls.length;
      rows.push({...row(id, args.input.providerId), title: "Handoff: " + rows.find(r => r.id === args.input.threadId)!.title});
      histories.push({sourceThreadId: args.input.threadId, targetThreadId: id,
        targetProvider: args.input.providerId, model: args.input.model, workspace: "reuse", at: Date.now(), verification: "pending"});
      outputs.set(id, args.input.extraInstructions.match(/HANDOFF-READY:[a-f0-9-]+/)[0]);
      seqs.set(id, 20);
      if (lostCreate) {lostCreate = false; throw Error("response_lost");}
      return {newThreadId: id, crossMachine: false};
    }},
    threads: {
      list: async (args: any) => structuredClone(rows.filter(r => (!args.threadIds || args.threadIds.includes(r.id)) &&
        (!args.parentThreadId || r.parentThreadId === args.parentThreadId))) as any,
      get: async ({threadId}: any) => structuredClone(rows.find(r => r.id === threadId)) as any,
      defaultExecutionOptions: async ({threadId}: any) => ({model: rows.find(r => r.id === threadId)!.model}) as any,
      queuedMessages: {list: async ({threadId}: any) => [
        ...(queues.has(threadId) ? [{payload: {kind: "retry", retryOfTurnRequestId: "request-" + threadId}}] : []),
        ...(ownershipQueues.has(threadId) ? [{initiator: "system", payload: {kind: "inline"}, systemNotice: {kind: "ownership-batch"}}] : []),
      ] as any},
      events: {list: async ({threadId, afterSeq}: any) => afterSeq && Number(afterSeq) >= (seqs.get(threadId) ?? 0) ? [] : [{seq: seqs.get(threadId) ?? 0, type: "client/turn/requested",
        data: {requestId: "request-" + threadId, originPluginId: "handoff", input: [{type: "text", text: outputs.get(threadId)}]}}] as any},
      output: async ({threadId}: any) => ({output: outputs.get(threadId) ?? ""}) as any,
      experimental_listDescendants: async ({threadIds}: any) => ({threads: threadIds.map((threadId: string) =>
        ({threadId, descendantIds: rows.filter(r => r.parentThreadId === threadId).map(r => r.id)}))}),
      experimental_listCascade: async ({threadIds}: any) => ({threads: threadIds.map((threadId: string) => ({threadId, cascadeThreadIds: [threadId, ...cascadeIds]}))}),
      archive: async ({threadId}: any) => {rows.find(r => r.id === threadId)!.archivedAt = Date.now(); return {} as any;},
      update: async (args: any) => {
        if (args.title !== undefined) {rows.find(r => r.id === args.threadId)!.title = args.title; return {} as any;}
        if (ownershipOnUpdate) {
          ownershipQueues.add(rows.find(r => r.id === args.threadId)!.parentThreadId!);
          ownershipQueues.add(args.parentThreadId);
        }
        rows.find(r => r.id === args.threadId)!.parentThreadId = args.parentThreadId;
        if (queueAfterUpdate) {queueAfterUpdate = false; queues.add("source");}
        if (lostUpdate) {lostUpdate = false; throw Error("response_lost");}
        return rows.find(r => r.id === args.threadId) as any;
      },
    },
  }});
  const db = bb.storage.database();
  db.exec("CREATE TABLE journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store: Store = {
    get: key => { const r = db.prepare("SELECT value FROM journal WHERE key=?").get(key) as {value: string} | undefined; return r && JSON.parse(r.value); },
    put: (k, v) => { db.prepare("INSERT OR REPLACE INTO journal VALUES (?,?)").run(k, JSON.stringify(v)); },
    del: k => { db.prepare("DELETE FROM journal WHERE key=?").run(k); },
    list: prefix => (db.prepare("SELECT key,value FROM journal WHERE substr(key,1,?)=?").all(prefix.length, prefix) as any[])
      .map(r => ({key: r.key, value: JSON.parse(r.value)})),
    atomic: fn => { db.transaction(fn)(); },
  };
  store.put("binding", {threadId: "source", topicId: 0, revision: "r1", projectId: "assistant"});
  const binding = () => store.get<any>("binding")!;
  const create = () => new TelegramHandoff({store, sdk: bb.sdk, binding,
    assertDeliveryDrained: () => {},
    commit: (job, cursor) => store.put("binding", {...binding(), threadId: job.target, revision: job.id, cursor}),
    notify: job => notices.push(structuredClone(job)),
    sourceRetired: job => retired.push(job.source),
    sourceIsBound: threadId => binding().threadId === threadId,
  });
  return {create, binding, rows, queues, calls, histories, notices, seqs, outputs, harness, retired, environment, cascadeIds,
    loseCreate: () => {lostCreate = true;}, unknownCreate: () => {noCreate = true;},
    loseUpdate: () => {lostUpdate = true;}, queueOnUpdate: () => {queueAfterUpdate = true;},
    enableOwnership: () => {ownershipOnUpdate = true;}};
}

test("one visible coordinator: keep original title and archive only the idle childless predecessor", async () => {
  const f = fixture();
  try {
    await f.create().begin(f.binding(), "codex", "codex-model");
    await f.create().poll();
    assert.equal(f.rows[2].title, "Личный помощник");
    assert.equal(f.rows[0].archivedAt, null);
    await f.create().poll();
    assert.ok(f.rows[0].archivedAt);
    assert.equal(f.rows[1].archivedAt, null);
    assert.equal(f.rows[2].archivedAt, null);
    assert.deepEqual(f.retired, ["source"]);
    assert.equal(f.create().needsPolling(), false);
  } finally {await f.harness.lifecycle.dispose();}
});

test("an old coordinator used again in BB is not auto-archived", async () => {
  const f = fixture();
  try {
    await f.create().begin(f.binding(), "codex", "codex-model");
    await f.create().poll();
    f.seqs.set("source", 11);
    await f.create().poll();
    assert.equal(f.rows[0].archivedAt, null);
    assert.equal(f.create().jobs()[0].retirementReason, "source_used_again");
  } finally {await f.harness.lifecycle.dispose();}
});

test("retirement waits for native ownership messages to finish", async () => {
  const f = fixture();
  try {
    await f.create().begin(f.binding(), "codex", "codex-model"); await f.create().poll();
    f.queues.add("source"); await f.create().poll();
    assert.equal(f.rows[0].archivedAt, null);
    f.queues.delete("source"); await f.create().poll();
    assert.ok(f.rows[0].archivedAt);
  } finally {await f.harness.lifecycle.dispose();}
});

for (const reason of ["pinned", "managed", "cascade", "question"] as const) {
  test(`automatic retirement protects ${reason}`, async () => {
    const f = fixture();
    try {
      await f.create().begin(f.binding(), "codex", "codex-model"); await f.create().poll();
      if (reason === "pinned") f.rows[0].pinnedAt = Date.now();
      if (reason === "managed") f.environment.managed = true;
      if (reason === "cascade") f.cascadeIds.push("unrelated");
      if (reason === "question") f.rows[0].hasPendingInteraction = true;
      await f.create().poll();
      assert.equal(f.rows[0].archivedAt, null);
      assert.deepEqual(f.retired, []);
    } finally {await f.harness.lifecycle.dispose();}
  });
}

test("native ownership notices generated by reparenting do not abort the transaction", async () => {
  const f = fixture();
  try {
    f.enableOwnership();
    await f.create().begin(f.binding(), "codex", "codex-model");
    await f.create().poll();
    assert.equal(f.binding().threadId, "target-1");
    assert.equal(f.rows[1].parentThreadId, "target-1");
  } finally {await f.harness.lifecycle.dispose();}
});

test("native handoff round trip keeps the chat and worker, returning to a fresh Claude thread", async () => {
  const f = fixture();
  try {
    await f.create().begin(f.binding(), "codex", "codex-model");
    await f.create().poll();
    assert.equal(f.binding().threadId, "target-1");
    assert.equal(f.rows[1].parentThreadId, "target-1");
    assert.equal(f.rows[1].projectId, "finance");
    await f.create().begin(f.binding(), "claude-code", "claude-code-model");
    await f.create().poll();
    assert.equal(f.binding().threadId, "target-2");
    assert.equal(f.rows[1].parentThreadId, "target-2");
    assert.equal(f.binding().topicId, 0);
    assert.equal(f.calls[1].threadId, "target-1");
    assert.equal(f.calls.length, 2);
    assert.equal(f.rows[0].id, "source");
  } finally {await f.harness.lifecycle.dispose();}
});

test("lost native creation response resolves from history on reload without spawning twice", async () => {
  const f = fixture();
  try {
    f.loseCreate();
    const job = await f.create().begin(f.binding(), "codex", "codex-model");
    assert.equal(job.phase, "uncertain");
    await f.create().poll();
    await f.create().poll();
    assert.equal(f.calls.length, 1);
    assert.equal(f.binding().threadId, "target-1");
  } finally {await f.harness.lifecycle.dispose();}
});

test("unknown creation is not retried and can be cancelled without losing original binding", async () => {
  const f = fixture();
  try {
    f.unknownCreate();
    await f.create().begin(f.binding(), "codex", "codex-model");
    await f.create().poll(); await f.create().poll();
    assert.equal(f.create().active(0)?.phase, "uncertain");
    assert.equal(f.calls.length, 1);
    await f.create().cancel(0);
    assert.equal(f.create().active(0), undefined);
    assert.equal(f.binding().threadId, "source");
  } finally {await f.harness.lifecycle.dispose();}
});

for (const change of ["new-source-message", "wrong-reply", "partial-update", "queued-after-update"] as const) {
  test(`switch rolls back safely after ${change}`, async () => {
    const f = fixture();
    try {
      await f.create().begin(f.binding(), "codex", "codex-model");
      if (change === "new-source-message") f.seqs.set("source", 11);
      if (change === "wrong-reply") f.outputs.set("target-1", "I continued the old task");
      if (change === "partial-update") f.loseUpdate();
      if (change === "queued-after-update") f.queueOnUpdate();
      await f.create().poll();
      assert.equal(f.create().active(0)?.phase, "rollback");
      await f.create().poll();
      assert.equal(f.create().active(0), undefined);
      assert.equal(f.binding().threadId, "source");
      assert.equal(f.rows[1].parentThreadId, "source");
      assert.equal(f.calls.length, 1);
    } finally {await f.harness.lifecycle.dispose();}
  });
}

test("held messages and child work wait, while native pickup can run", async () => {
  const f = fixture();
  try {
    await f.create().begin(f.binding(), "codex", "codex-model");
    for (const id of ["source", "worker", "target-1"])
      assert.equal(f.create().dispatch({thread: {id}, originPluginId: null} as any)?.action, "wait");
    assert.equal(f.create().dispatch({thread: {id: "target-1"}, originPluginId: "handoff", input: {text: f.outputs.get("target-1")}} as any), undefined);
    assert.equal(f.create().dispatch({thread: {id: "unrelated"}} as any), undefined);
    f.rows[2].status = "error"; f.queues.add("target-1");
    await f.create().poll();
    assert.equal(f.create().active(0)?.phase, "waiting");
    assert.equal(f.create().dispatch({thread: {id: "target-1"}, originPluginId: null,
      queuedMessages: [{payload: {kind: "retry", retryOfTurnRequestId: "request-target-1"}}]} as any), undefined);
    assert.equal(f.create().dispatch({thread: {id: "target-1"}, originPluginId: null,
      queuedMessages: [{payload: {kind: "retry", retryOfTurnRequestId: "other-request"}}]} as any)?.action, "wait");
    f.rows[2].status = "idle"; f.queues.delete("target-1");
    await f.create().poll();
    assert.equal(f.binding().threadId, "target-1");
  } finally {await f.harness.lifecycle.dispose();}
});

test("busy worker prevents native creation", async () => {
  const f = fixture();
  try {
    f.rows[1].activity.activeBackgroundAgentCount = 1;
    const job = await f.create().begin(f.binding(), "codex", "codex-model");
    assert.equal(job.phase, "cancelled");
    assert.equal(f.calls.length, 0);
  } finally {await f.harness.lifecycle.dispose();}
});
