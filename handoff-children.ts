import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./model";

type Threads = BbPluginApi["sdk"]["threads"];
type Row = Awaited<ReturnType<Threads["list"]>>[number] & {model: string | null};
type Child = Pick<Row, "id" | "projectId" | "environmentId" | "providerId" | "model" | "parentNotifications">;
export type ChildTransfer = {
  source: string;
  target: string;
  children: Child[];
  phase: "prepared" | "moving" | "moved" | "rolling-back" | "rolled-back";
};

/** Only native parent links are changed. The caller must hold dispatch and
 * Telegram ingress throughout this transaction and verify the handoff history.
 * This module deliberately cannot spawn, send, archive, or switch bindings. */
export class HandoffChildren {
  constructor(private store: Store, private threads: Threads,
    private assertFence: () => Promise<void>,
    private allowedQueue: (id: string, rows: Awaited<ReturnType<Threads["queuedMessages"]["list"]>>) => boolean = () => false) {}

  private key(id: string) { return "chat:handoff-children:" + id; }
  get(id: string) { return this.store.get<ChildTransfer>(this.key(id)); }
  private save(id: string, transfer: ChildTransfer) { this.store.put(this.key(id), transfer); }

  private async row(id: string, heldQueueAllowed = false) {
    const rows = await this.threads.list({threadIds: [id], archived: false, includeHidden: true});
    const row = rows.find(r => r.id === id);
    if (!row || row.archivedAt || row.deletedAt) throw Error("handoff_thread_missing");
    if (!["idle", "error"].includes(row.status) || row.hasPendingInteraction ||
      Object.values(row.activity).some(n => n !== 0)) throw Error("handoff_thread_busy");
    if (!heldQueueAllowed) {
      const queue = await this.threads.queuedMessages.list({threadId: id});
      if (queue.length && !this.allowedQueue(id, queue)) throw Error("handoff_thread_queued");
    }
    const options = await this.threads.defaultExecutionOptions({threadId: id});
    if (!options) throw Error("handoff_model_unavailable");
    return {...row, model: options.model ?? null};
  }

  private async children(parentThreadId: string) {
    // Refuse a potentially truncated roster rather than silently abandon children.
    const rows = await this.threads.list({parentThreadId, archived: false, includeHidden: true, limit: 100});
    if (rows.length >= 100) throw Error("handoff_children_limit");
    return rows;
  }

  async prepare(id: string, source: string, target: string) {
    if (!id || source === target) throw Error("handoff_invalid_transfer");
    const existing = this.get(id);
    if (existing) {
      if (existing.source !== source || existing.target !== target) throw Error("handoff_id_conflict");
      return existing;
    }
    await this.assertFence();
    const before = await this.row(source), after = await this.row(target);
    if (before.projectId !== after.projectId || before.environmentId !== after.environmentId)
      throw Error("handoff_target_mismatch");
    if ((await this.children(target)).length) throw Error("handoff_target_has_children");
    const children: Child[] = [];
    for (const child of await this.children(source)) {
      if (child.id === target) throw Error("handoff_target_is_child");
      const current = await this.row(child.id);
      if (current.parentThreadId !== source) throw Error("handoff_parent_changed");
      children.push(this.identity(current));
    }
    await this.assertFence();
    const transfer: ChildTransfer = {source, target, children, phase: "prepared"};
    this.save(id, transfer);
    return transfer;
  }

  private identity(row: Row): Child {
    const {id, projectId, environmentId, providerId, model, parentNotifications} = row;
    return {id, projectId, environmentId, providerId, model, parentNotifications};
  }

  private async validate(transfer: ChildTransfer, rollback = false) {
    await this.assertFence();
    const source = await this.row(transfer.source, rollback), target = await this.row(transfer.target, rollback);
    if (source.projectId !== target.projectId || source.environmentId !== target.environmentId)
      throw Error("handoff_target_mismatch");
    const actual = [...await this.children(transfer.source), ...await this.children(transfer.target)];
    const expected = new Set(transfer.children.map(c => c.id));
    if (actual.length !== expected.size || actual.some(c => !expected.has(c.id)))
      throw Error("handoff_roster_changed");
    for (const child of transfer.children) {
      const row = await this.row(child.id, rollback);
      if (JSON.stringify(this.identity(row)) !== JSON.stringify(child))
        throw Error("handoff_child_changed");
      if (row.parentThreadId !== transfer.source && row.parentThreadId !== transfer.target)
        throw Error("handoff_parent_changed");
    }
  }

  /** Reconcile native state after any lost update response. Never assume that
   * a rejected RPC means the parent link was not already changed. */
  async move(id: string) { return this.apply(id, false); }
  async rollback(id: string) { return this.apply(id, true); }

  private async apply(id: string, rollback: boolean) {
    const transfer = this.get(id);
    if (!transfer) throw Error("handoff_transfer_missing");
    if (!rollback && ["rolling-back", "rolled-back"].includes(transfer.phase))
      throw Error("handoff_rollback_started");
    await this.validate(transfer, rollback);
    transfer.phase = rollback ? "rolling-back" : "moving";
    this.save(id, transfer);
    const parent = rollback ? transfer.source : transfer.target;
    for (const child of transfer.children) {
      await this.assertFence();
      const row = await this.row(child.id, rollback);
      if (JSON.stringify(this.identity(row)) !== JSON.stringify(child) ||
        ![transfer.source, transfer.target].includes(row.parentThreadId ?? ""))
        throw Error("handoff_child_changed");
      if (row.parentThreadId !== parent) {
        await this.threads.update({threadId: child.id, parentThreadId: parent});
        const check = await this.row(child.id, rollback);
        if (check.parentThreadId !== parent) throw Error("handoff_parent_unconfirmed");
      }
    }
    await this.validate(transfer, rollback);
    transfer.phase = rollback ? "rolled-back" : "moved";
    this.save(id, transfer);
    return transfer;
  }
}
