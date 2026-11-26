import { randomUUID } from "node:crypto";
import type { Store, Telegram } from "./model";
import { canInvokeGroup, type GroupTopicPolicy } from "./ingress";
import { effectiveGroupPolicy } from "./rights";
import { isTopicPaused } from "./topic-lifecycle";

export const MAX_ACTION_BUTTONS = 6;
const MAX_LABEL_LEN = 64;
const MAX_DATA_LEN = 256;
const MAX_EXCERPT_LEN = 200;

export type ActionButton = { label: string; data?: string };

export type ActionButtonRecord = {
  token: string;
  botId: number;
  ownerId: number;
  chatId: number;
  topicId: number;
  messageId: number;
  buttons: ActionButton[];
  textExcerpt: string;
  createdAt: number;
};

export const actionButtonKey = (botId: number, token: string) => `action:btn:${botId}:${token}`;

export function parseActionButtons(raw: readonly string[]): { buttons: ActionButton[] } | { error: string } {
  if (raw.length > MAX_ACTION_BUTTONS) return { error: `too_many_buttons: максимум ${MAX_ACTION_BUTTONS} кнопок` };
  const buttons: ActionButton[] = [];
  for (const item of raw) {
    const eq = item.indexOf("=");
    const label = (eq >= 0 ? item.slice(0, eq) : item).replace(/\s+/g, " ").trim();
    const data = eq >= 0 ? item.slice(eq + 1).trim() : undefined;
    if (!label) return { error: "empty_button_label: подпись кнопки не может быть пустой" };
    if (label.length > MAX_LABEL_LEN) return { error: `button_label_too_long: максимум ${MAX_LABEL_LEN} знаков` };
    if (data && data.length > MAX_DATA_LEN) return { error: `button_data_too_long: максимум ${MAX_DATA_LEN} знаков` };
    buttons.push(data ? { label, data } : { label });
  }
  return { buttons };
}

