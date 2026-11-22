import test from "node:test";
import assert from "node:assert/strict";
import {acceptPrivateEmployeeUpdate,privatePolicyKey} from "../employee-private";
import {acceptGroupUpdate} from "../ingress";
import {bindGroupTopic} from "../group-worker";
import {accessList,hasAccess} from "../rights";

const OWNER=7, BOT=5, ALICE=21, PROJECT="employee-project";
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}
function harness(){
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  const sent:any[]=[];
  const binds:number[]=[];
  const transport=(chat:number)=>(async(method:string,p:any)=>{sent.push({chat,method,...p});return {message_id:sent.length};}) as any;
  const d={store:store as any,owner:OWNER,bot:BOT,transport,current:()=>true,
    bindPerson:async(subject:number,name:string)=>{
      binds.push(subject);
      bindGroupTopic(store as any,{chatId:subject,topicId:0,threadId:"thr_"+subject,privateChat:true,ownerOnly:true,
        allowedSenderIds:[subject],requireMention:false,includeTopicContext:true,searchableHistory:true,retainFullHistory:true,
        botId:BOT,botUsername:"acme_bot",ownerId:OWNER,revision:"r-"+name},PROJECT);
      return true;
    }};
  let seq=0;
  const say=(from:number,text:string)=>{const u={update_id:++seq,message:{message_id:100+seq,date:2_000_000_000,
    chat:{id:from,type:"private"},from:{id:from,first_name:"Алиса"},text}};return {u,handled:acceptPrivateEmployeeUpdate(d,u)};};
  const tap=(from:number,data:string,messageId:number)=>acceptPrivateEmployeeUpdate(d,{update_id:++seq,
    callback_query:{id:"c"+seq,from:{id:from},data,message:{message_id:messageId,chat:{id:from,type:"private"}}}});
  return {store,sent,binds,say,tap};
}

test("a stranger gets one notice and the owner one card with buttons",async()=>{
  const h=harness();
  assert.equal(await h.say(ALICE,"привет").handled,true);
  assert.match(h.sent.find(x=>x.chat===ALICE).text,/Доступ к сотруднику ещё не выдан/);
  const card=h.sent.find(x=>x.chat===OWNER);
  assert.match(card.text,/Запрос личного доступа: Алиса/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b:any)=>b.text),["Разрешить","Отказать"]);
  assert.equal(await h.say(ALICE,"ещё раз").handled,true);
  assert.equal(h.sent.filter(x=>x.chat===OWNER).length,1,"no second card while the request waits");
  assert.equal(h.sent.at(-1).text,"Запрос уже у владельца. Как только он решит, я отвечу.");
  await h.say(ALICE,"и ещё").handled;
  assert.equal(h.sent.filter(x=>x.chat===ALICE).length,2,"told once while waiting");
  const key=h.store.list<any>("employee:private:access:")[0];
  h.store.put(key.key,{...key.value,at:Date.now()-2*3600_000});
  await h.say(ALICE,"прошёл час").handled;
  assert.equal(h.sent.filter(x=>x.chat===OWNER).length,2,"a fresh card after an hour without a decision");
  assert.equal(h.binds.length,0);
});

test("approval puts the person on the one access list; the chat goes to an ordinary employee thread",async()=>{
  const h=harness();
  await h.say(ALICE,"привет").handled;
  const card=h.sent.find(x=>x.chat===OWNER);
  const id=h.sent.indexOf(card)+1;
  const allow=card.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(await h.tap(ALICE,allow,id),true);
  assert.equal(hasAccess(h.store as any,BOT,OWNER,ALICE),false,"only the owner decides");
  assert.equal(await h.tap(OWNER,allow,id),true);
  assert.deepEqual(accessList(h.store as any,BOT).map(p=>p.id),[ALICE]);
  assert.equal(h.sent.at(-1).chat,ALICE);
  assert.equal(h.sent.at(-1).text,"Доступ разрешён.");
  const {u,handled}=h.say(ALICE,"собери статус по задачам");
  assert.equal(await handled,false,"the message continues to the group pipeline");
  assert.deepEqual(h.binds,[ALICE]);
  const policy=h.store.get<any>(privatePolicyKey(ALICE));
  assert.equal(policy.privateChat,true);
  assert.equal(h.store.get("group:project:"+PROJECT),undefined,"the owner's project keeps its bridge commands");
  assert.equal(acceptGroupUpdate(h.store as any,u,OWNER,BOT),true);
  const job=h.store.list<any>(`group:in:${BOT}:`)[0].value;
  assert.equal(job.route.chatId,ALICE);
  assert.equal(job.route.threadId,"thr_"+ALICE);
  assert.match(job.route.text,/собери статус/);
  assert.equal(await h.say(ALICE,"и сроки").handled,false);
  assert.deepEqual(h.binds,[ALICE],"a second message reuses the binding");
});

test("revoking access unbinds the chat; the thread and its history stay in BB",async()=>{
  const h=harness();
  await h.say(ALICE,"привет").handled;
  const card=h.sent.find(x=>x.chat===OWNER);
  const id=h.sent.indexOf(card)+1;
  await h.tap(OWNER,card.reply_markup.inline_keyboard[0][0].callback_data,id);
  await h.say(ALICE,"вопрос").handled;
  const revoke=h.sent.find(x=>x.method==="editMessageReplyMarkup").reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(await h.tap(OWNER,revoke,id),true);
  assert.equal(hasAccess(h.store as any,BOT,OWNER,ALICE),false);
  assert.equal(h.store.get(privatePolicyKey(ALICE)),undefined);
  const {u,handled}=h.say(ALICE,"а теперь?");
  assert.equal(await handled,true,"a new request card instead of a reply");
  assert.equal(acceptGroupUpdate(h.store as any,u,OWNER,BOT),false);
});

test("the owner's own chat is not touched",async()=>{
  const h=harness();
  assert.equal(await h.say(OWNER,"привет").handled,false);
  assert.equal(h.sent.length,0);
});

test("a private chat is never accepted as a group without a private binding",()=>{
  const h=harness();
  const u={update_id:1,message:{message_id:5,date:2_000_000_000,chat:{id:ALICE,type:"private"},from:{id:ALICE},text:"x"}};
  assert.equal(acceptGroupUpdate(h.store as any,u,OWNER,BOT),false);
  h.store.put(`group:policy:${ALICE}:0`,{chatId:ALICE,topicId:0,threadId:"t",botId:BOT,botUsername:"b",ownerOnly:false,requireMention:false});
  assert.equal(acceptGroupUpdate(h.store as any,u,OWNER,BOT),false,"a group binding cannot capture a private chat");
});
