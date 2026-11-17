import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Store } from "./model";
import { HandoffChildren } from "./handoff-children";

type Sdk = BbPluginApi["sdk"];
export type HandoffBinding = {topicId: number; threadId: string | null; revision: string; projectId: string};
export type HandoffJob = {
  id: string; binding: HandoffBinding; providerId: string; model: string;
  source: string; sourceSeq: number; environmentId: string; at: number;
  frozen: string[]; priorTargets: string[]; target?: string;
  phase: "preparing" | "creating" | "uncertain" | "waiting" | "moving" | "rollback" | "cancelled" | "done";
  error?: string;
  cancelRequested?: boolean;
  pickupRequests?: string[];
  retryAt?: number;
  errorSeenAt?: number;
};
const historySchema = z.object({handoffs: z.array(z.object({
  sourceThreadId: z.string(), targetThreadId: z.string(), targetProvider: z.string(),
  model: z.string().nullable(), workspace: z.string(), at: z.number(),
  verification: z.enum(["pending", "confirmed", "failed"]).optional(),
}))});
const startedSchema = z.object({newThreadId: z.string().min(1), crossMachine: z.boolean()});
const terminal = (j: HandoffJob) => j.phase === "done" || j.phase === "cancelled";
type Queued = Awaited<ReturnType<Sdk["threads"]["queuedMessages"]["list"]>>[number];
const ownershipNotice = (q: Queued) => q.initiator === "system" && q.payload.kind === "inline" &&
  ["ownership-assigned", "ownership-removed", "ownership-batch"].includes(q.systemNotice?.kind ?? "");

export function handoffDispatch(store: Store, ctx: MessageDispatchHookContext): MessageDispatchHookDecision | undefined {
  const job = store.list<HandoffJob>("chat:handoff:").map(r => r.value).find(j =>
    !terminal(j) && (j.frozen.includes(ctx.thread.id) || j.target === ctx.thread.id));
  if (!job) return;
  if (job.target === ctx.thread.id) {
    if (ctx.originPluginId === "handoff" && ctx.input?.text.includes(`HANDOFF-READY:${job.id}`)) return;
    if (ctx.queuedMessages?.length === 1) {
      const payload = ctx.queuedMessages[0].payload;
      if (payload.kind === "retry" && job.pickupRequests?.includes(payload.retryOfTurnRequestId)) return;
    }
  }
  return {action: "wait", reason: "Переключение помощника: сохраняю историю и рабочие подтреды.", sendAt: Date.now() + 2000};
}

/** Native handoff owns history capture and agent creation. This journal owns
 * only the Telegram binding transaction and never retries ambiguous creation. */
