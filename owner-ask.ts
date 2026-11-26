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

const STATUS = {owner: "владелец", approved: "одобренный собеседник", member: "участник группы", agent: "коллега-агент"} as const;

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
export async function forwardOriginal(tg: (chat: number) => Telegram, owner: number, turn: TurnMessage, store?: Store) {
  // Once per original message: a second question about the same request does not bring the same message again.
  const key = `send:ask-forwarded:${turn.chat}:${turn.message}`;
  if (store?.get(key)) return "already";
  try {
    await tg(owner)("forwardMessage", {chat_id: owner, from_chat_id: turn.chat, message_id: turn.message});
    store?.put(key, Date.now());   // marked only once it went: a failed forward is tried again next time
    return "forwarded";
  } catch {
    if (!turn.text?.trim()) return "none";
    await tg(owner)("sendMessage", {chat_id: owner, text: `Сообщение ${turn.senderName ?? "человека"} (цитатой — переслать нельзя):\n«${turn.text.slice(0, 1500)}»`}).catch(() => {});
    return "quoted";
  }
}

export type DeliverAnswer = (ask: Ask, answer: string, via: "button" | "text") => Promise<boolean>;

/** The owner pressed «Да» or «Нет» under a question. Returns true when the update was this kind of button. */
/** Lines of the owner's chat the conversation did not take part in (a card of another conversation and its answer). */
const chatLinesKey = (owner: number) => `chat:owner-lines:${owner}`;
export function rememberChatLine(store: Store, owner: number, line: string) {
  store.put(chatLinesKey(owner), [...(store.get<{line: string; at: number}[]>(chatLinesKey(owner)) ?? []), {line, at: Date.now()}].slice(-5));
}
/** Taken once, into the next turn of the owner's chat. */
export function takeChatLines(store: Store, owner: number) {
  const lines = (store.get<{line: string; at: number}[]>(chatLinesKey(owner)) ?? []).filter(l => Date.now() - l.at < 86400_000);
  store.del(chatLinesKey(owner));
  return lines.length ? "Раньше в этом чате (без тебя): " + lines.map(l => l.line).join("; ") + "." : "";
}

export async function acceptOwnerAskCallback(d: {store: Store; bot: number; owner: number; tg: Telegram; deliver: DeliverAnswer;
  tgFor?: (chat: number) => Telegram}, update: any) {
  const cq = update?.callback_query;
  if (cq?.data === "oa:done") { await d.tg("answerCallbackQuery", {callback_query_id: cq.id}).catch(() => {}); return true; }
  const m = /^oa:(y|n):([a-f0-9]{8})$/.exec(cq?.data ?? "");
  if (!cq || !m) return false;
  const ask = d.store.get<Ask & {postedChat?: number}>(`send:ask:${d.bot}:${m[2]}`);
  const chat = cq.message?.chat?.id;
  // С83: a question posted into the topic the work came from is answered there, by the owner himself.
  const here = chat === d.owner || (!!ask?.postedChat && chat === ask.postedChat);
  if (cq.from?.id !== d.owner || !here) {
    await d.tg("answerCallbackQuery", {callback_query_id: cq.id}).catch(() => {});
    return true;
  }
  const tgHere = chat === d.owner || !d.tgFor ? d.tg : d.tgFor(chat);
  const answer = m[1] === "y" ? "да" : "нет";
  if (!ask || ask.target !== d.owner) {
    await d.tg("answerCallbackQuery", {callback_query_id: cq.id, text: "Этот вопрос уже закрыт."}).catch(() => {});
    await tgHere("editMessageReplyMarkup", {chat_id: chat, message_id: cq.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
    return true;
  }
  const ok = await d.deliver(ask, answer, "button").catch(() => false);
  // Case 35 (0.9.77): the card and its button answer stay in this chat's own conversation as ordinary lines — the next
  // turn of the owner's chat sees «there was a question …; the owner answered …», nothing is wiped or substituted.
  if (ok && chat === d.owner) rememberChatLine(d.store, d.owner, `в этом чате был вопрос ${ask.question.slice(0, 300)} — владелец ответил кнопкой: «${answer}»`);
  await d.tg("answerCallbackQuery", {callback_query_id: cq.id, text: ok ? `Передал: ${answer}` : "Не удалось передать ответ, попробуйте ещё раз."}).catch(() => {});
  if (ok) await tgHere("editMessageReplyMarkup", {chat_id: chat, message_id: cq.message.message_id,
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
