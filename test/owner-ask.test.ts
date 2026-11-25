import test from "node:test";
import assert from "node:assert/strict";
import {acceptOwnerAskCallback, answerTurnText, queueAnswerTurn, askButtons, cleanQuestion, forwardOriginal, messageLink, ownerQuestion, rememberAskMessage} from "../owner-ask";
import {ownerAskNotes, rememberAsk} from "../send-command";
import {setAccess} from "../rights";

const OWNER = 7, BOT = 5, VIKTOR = 21, MEMBER = 22;
function memory() {
  const rows = new Map<string, any>();
  return {rows, get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); }, del: (k: string) => { rows.delete(k); },
    list: <T>(p: string) => [...rows].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({key, value: value as T})), atomic: (f: () => void) => f()};
}

test("the question has no service numbers, names who asks with the status and links the original group message (С67)", () => {
  const s = memory();
  setAccess(s as never, BOT, [{id: VIKTOR, name: "Виктор"}]);
  const turn = {chat: -1001234567890, topic: 68, message: 585, sender: VIKTOR, senderName: "Виктор"};
  const text = ownerQuestion({store: s as never, bot: BOT, owner: OWNER, place: "группы «Пилот»", turn,
    body: "Можно создать репозиторий? Ответь «да» или «нет». ID запроса: a1b697cb-e632-43ab-ba42-0012b5cfe197."});
  assert.doesNotMatch(text, /ID запроса|a1b697cb/);
  assert.match(text, /Вопрос из группы «Пилот»\. Просит: Виктор — одобренный собеседник\./);
  assert.match(text, /Исходная просьба: https:\/\/t\.me\/c\/1234567890\/68\/585/);
  assert.match(text, /Ответьте кнопкой или ответом на это сообщение\./);
  const member = ownerQuestion({store: s as never, bot: BOT, owner: OWNER, place: "группы «Пилот»", body: "?", turn: {...turn, sender: MEMBER, senderName: "Олег"}});
  assert.match(member, /Олег — участник группы/);
  assert.equal(messageLink(-5000000001, 0, 9), undefined, "a basic group has no message links");
  assert.equal(messageLink(-1009876543210, 0, 9), "https://t.me/c/9876543210/9");
  assert.equal(cleanQuestion("Да? (ID вопроса: 9a6f934e)"), "Да?");
  assert.equal(cleanQuestion("Можно? Номер запроса: 0a77081a-d4ea-4608-8304-c7987148ead4."), "Можно?");
});

test("«Да» and «Нет» are buttons; a press reaches the asking conversation once, other people's presses are ignored", async () => {
  const s = memory();
  const ask = rememberAsk(s as never, BOT, OWNER, {chat: -1001, topic: 68}, "Создать тестовую задачу?");
  assert.deepEqual(askButtons(ask.id).inline_keyboard[0].map(b => b.callback_data), [`oa:y:${ask.id}`, `oa:n:${ask.id}`]);
  const calls: any[] = []; const delivered: string[] = [];
  const tg = (async (method: string, body: any) => { calls.push([method, body]); return {}; }) as any;
  const deliver = async (a: any, answer: string) => { delivered.push(a.id + ":" + answer); s.del(`send:ask:${BOT}:${a.id}`); return true; };
  const press = (from: number, data: string) => acceptOwnerAskCallback({store: s as never, bot: BOT, owner: OWNER, tg, deliver},
    {callback_query: {id: "c", from: {id: from}, data, message: {message_id: 9, chat: {id: OWNER}}}});
  assert.equal(await press(VIKTOR, `oa:y:${ask.id}`), true);
  assert.deepEqual(delivered, [], "only the owner answers");
  assert.equal(await press(OWNER, `oa:y:${ask.id}`), true);
  assert.deepEqual(delivered, [`${ask.id}:да`]);
  assert.ok(calls.some(([m, b]) => m === "editMessageReplyMarkup" && b.reply_markup.inline_keyboard[0][0].text === "Ответ: да"));
  assert.equal(await press(OWNER, `oa:n:${ask.id}`), true);
  assert.deepEqual(delivered, [`${ask.id}:да`], "a closed question is not answered twice");
  assert.equal(await press(OWNER, "ep:allow:x"), false, "other buttons are not this kind");
});

test("several open questions are never guessed; a reply to the question message names it", () => {
  const s = memory();
  const a = rememberAsk(s as never, BOT, OWNER, {chat: -1001, topic: 68}, "Создать задачу?");
  const b = rememberAsk(s as never, BOT, OWNER, {chat: -1001, topic: 68}, "Создать репозиторий?");
  rememberAskMessage(s as never, BOT, 840, b.id);
  assert.match(ownerAskNotes(s as never, OWNER), /не угадывай/);
  const replied = ownerAskNotes(s as never, OWNER, Date.now(), 840);
  assert.match(replied, new RegExp(`--answer ${b.id}`));
  assert.doesNotMatch(replied, new RegExp(a.id));
});

