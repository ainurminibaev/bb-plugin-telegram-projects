import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import type { Store } from "./model";

export type ReplyRoute = { kind: "bb" } | {
  kind: "telegram"; chatId: number; topicId: number; updateId: number; messageId?: number;
};
const ownerResultInstructions = "\nIf your final answer includes the completed result of a delegated BB turn, append " +
  "one Markdown comment on its own line for each such result: <!-- bb-telegram-child-result:CHILD_THREAD_ID:CHILD_TURN_ID -->. " +
  "Use the exact turn ID from the child's BB event log. Omit this comment for launch acknowledgements, " +
  "progress updates, or results you did not include. The bridge removes the comment from Telegram.";

export type ChildResult = {threadId: string; turnId: string};

export function splitChildResultClaims(text: string) {
  const claims: ChildResult[] = [];
  const body = text.replace(/^<!-- bb-telegram-child-result:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+) -->[ \t]*\r?$/gm,
    (_, threadId: string, turnId: string) => {
      claims.push({threadId, turnId});
      return "";
    });
  return {body: body.trim(), claims};
}

// Telegram accepts both plain text and formatted replies. Keep the exact
// claim parser above separate: display-only variants cannot acknowledge work.
export function stripTelegramMarkers(text: string) {
  return text.replace(/^[ \t]*(?:<!--[ \t]*bb-telegram-child-result:[\w-]+:[\w-]+[ \t]*-->|bb-telegram-child-result:[\w-]+:[\w-]+|\[bb-telegram-reply-route:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\])[ \t]*(?:\r?\n|$)/gm, "");
}