export function buildActionKeyboard(token: string, buttons: readonly ActionButton[]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows: { text: string; callback_data: string }[][] = [];
  let row: { text: string; callback_data: string }[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const btn = { text: buttons[i].label, callback_data: `ab:${token}:${i}` };
    if (buttons[i].label.length > 20) {
      if (row.length) { rows.push(row); row = []; }
      rows.push([btn]);
    } else {
      row.push(btn);
      if (row.length === 2) { rows.push(row); row = []; }
    }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

export function newActionButtonToken(): string {
  return randomUUID().slice(0, 8);
}

export function rememberActionButtons(
  store: Store,
  input: Omit<ActionButtonRecord, "textExcerpt" | "createdAt"> & { text: string; now?: number },
): ActionButtonRecord {
  const excerpt = input.text.replace(/\s+/g, " ").trim();
  const record: ActionButtonRecord = {
    token: input.token,
    botId: input.botId,
    ownerId: input.ownerId,
    chatId: input.chatId,
    topicId: input.topicId,
    messageId: input.messageId,
    buttons: input.buttons,
    textExcerpt: excerpt.length > MAX_EXCERPT_LEN ? excerpt.slice(0, MAX_EXCERPT_LEN - 1) + "…" : excerpt,
    createdAt: input.now ?? Date.now(),
  };
  store.put(actionButtonKey(input.botId, input.token), record);
  return record;
}

export function formatActionClickText(clickerName: string, button: ActionButton, messageId: number, excerpt: string): string {
  const base = `${clickerName} нажал «${button.label}» под сообщением №${messageId}: «${excerpt}»`;
  return button.data ? `${base}; данные: ${button.data}` : base;
}

function appendMark(current: string, mark: string, limit: number): string {
  const lines = current.split("\n");
  if (lines[lines.length - 1]?.trim() === mark) return current;
  const next = current ? `${current}\n${mark}` : mark;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export async function acceptActionButtonCallback(
  deps: {
    store: Store;
    bot: number;
    owner: number;
    tgFor: (chatId: number) => Telegram;
    deliverOwner: (args: { chatId: number; topicId: number; messageId: number; updateId: number; text: string }) => Promise<void>;
    wake?: () => void;
  },
  update: any,
): Promise<boolean> {
  const cb = update?.callback_query;
  const raw = typeof cb?.data === "string" ? cb.data : "";
  const m = /^ab:([a-f0-9-]{8,36}):([0-5])$/.exec(raw);
  if (!m) return false;
  const [, token, idxStr] = m;
  const idx = Number(idxStr);
  const from = cb.from;
  const msg = cb.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  const tg = deps.tgFor(Number.isSafeInteger(chatId) ? chatId : deps.owner);
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, text }).catch(() => {});

  const record = deps.store.get<ActionButtonRecord>(actionButtonKey(deps.bot, token));
  if (!record || !from || from.is_bot || !Number.isSafeInteger(from.id) || from.id <= 0 ||
      record.chatId !== chatId || record.messageId !== messageId || !record.buttons[idx]) {
    await answer("Кнопка устарела.");
    return true;
  }

  const isOwnerDm = record.chatId === deps.owner;
  let policy: GroupTopicPolicy | undefined;
  let allowed = false;
  if (isOwnerDm) {
    allowed = from.id === deps.owner;
  } else if (record.chatId > 0) {
    const bound = deps.store.get<GroupTopicPolicy>(`group:policy:${record.chatId}:0`);
    policy = bound && bound.botId === deps.bot && !isTopicPaused(deps.store, deps.bot, record.chatId, 0) ? bound : undefined;
    allowed = !!policy && from.id === record.chatId;
  } else {
    const bound = deps.store.get<GroupTopicPolicy>(`group:policy:${record.chatId}:${record.topicId}`);
    if (bound && bound.botId === deps.bot && (bound.ownerId === undefined || bound.ownerId === deps.owner) &&
        !isTopicPaused(deps.store, deps.bot, record.chatId, record.topicId)) {
      policy = effectiveGroupPolicy(deps.store, bound, deps.owner);
      allowed = canInvokeGroup(policy, deps.owner, from.id);
    }
  }

  if (!allowed) {
    await answer("У вас нет права нажимать эту кнопку здесь.");
    return true;
  }

  const btn = record.buttons[idx];
  const clickerName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim().slice(0, 64) ||
    (from.username ? "@" + from.username : String(from.id));
  await answer(`✓ ${btn.label}`);

  // Mark the click under the message while keeping all buttons intact.
  const mark = `✓ ${btn.label} — ${clickerName}`;
  const markup = buildActionKeyboard(token, record.buttons);
  if (typeof msg.caption === "string") {
    const nextCaption = appendMark(msg.caption, mark, 1024);
    await tg("editMessageCaption", { chat_id: chatId, message_id: messageId, caption: nextCaption, reply_markup: markup }).catch(() => {});
  } else if (typeof msg.text === "string") {
    const nextText = appendMark(msg.text, mark, 4096);
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: nextText, reply_markup: markup }).catch(() => {});
  }

  const clickText = formatActionClickText(clickerName, btn, record.messageId, record.textExcerpt);
  if (isOwnerDm) {
    await deps.deliverOwner({
      chatId: deps.owner,
      topicId: record.topicId,
      messageId: record.messageId,
      updateId: update.update_id,
      text: clickText,
    });
  } else if (policy) {
    const jobKey = `group:in:${deps.bot}:${update.update_id}`;
    if (!deps.store.get(jobKey) && !deps.store.get(`group:receipt:${deps.bot}:${update.update_id}`)) {
      deps.store.put(jobKey, {
        ownerId: deps.owner,
        revision: policy.revision,
        state: "pending",
        route: {
          kind: "group",
          chatId: record.chatId,
          topicId: record.topicId,
          senderId: from.id,
          senderName: clickerName,
          threadId: policy.threadId,
          messageId: record.messageId,
          updateId: update.update_id,
          text: clickText,
          ownText: clickText,
        },
      });
      deps.wake?.();
    }
  }
  return true;
}