export class TelegramHandoff {
  private flights = new Set<string>();
  constructor(private d: {store: Store; sdk: Sdk;
    binding: (topic: number) => HandoffBinding | undefined;
    commit: (job: HandoffJob, cursor: number) => void;
    notify: (job: HandoffJob) => void;
    assertDeliveryDrained: (source: string, topic: number) => void;
  }) {}
  private save(j: HandoffJob) {
    if (this.d.store.get<HandoffJob>("chat:handoff:" + j.id)?.cancelRequested) j.cancelRequested = true;
    this.d.store.put("chat:handoff:" + j.id, j);
  }
  jobs() { return this.d.store.list<HandoffJob>("chat:handoff:").map(r => r.value); }
  active(topic: number) { return this.jobs().find(j => j.binding.topicId === topic && !terminal(j)); }
  private owns(j: HandoffJob) {
    const b = this.d.binding(j.binding.topicId);
    if (b?.threadId !== j.source || b.revision !== j.binding.revision || b.projectId !== j.binding.projectId)
      throw Error("handoff_binding_changed");
  }
  private async history() {
    return (await this.d.sdk.plugins.callRpc({pluginId: "handoff", method: "history", input: null, outputSchema: historySchema})).handoffs;
  }
  private async seq(threadId: string) {
    const events = await this.d.sdk.threads.events.list({threadId, types: ["client/turn/requested"], order: "desc", limit: "1"});
    return events[0]?.seq ?? 0;
  }
  private async pickup(j: HandoffJob) {
    const events = await this.d.sdk.threads.events.list({threadId: j.target!, types: ["client/turn/requested"], order: "asc", limit: "100"});
    if (events.length >= 100) throw Error("handoff_pickup_history_limit");
    const known: string[] = [];
    for (const event of events) {
      if (event.type !== "client/turn/requested") continue;
      const d = event.data;
      const initial = known.length === 0 && d.originPluginId === "handoff" &&
        d.input?.some(block => block.type === "text" && block.text.includes(`HANDOFF-READY:${j.id}`));
      if (!initial && (!d.retryOfRequestId || !known.includes(d.retryOfRequestId))) throw Error("handoff_target_changed");
      known.push(d.requestId);
    }
    j.pickupRequests = known;
    this.save(j);
    return known;
  }
  private async safe(id: string, transfer?: HandoffJob) {
    const rows = await this.d.sdk.threads.list({threadIds: [id], archived: false, includeHidden: true});
    const t = rows.find(t => t.id === id);
    if (!t || t.archivedAt || t.deletedAt) throw Error("handoff_thread_missing");
    if (!["idle", "error"].includes(t.status) || t.hasPendingInteraction || Object.values(t.activity).some(v => v !== 0))
      throw Error("handoff_thread_busy");
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId: id});
    if (queue.length && !(transfer?.phase === "moving" && [transfer.source, transfer.target].includes(id) && queue.every(ownershipNotice)))
      throw Error("handoff_thread_queued");
    return t;
  }
  async begin(binding: HandoffBinding, providerId: string, model: string) {
    if (!binding.threadId || this.active(binding.topicId)) throw Error("handoff_already_running");
    const j: HandoffJob = {id: randomUUID(), binding: {...binding}, source: binding.threadId,
      providerId, model, sourceSeq: 0, environmentId: "", at: Date.now(), frozen: [binding.threadId],
      priorTargets: [], phase: "preparing"};
    // Synchronous journal publication precedes all await points: dispatch and
    // Telegram ingress see the hold before any history capture can begin.
    this.save(j);
    this.flights.add(j.id);
    try {
      const source = await this.safe(j.source);
      if (!source.environmentId || source.projectId !== binding.projectId) throw Error("handoff_source_mismatch");
      if (source.providerId === providerId) throw Error("handoff_same_provider");
      const providers = await this.d.sdk.providers.list({environmentId: source.environmentId});
      if (!providers.some(p => p.id === providerId && p.available)) throw Error("handoff_provider_unavailable");
      const models = await this.d.sdk.providers.models({environmentId: source.environmentId, providerId});
      if (models.modelLoadError || !models.models.some(m => m.model === model)) throw Error("handoff_model_unavailable");
      const desc = await this.d.sdk.threads.experimental_listDescendants({threadIds: [j.source], includeHidden: true});
      j.frozen = [j.source, ...desc.threads.flatMap(r => r.descendantIds)];
      if (j.frozen.length > 100) throw Error("handoff_children_limit");
      if (this.jobs().some(other => other.id !== j.id && !terminal(other) && other.frozen.some(id => j.frozen.includes(id))))
        throw Error("handoff_overlapping_transfer");
      j.environmentId = source.environmentId;
      this.save(j);
      for (const id of j.frozen) await this.safe(id);
      this.owns(j);
      this.d.assertDeliveryDrained(j.source, binding.topicId);
      j.sourceSeq = await this.seq(j.source);
      j.priorTargets = (await this.history()).filter(h => h.sourceThreadId === j.source).map(h => h.targetThreadId);
      // No briefing turn: it would mutate source context while held.
      j.phase = "creating";
      this.save(j);
      const result = await this.d.sdk.plugins.callRpc({pluginId: "handoff", method: "startHandoff",
        input: {threadId: j.source, providerId, model, workspace: "reuse", briefing: false,
          extraInstructions: `Это только проверка передачи истории. Прочитай переданную историю как контекст, не выполняй прежние поручения повторно. Не меняй файлы, настройки, память, сервисы и проекты, не отправляй сообщения и не делегируй. Ответь только HANDOFF-READY:${j.id} и жди нового поручения.`},
        outputSchema: startedSchema});
      j.target = result.newThreadId;
      j.phase = "waiting";
      if (result.crossMachine) j.error = "handoff_wrong_machine";
      this.save(j);
    } catch (e) {
      j.error = e instanceof Error && /^handoff_[a-z_]+$/.test(e.message) ? e.message : "handoff_operation_unconfirmed";
      // Even a validation/network rejection may follow a successful native
      // spawn. The stored intent is never replayed on reload or on another click.
      j.phase = j.phase === "creating" ? "uncertain" : "cancelled";
      this.save(j);
    } finally { this.flights.delete(j.id); }
    this.d.notify(j);
    return j;
  }
  dispatch(ctx: MessageDispatchHookContext): MessageDispatchHookDecision | undefined {
    // The one native pickup turn (and its native retries) may run. Human work
    // in the new coordinator must wait until its Telegram route is committed.
    return handoffDispatch(this.d.store, ctx);
  }
  private transfer(j: HandoffJob, rollback = false) {
    return new HandoffChildren(this.d.store, this.d.sdk.threads, async () => {
      const current = this.jobs().find(x => x.id === j.id);
      if (!current || terminal(current)) throw Error("handoff_fence_lost");
      if (current.cancelRequested && !rollback) throw Error("handoff_cancel_requested");
      this.owns(j);
      if (!rollback) {
        if (await this.seq(j.source) !== j.sourceSeq) throw Error("handoff_source_changed");
        this.d.assertDeliveryDrained(j.source, j.binding.topicId);
        for (const id of j.frozen) await this.safe(id, j);
      }
    }, (id, queue) => j.phase === "moving" && [j.source, j.target].includes(id) && queue.every(ownershipNotice));
  }
  async cancel(topic: number) {
    const j = this.active(topic);
    if (!j) return;
    j.cancelRequested = true;
    this.save(j);
    if (this.flights.has(j.id)) { this.d.notify(j); return; }
    this.flights.add(j.id);
    try {
      j.phase = "rollback";
      this.save(j);
      if (this.transfer(j).get(j.id)) await this.transfer(j, true).rollback(j.id);
      j.phase = "cancelled";
      this.save(j);
      this.d.notify(j);
    } finally { this.flights.delete(j.id); }
  }
  async poll() {
    for (const j of this.jobs().filter(j => !terminal(j))) {
      if (this.flights.has(j.id)) continue;
      this.flights.add(j.id);
      try {
        if (j.cancelRequested) { j.phase = "rollback"; this.save(j); }
        if (j.phase === "preparing") {
          // Reload before native creation: safe to release, not replay.
          j.phase = "cancelled"; j.error = "handoff_preflight_interrupted"; this.save(j); this.d.notify(j); continue;
        }
        if (j.phase === "rollback") {
          if (this.transfer(j).get(j.id)) await this.transfer(j, true).rollback(j.id);
          j.phase = "cancelled"; this.save(j); this.d.notify(j); continue;
        }
        const candidates = (await this.history()).filter(h => h.sourceThreadId === j.source &&
          !j.priorTargets.includes(h.targetThreadId) && h.targetProvider === j.providerId &&
          h.model === j.model && h.workspace === "reuse" && h.at >= j.at);
        if (!j.target) {
          if (candidates.length !== 1) {
            j.phase = "uncertain";
            j.error = "handoff_creation_uncertain";
            this.save(j); this.d.notify(j); continue;
          }
          j.target = candidates[0].targetThreadId; j.phase = "waiting"; this.save(j);
        }
        if (!candidates.some(h => h.targetThreadId === j.target)) throw Error("handoff_history_mismatch");
        this.owns(j);
        if (j.error === "handoff_wrong_machine") throw Error(j.error);
        if (await this.seq(j.source) !== j.sourceSeq) throw Error("handoff_source_changed");
        for (const id of j.frozen) await this.safe(id, j);
        const target = await this.d.sdk.threads.get({threadId: j.target});
        if (target.projectId !== j.binding.projectId || target.environmentId !== j.environmentId ||
          target.providerId !== j.providerId || target.archivedAt || target.deletedAt) throw Error("handoff_target_mismatch");
        const requests = await this.pickup(j);
        const queue = (await this.d.sdk.threads.queuedMessages.list({threadId: j.target}))
          .filter(q => !(j.phase === "moving" && ownershipNotice(q)));
        if (queue.some(q => q.payload.kind === "retry" ? !requests.includes(q.payload.retryOfTurnRequestId) : q.originPluginId !== "handoff"))
          throw Error("handoff_target_changed");
        if (queue.length) {
          const dates = queue.flatMap(q => q.sendAt && q.sendAt > Date.now() ? [q.sendAt] : []);
          const retryAt = dates.length ? Math.min(...dates) : undefined;
          if (j.retryAt !== retryAt) { j.retryAt = retryAt; this.save(j); this.d.notify(j); }
          continue;
        }
        if (!['idle', 'error'].includes(target.status)) continue;
        // A failure event and native retry scheduling are separate commits.
        // Give the native retry handler time to publish its durable row.
        if (target.status === "error") {
          if (!j.errorSeenAt) {j.errorSeenAt = Date.now(); this.save(j); continue;}
          if (Date.now() - j.errorSeenAt < 10000) continue;
        }
        if (!requests.length) throw Error("handoff_pickup_unconfirmed");
        const output = await this.d.sdk.threads.output({threadId: j.target});
        if (target.status === "error" || output.output?.trim() !== `HANDOFF-READY:${j.id}`) throw Error("handoff_pickup_unconfirmed");
        const transfer = this.transfer(j);
        await transfer.prepare(j.id, j.source, j.target);
        j.phase = "moving"; this.save(j);
        await transfer.move(j.id);
        const events = await this.d.sdk.threads.events.list({threadId: j.target, order: "desc", limit: "1"});
        // Binding + journal are one SQLite transaction. A crash after this
        // point cannot reparent again or release input into the old binding.
        await this.safe(j.source, j);
        if (await this.seq(j.source) !== j.sourceSeq) throw Error("handoff_source_changed");
        this.owns(j);
        if (this.jobs().find(x => x.id === j.id)?.cancelRequested) throw Error("handoff_cancel_requested");
        this.d.store.atomic(() => {
          this.d.commit(j, events[0]?.seq ?? 0);
          j.phase = "done"; this.save(j);
        });
        this.d.notify(j);
      } catch (e) {
        j.error = e instanceof Error && /^handoff_[a-z_]+$/.test(e.message) ? e.message : "handoff_operation_unconfirmed";
        // Retain the hold on any partial transfer. A later poll reconciles
        // native parent links, including writes whose replies were lost.
        j.phase = "rollback";
        this.save(j); this.d.notify(j);
      } finally { this.flights.delete(j.id); }
    }
  }
}