test("the answer comes to the asking conversation as the owner's own words; a person's message is forwarded or quoted", async () => {
  const s = memory();
  const ask = rememberAsk(s as never, BOT, OWNER, {chat: -1001, topic: 68}, "Создать задачу?");
  assert.match(answerTurnText(ask, "да", "button"), /Владелец ответил на твой вопрос кнопкой в Telegram: «да»/);
  const sent: any[] = [];
  const ok = (chat: number) => (async (m: string, b: any) => { sent.push([chat, m, b]); return {}; }) as any;
  assert.equal(await forwardOriginal(ok, OWNER, {chat: VIKTOR, topic: 0, message: 12, sender: VIKTOR, text: "можно?"}), "forwarded");
  assert.equal(sent[0][1], "forwardMessage");
  const refuse = (chat: number) => (async (m: string, b: any) => { if (m === "forwardMessage") throw Error("protected"); sent.push([chat, m, b]); return {}; }) as any;
  assert.equal(await forwardOriginal(refuse, OWNER, {chat: VIKTOR, topic: 0, message: 12, sender: VIKTOR, senderName: "Виктор", text: "можно?"}), "quoted");
  assert.match(sent.at(-1)[2].text, /цитатой — переслать нельзя/);
  // 0.9.76: a second question about the same request does not forward the same message again.
  const n = sent.length;
  assert.equal(await forwardOriginal(ok, OWNER, {chat: VIKTOR, topic: 0, message: 13, sender: VIKTOR, text: "а это?"}, s as never), "forwarded");
  assert.equal(await forwardOriginal(ok, OWNER, {chat: VIKTOR, topic: 0, message: 13, sender: VIKTOR, text: "а это?"}, s as never), "already");
  assert.equal(sent.length, n + 1);
});

test("the answer becomes a request of the asking conversation under the original message", () => {
  const s = memory();
  s.put("group:policy:21:0", {threadId: "dm", revision: "r", botId: BOT, chatId: 21, topicId: 0});
  const ask = {...rememberAsk(s as never, BOT, OWNER, {chat: 21, topic: 0}, "Уйти в 17:00?"), replyTo: 2343};
  assert.equal(queueAnswerTurn(s as never, BOT, OWNER, ask, answerTurnText(ask, "да", "button"), {id: OWNER, name: "Владелец"}), true);
  const [job] = s.list<any>(`group:in:${BOT}:`).map(r => r.value);
  assert.equal(job.state, "pending");
  assert.equal(job.route.messageId, 2343);
  assert.equal(job.route.threadId, "dm");
  assert.ok(job.route.updateId < 0, "no reaction on the owner's chat message");
  assert.match(job.route.text, /уйдёт сюда сам/);
  assert.equal(queueAnswerTurn(s as never, BOT, OWNER, {...ask, replyTo: undefined}, "x", {id: OWNER, name: "В"}), false);
});

test("С83: a question posted into the topic the work came from is answered there by the owner", async () => {
  const s = memory();
  const ask = rememberAsk(s as never, BOT, OWNER, {chat: OWNER, topic: 0}, "Отправить смету?");
  s.put(`send:ask:${BOT}:${ask.id}`, {...s.get<any>(`send:ask:${BOT}:${ask.id}`), originThread: "orchestrator", postedChat: -1001});
  const delivered: string[] = []; const edits: any[] = [];
  const tg = (async () => ({})) as any;
  const tgFor = (chat: number) => (async (method: string, body: any) => { edits.push([chat, method, body.chat_id]); return {}; }) as any;
  const deliver = async (a: any, answer: string) => { delivered.push(a.id + ":" + answer); return true; };
  const press = (from: number, chat: number) => acceptOwnerAskCallback({store: s as never, bot: BOT, owner: OWNER, tg, deliver, tgFor},
    {callback_query: {id: "c", from: {id: from}, data: `oa:y:${ask.id}`, message: {message_id: 9, chat: {id: chat}}}});
  await press(VIKTOR, -1001);
  assert.deepEqual(delivered, [], "only the owner answers");
  await press(OWNER, -2002);
  assert.deepEqual(delivered, [], "not from another chat");
  await press(OWNER, -1001);
  assert.deepEqual(delivered, [`${ask.id}:да`]);
  assert.ok(edits.some(([chat, m, id]) => chat === -1001 && m === "editMessageReplyMarkup" && id === -1001));
});
