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

test("a mention of a person by id becomes a Telegram mention, not raw brackets", async () =>
  assert.equal(await send("[Виктор](tg://user?id=12345), встреча в 16:00"), '<a href="tg://user?id=12345">Виктор</a>, встреча в 16:00'));

test("group send preserves all 15 lines across an unfinished local link", async () => {
  const first = Array.from({length: 14}, (_, i) => ("• " + (i === 13 ? "По просьбе Миры" : "Макет")).padEnd(111, "а")).join("\n");
  const prefix = first + "[лист](/макет\n• ";
  const text = prefix.padEnd(2474, "б") + ")";
  assert.equal(await send(text), text);
  assert.equal(await send("[лист](/tmp/list.pdf) и (обычная проза)"), "лист и (обычная проза)");
});

test("multipart group question retains paragraph boundaries, destination and all receipts", async () => {
  const t = fakeTelegram();
  const first = "Запись ".repeat(430) + "\n\n";
  const second = "Ответ ".repeat(370) + "?";
  const buttons = {inline_keyboard: []};
  const args = {chatId: CHAT, topicId: TOPIC, markdown: first + second, replyMarkup: buttons};
  assert.deepEqual(await sendFormattedText(t.tg, args), [1, 2]);
  assert.deepEqual(t.calls.map(c => c.body.text), [first, second]);
  assert.deepEqual(t.calls.map(c => c.body.reply_markup), [undefined, buttons]);
  assert.ok(t.calls.every(c => c.body.chat_id === CHAT && c.body.message_thread_id === TOPIC));
  let count = 0;
  await assert.rejects(sendFormattedText(async (...call) => {
    if (++count === 2) throw new TelegramFailure("telegram_403");
    return (t.tg as any)(...call);
  }, args), /partial_send:.*part=2.*telegram_403/);
});

test("oversized code, words and URLs retain characters, balanced tags and only the first reply",async()=>{
  const content="🙂<&".repeat(2400);
  const url="https://example.invalid/"+ "w".repeat(5200);
  for(const [markdown,expected] of [["\u0060\u0060\u0060\n"+content+"\n\u0060\u0060\u0060",content],[url,url],["[макет]("+url+")","макет ("+url+")"]]){
    const t=fakeTelegram();
    await sendFormattedText(t.tg,{chatId:CHAT,topicId:TOPIC,replyTo:43,markdown});
    assert.ok(t.calls.length>1);
    assert.equal(t.calls.map(c=>plainFromHtml(c.body.text)).join(""),expected);
    for(const [i,c] of t.calls.entries()){
      assert.equal(c.body.reply_parameters?.message_id,i===0?43:undefined);
      assert.ok(c.body.text.length<=4096);
      if(expected===content) assert.match(c.body.text,/^<code>.+<\/code>$/u);
    }
  }
});

test("greedy splitting fills the first message past a short introduction and backs up to a sentence",async()=>{
  const intro="Итоги.\n\n";
  const sentence="Сверили макет и согласовали подпись. ";
  const markdown=intro+sentence.repeat(180).trimEnd();
  const t=fakeTelegram();
  await sendFormattedText(t.tg,{chatId:CHAT,topicId:TOPIC,markdown});
  const first=t.calls[0].body.text;
  assert.equal(first,intro+sentence.repeat(Math.floor((4096-intro.length)/sentence.length)));
  assert.equal(t.calls.map(c=>c.body.text).join(""),markdown);
});
