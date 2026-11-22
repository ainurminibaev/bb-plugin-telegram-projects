import test from "node:test";
import assert from "node:assert/strict";
import {CODEX_LOCK,groupScreen,handleSetupUpdate,notifyGroupsAdded,welcomeScreen} from "../setup-screens";
import {accessList,defaultGroupSettings,groupSettings,setAccess} from "../rights";

const OWNER=7, BOT=5, CHAT=-1004297046755, LENA=11, STRANGER=99;
function harness(provider="claude-code",admins=[OWNER]){
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
  store.put(`visibility:${BOT}:group:${CHAT}`,{chat:CHAT,title:"Склад",administrator:true,inviter:OWNER,event:4});
  store.put(`group:policy:${CHAT}:3`,{chatId:CHAT,topicId:3,threadId:"t",botId:BOT});
  store.put("rights:install-kind","employee");
  const sent:any[]=[];
  const tg=(chat:number)=>(async(method:string,p:any)=>{
    sent.push({chat,method,...p});
    if (method==="getChatMember") return {status:admins.includes(p.user_id)?"administrator":"member"};
    return {message_id:sent.length};
  }) as any;
  const ctx={store:store as any,bot:BOT,owner:OWNER,botUsername:"acme_bot",tg,zones:["Проект ERP","Сроки задач","Финансы"],role:"Я — помощник проекта.",
    sdk:{threads:{get:async()=>({providerId:provider})}} as any};
  let seq=0;
  const tap=(from:number,data:string)=>handleSetupUpdate(ctx,{update_id:++seq,callback_query:{id:"c"+seq,from:{id:from},data,message:{message_id:50,chat:{id:from,type:"private"}}}});
  const say=(from:number,text:string,extra:any={})=>handleSetupUpdate(ctx,{update_id:++seq,message:{message_id:60+seq,chat:{id:from,type:"private"},from:{id:from},text,...extra}});
  const last=(method:string)=>sent.filter(x=>x.method===method).at(-1);
  return {store,sent,ctx,tap,say,last};
}
const visibleText=(screen:any)=>[screen.text,...screen.reply_markup.inline_keyboard.flat().map((b:any)=>b.text)].join("\n");

test("one group fits one screen: every button shows its current value and no IDs or versions",()=>{
  const screen=groupScreen("Склад",CHAT,defaultGroupSettings(),false);
  const text=visibleText(screen);
  assert.doesNotMatch(text,/\d{4,}|версия|ID/);
  assert.match(text,/Ко мне обращаются: только те, кто может мне поручать/);
  assert.match(text,/Обращаются: только кто может поручать/);
  assert.match(text,/Отвечаю: когда отметили/);
  assert.doesNotMatch(text,/Остальным:/,"the level for other members appears only when everyone may call");
});

test("a tap saves at once and the screen shows the new value",async()=>{
  const h=harness();
  assert.equal(await h.say(OWNER,"Мои группы"),true);
  assert.match(visibleText(h.last("sendMessage")),/Склад — отвечаю всем/);
  await h.tap(OWNER,`rs:g:${CHAT}`);
  let screen=h.last("editMessageText");
  assert.match(visibleText(screen),/Обращаются: все участники/);
  assert.match(screen.text,/Все участники группы могут мне поручать/);
  assert.doesNotMatch(visibleText(screen),/Остальным:/);
  await h.tap(OWNER,`rs:w:${CHAT}`);
  assert.equal(groupSettings(h.store as any,BOT,CHAT)!.who,"access");
  screen=h.last("editMessageText");
  assert.match(visibleText(screen),/Обращаются: только кто может поручать/);
  await h.tap(OWNER,`rs:r:${CHAT}`);
  assert.equal(groupSettings(h.store as any,BOT,CHAT)!.reply,"auto");
  await h.tap(OWNER,`rs:z:${CHAT}`);
  await h.tap(OWNER,`rs:zt:${CHAT}:1`);
  assert.deepEqual(groupSettings(h.store as any,BOT,CHAT)!.zones,["Сроки задач"]);
  assert.match(visibleText(h.last("editMessageText")),/✅ Сроки задач/);
  await h.tap(OWNER,`rs:n:${CHAT}`);
  assert.equal(await h.say(OWNER,"здесь кладовщики, отвечай проще"),true);
  assert.equal(groupSettings(h.store as any,BOT,CHAT)!.note,"здесь кладовщики, отвечай проще");
  assert.match(h.last("sendMessage").text,/Заметка: здесь кладовщики/);
  assert.equal(await h.say(OWNER,"обычное поручение"),false,"after the note, ordinary messages go to the assistant again");
  for (const x of h.sent.filter(x=>x.method==="sendMessage"||x.method==="editMessageText"))
    assert.doesNotMatch(String(x.text),/-?100\d{6,}|версия/);
});

test("a Codex employee may open its group to all members like any employee",async()=>{
  const h=harness("codex");
  await h.tap(OWNER,`rs:g:${CHAT}`);
  assert.doesNotMatch(h.last("editMessageText").text,new RegExp(CODEX_LOCK.slice(0,30)));
  assert.match(visibleText(h.last("editMessageText")),/Обращаются: все участники/);
  await h.tap(OWNER,`rs:w:${CHAT}`);
  assert.equal(groupSettings(h.store as any,BOT,CHAT)!.who,"access");
});

test("only people with access who administer the group can open its settings",async()=>{
  const h=harness("claude-code",[OWNER]);
  await h.tap(STRANGER,`rs:g:${CHAT}`);
  assert.match(h.last("answerCallbackQuery").text,/тем, кто может мне поручать/);
  assert.equal(await h.say(STRANGER,"Мои группы"),false);
  setAccess(h.store as any,BOT,[{id:LENA,name:"Лена"}]);
  await h.tap(LENA,`rs:g:${CHAT}`);
  assert.match(h.last("answerCallbackQuery").text,/администраторы/);
  const admin=harness("claude-code",[OWNER,LENA]);
  setAccess(admin.store as any,BOT,[{id:LENA,name:"Лена"}]);
  await admin.tap(LENA,`rs:g:${CHAT}`);
  assert.match(admin.last("editMessageText").text,/Группа «Склад»/);
});

