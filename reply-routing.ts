import { randomUUID } from "node:crypto";
import type { Store } from "./model";

export type ReplyRoute = { kind: "bb" } | {
  kind: "telegram"; chatId: number; topicId: number; updateId: number;
};
type TurnRoutes = { requestIds: string[]; ambiguous: boolean };

// This ledger requires a proven native request ID. It never guesses from the
// most recent message, text equality, a binding, or the currently active UI.
export class ReplyRoutes {
  constructor(private readonly store: Store) {}
  sameTask(a: ReplyRoute | undefined, b: ReplyRoute | undefined) {
    return a?.kind === "telegram" && b?.kind === "telegram" &&
      a.chatId === b.chatId && a.topicId === b.topicId && a.updateId === b.updateId;
  }
  private requestKey(threadId: string, requestId: string) {
    return "reply:request:" + JSON.stringify([threadId, requestId]);
  }
  private turnKey(threadId: string, turnId: string) {
    return "reply:turn:" + JSON.stringify([threadId, turnId]);
  }
  ingress(threadId: string | null, route: Extract<ReplyRoute, {kind: "telegram"}>) {
    const id = randomUUID();
    this.store.put("reply:ingress:" + id, {threadId, route});
    return {type: "text" as const, visibility: "agent-only" as const, mentions: [],
      text: "[bb-telegram-reply-route:" + id + "]\nTransport metadata only; do not quote this marker in the answer."};
  }
  delegatedIngress(parentThreadId: string, token: string, childThreadId: string | null) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw Error("invalid_parent_route_token");
    const parent = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string}>("reply:ingress:" + token);
    if (!parent || parent.threadId !== parentThreadId || !parent.requestId || parent.route.kind !== "telegram")
      throw Error("unproven_parent_request");
    const accepted = this.store.get<ReplyRoute>(this.requestKey(parentThreadId, parent.requestId));
    if (!this.sameTask(accepted, parent.route)) throw Error("parent_route_conflict");
    return this.ingress(childThreadId, parent.route);
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
    if (!this.store.get(key)) this.store.put(key, {threadId, turnId, status, route, consumedBy: null});
  }
  retryBelongsToTurn(threadId: string, turnId: string, originalRequestId: string) {
    return this.sameTask(this.destination(threadId, turnId),
      this.store.get<ReplyRoute>(this.requestKey(threadId, originalRequestId)));
  }
  inheritOutcomes(threadId: string, requestId: string, outcomes: readonly {threadId: string; status: string}[]) {
    if (!outcomes.length || new Set(outcomes.map(o => o.threadId)).size !== outcomes.length) return false;
    const candidates = outcomes.map(outcome => this.store.list<{
      threadId: string; status: string; route?: ReplyRoute; consumedBy: string | null;
    }>("reply:outcome:").filter(({value}) => value.threadId === outcome.threadId &&
      value.status === outcome.status && (value.consumedBy === null || value.consumedBy === threadId + ":" + requestId)));
    if (candidates.some(rows => rows.length !== 1)) return false;
    const rows = candidates.map(rows => rows[0]);
    const route = rows[0].value.route;
    if (!route || rows.some(row => route.kind === "bb" ? row.value.route?.kind !== "bb" : !this.sameTask(route, row.value.route))) return false;
    this.store.atomic(() => {
      this.record(threadId, requestId, route);
      for (const row of rows) this.store.put(row.key, {...row.value, consumedBy: threadId + ":" + requestId});
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
    input?: readonly {type: string; text?: string; visibility?: string}[];
  }) {
    if (data.retryOfRequestId) return this.retry(threadId, data.requestId, data.retryOfRequestId);
    if (data.originPluginId !== "telegram-projects") {
      this.record(threadId, data.requestId, {kind: "bb"});
      return true;
    }
    const ids = (data.input ?? []).flatMap(block => {
      if (block.type !== "text" || block.visibility !== "agent-only") return [];
      const id = /^\[bb-telegram-reply-route:([a-f0-9-]{36})\]\nTransport metadata only; do not quote this marker in the answer\.$/.exec(block.text ?? "")?.[1];
      return id ? [id] : [];
    });
    if (ids.length !== 1) return false;
    const ingress = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string}>("reply:ingress:" + ids[0]);
    if (!ingress || ingress.threadId !== threadId ||
        (ingress.requestId && ingress.requestId !== data.requestId)) return false;
    this.record(threadId, data.requestId, ingress.route);
    this.store.put("reply:ingress:" + ids[0], {...ingress, requestId: data.requestId});
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
    return true;
  }
  accept(threadId: string, turnId: string, requestId: string) {
    const key = this.turnKey(threadId, turnId);
    const turn = this.store.get<TurnRoutes>(key) ?? {requestIds: [], ambiguous: false};
    if (!turn.requestIds.includes(requestId)) turn.requestIds.push(requestId);
    const routes = turn.requestIds.map(id => this.store.get<ReplyRoute>(this.requestKey(threadId, id)));
    // Child notifications can continue the exact same task. Different updates
    // in the same topic are still different tasks and cannot be merged safely.
    const first = routes[0];
    turn.ambiguous ||= routes.some(r => !r || !first ||
      (first.kind === "bb" ? r.kind !== "bb" : !this.sameTask(first, r)));
    this.store.put(key, turn);
  }
  destination(threadId: string, turnId: string): ReplyRoute | undefined {
    const turn = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId));
    if (!turn || turn.ambiguous || !turn.requestIds.length) return undefined;
    return this.store.get<ReplyRoute>(this.requestKey(threadId, turn.requestIds[0]));
  }
}
