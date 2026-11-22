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
  ingress: (threadId: string, route: Telegram) => ReturnType<typeof routeMarker>;
};

const KEY = "chat:pair:";
const URGENT = "chat:pair:urgent:";
const HANDLED = "chat:pair:handled:";
const MOVED = "chat:pair:moved-child:";
const MARK_ACTIVE = "🟢 Действующий";
const MARK_STANDBY = "⏸ Резерв";
const MARK_WAITING = "⏳ Ждёт лимита";
const MARKS = [MARK_ACTIVE, MARK_STANDBY, MARK_WAITING];
const MARKER = /^\[bb-telegram-reply-route:[^\]]+\][\s\S]*$/;
const SUMMARY_LIMIT = 6000;

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
  async onLimit(b: Binding, threadId: string, turnId: string): Promise<boolean> {
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
    const until = retry?.sendAt && retry.sendAt > now ? retry.sendAt : now + 30 * 60_000;
    p.blockedUntil = {...p.blockedUntil, [threadId]: Math.max(p.blockedUntil[threadId] ?? 0, until)};
    const to = this.other(p, threadId);
    this.d.store.put(handled, {at: now});
    if (this.free(p, to, now) && !this.d.busy(b.topicId)) {
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
  private async tickPair(p: ChatPair) {
    const b = this.d.binding(p.topicId);
    if (!b?.threadId || (b.threadId !== p.primary && b.threadId !== p.fallback)) return;
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
    await this.marks(this.get(p.topicId)!);
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
    const bounce = opts.kind === "limit" && p.lastSwitch?.kind === "return" && p.lastSwitch.to === from &&
      now - p.lastSwitch.at < 30 * 60_000;
    this.put({...p, inactiveSince: {...p.inactiveSince, [from]: now}, lastSwitch: {from, to, at: now, kind: opts.kind}});
    if (!bounce) this.d.notify(topicId, opts.notice, `pair-switch:${from}:${to}:${now}`);
    if (opts.replay) {
      const text = await this.originalText(opts.replay.threadId, opts.replay.turnId);
      const summary = since ? await this.summary(from, since) : "";
      const lead = "Ответь владельцу на сообщение ниже. Прошлая попытка ответить на него оборвалась: у второго " +
        "исполнителя закончился лимит модели. Сначала проверь, что из начатого уже сделано, и не повторяй выполненные " +
        "действия с внешним эффектом.";
      await this.d.sdk.threads.send({threadId: to, mode: "queue-if-active", input: [
        {type: "text", text: [summary, lead, "Сообщение владельца:\n" + text].filter(Boolean).join("\n\n"), mentions: []},
        this.d.ingress(to, opts.replay.route),
      ]});
      if (opts.replay.retryId)
        await this.d.sdk.threads.queuedMessages.delete({threadId: opts.replay.threadId, queuedMessageId: opts.replay.retryId})
          .catch(() => undefined);
    } else if (since) {
      this.d.store.put(KEY + "catchup:" + to, {from, since});
    }
    await this.moveChildren(this.get(topicId)!, from, to);
    await this.marks(this.get(topicId)!);
  }

  /** Первое после переключения сообщение владельца получает сводку пропущенного. */
  async catchUpPrefix(threadId: string): Promise<string> {
    const key = KEY + "catchup:" + threadId;
    const c = this.d.store.get<{from: string; since: number}>(key);
    if (!c) return "";
    this.d.store.del(key);
    return this.summary(c.from, c.since).catch(() => "");
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
          const t = (d.input ?? []).filter(i => i.type === "text" && i.text && !MARKER.test(i.text)).map(i => i.text).join(" ");
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
    const doneKey = URGENT + "done:" + childId;
    const done = this.d.store.get<{target?: string}>(doneKey);
    if (done) return done.target;
    const child = await this.thread(childId);
    if (!child.parentThreadId || !["error", "idle"].includes(child.status)) return;
    const pair = this.of(child.parentThreadId) ?? this.list()[0];
    if (!pair) return;
    // Другой провайдер берём у треда пары с этим провайдером.
    const [a, c] = await Promise.all([this.thread(pair.primary), this.thread(pair.fallback)]);
    const target = [a, c].find(t => t.providerId !== child.providerId);
    if (!target) return;
    const options = await this.d.sdk.threads.defaultExecutionOptions({threadId: target.id}).catch(() => null);
    this.d.store.put(doneKey, {at: Date.now()});
    const result = await this.d.sdk.plugins.callRpc({pluginId: "handoff", method: "startHandoff",
      input: {threadId: childId, providerId: target.providerId, ...(options?.model ? {model: options.model} : {}),
        workspace: "reuse", briefing: false,
        extraInstructions: "Продолжи эту задачу: прошлый исполнитель упёрся в лимит модели посреди работы. " +
          "Ты в той же рабочей папке. Сначала проверь, что уже сделано (файлы, git status, внешние действия), " +
          "и не повторяй выполненные действия с внешним эффектом."},
      outputSchema: z.object({newThreadId: z.string().min(1)}).passthrough(),
    });
    this.d.store.put(doneKey, {at: Date.now(), target: result.newThreadId});
    await this.d.sdk.threads.update({threadId: result.newThreadId, parentThreadId: child.parentThreadId}).catch(() => undefined);
    const queue = await this.d.sdk.threads.queuedMessages.list({threadId: childId});
    for (const r of queue.filter(r => r.payload.kind === "retry"))
      await this.d.sdk.threads.queuedMessages.delete({threadId: childId, queuedMessageId: r.id}).catch(() => undefined);
    return result.newThreadId;
  }
}