export function routeMarker(id:string, owner = false) {
    return {type: "text" as const, visibility: "agent-only" as const, mentions: [],
      text: "[bb-telegram-reply-route:" + id + "]\nTransport metadata only; do not quote this marker in the answer." +
        (owner ? ownerResultInstructions : "")};
}
type TurnRoutes = { requestIds: string[]; ambiguous: boolean };
type FinalClaim = { route: ReplyRoute; outboxKey: string; writtenAt?: number; native?: boolean };
type Outcome = {status: string; route?: ReplyRoute; consumedBy: string | null; completedAt?: number; parent?: string};
type Report = ChildResult & {
  parent: string; status: string; route: Extract<ReplyRoute, {kind:"telegram"}>; mixed?: boolean;
};
type Disposition = "wait" | "delivered" | undefined;

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
  ingress(threadId: string | null, route: Extract<ReplyRoute, {kind: "telegram"}>, delegatedBy?: string, reportKey?: string, originalDigest?:string, id = randomUUID()) {
    this.store.put("reply:ingress:" + id, {threadId, route, delegatedBy, reportKey,...(originalDigest && {originalDigest})});
    return routeMarker(id, !delegatedBy && !reportKey);
  }
  // The reply label is public in the native timeline and carries no permission
  // to delegate. The separate hidden ingress token proves the native request.
  busyIngress(threadId: string, route: Extract<ReplyRoute, {kind: "telegram"}>, digest?: string) {
    const token = randomUUID();
    const marker = this.ingress(threadId, route, undefined, undefined, digest, token);
    const uuid = randomUUID();
    const short = uuid.slice(0, 8);
    const reserved = "reply:busy-selector:" + short;
    // Reserve before BB accepts the request, so concurrent pending inputs
    // cannot receive the same selector. Retain UUIDs as the collision fallback.
    let label: string = uuid;
    this.store.atomic(() => {
      if (!this.store.get(reserved)) {
        this.store.put(reserved, true);
        label = short;
      }
      this.store.put("reply:busy-ingress:" + token, label);
    });
    return [marker, {type: "text" as const, visibility: "agent-only" as const, mentions: [],
      text: "This private Telegram message arrived while work was running. Answer the owner's message promptly in a separate public assistant message. " +
        "Start that message with this line exactly: [telegram-answer:" + label + "]. On the following lines write only the answer intended for this message. " +
        "End it with [/telegram-answer] on a line of its own. The bridge sends the enclosed answer only if the selector matches exactly. " +
        "Copy only the selector shown for this message. Never guess or reuse another message's selector. " +
        "Continue the ongoing work in a separate message."}];
  }
  private markerId(input: readonly {type: string; text?: string; visibility?: string}[]) {
    const ids = input.flatMap(block => {
      if (block.type !== "text" || block.visibility !== "agent-only") return [];
      const id = /^\[bb-telegram-reply-route:([a-f0-9-]{36})\]/.exec(block.text ?? "")?.[1];
      return id && (block.text === routeMarker(id).text || block.text === routeMarker(id, true).text) ? [id] : [];
    });
    return ids.length === 1 ? ids[0] : undefined;
  }
  busyInput(threadId: string, input: readonly {type: string; text?: string; visibility?: string}[]) {
    const token = this.markerId(input);
    if (!token || !this.store.get<string>("reply:busy-ingress:" + token)) return false;
    const ingress = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string}>("reply:ingress:" + token);
    return ingress?.threadId === threadId && !ingress.requestId && !this.cancelled(ingress.route);
  }
  busyAnswer(threadId: string, turnId: string, label: string) {
    const requestId = this.store.get<string>("reply:busy-answer:" + label);
    if (!requestId) return;
    const turn = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId));
    if (!turn?.requestIds.includes(requestId)) return;
    const route = this.routeOf(threadId, requestId);
    return route?.kind === "telegram" && !this.cancelled(route) ? route : undefined;
  }
  busyLabel(threadId: string, requestId: string) {
    const label = this.store.get<string>("reply:busy-source-label:" + this.requestKey(threadId,requestId));
    return label && this.store.get("reply:busy-answer:"+label) === requestId ? label : undefined;
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
  complete(threadId: string, turnId: string, status: string, completedAt?: number) {
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
      this.store.put(key, {threadId, turnId, status, route, consumedBy: null, completedAt, parent: delegatedBy ?? mixedParent});
      if (route?.kind === "telegram" && delegatedBy)
        this.store.put("reply:pending-child:" + JSON.stringify([delegatedBy,threadId,turnId]),
          {parent:delegatedBy, threadId, turnId, status, route});
      else if (mixed && mixedParent)
        this.store.put("reply:pending-child:" + JSON.stringify([mixedParent,threadId,turnId]),
          {parent:mixedParent, threadId, turnId, status, route:mixed, mixed:true});
    });
  }
  private claimPrefix(parent: string, child: ChildResult) {
    return "reply:final-claim:" + JSON.stringify([parent, child.threadId, child.turnId]).slice(0, -1) + ",";
  }
  claimFinal(parent: string, turnId: string, claims: readonly ChildResult[], final: FinalClaim) {
    for (const child of claims)
      this.store.put(this.claimPrefix(parent, child) + JSON.stringify(turnId) + "]", final);
  }
  finalDelivered(outboxKey: string) {
    this.store.put("reply:final-delivered:" + outboxKey, true);
  }
  private disposition(report: Report, activeRoute?: ReplyRoute): Disposition {
    if (report.mixed) return;
    const outcome = this.store.get<Outcome>("reply:outcome:" + JSON.stringify([report.threadId, report.turnId]));
    let waiting = this.sameTask(activeRoute, report.route);
    for (const {value} of this.store.list<FinalClaim>(this.claimPrefix(report.parent, report))) {
      if (!this.sameTask(value.route, report.route)) continue;
      if (!value.native && (outcome?.status !== "completed" || outcome.completedAt === undefined ||
          value.writtenAt === undefined || value.writtenAt < outcome.completedAt)) continue;
      if (this.store.get("reply:final-delivered:" + value.outboxKey)) return "delivered";
      const outbox = this.store.get<{sentId?: number}>(value.outboxKey);
      if (outbox && !outbox.sentId) waiting = true;
    }
    return waiting ? "wait" : undefined;
  }
  reserveChildReports(parent: string, chatId: number, topicId: number, activeRoute?: ReplyRoute) {
    const parentPrefix = JSON.stringify([parent]).slice(0,-1) + ",";
    for (const {key,value} of this.store.list<Report>("reply:pending-child:" + parentPrefix)) {
      if (value.route.chatId !== chatId || value.route.topicId !== topicId) continue;
      const outcomeKey = "reply:outcome:" + JSON.stringify([value.threadId,value.turnId]);
      const row = this.store.get<Outcome>(outcomeKey);
      if (this.cancelled(value.route)) {
        this.store.del(key);
        continue;
      }
      if (!row || row.consumedBy !== null) continue;
      const disposition = this.disposition(value, activeRoute);
      if (disposition === "wait") continue;
      if (disposition === "delivered") {
        this.store.atomic(() => {
          this.store.put(outcomeKey, {...row, consumedBy: "parent-final"});
          this.store.del(key);
        });
        continue;
      }
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
          value.startedAt !== undefined && Date.now() - value.startedAt > 60_000)))
      .filter(({key,value}) => {
        if (value.state !== "reserved") return true;
        const disposition = this.disposition(value, activeRoute);
        if (disposition === "delivered") this.store.del(key);
        return disposition === undefined;
      });
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
    const children = outcomes.map(o => ({threadId: o.threadId, turnId: o.turnId!}));
    const pendingKeys = children.map(child => "reply:pending-child:" +
      JSON.stringify([threadId, child.threadId, child.turnId]));
    const reports = pendingKeys.map(key => this.store.get<Report>(key));
    const delegated = route.kind === "telegram" && (reports.some(Boolean) || rows.some(row => row.value.parent));
    const nativeOwnerKeys = rows.map(row => "reply:native-owner:" + row.key);
    if (delegated && children.some((_, i) => {
      const report = reports[i];
      const owner = this.store.get<string>(nativeOwnerKeys[i]);
      return !report || rows[i].value.consumedBy !== null || (owner && owner !== consumer) ||
        this.disposition(report) !== undefined;
    })) return false;
    this.store.atomic(() => {
      this.record(threadId, requestId, route);
      // Keep a Telegram outcome pending until this notification's final reaches
      // Telegram. A notification steered into the owner's turn is not consent
      // to cover that outcome in the owner's answer.
      if (delegated) {
        for (const key of nativeOwnerKeys) this.store.put(key, consumer);
        this.store.put(this.nativeOutcomesKey(threadId, requestId), children);
        return;
      }
      for (const [i,row] of rows.entries()) {
        this.store.put(row.key, {...row.value, consumedBy: consumer});
        this.store.del("reply:pending-child:" + JSON.stringify([threadId,outcomes[i].threadId,outcomes[i].turnId]));
      }
    });
    return true;
  }
  private nativeOutcomesKey(threadId: string, requestId: string) {
    return "reply:native-outcomes:" + JSON.stringify([threadId, requestId]);
  }
  nativeOutcomes(threadId: string, turnId: string) {
    const requestId = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId))?.requestIds[0];
    return requestId ? this.store.get<ChildResult[]>(this.nativeOutcomesKey(threadId, requestId)) ?? [] : [];
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
    const token = this.markerId(data.input ?? []);
    if (!token) return false;
    const ingress = this.store.get<{threadId: string; route: ReplyRoute; requestId?: string; delegatedBy?: string; reportKey?: string}>("reply:ingress:" + token);
    if (!ingress || ingress.threadId !== threadId ||
        (ingress.requestId && ingress.requestId !== data.requestId)) return false;
    this.record(threadId, data.requestId, ingress.route);
    this.store.put("reply:ingress:" + token, {...ingress, requestId: data.requestId});
    const label = this.store.get<string>("reply:busy-ingress:" + token);
    if (label) {
      this.store.put("reply:busy-answer:" + label, data.requestId);
      this.store.put("reply:busy-source-label:" + this.requestKey(threadId,data.requestId),label);
      this.store.put(this.auxiliaryKey(threadId, data.requestId), {kind: "busy-reply"});
    }
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
      if (aux?.kind === "busy-reply") {
        const primary = this.routeOf(threadId, turn.requestIds[0]);
        const incoming = this.routeOf(threadId, id);
        // Only the addressed message is delivered to the owner. The original
        // turn keeps its own destination, including BB-only background work.
        if (primary?.kind === "bb" || (primary?.kind === "telegram" && incoming?.kind === "telegram" &&
            primary.chatId === incoming.chatId && primary.topicId === incoming.topicId)) return false;
      }
      return !(aux?.kind === "child-notice" || (aux?.kind === "agent" && delegatedBy && aux.senderThreadId === delegatedBy));
    });
  }
  canJoinNativeAgent(threadId:string,senderThreadId:string,
    history:Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>) {
    const events=[...history].sort((a,b)=>b.seq-a.seq);
    const started=events.find(event=>event.type==="turn/started");
    const boundary=events.find(event=>event.type==="turn/completed");
    if (started?.scope.kind!=="turn" || (boundary && boundary.seq>started.seq) ||
        (!boundary && events.length>=100)) return false;

    const turnId=started.scope.turnId;
    const requests=new Map(events.flatMap(event=>event.type==="client/turn/requested" ?
      [[event.data.requestId,event] as const] : []));
    const acceptedIds=new Set(events.flatMap(event=>event.type==="turn/input/accepted" ?
      [event.data.clientRequestId] : []));
    const active=events.flatMap(event=>event.type==="turn/input/accepted" &&
      event.scope.kind==="turn" && event.scope.turnId===turnId ? [event.data.clientRequestId] : []).reverse();
    for (const event of requests.values()) {
      // Let the provider finish accepting any earlier input before joining.
      const target=event.data.target;
      if (event.seq>(boundary?.seq??0) && !acceptedIds.has(event.data.requestId) &&
          (target.kind==="new-turn" || ("expectedTurnId" in target && target.expectedTurnId===turnId))) return false;
    }

    const turn=this.store.get<TurnRoutes>(this.turnKey(threadId,turnId));
    if (turn?.ambiguous) return false;
    const primary=active[0];
    const delegated=primary && this.parentOf(threadId,primary)===senderThreadId &&
      this.destination(threadId,turnId)?.kind==="telegram";
    for (const id of active) {
      const request=requests.get(id)?.data;
      if (!request) return false;
      if (request.originPluginId) {
        if (delegated && id===primary) continue;
        // An addressed Telegram check-in already proven auxiliary leaves the
        // BB or delegated turn's exact original destination intact.
        if (!turn || !turn.requestIds.includes(id) || this.owningRequests(threadId,turn).includes(id)) return false;
      } else if (request.initiator==="agent" && request.senderThreadId!==senderThreadId) {
        return false;
      }
    }
    return true;
  }
  routeOf(threadId: string, requestId: string) {
    return this.store.get<ReplyRoute>(this.requestKey(threadId, requestId));
  }
  destination(threadId: string, turnId: string): ReplyRoute | undefined {
    const turn = this.store.get<TurnRoutes>(this.turnKey(threadId, turnId));
    if (!turn || turn.ambiguous || !turn.requestIds.length) return undefined;
    const route = this.store.get<ReplyRoute>(this.requestKey(threadId, turn.requestIds[0]));
    return this.cancelled(route) ? undefined : route;
  }
}
