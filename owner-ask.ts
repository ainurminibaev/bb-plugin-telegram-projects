import type {Store, Telegram} from "./model";
import type {Ask} from "./send-command";
import {authorStatus} from "./rights";

/**
 * A question to the owner from another conversation (С43, С67).
 * The owner sees where it comes from, who asks and their status, the original request (a link to the group message,
 * or the person's message forwarded), and answers with a button or by replying; the answer comes back to the asking
 * conversation as a turn, so the agent there carries on with the work.
 */
const askMessageKey = (bot: number, messageId: number) => `send:ask-msg:${bot}:${messageId}`;
export const turnMessageKey = (threadId: string) => `group:turn-message:${threadId}`;
export type TurnMessage = {chat: number; topic: number; message: number; sender: number; senderName?: string; text?: string};

export function askButtons(id: string) {
  return {inline_keyboard: [[{text: "Да", callback_data: `oa:y:${id}`}, {text: "Нет", callback_data: `oa:n:${id}`}]]};
}

/** Service numbers never reach the owner: the link between a question and its answer is the button or the reply. */
export function cleanQuestion(text: string) {
  return text.replace(/\s*\(?\s*(ID|айди|номер|идентификатор)\s+(запроса|вопроса|просьбы)\s*:?\s*[\w-]{6,}\s*\)?\.?/giu, "")
    .replace(/\s*Ответьте мне здесь[^\n]*/g, "").trim();
}

/** t.me link to a message of a group or a forum topic (supergroups only). */
export function messageLink(chat: number, topic: number, message: number) {
  const id = String(chat);
  if (!id.startsWith("-100")) return undefined;
  return `https://t.me/c/${id.slice(4)}/${topic > 0 ? topic + "/" : ""}${message}`;
}

const STATUS = {owner: "владелец", approved: "одобренный собеседник", member: "участник группы"} as const;

/** The question text the owner gets: place, who and their status, the original request, then the question. */
export function ownerQuestion(args: {store: Store; bot: number; owner: number; place: string; turn?: TurnMessage; body: string}) {
  const {turn} = args;
  const who = turn ? `${turn.senderName ?? turn.sender} — ${STATUS[authorStatus(args.store, args.bot, args.owner, turn.sender)]}` : undefined;
  const link = turn && turn.chat < 0 ? messageLink(turn.chat, turn.topic, turn.message) : undefined;
  const body = cleanQuestion(args.body);
  return [
    `Вопрос из ${args.place}${who ? `. Просит: ${who}` : ""}.`,
    link ? `Исходная просьба: ${link}` : "",
    body.length > 3500 ? body.slice(0, 3500) + "…" : body,
    "Ответьте кнопкой или ответом на это сообщение.",
  ].filter(Boolean).join("\n");
}

export function rememberAskMessage(store: Store, bot: number, messageId: number, askId: string) {
  store.put(askMessageKey(bot, messageId), askId);
}
export function askOfMessage(store: Store, bot: number, messageId: number | undefined) {
  return messageId === undefined ? undefined : store.get<string>(askMessageKey(bot, messageId));
}

/** The person's own message goes to the owner as it is; if Telegram does not forward it, a marked quote. */
export async function forwardOriginal(tg: (chat: number) => Telegram, owner: number, turn: TurnMessage) {
  try {
    await tg(owner)("forwardMessage", {chat_id: owner, from_chat_id: turn.chat, message_id: turn.message});
    return "forwarded";
  } catch {
    if (!turn.text?.trim()) return "none";
    await tg(owner)("sendMessage", {chat_id: owner, text: `Сообщение ${turn.senderName ?? "человека"} (цитатой — переслать нельзя):\n«${turn.text.slice(0, 1500)}»`}).catch(() => {});
    return "quoted";
  }
}

export type DeliverAnswer = (ask: Ask, answer: string, via: "button" | "text") => Promise<boolean>;

/** The owner pressed «Да» or «Нет» under a question. Returns true when the update was this kind of button. */
export async function acceptOwnerAskCallback(d: {store: Store; bot: number; owner: number; tg: Telegram; deliver: DeliverAnswer}, update: any) {
  const cq = update?.callback_query;
  if (cq?.data === "oa:done") { await d.tg("answerCallbackQuery", {callback_query_id: cq.id}).catch(() => {}); return true; }
  const m = /^oa:(y|n):([a-f0-9]{8})$/.exec(cq?.data ?? "");
  if (!cq || !m) return false;
  if (cq.from?.id !== d.owner || cq.message?.chat?.id !== d.owner) {
    await d.tg("answerCallbackQuery", {callback_query_id: cq.id}).catch(() => {});
    return true;
  }
  const ask = d.store.get<Ask>(`send:ask:${d.bot}:${m[2]}`);
  const answer = m[1] === "y" ? "да" : "нет";
  if (!ask || ask.target !== d.owner) {
    await d.tg("answerCallbackQuery", {callback_query_id: cq.id, text: "Этот вопрос уже закрыт."}).catch(() => {});
    await d.tg("editMessageReplyMarkup", {chat_id: d.owner, message_id: cq.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
    return true;
  }
  const ok = await d.deliver(ask, answer, "button").catch(() => false);
  await d.tg("answerCallbackQuery", {callback_query_id: cq.id, text: ok ? `Передал: ${answer}` : "Не удалось передать ответ, попробуйте ещё раз."}).catch(() => {});
  if (ok) await d.tg("editMessageReplyMarkup", {chat_id: d.owner, message_id: cq.message.message_id,
    reply_markup: {inline_keyboard: [[{text: `Ответ: ${answer}`, callback_data: "oa:done"}]]}}).catch(() => {});
  return true;
}

/** The answer as a turn of the asking conversation: it continues the work and reports where the request was made. */
export function answerTurnText(ask: Ask, answer: string, via: "button" | "text", who = "Владелец") {
  return [
    `[Мост Telegram] ${who} ответил на твой вопрос ${via === "button" ? "кнопкой в Telegram" : "в своей личке"}: «${answer}».`,
    `Вопрос был: «${ask.question.slice(0, 400)}».`,
    `Это ответ ${who === "Владелец" ? "самого владельца" : "этого человека"}. Продолжи дело по нему; твой ответ уйдёт сюда сам, под исходной просьбой — одним сообщением человеку: что решено и что сделано.`,
  ].join("\n");
}

/**
 * The answer enters the asking conversation as an ordinary request of its queue, under the original message:
 * the bridge then delivers the agent's reply itself, as for any message there. Returns false when that place is gone.
 */
export function queueAnswerTurn(store: Store, bot: number, owner: number, ask: Ask, text: string, sender: {id: number; name: string}) {
  const key = `group:policy:${ask.origin.chat}:${ask.origin.topic}`;
  const policy = store.get<{threadId?: string; revision?: string; botId?: number}>(key);
  if (!policy?.threadId || policy.botId !== bot || !ask.replyTo) return false;
  const updateId = -Date.now();
  store.put(`group:in:${bot}:${updateId}`, {ownerId: owner, revision: policy.revision, state: "pending", route: {
    kind: "group", chatId: ask.origin.chat, topicId: ask.origin.topic, senderId: sender.id, senderName: sender.name,
    threadId: policy.threadId, messageId: ask.replyTo, updateId, text}});
  return true;
}
