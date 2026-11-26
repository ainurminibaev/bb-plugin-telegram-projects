import test from "node:test";
import assert from "node:assert/strict";
import {TelegramFailure,type Telegram} from "../model";
import {editFormatted,formattedCaption,plainFromHtml,sendFormattedFile} from "../outbound-message";
import {routedCaption} from "../routed-message";

// The text of a real caption people saw with «**» (a file with the agent's text), word for word.
const text="**Начать с пунктов 1–3?**\n\nГотового модуля «под ключ» нет. Открытые Telegram-боты для Google Календаря на GitHub заброшены и умеют меньше нашего, а n8n и Zapier закрывают только куски задачи. Поэтому лучше оставить своё и дописать 5 вещей:\n\n1. **Сообщения об изменениях:** «перенесли с пт 15:00 на пн 11:00», «отменили», «новое приглашение», «сменилось место». Сейчас при переносе напоминание приходит уже на новое время, но о самом переносе ты не узнаёшь.\n2. **Напоминания за неделю, за день и за 2 часа** для ивентов из анонсов.\n3. **Сводки:** утром на день и в воскресенье вечером на неделю.\n4. **«Пора выезжать»** с учётом пробок. Нужны адреса дома и офиса и платный ключ к картам Google.\n5. **Подготовка к встрече** за полчаса: кто будет, о чём вы уже переписывались, какие файлы.\n\nКак ты просил, календарь теперь проверяю раз в 15 минут.\n\nПодробности, сравнение и источники — в PDF.";
const file={kind:"document" as const,name:"calendar-research.pdf",data:new Blob(["%PDF-1"]),sha256:"",bytes:6};

test("a file's caption is formatted as a message: bold, numbered list; no «**» left",()=>{
  const caption=formattedCaption(text)!;
  assert.ok(caption,"fits one caption");
  assert.match(caption,/<b>Начать с пунктов 1–3\?<\/b>/);
  assert.match(caption,/1\. <b>Сообщения об изменениях:<\/b>/);
  assert.doesNotMatch(caption,/\*\*/);
  const plain=plainFromHtml(caption);
  assert.doesNotMatch(plain,/\*\*|<b>/,"the plain fallback has no Markdown marks either");
  assert.match(plain,/^Начать с пунктов 1–3\?/);
  assert.doesNotMatch(plainFromHtml(formattedCaption("См. [отчёт](https://example.org/r)")!),/\[|\]\(/,"a link is «name (address)», not Markdown");
  assert.equal(routedCaption(text+"\n\n[PDF](/x/calendar-research.pdf)",[{path:"/x/calendar-research.pdf",markdown:"[PDF](/x/calendar-research.pdf)"} as any]),caption);
});

test("send with one file: the caption goes as Telegram HTML; if Telegram rejects it — plain words without marks",async()=>{
  const calls:any[]=[];
  const tg=(reject:boolean):Telegram=>(async <T>(method:string,body:Record<string,unknown>)=>{
    calls.push({method,body});
    if (reject && body.parse_mode) throw new TelegramFailure("telegram_400");
    return {chat:{id:-7},message_thread_id:3,message_id:9,document:{file_id:"f",file_name:file.name,file_size:file.bytes}} as T;
  }) as Telegram;
  assert.equal(await sendFormattedFile(tg(false),{chatId:-7,topicId:3,markdown:text,file}),9);
  assert.equal(calls[0].method,"sendDocument"); assert.equal(calls[0].body.parse_mode,"HTML");
  assert.doesNotMatch(String(calls[0].body.caption),/\*\*/);
  calls.length=0;
  assert.equal(await sendFormattedFile(tg(true),{chatId:-7,topicId:3,markdown:text,file}),9);
  assert.equal(calls.length,2); assert.equal(calls[1].body.parse_mode,undefined);
  assert.doesNotMatch(String(calls[1].body.caption),/\*\*|<b>/);
  calls.length=0;
  const ids:number[]=[];
  await sendFormattedFile(tg(false),{chatId:-7,topicId:3,markdown:text.repeat(2),file},ids);
  assert.deepEqual(ids,[9,9]);
  assert.deepEqual(calls.map(c=>c.method),["sendMessage","sendDocument"],"too long for a caption: the formatted text, then the file");
  assert.equal(calls[1].body.caption,undefined);
});

test("edit: a file's caption is edited by editMessageCaption, formatted; a text by editMessageText; unknown — text, then caption",async()=>{
  const calls:any[]=[];
  const tg=(noText:boolean,rejectHtml=false):Telegram=>(async <T>(method:string,body:Record<string,unknown>)=>{
    calls.push({method,body});
    if (noText && method==="editMessageText") throw new TelegramFailure("telegram_400");   // «there is no text in the message to edit»
    if (rejectHtml && body.parse_mode) throw new TelegramFailure("telegram_400");
    return {message_id:9} as T;
  }) as Telegram;
  assert.equal(await editFormatted(tg(false),{chatId:-7,messageId:359,markdown:text,caption:true}),"caption");
  assert.equal(calls[0].method,"editMessageCaption"); assert.equal(calls[0].body.parse_mode,"HTML");
  assert.match(String(calls[0].body.caption),/<b>Начать с пунктов 1–3\?<\/b>/); assert.doesNotMatch(String(calls[0].body.caption),/\*\*/);
  calls.length=0;
  assert.equal(await editFormatted(tg(false),{chatId:-7,messageId:5,markdown:"**да**",caption:false}),"text");
  assert.deepEqual(calls.map(c=>c.method),["editMessageText"]);
  calls.length=0;
  assert.equal(await editFormatted(tg(true),{chatId:-7,messageId:5,markdown:"**да**"}),"caption","not in the archive: Telegram says it has no text");
  assert.equal(calls.at(-1).method,"editMessageCaption");
  calls.length=0;
  await editFormatted(tg(false,true),{chatId:-7,messageId:359,markdown:text,caption:true});
  assert.equal(calls.length,2); assert.equal(calls[1].body.parse_mode,undefined);
  assert.doesNotMatch(String(calls[1].body.caption),/\*\*|<b>/,"a refused formatting — plain words without marks");
  await assert.rejects(editFormatted(tg(false),{chatId:-7,messageId:359,markdown:text.repeat(2),caption:true}),/edit_caption_too_long/);
});

test("a caption and its edit keep prose following an unfinished link",async()=>{
  const markdown="• По просьбе Миры [лист](/макет\n• Уточнили сроки)";
  assert.equal(formattedCaption(markdown),markdown);
  const tg:Telegram=async<T>(_method,body)=>{
    assert.equal(body.caption,markdown);
    return true as T;
  };
  await editFormatted(tg,{chatId:-7,messageId:9,markdown,caption:true});
});
