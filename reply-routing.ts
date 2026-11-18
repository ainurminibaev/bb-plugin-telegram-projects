import { randomUUID } from "node:crypto";
import type { Store } from "./model";

export type ReplyRoute = { kind: "bb" } | {
  kind: "telegram"; chatId: number; topicId: number; updateId: number; messageId?: number;
};
export function routeMarker(id:string) {
    return {type: "text" as const, visibility: "agent-only" as const, mentions: [],
      text: "[bb-telegram-reply-route:" + id + "]\nTransport metadata only; do not quote this marker in the answer."};
}
type TurnRoutes = { requestIds: string[]; ambiguous: boolean };

// This ledger requires a proven native request ID. It never guesses from the
// most recent message, text equality, a binding, or the currently active UI.
export class ReplyRoutes {
  constructor(private readonly store: Store) {}
  sameTask(a: ReplyRoute | undefined, b: ReplyRoute | undefined) {
    return a?.kind === "telegram" && b?.kind === "telegram" &&
      a.chatId === b.chatId && a.topicId === b.topicId && a.updateId === b.updateId;
  }
  private cancellationKey(route: Extract<ReplyRoute, {kind:"telegram"}>) {
    return "reply:cancelled:" + JSON.stringify([route.chatId, route.topicId, route.updateId]);
  }
  cancel(route: Extract<ReplyRoute, {kind:"telegram"}>) {
    this.store.put(this.cancellationKey(route), true);
  }
  cancelled(route?: ReplyRoute) {
    return route?.kind === "telegram" && this.store.get<boolean>(this.cancellationKey(route)) === true;
  }
  private requestKey(threadId: string, requestId: string) {
    return "reply:request:" + JSON.stringify([threadId, requestId]);
  }
  private turnKey(threadId: string, turnId: string) {
    return "reply:turn:" + JSON.stringify([threadId, turnId]);
  }
  ingress(threadId: string | null, route: Extract<ReplyRoute, {kind: "telegram"}>, delegatedBy?: string, reportKey?: string) {
    const id = randomUUID();
    this.store.put("reply:ingress:" + id, {threadId, route, delegatedBy, reportKey});
    return routeMarker(id);
  }
  delegatedIngress(parentThreadId: string, token: string, childThreadId: string | null) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw Error("invalid_parent_route_token");
    const parent = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string}>("reply:ingress:" + token);
    if (!parent || parent.threadId !== parentThreadId || !parent.requestId || parent.route.kind !== "telegram")
      throw Error("unproven_parent_request");
    const accepted = this.store.get<ReplyRoute>(this.requestKey(parentThreadId, parent.requestId));
    if (this.cancelled(parent.route) || !this.sameTask(accepted, parent.route)) throw Error("parent_route_conflict");
    return this.ingress(childThreadId, parent.route, parentThreadId);
  }
  assertCurrentDelegation(parentThreadId: string, token: string, currentRequestId: string) {
    const parent = this.store.get<{threadId: string; route: ReplyRoute}>("reply:ingress:" + token);
    const current = this.store.get<ReplyRoute>(this.requestKey(parentThreadId,currentRequestId));
    if (!parent || parent.threadId !== parentThreadId || !this.sameTask(parent.route,current))
      throw Error("route_token_does_not_match_current_request");
  }
  complete(threadId: string, turnId: string, status: string) {
    const route = this.destination(threadId, turnId);
    // Retain BB outcomes too: an ambiguous reused worker must never inherit
    // an older Telegram task just because only that task has a destination.
    const key = "reply:outcome:" + JSON.stringify([threadId, turnId]);
    if (this.store.get(key)) return;
    const turn = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId));
    const owners = turn ? this.owningRequests(threadId, turn) : [];
    const parents = owners.map(id => this.parentOf(threadId, id));
    const delegatedBy = parents[0] && parents.every(id => id === parents[0]) ? parents[0] : undefined;
    // A delegated turn that mixed separate submissions has no single exact
    // destination. It is still reported to its coordinator, explicitly marked,
    // so the coordinator answers the owner instead of the result being lost.
    const first = turn?.requestIds.length ? this.store.get<ReplyRoute>(this.requestKey(threadId, turn.requestIds[0])) : undefined;
    const mixedParent = turn?.ambiguous ? this.parentOf(threadId, turn.requestIds[0]) : undefined;
    const mixed = !route && mixedParent && first?.kind === "telegram" && !this.cancelled(first) &&
      owners.every(id => {
        const r = this.store.get<ReplyRoute>(this.requestKey(threadId, id));
        return r?.kind !== "telegram" || (r.chatId === first.chatId && r.topicId === first.topicId);
      }) ? first : undefined;
    this.store.atomic(() => {
      this.store.put(key, {threadId, turnId, status, route, consumedBy: null});
      if (route?.kind === "telegram" && delegatedBy)
        this.store.put("reply:pending-child:" + JSON.stringify([delegatedBy,threadId,turnId]),
          {parent:delegatedBy, threadId, turnId, status, route});
      else if (mixed && mixedParent)
        this.store.put("reply:pending-child:" + JSON.stringify([mixedParent,threadId,turnId]),
          {parent:mixedParent, threadId, turnId, status, route:mixed, mixed:true});
    });
  }
  reserveChildReports(parent: string, chatId: number, topicId: number) {
    type Report = {parent:string; threadId:string; turnId:string; status:string; route:Extract<ReplyRoute,{kind:"telegram"}>; mixed?:boolean};
    const parentPrefix = JSON.stringify([parent]).slice(0,-1) + ",";
    for (const {key,value} of this.store.list<Report>("reply:pending-child:" + parentPrefix)) {
      if (value.route.chatId !== chatId || value.route.topicId !== topicId) continue;
      const outcomeKey = "reply:outcome:" + JSON.stringify([value.threadId,value.turnId]);
      const row = this.store.get<{consumedBy:string|null}>(outcomeKey);
      if (this.cancelled(value.route)) {
        this.store.del(key);
        continue;
      }
      if (!row || row.consumedBy !== null) continue;
      this.store.atomic(() => {
        const reportKey = "reply:child-report:" + JSON.stringify([parent,value.threadId,value.turnId]);
        const marker = this.ingress(parent,value.route,undefined,reportKey);
        this.store.put(outcomeKey,{...row,consumedBy:reportKey});
        this.store.put(reportKey,{...value,marker,state:"reserved"});
        this.store.del(key);
      });
    }
    return this.store.list<Report & {marker:ReturnType<ReplyRoutes["ingress"]>;state:string; startedAt?:number}>("reply:child-report:" + parentPrefix)
      .filter(({value}) => !this.cancelled(value.route) && value.route.chatId === chatId && value.route.topicId === topicId &&
        (value.state === "reserved" || (["submitting","submitted","uncertain"].includes(value.state) &&
          value.startedAt !== undefined && Date.now() - value.startedAt > 60_000)));
  }
  retryBelongsToTurn(threadId: string, turnId: string, originalRequestId: string) {
    return this.sameTask(this.destination(threadId, turnId),
      this.store.get<ReplyRoute>(this.requestKey(threadId, originalRequestId)));
  }
  inheritOutcomes(threadId: string, requestId: string, outcomes: readonly {threadId: string; status: string; turnId?: string | null}[]) {
    if (!outcomes.length || new Set(outcomes.map(o => o.threadId)).size !== outcomes.length) return false;
    // Stock BB can omit the run ID even for a delayed or pre-turn notice.
    // A single unconsumed ledger row does not identify that notice.
    if (outcomes.some(outcome => !outcome.turnId)) return false;
    const consumer = threadId + ":" + requestId;
    type Outcome = {status: string; route?: ReplyRoute; consumedBy: string | null};
    const rows: {key: string; value: Outcome}[] = [];
    for (const outcome of outcomes) {
      const key = "reply:outcome:" + JSON.stringify([outcome.threadId, outcome.turnId]);
      const value = this.store.get<Outcome>(key);
      if (!value || value.status !== outcome.status ||
          (value.consumedBy !== null && value.consumedBy !== consumer)) return false;
      rows.push({key, value});
    }
    const route = rows[0].value.route;
    if (!route || rows.some(row => route.kind === "bb" ? row.value.route?.kind !== "bb" : !this.sameTask(route, row.value.route))) return false;
    this.store.atomic(() => {
      this.record(threadId, requestId, route);
      for (const [i,row] of rows.entries()) {
        this.store.put(row.key, {...row.value, consumedBy: consumer});
        this.store.del("reply:pending-child:" + JSON.stringify([threadId,outcomes[i].threadId,outcomes[i].turnId]));
      }
    });
    return true;
  }
  bindIngress(marker: {text: string}, threadId: string) {
    const id = /^\[bb-telegram-reply-route:([a-f0-9-]{36})\]/.exec(marker.text)?.[1];
    if (!id) throw Error("invalid_ingress_marker");
    const key = "reply:ingress:" + id;
    const row = this.store.get<{threadId: string | null; route: ReplyRoute}>(key);
    if (!row || (row.threadId !== null && row.threadId !== threadId)) throw Error("ingress_thread_conflict");
    this.store.put(key, {...row, threadId});
  }
  requested(threadId: string, data: {
    requestId: string; originPluginId?: string; retryOfRequestId?: string;
    initiator?: string; systemMessageKind?: string; senderThreadId?: string | null;
    input?: readonly {type: string; text?: string; visibility?: string}[];
  }) {
    if (data.retryOfRequestId) return this.retry(threadId, data.requestId, data.retryOfRequestId);
    if (data.originPluginId !== "telegram-projects") {
      this.record(threadId, data.requestId, {kind: "bb"});
      if (data.initiator === "system" && data.systemMessageKind?.startsWith("child-"))
        this.unroutedNotice(threadId, data.requestId);
      else if (data.initiator === "agent" && data.senderThreadId)
        this.store.put(this.auxiliaryKey(threadId, data.requestId), {kind: "agent", senderThreadId: data.senderThreadId});
      return true;
    }
    const ids = (data.input ?? []).flatMap(block => {
      if (block.type !== "text" || block.visibility !== "agent-only") return [];
      const id = /^\[bb-telegram-reply-route:([a-f0-9-]{36})\]\nTransport metadata only; do not quote this marker in the answer\.$/.exec(block.text ?? "")?.[1];
      return id ? [id] : [];
    });
    if (ids.length !== 1) return false;
    const ingress = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string; delegatedBy?: string; reportKey?: string}>("reply:ingress:" + ids[0]);
    if (!ingress || ingress.threadId !== threadId ||
        (ingress.requestId && ingress.requestId !== data.requestId)) return false;
    this.record(threadId, data.requestId, ingress.route);
    this.store.put("reply:ingress:" + ids[0], {...ingress, requestId: data.requestId});
    // A persisted native request proves BB accepted the submission even if the
    // original SDK response was lost. Replaying this event is idempotent.
    if (ingress.reportKey) this.store.del(ingress.reportKey);
    const parent = ingress.delegatedBy;
    if (parent) this.store.put("reply:request-parent:" + this.requestKey(threadId,data.requestId),parent);
    return true;
  }
  record(threadId: string, requestId: string, route: ReplyRoute) {
    const key = this.requestKey(threadId, requestId);
    const previous = this.store.get<ReplyRoute>(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(route))
      throw Error("reply_route_conflict");
    this.store.put(key, route);
  }
  retry(threadId: string, requestId: string, originalRequestId: string) {
    const original = this.store.get<ReplyRoute>(this.requestKey(threadId, originalRequestId));
    if (!original) return false;
    this.record(threadId, requestId, original);
    const parent = this.store.get<string>("reply:request-parent:" + this.requestKey(threadId,originalRequestId));
    if (parent) this.store.put("reply:request-parent:" + this.requestKey(threadId,requestId),parent);
    return true;
  }
  accept(threadId: string, turnId: string, requestId: string) {
    const key = this.turnKey(threadId, turnId);
    const turn = this.store.get<TurnRoutes>(key) ?? {requestIds: [], ambiguous: false};
    if (!turn.requestIds.includes(requestId)) turn.requestIds.push(requestId);
    const owners = this.owningRequests(threadId, turn);
    const routes = owners.map(id => this.store.get<ReplyRoute>(this.requestKey(threadId, id)));
    // Child notifications can continue the exact same task. Different updates
    // in the same topic are still different tasks and cannot be merged safely.
    const first = routes[0];
    turn.ambiguous ||= routes.some(r => !r || !first ||
      (first.kind === "bb" ? r.kind !== "bb" : !this.sameTask(first, r)));
    this.store.put(key, turn);
  }
  /** A notice about the thread's own child that carries no Telegram task. */
  unroutedNotice(threadId: string, requestId: string) {
    this.store.put(this.auxiliaryKey(threadId, requestId), {kind: "child-notice"});
  }
  private auxiliaryKey(threadId: string, requestId: string) {
    return "reply:auxiliary:" + JSON.stringify([threadId, requestId]);
  }
  private parentOf(threadId: string, requestId: string) {
    return this.store.get<string>("reply:request-parent:" + this.requestKey(threadId, requestId));
  }
  // Requests that decide a turn's destination. A notice about the worker's own
  // children, or a BB message from the coordinator that delegated this turn,
  // steered into an already started turn continues that same task. It must not
  // make the turn ambiguous: its first request still identifies the destination.
  private owningRequests(threadId: string, turn: TurnRoutes) {
    const delegatedBy = turn.requestIds.length ? this.parentOf(threadId, turn.requestIds[0]) : undefined;
    return turn.requestIds.filter((id, i) => {
      if (i === 0) return true;
      const aux = this.store.get<{kind: string; senderThreadId?: string}>(this.auxiliaryKey(threadId, id));
      return !(aux?.kind === "child-notice" || (aux?.kind === "agent" && delegatedBy && aux.senderThreadId === delegatedBy));
    });
  }
  destination(threadId: string, turnId: string): ReplyRoute | undefined {
    const turn = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId));
    if (!turn || turn.ambiguous || !turn.requestIds.length) return undefined;
    const route = this.store.get<ReplyRoute>(this.requestKey(threadId, turn.requestIds[0]));
    return this.cancelled(route) ? undefined : route;
  }
}
