import test from "node:test";
import assert from "node:assert/strict";
import { plainFromHtml, sendFormattedText } from "../outbound-message";
import { TelegramFailure } from "../model";

// Group answers, `send` and scheduled group messages: the same formatting as the owner's private chat.
const CHAT = -1001, TOPIC = 3;
function fakeTelegram(reject = false) {
  const calls: any[] = [];
  const tg = async (method: string, body: any) => {
    calls.push({ method, body });
    if (reject && body.parse_mode) throw new TelegramFailure("telegram_400");
    return { message_id: calls.length, chat: { id: CHAT }, message_thread_id: TOPIC };
  };
  return { tg: tg as never, calls };
}
const send = async (markdown: string) => {
  const t = fakeTelegram();
  await sendFormattedText(t.tg, { chatId: CHAT, topicId: TOPIC, markdown });
  assert.equal(t.calls[0].body.parse_mode, "HTML");
  assert.equal(t.calls[0].body.message_thread_id, TOPIC);
  return t.calls[0].body.text as string;
};

test("bold", async () => assert.equal(await send("Срок **завтра**"), "Срок <b>завтра</b>"));
test("italic", async () => assert.equal(await send("Это *важно* сейчас"), "Это <i>важно</i> сейчас"));
test("list", async () => assert.equal(await send("- первое\n- второе"), "• первое\n• второе"));
test("inline code and a code block", async () => {
  assert.equal(await send("Команда `git pull`"), "Команда <code>git pull</code>");
  assert.equal(await send("```\na < b\n```"), "<code>a &lt; b</code>");
});
test("link", async () =>
  assert.equal(await send("[Карточка](https://example.com/c/1)"), '<a href="https://example.com/c/1">Карточка</a>'));
test("heading", async () => assert.equal(await send("## Итог"), "<b>Итог</b>"));

test("rejected formatting goes as plain words", async () => {
  const t = fakeTelegram(true);
  const ids = await sendFormattedText(t.tg, { chatId: CHAT, topicId: TOPIC, markdown: "**Итог** и [ссылка](https://example.com)" });
  assert.equal(ids.length, 1);
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].body.parse_mode, undefined);
  assert.equal(t.calls[1].body.text, "Итог и ссылка (https://example.com)");
});

test("a long answer is split into whole parts", async () => {
  const t = fakeTelegram();
  const ids = await sendFormattedText(t.tg, { chatId: CHAT, topicId: TOPIC, markdown: ("**слово** ".repeat(800)).trim() });
  assert.ok(ids.length > 1);
  for (const c of t.calls) {
    assert.ok(c.body.text.length <= 4096);
    assert.equal((c.body.text.match(/<b>/g) ?? []).length, (c.body.text.match(/<\/b>/g) ?? []).length);
  }
});

test("plain words keep escaped characters", () => assert.equal(plainFromHtml("<b>a &lt; b &amp; c</b>"), "a < b & c"));
