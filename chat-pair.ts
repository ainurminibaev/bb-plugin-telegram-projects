import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { Store } from "./model";
import type { ReplyRoute } from "./reply-routing";
import { z } from "zod";
import { routeMarker } from "./reply-routing";

/**
 * Постоянная пара тредов одного чата: основной и резервный (обычно разные
 * провайдеры). Когда действующий тред упирается в лимит модели, чат
 * переключается на второй тред, а сообщение, на котором случился лимит,
 * переотправляется туда со своим маршрутом ответа. Новые треды не создаются,
 * старые не архивируются. Возврат на основной — на границе хода, когда его
 * лимит истёк, а резерв свободен и без очереди.
 */
type Sdk = BbPluginApi["sdk"];
type Telegram = Extract<ReplyRoute, {kind: "telegram"}>;

export type ChatPair = {
  topicId: number;
  projectId: string;
  primary: string;
  fallback: string;
  /** Название без пометки состояния, по треду. */
  titles: Record<string, string>;
  /** Когда у треда истекает лимит (по времени штатного повтора). */
  blockedUntil: Record<string, number>;
  /** Когда тред перестал быть действующим — начало сводки «что было без тебя». */
  inactiveSince: Record<string, number>;
  /** Сообщение ждёт: заняты оба треда. */
  waiting?: {threadId: string; turnId: string; retryId?: string; at: number};
  /** Последнее переключение: не повторять уведомление при быстром возврате. */
  lastSwitch?: {from: string; to: string; at: number; kind: "limit" | "return" | "manual"};
  /** Когда последний раз убирали завершённые треды помощника. */
  lastCleanup?: number;
  /** Последний список незаконченных для владельца: номер → тред. */
  roster?: {at: number; items: {n: number; threadId: string}[]};
  /** Последняя проставленная пометка, чтобы не переименовывать впустую. */
  marks?: Record<string, string>;
};

export type ThreadRow = {
  id: string; projectId: string; environmentId: string | null; providerId: string;
  status: string; title: string | null; parentThreadId: string | null;
  archivedAt?: number | null; deletedAt?: number | null; visibility?: string;
};

type Binding = {topicId: number; projectId: string; threadId: string | null; revision: string; [k: string]: unknown};

export type PairDeps = {
  store: Store;
  sdk: Sdk;
  signal: AbortSignal;
  binding: (topicId: number) => Binding | undefined;
  /** Записать привязку штатным путём моста (с проверкой групп). */
  save: (b: Binding) => void;
  fresh: () => string;
  /** Тема занята: идёт обработка входящего. */
  busy: (topicId: number) => boolean;
  notify: (topicId: number, text: string, id: string) => void;
  /** Маршрут ответа хода (кому в Telegram ушёл бы ответ). */
  destination: (threadId: string, turnId: string) => ReplyRoute | undefined;
  requestIds: (threadId: string, turnId: string) => string[];
  retryBelongsToTurn: (threadId: string, turnId: string, retryOf: string) => boolean;
  /**
   * Фактический лимит провайдера треда на его машине: true — есть запас,
   * false — исчерпан, undefined — неизвестно. Нужен, чтобы вернуться раньше
   * расчётного времени, если лимит сняли досрочно.
   */
  available?: (threadId: string) => Promise<boolean | undefined>;
  ingress: (threadId: string, route: Telegram) => ReturnType<typeof routeMarker>;
};

const KEY = "chat:pair:";
const URGENT = "chat:pair:urgent:";
const HANDLED = "chat:pair:handled:";
const MOVED = "chat:pair:moved-child:";
const REPLAYED = "chat:pair:replayed:";
const MARK_ACTIVE = "🟢 Действующий";
const MARK_STANDBY = "⏸ Резерв";
const MARK_WAITING = "⏳ Ждёт лимита";
const MARKS = [MARK_ACTIVE, MARK_STANDBY, MARK_WAITING];
const MARKER = /^\[bb-telegram-reply-route:[^\]]+\][\s\S]*$/;
const SUMMARY_LIMIT = 6000;
/** Разделитель: всё после него — собственно сообщение владельца, до него — служебная шапка. */
export const OWNER_MESSAGE = "Сообщение владельца:\n";
const ownerPart = (text: string) => {
  const i = text.lastIndexOf(OWNER_MESSAGE);
  return i >= 0 ? text.slice(i + OWNER_MESSAGE.length) : text;
};

