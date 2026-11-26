import { randomUUID } from "node:crypto";
import type { Store } from "./model";

export const PROMISE_LABEL_TTL_MS = 24 * 3600_000;
export const MAX_RECENT_LABELS = 5;
export const PROMISE_NOTE_MARKER = "[bb-telegram-promise-note]";

export type PromiseLabel = {
  label: string;
  threadId: string;
  chatId: number;
  topicId: number;
  messageId: number;
  updateId: number;
  botId: number;
  ownerId: number;
  revision?: string;
  senderName?: string;
  excerpt: string;
  afterSeq: number;
  createdAt: number;
  expiresAt: number;
  lastDeliveredWords?: string;
  kind: "owner" | "group";
};

export type PromiseWatch = {
  threadId: string;
  chatId: number;
  topicId: number;
  botId: number;
  ownerId: number;
  cursor: number;
  at: number;
};

export const promiseLabelKey = (threadId: string, label: string) => `promise:label:${threadId}:${label}`;
export const promiseLabelPrefix = (threadId: string) => `promise:label:${threadId}:`;
export const promiseWatchKey = (botId: number, threadId: string) => `promise:watch:${botId}:${threadId}`;

export function normalizePromiseWords(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function extractPromiseAnswer(text: string): { label: string; body: string } | undefined {
  const m = /^\[telegram-answer:([a-f0-9]{8}|[a-f0-9-]{36})\][ \t]*(?:\r?\n)?([\s\S]+?)(?:\r?\n)?\[\/telegram-answer\]$/.exec(text.trim());
  if (!m || /\[\/?telegram-answer[\]:]/.test(m[2])) return undefined;
  const body = m[2].trim();
  return body ? { label: m[1], body } : undefined;
}

function cleanExcerpt(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function pruneExpiredPromiseLabels(store: Store, threadId: string, now = Date.now()) {
  for (const { key, value } of store.list<PromiseLabel>(promiseLabelPrefix(threadId))) {
    if (!value || value.expiresAt <= now) store.del(key);
  }
}

export function recordPromiseLabel(
  store: Store,
  input: Omit<PromiseLabel, "label" | "createdAt" | "expiresAt" | "excerpt"> & {
    label?: string;
    excerpt: string;
    now?: number;
  },
): string {
  const now = input.now ?? Date.now();
  pruneExpiredPromiseLabels(store, input.threadId, now);
  let label = input.label;
  if (!label) {
    const uuid = randomUUID();
    const short = uuid.slice(0, 8);
    label = store.get(promiseLabelKey(input.threadId, short)) ? uuid : short;
  }
  const entry: PromiseLabel = {
    label,
    threadId: input.threadId,
    chatId: input.chatId,
    topicId: input.topicId,
    messageId: input.messageId,
    updateId: input.updateId,
    botId: input.botId,
    ownerId: input.ownerId,
    ...(input.revision !== undefined && { revision: input.revision }),
    ...(input.senderName && { senderName: input.senderName.replace(/\s+/g, " ").trim().slice(0, 40) }),
    excerpt: cleanExcerpt(input.excerpt),
    afterSeq: input.afterSeq,
    createdAt: now,
    expiresAt: now + PROMISE_LABEL_TTL_MS,
    kind: input.kind,
  };
  store.put(promiseLabelKey(input.threadId, label), entry);
  return label;
}

export function recentPromiseLabels(store: Store, threadId: string, now = Date.now()): PromiseLabel[] {
  const active: PromiseLabel[] = [];
  for (const { key, value } of store.list<PromiseLabel>(promiseLabelPrefix(threadId))) {
    if (!value || value.expiresAt <= now) {
      store.del(key);
      continue;
    }
    active.push(value);
  }
  return active.sort((a, b) => b.createdAt - a.createdAt || b.messageId - a.messageId).slice(0, MAX_RECENT_LABELS);
}

export function resolvePromiseLabel(
  store: Store,
  threadId: string,
  label: string,
  expected: { chatId: number; topicId: number; botId: number; ownerId: number; kind: "owner" | "group" },
  now = Date.now(),
): PromiseLabel | undefined {
  const key = promiseLabelKey(threadId, label);
  const entry = store.get<PromiseLabel>(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.del(key);
    return undefined;
  }
  if (
    entry.threadId !== threadId ||
    entry.chatId !== expected.chatId ||
    entry.topicId !== expected.topicId ||
    entry.botId !== expected.botId ||
    entry.ownerId !== expected.ownerId ||
    entry.kind !== expected.kind
  ) {
    return undefined;
  }
  return entry;
}

export function markPromiseDelivered(store: Store, threadId: string, label: string, body: string) {
  const key = promiseLabelKey(threadId, label);
  const entry = store.get<PromiseLabel>(key);
  if (!entry) return;
  store.put(key, { ...entry, lastDeliveredWords: normalizePromiseWords(body) });
}

export function formatRecentLabelsNote(labels: readonly PromiseLabel[]): string {
  if (!labels.length) return "";
  const lines = labels.slice(0, MAX_RECENT_LABELS).map(l => {
    const who = l.senderName ? ` от ${l.senderName}` : "";
    const text = l.excerpt ? `: «${l.excerpt}»` : "";
    return `• №${l.messageId}${who}${text} — метка: ${l.label}`;
  });
  return [
    PROMISE_NOTE_MARKER,
    "Этот ход начат не из Telegram, поэтому его обычный итог в чат не уходит. " +
      "Если нужно доставить обещанный ответ человеку по недавнему обращению (действует 24 ч), напиши отдельное сообщение строго в формате:\n" +
      "[telegram-answer:<метка>]\n<текст ответа>\n[/telegram-answer]\n" +
      "Недавние обращения людей в этом чате:",
    ...lines,
  ].join("\n");
}
