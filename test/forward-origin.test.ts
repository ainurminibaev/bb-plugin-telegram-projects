import test from "node:test";
import assert from "node:assert/strict";
import {forwardOriginOf} from "../ingress";
import {forwardLabel} from "../chat";

// С73: whose words a forwarded message carries. The agent never takes them for the words of whoever forwarded it.
const BOT = 5;
test("four kinds of authors are named, with the date", () => {
  const date = 1795460000;
  const person = forwardOriginOf({type: "user", date, sender_user: {id: 21, first_name: "Иван", last_name: "Петров", is_bot: false}});
  assert.match(forwardLabel(person, BOT), /Автор оригинала: Иван Петров \(человек\), \d\d\.\d\d, \d\d:\d\d МСК\. Это слова автора оригинала, а не того, кто переслал/);
  const bot = forwardOriginOf({type: "user", date, sender_user: {id: 77, first_name: "Другой", username: "other_bot", is_bot: true}});
  assert.match(forwardLabel(bot, BOT), /Другой @other_bot \(бот\)/);
  assert.match(forwardLabel(forwardOriginOf({type: "hidden_user", date, sender_user_name: "Аноним"}), BOT), /Аноним \(автор скрыл профиль\)/);
  assert.match(forwardLabel(forwardOriginOf({type: "chat", date, sender_chat: {title: "Склад"}}), BOT), /чат «Склад»/);
  assert.match(forwardLabel(forwardOriginOf({type: "channel", date, chat: {title: "Новости"}, author_signature: "Редактор"}), BOT), /канал «Новости, подпись Редактор»/);
});

test("the agent's own forwarded message is named as its own", () => {
  const own = forwardOriginOf({type: "user", date: 1795460000, sender_user: {id: BOT, first_name: "Помощник", is_bot: true}});
  assert.match(forwardLabel(own, BOT), /это твоё собственное сообщение.*Его слова — твои, а не того, кто переслал/);
  assert.equal(forwardLabel(undefined, BOT), "[Пересланное сообщение]\n");
  assert.equal(forwardOriginOf(undefined), undefined);
});