export const msk = (ms: number) => new Date(ms).toLocaleString("ru-RU", {
  timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
const sameDay = (a: number, b: number) => new Date(a + 3 * 3600_000).toISOString().slice(0, 10) ===
  new Date(b + 3 * 3600_000).toISOString().slice(0, 10);
const when = (ms: number) => sameDay(ms, Date.now())
  ? new Date(ms).toLocaleTimeString("ru-RU", {timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit"}) : msk(ms);

/** Снять пометку состояния с названия: «🟢 Действующий · X» → «X». */
export function baseTitle(title: string) {
  for (const m of MARKS) if (title.startsWith(m + " · ")) return title.slice(m.length + 3);
  return title;
}
export const providerLabel = (providerId: string) =>
  providerId === "codex" ? "Codex" : providerId === "claude-code" ? "Claude" : providerId;

export class ChatPairs {
  constructor(private d: PairDeps) {}

  get(topicId: number) { return this.d.store.get<ChatPair>(KEY + topicId); }
  private put(p: ChatPair) { this.d.store.put(KEY + p.topicId, p); }
  list() { return this.d.store.list<ChatPair>(KEY).filter(r => /^chat:pair:\d+$/.test(r.key)).map(r => r.value); }
  /** Пара, в которую входит тред. */
  of(threadId: string) { return this.list().find(p => p.primary === threadId || p.fallback === threadId); }
  isUrgent(threadId: string) { return Boolean(this.d.store.get(URGENT + threadId)); }
  setUrgent(threadId: string, urgent: boolean) {
    if (urgent) this.d.store.put(URGENT + threadId, true); else this.d.store.del(URGENT + threadId);
    return urgent;
  }

  private async thread(id: string): Promise<ThreadRow> {
    const r = await this.d.sdk.threads.get({threadId: id});
    return ("thread" in r ? r.thread : r) as unknown as ThreadRow;
  }

  async configure(topicId: number, primary: string, fallback: string) {
    const b = this.d.binding(topicId);
    if (!b?.threadId) throw Error("pair_binding_missing");
    if (primary === fallback) throw Error("pair_same_thread");
    if (b.threadId !== primary && b.threadId !== fallback) throw Error("pair_binding_not_in_pair");
    const [p, f] = await Promise.all([this.thread(primary), this.thread(fallback)]);
    for (const t of [p, f]) {
      if (t.archivedAt || t.deletedAt) throw Error("pair_thread_archived");
      if (t.projectId !== b.projectId) throw Error("pair_project_mismatch");
      if (t.parentThreadId) throw Error("pair_thread_is_child");
      if (this.list().some(x => x.topicId !== topicId && (x.primary === t.id || x.fallback === t.id)))
        throw Error("pair_thread_taken");
    }
    const old = this.get(topicId);
    const base = (t: ThreadRow) => {
      const raw = baseTitle(t.title ?? "Личный помощник");
      const tail = " · " + providerLabel(t.providerId);
      return raw.endsWith(tail) ? raw : raw + tail;
    };
    const pair: ChatPair = {topicId, projectId: b.projectId, primary, fallback,
      titles: {[primary]: base(p), [fallback]: base(f)},
      blockedUntil: old?.primary === primary && old.fallback === fallback ? old.blockedUntil : {},
      inactiveSince: old?.inactiveSince ?? {}, waiting: undefined};
    this.put(pair);
    await this.marks(pair);
    return pair;
  }
  remove(topicId: number) { this.d.store.del(KEY + topicId); return true; }
  /** Лимит треда снят досрочно (сброс, докупка): возврат на ближайшем такте. */
  clearLimit(topicId: number, threadId: string) {
    const p = this.get(topicId);
    if (!p || (threadId !== p.primary && threadId !== p.fallback)) throw Error("pair_threads_mismatch");
    const {[threadId]: _gone, ...rest} = p.blockedUntil;
    this.put({...p, blockedUntil: rest});
    return true;
  }

  status(topicId: number) {
    const p = this.get(topicId);
    if (!p) return null;
    const b = this.d.binding(topicId);
    return {...p, active: b?.threadId ?? null};
  }

  private other(p: ChatPair, id: string) { return id === p.primary ? p.fallback : p.primary; }
  private free(p: ChatPair, id: string, now = Date.now()) { return (p.blockedUntil[id] ?? 0) <= now; }

  private mark(p: ChatPair, id: string, active: string | null) {
    if (id === active) return MARK_ACTIVE;
    return this.free(p, id) ? MARK_STANDBY : MARK_WAITING;
  }
  /** Пометки в названиях обоих тредов по фактическому состоянию. */
  async marks(p: ChatPair) {
    const active = this.d.binding(p.topicId)?.threadId ?? null;
    const marks = {...(p.marks ?? {})};
    let changed = false;
    for (const id of [p.primary, p.fallback]) {
      const mark = this.mark(p, id, active);
      if (marks[id] === mark) continue;
      try {
        await this.d.sdk.threads.update({threadId: id, title: `${mark} · ${p.titles[id]}`});
        marks[id] = mark; changed = true;
      } catch { /* название — не повод сорвать переключение */ }
    }
    if (changed) {
      const now = this.get(p.topicId);
      if (now) this.put({...now, marks});
    }
  }

  /** Очередь треда: повтор, который штатный provider-retry поставил на этот ход. */
  private async retryOf(threadId: string, turnId: string) {
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId});
    return queue.filter(r => r.payload.kind === "retry" && r.state !== "failed_exhausted" &&
      this.d.retryBelongsToTurn(threadId, turnId, (r.payload as {retryOfTurnRequestId: string}).retryOfTurnRequestId))
      .sort((a, c) => (a.sendAt || 0) - (c.sendAt || 0))[0];
  }

  /**
   * Ход действующего треда пары упал из-за лимита. true — сбой обработан
   * парой, мосту не нужно присылать «⚠️ … не подтверждён».
   */
  async onLimit(b: Binding, threadId: string, turnId: string, endedAt?: number): Promise<boolean> {
    const p = this.get(b.topicId);
    if (!p || (threadId !== p.primary && threadId !== p.fallback)) return false;
    const handled = HANDLED + threadId + ":" + turnId;
    if (this.d.store.get(handled)) return true;
    if (this.d.binding(b.topicId)?.threadId !== threadId) {
      // Неактивный тред пары (служебный ход, уведомление подтреда): только запомнить лимит.
      const retry = await this.retryOf(threadId, turnId);
      if (retry?.sendAt) this.put({...p, blockedUntil: {...p.blockedUntil, [threadId]: Math.max(p.blockedUntil[threadId] ?? 0, retry.sendAt)}});
      this.d.store.put(handled, {at: Date.now()});
      return true;
    }
    const route = this.d.destination(threadId, turnId);
    // Ход не от владельца (служебный, от расписания) — не переключаем ради него.
    if (route?.kind !== "telegram") return false;
    const retry = await this.retryOf(threadId, turnId);
    const now = Date.now();
    // Штатный повтор ставится сразу за сбоем; дать ему появиться, иначе он
    // позже выполнится на старом треде и ответ придёт дважды.
    if (!retry && endedAt && now - endedAt < 20_000) return true;
    const to = this.other(p, threadId);
    // Тема занята входящим: разобрать этот сбой на следующем такте.
    if (this.free(p, to, now) && this.d.busy(b.topicId)) return true;
    const until = retry?.sendAt && retry.sendAt > now ? retry.sendAt : now + 30 * 60_000;
    p.blockedUntil = {...p.blockedUntil, [threadId]: Math.max(p.blockedUntil[threadId] ?? 0, until)};
    this.d.store.put(handled, {at: now});
    if (this.free(p, to, now)) {
      this.put({...p, waiting: undefined});
      await this.switchTo(b.topicId, threadId, to, {
        replay: {threadId, turnId, route, retryId: retry?.id}, kind: "limit",
        notice: to === p.fallback
          ? `${providerLabel(await this.providerOf(threadId))} в лимите до ${when(until)}. Пока отвечает ${providerLabel(await this.providerOf(to))}.`
          : `Снова отвечает ${providerLabel(await this.providerOf(to))}.`,
      });
      return true;
    }
    // Оба в лимите: сообщение остаётся в очереди штатного повтора.
    const resume = Math.min(until, p.blockedUntil[to] ?? until);
    this.put({...p, waiting: {threadId, turnId, retryId: retry?.id, at: now}});
    this.d.notify(b.topicId, `Лимит исчерпан на всех аккаунтах. Продолжу в ${when(resume)} по Москве, сообщение сохранено.`,
      `pair-wait:${threadId}:${turnId}`);
    await this.marks(this.get(b.topicId)!);
    return true;
  }

  private async providerOf(id: string) { return (await this.thread(id)).providerId; }

  /** Периодическая проверка: возврат на основной, выход из ожидания, перенос подтредов. */
  async tick() {
    for (const p of this.list()) {
      try { await this.tickPair(p); } catch { /* следующая попытка на следующем такте */ }
    }
  }
  private probed = new Map<string, number>();
  /** Лимит мог сняться раньше расчётного времени: проверить фактический остаток. */
  private async refreshBlocked(p: ChatPair, id: string) {
    if (this.free(p, id) || !this.d.available) return p;
    const last = this.probed.get(id) ?? 0;
    if (Date.now() - last < 5 * 60_000) return p;
    this.probed.set(id, Date.now());
    if (await this.d.available(id).catch(() => undefined) !== true) return p;
    const next = {...p, blockedUntil: {...p.blockedUntil, [id]: 0}};
    this.put(next);
    return next;
  }
  private async tickPair(p: ChatPair) {
    const b = this.d.binding(p.topicId);
    if (!b?.threadId || (b.threadId !== p.primary && b.threadId !== p.fallback)) return;
    p = await this.refreshBlocked(p, this.other(p, b.threadId));
    await this.sweepReplayed(this.other(p, b.threadId)).catch(() => undefined);
    const now = Date.now();
    const active = b.threadId, other = this.other(p, active);
    if (p.waiting && p.waiting.threadId === active && this.free(p, other, now) && !this.free(p, active, now)) {
      // Второй тред освободился раньше: переносим ждущее сообщение туда.
      const route = this.d.destination(active, p.waiting.turnId);
      const retry = await this.retryOf(active, p.waiting.turnId);
      if (route?.kind === "telegram" && retry && !this.d.busy(p.topicId)) {
        this.put({...p, waiting: undefined});
        await this.switchTo(p.topicId, active, other, {
          replay: {threadId: active, turnId: p.waiting.turnId, route, retryId: retry.id}, kind: "limit",
          notice: `Отвечает ${providerLabel(await this.providerOf(other))}.`,
        });
        return;
      }
    }
    if (p.waiting && (this.free(p, active, now) || !(await this.retryOf(active, p.waiting.turnId))))
      this.put({...p, waiting: undefined});
    if (active === p.fallback && this.free(p, p.primary, now)) {
      const [f, q] = await Promise.all([this.thread(active),
        this.d.sdk.threads.queuedMessages.list({threadId: active})]);
      if ((f.status === "idle" || f.status === "error") && !q.length && !this.d.busy(p.topicId)) {
        await this.switchTo(p.topicId, active, p.primary, {kind: "return",
          notice: `Снова отвечает ${providerLabel(await this.providerOf(p.primary))}.`});
        return;
      }
    }
    await this.moveChildren(this.get(p.topicId)!, other, active);
    const cur = this.get(p.topicId)!;
    if (now - (cur.lastCleanup ?? 0) > 24 * 3600_000) {
      this.put({...cur, lastCleanup: now});
      await this.cleanup(cur).catch(() => undefined);
    }
    await this.marks(this.get(p.topicId)!);
  }

  private async completedSince(threadId: string, at: number) {
    const ev = await this.d.sdk.threads.events.list({threadId, types: ["turn/completed"], order: "desc", limit: "20",
      signal: this.d.signal});
    return ev.some(e => e.createdAt >= at && (e.data as {status?: string}).status === "completed");
  }

  /** Повтор, поставленный BB уже после переотправки сообщения, снимается: ответ не придёт дважды. */
  private async sweepReplayed(threadId: string) {
    const turns = this.d.store.list<{at: number}>(REPLAYED + threadId + ":");
    if (!turns.length) return;
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId});
    for (const r of queue) {
      if (r.payload.kind !== "retry") continue;
      const of = (r.payload as {retryOfTurnRequestId: string}).retryOfTurnRequestId;
      if (turns.some(t => this.d.retryBelongsToTurn(threadId, t.key.slice((REPLAYED + threadId + ":").length), of)))
        await this.d.sdk.threads.queuedMessages.delete({threadId, queuedMessageId: r.id}).catch(() => undefined);
    }
    for (const t of turns) if (Date.now() - t.value.at > 24 * 3600_000) this.d.store.del(t.key);
  }

  /** Ручное переключение (RPC) с теми же проверками. */
  async manualSwitch(topicId: number, from: string, to: string) {
    const p = this.get(topicId);
    if (!p || ![p.primary, p.fallback].includes(from) || ![p.primary, p.fallback].includes(to) || from === to)
      throw Error("pair_threads_mismatch");
    const t = await this.thread(from);
    if (!["idle", "error"].includes(t.status)) throw Error("pair_source_busy");
    if ((await this.d.sdk.threads.queuedMessages.list({threadId: from})).length) throw Error("pair_source_queued");
    await this.switchTo(topicId, from, to, {kind: "manual", notice: `Отвечает ${providerLabel(await this.providerOf(to))}.`});
    return this.status(topicId);
  }

  private async switchTo(topicId: number, from: string, to: string, opts: {
    replay?: {threadId: string; turnId: string; route: Telegram; retryId?: string};
    notice: string;
    kind: "limit" | "return" | "manual";
  }) {
    const b = this.d.binding(topicId);
    if (!b || b.threadId !== from) throw Error("pair_binding_changed");
    const target = await this.thread(to);
    if (target.archivedAt || target.deletedAt) throw Error("pair_target_archived");
    if (!["idle", "error"].includes(target.status)) throw Error("pair_target_busy");
    const options = await this.d.sdk.threads.defaultExecutionOptions({threadId: to}).catch(() => null);
    const p = this.get(topicId)!;
    const now = Date.now();
    // Как штатная кнопка «Подключиться»: курсор — на последнее событие
    // целевого треда, чтобы мост не переслал его старые ответы.
    const latest = await this.d.sdk.threads.events.list({threadId: to, order: "desc", limit: "1", signal: this.d.signal});
    this.d.save({...b, threadId: to, providerId: target.providerId, model: options?.model ?? undefined,
      revision: this.d.fresh(), ready: false, cursor: latest[0]?.seq ?? 0,
      profileId: undefined, profileTarget: undefined, status: undefined, progressId: undefined,
      progressText: undefined, activity: undefined, toolActivity: undefined});
    const since = p.inactiveSince[to];
    // Быстрый возврат туда, откуда только что ушли (лимит не снялся), — без второго уведомления.
    // Тихо — только если основной отказал на первом же ходе после возврата.
    const bounce = opts.kind === "limit" && p.lastSwitch?.kind === "return" && p.lastSwitch.to === from &&
      !(await this.completedSince(from, p.lastSwitch.at));
    this.put({...p, inactiveSince: {...p.inactiveSince, [from]: now}, lastSwitch: {from, to, at: now, kind: opts.kind}});
    if (!bounce) this.d.notify(topicId, opts.notice, `pair-switch:${from}:${to}:${now}`);
    await this.moveChildren(this.get(topicId)!, from, to);
    const review = await this.review(this.get(topicId)!, to).catch(() => undefined);
    if (review?.ownerList) this.d.notify(topicId, review.ownerList, `pair-roster:${to}:${now}`);
    if (opts.replay) {
      const text = await this.originalText(opts.replay.threadId, opts.replay.turnId);
      const summary = [since ? await this.summary(from, since) : "", review?.handover ?? ""].filter(Boolean).join("\n\n");
      const lead = "Ответь владельцу на сообщение ниже. Прошлая попытка ответить на него оборвалась: у второго " +
        "исполнителя закончился лимит модели. Сначала проверь, что из начатого уже сделано, и не повторяй выполненные " +
        "действия с внешним эффектом.";
      await this.d.sdk.threads.send({threadId: to, mode: "queue-if-active", input: [
        {type: "text", text: [summary, lead, OWNER_MESSAGE + ownerPart(text)].filter(Boolean).join("\n\n"), mentions: []},
        this.d.ingress(to, opts.replay.route),
      ]});
      this.d.store.put(REPLAYED + opts.replay.threadId + ":" + opts.replay.turnId, {at: now});
      if (opts.replay.retryId)
        await this.d.sdk.threads.queuedMessages.delete({threadId: opts.replay.threadId, queuedMessageId: opts.replay.retryId})
          .catch(() => undefined);
    } else if (since || review?.handover) {
      this.d.store.put(KEY + "catchup:" + to, {from, since: since ?? 0, handover: review?.handover});
    }
    await this.moveChildren(this.get(topicId)!, from, to);
    await this.marks(this.get(topicId)!);
  }

  /** Первое после переключения сообщение владельца получает сводку пропущенного. */
  async catchUpPrefix(threadId: string): Promise<string> {
    const key = KEY + "catchup:" + threadId;
    const c = this.d.store.get<{from: string; since: number; handover?: string}>(key);
    if (!c) return "";
    this.d.store.del(key);
    const summary = c.since ? await this.summary(c.from, c.since).catch(() => "") : "";
    return [summary, c.handover ?? ""].filter(Boolean).join("\n\n");
  }

  private async originalText(threadId: string, turnId: string) {
    const ids = new Set(this.d.requestIds(threadId, turnId));
    const events = await this.d.sdk.threads.events.list({threadId, types: ["client/turn/requested"], order: "desc",
      limit: "50", signal: this.d.signal});
    const req = events.find(e => e.type === "client/turn/requested" && ids.has((e.data as {requestId: string}).requestId));
    const input = (req?.data as {input?: {type: string; text?: string}[]} | undefined)?.input ?? [];
    return input.filter(i => i.type === "text" && i.text && !MARKER.test(i.text)).map(i => i.text!).join("\n\n").trim();
  }

  /** Что было сказано в треде `from` после `since`: реплики владельца и итоговые ответы. */
  async summary(from: string, since: number) {
    const lines: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const events = await this.d.sdk.threads.events.list({threadId: from, order: "asc", limit: "100",
        ...(after ? {afterSeq: after} : {}), types: ["client/turn/requested", "item/completed"], signal: this.d.signal});
      for (const e of events) {
        if (e.createdAt < since) continue;
        if (e.type === "client/turn/requested") {
          const d = e.data as {originPluginId?: string; input?: {type: string; text?: string}[]};
          if (d.originPluginId !== "telegram-projects") continue;
          const t = ownerPart((d.input ?? []).filter(i => i.type === "text" && i.text && !MARKER.test(i.text)).map(i => i.text).join(" "));
          if (t.trim()) lines.push("Владелец: " + t.replace(/\s+/g, " ").slice(0, 600));
        } else {
          const item = (e.data as {item?: {type: string; text?: string}}).item;
          if (item?.type === "agentMessage" && item.text?.trim())
            lines.push("Ответ: " + item.text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").slice(0, 600));
        }
      }
      if (events.length < 100) break;
      after = String(events[events.length - 1].seq);
    }
    if (!lines.length) return "";
    let body = lines.join("\n");
    if (body.length > SUMMARY_LIMIT) body = "…\n" + body.slice(body.length - SUMMARY_LIMIT);
    return `Пока ты был в резерве (с ${msk(since)} МСК), владелец переписывался со вторым исполнителем (тред ${from}). ` +
      `Коротко, по порядку:\n${body}\n\nДальше — новое сообщение.`;
  }

  /** Свободные подтреды переезжают к действующему треду; занятые — когда освободятся. */
  private async moveChildren(p: ChatPair, from: string, to: string) {
    const children = await this.d.sdk.threads.list({parentThreadId: from, archived: false, includeHidden: true, limit: 100});
    for (const c of children as unknown as ThreadRow[]) {
      if (c.parentThreadId !== from || c.id === to || !["idle", "error"].includes(c.status)) continue;
      try {
        await this.d.sdk.threads.update({threadId: c.id, parentThreadId: to});
        this.d.store.put(MOVED + c.id, {from, to, at: Date.now()});
      } catch { /* повтор на следующем такте */ }
    }
  }

  /**
   * Подтред упёрся в лимит, повтор стоит в очереди: уведомление родителю
   * «failed» ждёт, а в карточке очереди видно время. Если повтор прошёл —
   * уведомление снимается. Срочный подтред продолжается на другом провайдере.
   */
  async admitChildNotice(ctx: MessageDispatchHookContext): Promise<MessageDispatchHookDecision | undefined> {
    const q = ctx.queuedMessages?.length === 1 ? ctx.queuedMessages[0] : undefined;
    const notice = q?.systemNotice;
    if (!q || notice?.kind !== "child-failed" || notice.subject?.kind !== "thread") return;
    const childId = (notice.subject as {threadId?: string; id?: string}).threadId ?? (notice.subject as {id?: string}).id;
    if (!childId) return;
    const limited = await this.childLimit(childId);
    if (!limited) return;
    if (limited.state === "recovered") {
      // Повтор прошёл: старое уведомление о сбое неактуально.
      void this.d.sdk.threads.queuedMessages.delete({threadId: ctx.thread.id, queuedMessageId: q.id}).catch(() => undefined);
      return {action: "wait", reason: "Подтред продолжил работу после лимита.", sendAt: Date.now() + 60 * 60_000};
    }
    return {action: "wait", sendAt: limited.until + 10 * 60_000,
      reason: `Подтред «${limited.title}» ждёт сброса лимита до ${msk(limited.until)} МСК, повтор поставлен.`};
  }

  /** Состояние подтреда по лимиту: ждёт повтора или уже работает дальше. */
  async childLimit(childId: string): Promise<{state: "waiting" | "recovered"; until: number; title: string} | undefined> {
    const child = await this.thread(childId).catch(() => undefined);
    if (!child) return;
    const title = (child.title ?? "Отдельная задача").replace(/\s+/g, " ").slice(0, 80);
    const events = await this.d.sdk.threads.events.list({threadId: childId, order: "desc", limit: "30",
      types: ["provider/error", "turn/completed", "turn/started"], signal: this.d.signal});
    const sorted = [...events].sort((a, c) => c.seq - a.seq);
    const end = sorted.find(e => e.type === "turn/completed");
    const failed = end?.type === "turn/completed" && (end.data as {status: string}).status === "failed";
    const start = sorted.find(e => e.type === "turn/started");
    const error = sorted.find(e => e.type === "provider/error" && (!start || e.seq > start.seq));
    const category = (error?.data as {errorInfo?: {category?: string}} | undefined)?.errorInfo?.category;
    if (!failed || category !== "rate-limit") {
      if (this.d.store.get(KEY + "child-limit:" + childId)) {
        this.d.store.del(KEY + "child-limit:" + childId);
        return {state: "recovered", until: 0, title};
      }
      return;
    }
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId: childId});
    const retry = queue.filter(r => r.payload.kind === "retry" && r.state !== "failed_exhausted")
      .sort((a, c) => (a.sendAt || 0) - (c.sendAt || 0))[0];
    if (!retry?.sendAt) return;
    this.d.store.put(KEY + "child-limit:" + childId, {until: retry.sendAt});
    return {state: "waiting", until: retry.sendAt, title};
  }

  /**
   * Срочный подтред в лимите: штатный handoff на другой провайдер в той же
   * папке (workspace reuse), родитель возвращается. Старый тред остаётся как
   * есть, его повтор снимается, чтобы работа не пошла дважды.
   */
  async continueUrgent(childId: string): Promise<string | undefined> {
    if (!this.isUrgent(childId)) return;
    const done = this.d.store.get<{target?: string}>(URGENT + "done:" + childId);
    if (done) return done.target;
    const child = await this.thread(childId);
    if (!child.parentThreadId || !["error", "idle"].includes(child.status)) return;
    const pair = this.of(child.parentThreadId) ?? this.list()[0];
    if (!pair) return;
    // Другой провайдер берём у треда пары с этим провайдером.
    const [a, c] = await Promise.all([this.thread(pair.primary), this.thread(pair.fallback)]);
    const target = [a, c].find(t => t.providerId !== child.providerId);
    if (!target) return;
    return this.handoffTo(child, target.id, child.parentThreadId);
  }

  /**
   * Штатный handoff треда на провайдера треда `providerOf` в той же папке
   * (workspace reuse), родитель — `parent`. Старый тред остаётся, его повтор
   * снимается, чтобы работа не пошла дважды. Повторный вызов не создаёт второй.
   */
  private async handoffTo(child: ThreadRow, providerOf: string, parent: string): Promise<string> {
    const doneKey = URGENT + "done:" + child.id;
    const done = this.d.store.get<{target?: string}>(doneKey);
    if (done) {
      if (done.target) return done.target;
      throw Error("handoff_outcome_uncertain_check_threads");
    }
    const target = await this.thread(providerOf);
    const options = await this.d.sdk.threads.defaultExecutionOptions({threadId: target.id}).catch(() => null);
    const plugins = await this.d.sdk.plugins.list().catch(() => undefined);
    // Без плагина handoff перенос невозможен, и это известно до попытки.
    if (plugins && !plugins.plugins.some(x => x.id === "handoff" && x.enabled)) throw Error("handoff_plugin_missing");
    this.d.store.put(doneKey, {at: Date.now()});
    const result = await this.d.sdk.plugins.callRpc({pluginId: "handoff", method: "startHandoff",
      input: {threadId: child.id, providerId: target.providerId, ...(options?.model ? {model: options.model} : {}),
        workspace: "reuse", briefing: false,
        extraInstructions: "Продолжи эту задачу: прошлый исполнитель упёрся в лимит модели посреди работы. " +
          "Ты в той же рабочей папке. Сначала проверь, что уже сделано (файлы, git status, внешние действия), " +
          "и не повторяй выполненные действия с внешним эффектом."},
      outputSchema: z.object({newThreadId: z.string().min(1)}).passthrough(),
    });
    this.d.store.put(doneKey, {at: Date.now(), target: result.newThreadId});
    await this.d.sdk.threads.update({threadId: result.newThreadId, parentThreadId: parent}).catch(() => undefined);
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId: child.id});
    for (const r of queue.filter(r => r.payload.kind === "retry"))
      await this.d.sdk.threads.queuedMessages.delete({threadId: child.id, queuedMessageId: r.id}).catch(() => undefined);
    return result.newThreadId;
  }

  // ---------- Треды, созданные помощником: сводка, уборка, решение владельца ----------

  /**
   * Тред создан помощником под задачу — только по штатным признакам:
   * запись моста о создании (spawnDelegated) или создание мостом с родителем
   * из пары, либо lifecycleOwner — тред пары. Треды расписаний не входят:
   * они живут дольше одной задачи. По названию ничего не угадывается.
   */
  createdByAssistant(row: ThreadRow & {originPluginId?: string | null; lifecycleOwnerThreadId?: string | null}, p: ChatPair) {
    if (row.id === p.primary || row.id === p.fallback) return false;
    if (row.originPluginId === "automations") return false;
    const pair = new Set([p.primary, p.fallback]);
    if (row.lifecycleOwnerThreadId && pair.has(row.lifecycleOwnerThreadId)) return true;
    if (this.spawnedByBridge().has(row.id)) return true;
    return row.originPluginId === "telegram-projects" && Boolean(row.parentThreadId && pair.has(row.parentThreadId));
  }
  private spawnedByBridge() {
    return new Set(this.d.store.list<{state?: string; threadId?: string}>("reply:delegation-spawn:")
      .flatMap(r => r.value.state === "accepted" && r.value.threadId ? [r.value.threadId] : []));
  }

  /** Все треды, которые помощник создал (не архивные). */
  private async createdThreads(p: ChatPair) {
    const ids = new Set<string>();
    const rows: (ThreadRow & {originPluginId?: string | null; lifecycleOwnerThreadId?: string | null})[] = [];
    for (const parent of [p.primary, p.fallback]) {
      const children = await this.d.sdk.threads.list({parentThreadId: parent, archived: false, includeHidden: true, limit: 100});
      for (const c of children as unknown as ThreadRow[]) {
        if (ids.has(c.id) || c.parentThreadId !== parent) continue;
        ids.add(c.id);
        // В списке тредов нет полей происхождения — берём полную карточку.
        const full = await this.thread(c.id).catch(() => undefined) as (typeof rows)[number] | undefined;
        if (full) rows.push(full);
      }
    }
    for (const id of this.spawnedByBridge()) {
      if (ids.has(id)) continue;
      const t = await this.thread(id).catch(() => undefined) as (typeof rows)[number] | undefined;
      if (t && !t.archivedAt && !t.deletedAt) { ids.add(id); rows.push(t); }
    }
    return rows.filter(r => !r.archivedAt && !r.deletedAt && this.createdByAssistant(r, p));
  }

  /** Треды, на которые нацелены включённые расписания (их не архивируем). */
  private async scheduledTargets(projectIds: string[]) {
    const out = new Set<string>();
    for (const projectId of new Set(projectIds)) {
      const list = await this.d.sdk.plugins.callRpc({pluginId: "automations", method: "automations_list", input: {projectId},
        outputSchema: z.array(z.object({enabled: z.boolean(), execution: z.object({targetThreadId: z.string().nullish()}).passthrough()}).passthrough()),
      }).catch(() => undefined);
      if (!list) throw Error("automations_unavailable");
      for (const a of list) if (a.enabled && a.execution.targetThreadId) out.add(a.execution.targetThreadId);
    }
    return out;
  }

  /** Состояние треда для решения: завершён или что именно не закончено. */
  async state(row: ThreadRow): Promise<{done: boolean; lastAt: number; icon: string; status: string; limited?: number}> {
    const [events, queue, asks] = await Promise.all([
      this.d.sdk.threads.events.list({threadId: row.id, order: "desc", limit: "20",
        types: ["turn/completed", "turn/started", "provider/error"], signal: this.d.signal}),
      this.d.sdk.threads.queuedMessages.list({threadId: row.id}),
      this.d.sdk.threads.interactions.list({threadId: row.id, signal: this.d.signal}).catch(() => []),
    ]);
    const sorted = [...events].sort((a, c) => c.seq - a.seq);
    const end = sorted.find(e => e.type === "turn/completed");
    const endStatus = (end?.data as {status?: string} | undefined)?.status;
    const lastAt = end?.createdAt ?? 0;
    const retry = queue.find(r => r.payload.kind === "retry" && r.state !== "failed_exhausted");
    if ((asks as {status?: string}[]).some(i => i.status === "pending"))
      return {done: false, lastAt, icon: "❓", status: "ждёт ответа на вопрос"};
    if (["active", "starting", "pending", "stopping"].includes(row.status))
      return {done: false, lastAt, icon: "▶️", status: "работает"};
    if (retry?.sendAt) return {done: false, lastAt, icon: "⏳", status: `ждёт лимита до ${msk(retry.sendAt)}`, limited: retry.sendAt};
    if (queue.length) return {done: false, lastAt, icon: "📨", status: "в очереди сообщения"};
    if (row.status === "error" || endStatus === "failed") return {done: false, lastAt, icon: "🔴", status: "остановился с ошибкой"};
    if (endStatus === "interrupted") return {done: false, lastAt, icon: "⏸", status: "прерван"};
    if (row.status === "idle" && endStatus === "completed") return {done: true, lastAt, icon: "✅", status: "завершён"};
    return {done: false, lastAt, icon: "⚪", status: "без результата"};
  }

  private async taskOf(threadId: string) {
    const ev = await this.d.sdk.threads.events.list({threadId, types: ["client/turn/requested"], order: "asc", limit: "1",
      signal: this.d.signal});
    const input = (ev[0]?.data as {input?: {type: string; text?: string}[]} | undefined)?.input ?? [];
    const text = input.filter(i => i.type === "text" && i.text && !MARKER.test(i.text)).map(i => i.text).join(" ");
    return text.replace(/\s+/g, " ").trim().slice(0, 90);
  }

  /** Время последнего завершённого хода тредов пары: итог подтреда уже прочитан. */
  private async pairDigestedAt(p: ChatPair) {
    let at = 0;
    for (const id of [p.primary, p.fallback]) {
      const ev = await this.d.sdk.threads.events.list({threadId: id, types: ["turn/completed"], order: "desc", limit: "1",
        signal: this.d.signal});
      at = Math.max(at, ev[0]?.createdAt ?? 0);
    }
    return at;
  }

  /**
   * Уборка: завершённые треды, созданные помощником, итог которых уже прочитан
   * (после них у пары был завершённый ход) и которые 6 часов без движения,
   * архивируются. Не удаляются; хранилище и рабочие копии не трогаются.
   * Треды под расписаниями и чужие треды не трогаются никогда.
   */
  async cleanup(p: ChatPair) {
    const rows = await this.createdThreads(p);
    if (!rows.length) return [];
    const targets = await this.scheduledTargets(rows.map(r => r.projectId));
    const digested = await this.pairDigestedAt(p);
    const archived: string[] = [];
    for (const row of rows) {
      if (targets.has(row.id)) continue;
      const children = await this.d.sdk.threads.list({parentThreadId: row.id, archived: false, includeHidden: true, limit: 1});
      if (children.length) continue;
      const st = await this.state(row);
      if (!st.done || !st.lastAt || st.lastAt > digested || Date.now() - st.lastAt < 6 * 3600_000) continue;
      await this.d.sdk.threads.archive({threadId: row.id});
      this.d.store.put(KEY + "archived:" + row.id, {at: Date.now(), title: row.title});
      archived.push(row.id);
    }
    return archived;
  }

  /**
   * При переключении: уборка завершённых, сводка для нового действующего треда
   * о том, что осталось от прежнего, и — если есть незаконченные треды на
   * провайдере, который сейчас в лимите, — один нумерованный вопрос владельцу.
   */
  async review(p: ChatPair, active: string) {
    const archived = await this.cleanup(p).catch(() => [] as string[]);
    const rows = (await this.createdThreads(p)).filter(r => !archived.includes(r.id));
    const activeProvider = await this.providerOf(active);
    const limitedProviders = new Set<string>();
    for (const id of [p.primary, p.fallback]) if (!this.free(p, id)) limitedProviders.add(await this.providerOf(id));
    const open: {row: ThreadRow; st: Awaited<ReturnType<ChatPairs["state"]>>; task: string}[] = [];
    for (const row of rows) {
      const st = await this.state(row);
      if (st.done) continue;
      open.push({row, st, task: await this.taskOf(row.id).catch(() => "")});
    }
    const line = (x: (typeof open)[number], n?: number) =>
      `${n ? n + ". " : "— "}${x.st.icon} ${(x.row.title ?? "Без названия").replace(/\s+/g, " ").slice(0, 70)}` +
      (x.task ? ` — ${x.task}` : "") + ` — ${x.st.status}, ${providerLabel(x.row.providerId)}`;
    const handover = open.length || archived.length ? [
      "Сводка при переключении: подтреды и задачи помощника, оставшиеся от прежнего исполнителя.",
      ...open.map(x => line(x) + ` (${x.row.id})`),
      archived.length ? `Завершённые и уже переданные треды заархивированы: ${archived.join(", ")}.` : "",
    ].filter(Boolean).join("\n") : "";
    const ask = open.filter(x => limitedProviders.has(x.row.providerId) && x.row.providerId !== activeProvider);
    if (!ask.length) {
      const cur = this.get(p.topicId);
      if (cur) this.put({...cur, roster: undefined});
      return {handover, ownerList: null as string | null};
    }
    const items = ask.map((x, i) => ({n: i + 1, threadId: x.row.id}));
    const cur = this.get(p.topicId);
    if (cur) this.put({...cur, roster: {at: Date.now(), items}});
    const ownerList = [`Незаконченные задачи на ${[...new Set(ask.map(x => providerLabel(x.row.providerId)))].join(" и ")}, ` +
      `который сейчас в лимите:`, ...ask.map((x, i) => line(x, i + 1)), "",
      "Ответь номерами: что перенести на действующую модель, что оставить ждать, что закрыть. " +
      "Пока ответа нет, всё ждёт сброса лимита."].join("\n");
    const instructions = "Владелец получил этот список номерами. Когда он ответит: «перенести» — вызови telegram-projects " +
      "continueChildOnActive {threadId}; «закрыть» — archiveAssistantThread {threadId}; «ждать» — ничего не делай. " +
      "Номера: " + items.map(i => `${i.n} = ${i.threadId}`).join(", ") + ".";
    return {handover: [handover, instructions].filter(Boolean).join("\n"), ownerList};
  }

  /** Пара, к которой относится тред помощника (по родителю), иначе единственная. */
  async pairFor(threadId: string, topicId?: number) {
    if (topicId !== undefined) return this.get(topicId);
    const row = await this.thread(threadId).catch(() => undefined);
    return (row?.parentThreadId && this.of(row.parentThreadId)) || (this.list().length === 1 ? this.list()[0] : undefined);
  }
  /** Решение владельца «перенести»: продолжить тред на действующем провайдере в той же папке. */
  async continueOnActive(topicId: number, threadId: string) {
    const p = this.get(topicId);
    if (!p) throw Error("pair_missing");
    const row = await this.thread(threadId) as ThreadRow & {originPluginId?: string | null; lifecycleOwnerThreadId?: string | null};
    if (!this.createdByAssistant(row, p)) throw Error("thread_not_created_by_assistant");
    const active = this.d.binding(topicId)?.threadId;
    if (!active) throw Error("pair_binding_missing");
    const target = await this.thread(active);
    if (target.providerId === row.providerId) throw Error("thread_already_on_active_provider");
    return this.handoffTo(row, target.id, active);
  }

  /** Решение владельца «закрыть»: архив, только для созданного помощником. */
  async archiveCreated(topicId: number, threadId: string) {
    const p = this.get(topicId);
    if (!p) throw Error("pair_missing");
    const row = await this.thread(threadId) as ThreadRow & {originPluginId?: string | null; lifecycleOwnerThreadId?: string | null};
    if (!this.createdByAssistant(row, p)) throw Error("thread_not_created_by_assistant");
    if (["active", "starting", "pending"].includes(row.status)) throw Error("thread_busy");
    for (const r of await this.d.sdk.threads.queuedMessages.list({threadId}))
      if (r.payload.kind === "retry") await this.d.sdk.threads.queuedMessages.delete({threadId, queuedMessageId: r.id}).catch(() => undefined);
    await this.d.sdk.threads.archive({threadId});
    this.d.store.put(KEY + "archived:" + threadId, {at: Date.now(), title: row.title, byOwner: true});
    return true;
  }
}