test("the owner adds people with the Telegram contact picker and removes them by name",async()=>{
  const h=harness();
  assert.equal(await h.say(OWNER,"Кто может мне поручать"),true);
  assert.match(h.last("sendMessage").text,/Поручать мне могут:\n• вы/);
  await h.tap(OWNER,"rs:aa");
  const picker=h.last("sendMessage").reply_markup.keyboard[0][0];
  assert.equal(picker.request_users.user_is_bot,false);
  await h.say(OWNER,"",{users_shared:{request_id:1,users:[{user_id:LENA,first_name:"Лена",last_name:"Петрова"}]}});
  assert.deepEqual(accessList(h.store as any,BOT),[{id:LENA,name:"Лена Петрова"}]);
  assert.match(h.last("sendMessage").text,/• Лена Петрова/);
  await h.tap(OWNER,`rs:ar:${LENA}`);
  assert.deepEqual(accessList(h.store as any,BOT),[]);
  setAccess(h.store as any,BOT,[{id:LENA,name:"Лена"}]);
  await h.tap(LENA,"rs:aa");
  assert.match(h.last("answerCallbackQuery").text,/ведёт владелец/);
});

test("the owner is told once, in plain words, what happens if nothing is changed",async()=>{
  const h=harness();
  h.store.put(`privacy:x`,true);
  h.store.put(`visibility:${BOT}:privacy`,true);
  h.store.put(`visibility:${BOT}:group:${CHAT}`,{chat:CHAT,title:"Склад",administrator:false,inviter:STRANGER,event:5});
  await notifyGroupsAdded(h.ctx as any);
  await notifyGroupsAdded(h.ctx as any);
  const notes=h.sent.filter(x=>x.method==="sendMessage");
  assert.equal(notes.length,1);
  assert.equal(notes[0].chat_id,OWNER,"the inviter cannot give tasks, so the owner is told");
  assert.match(notes[0].text,/^Меня добавили в «Склад»\. Если ничего не менять: отвечаю всем участникам, когда меня отметят или ответят мне; память только этой группы\./);
  assert.match(notes[0].text,/сделайте меня администратором группы/);
  assert.deepEqual(notes[0].reply_markup.inline_keyboard[0].map((b:any)=>b.text),["Настроить: 3 шага","Оставить как есть"]);
});

test("the welcome tells the owner what to do next",()=>{
  const screen=welcomeScreen({role:"Я — помощник проекта.",botUsername:"acme_bot"});
  assert.match(screen.text,/Сейчас поручения мне можете давать только вы/);
  assert.equal(screen.reply_markup.inline_keyboard[0][0].url,"https://t.me/acme_bot?startgroup=setup");
});

test("a personal assistant keeps «only who may give tasks» and says why",async()=>{
  const h=harness();
  h.store.put("rights:install-kind","assistant");
  h.store.put(`rights:${BOT}:group:${CHAT}`,{version:1,who:"all",reply:"auto",members:"read",zones:[],note:""});
  await h.say(OWNER,"Мои группы");
  assert.match(visibleText(h.last("sendMessage")),/Склад — отвечаю только своим/);
  await h.tap(OWNER,`rs:g:${CHAT}`);
  assert.match(h.last("editMessageText").text,/личный помощник/);
  await h.tap(OWNER,`rs:w:${CHAT}`);
  assert.equal(groupSettings(h.store as any,BOT,CHAT)!.version,1,"nothing is saved");
  assert.equal(h.last("answerCallbackQuery").show_alert,true);
});

test("three steps with examples, then one line and «Изменить»",async()=>{
  const h=harness();
  await h.tap(OWNER,`rs:s1:${CHAT}`);
  let screen=h.last("editMessageText");
  assert.match(screen.text,/^Шаг 1 из 3\. Кто может обращаться ко мне в «Склад»\?/);
  assert.match(screen.text,/например, любой попросит сводку/);
  await h.tap(OWNER,`rs:a1:${CHAT}:all`);
  screen=h.last("editMessageText");
  assert.match(screen.text,/^Шаг 2 из 3/);
  assert.match(screen.text,/«@acme_bot, какой срок у задачи\?»/);
  await h.tap(OWNER,`rs:a2:${CHAT}:mention`);
  screen=h.last("editMessageText");
  assert.match(screen.text,/^Шаг 3 из 3\. Память в «Склад»/);
  await h.tap(OWNER,`rs:a3:${CHAT}:shared`);
  screen=h.last("editMessageText");
  assert.equal(screen.text,"Готово. «Склад»: отвечаю всем участникам, когда меня отметят или ответят мне; память общая с другими разговорами.");
  assert.deepEqual(screen.reply_markup.inline_keyboard[0].map((b:any)=>b.text),["Изменить"]);
  const s=groupSettings(h.store as any,BOT,CHAT)!;
  assert.deepEqual([s.who,s.reply,s.memory],["all","mention","shared"]);
});

test("a personal assistant offers only «you» in step 1 and says why",async()=>{
  const h=harness();
  h.store.put("rights:install-kind","assistant");
  await h.tap(OWNER,`rs:s1:${CHAT}`);
  const screen=h.last("editMessageText");
  assert.deepEqual(screen.reply_markup.inline_keyboard[0].map((b:any)=>b.text),["Только вы"]);
  assert.match(screen.text,/Личный помощник работает с вашими файлами/);
});
