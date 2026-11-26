import test from "node:test";
import assert from "node:assert/strict";
import type {Store} from "../model";
import {WaitingMarks,createWaitingNotifier} from "../waiting-mark";

const chat=-1007654321,topic=17,bot=6301,owner=7802;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(answer:(s:string)=>Promise<string|undefined>=async()=>"yes") {
  const data=new Map<string,unknown>();
  const store:Store={get:k=>data.get(k) as never,put:(k,v)=>{data.set(k,v);},del:k=>{data.delete(k);},
    list:p=>[...data].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:value as never})),atomic:f=>f()};
  const config={waitingMarkEnabled:true,waitingMarkChatId:"",waitingMarkExcludedTopics:"",waitingNotifyCommand:"",companionDir:"",decideCommand:""};
  for (const t of [0,topic]) store.put(`group:policy:${chat}:${t}`,{botId:bot,ownerId:owner,chatId:chat,topicId:t,
    threadId:"fiction",ownerSharedProject:true,ownerOnly:true});
  const calls:string[]=[];
  const make=()=>new WaitingMarks(store,()=>config,()=>({bot,owner}),async s=>{calls.push(s);return answer(s);});
  const marks=make();
  return {marks,make,store,calls,config,status:()=>marks.snapshot().topics[0]?.waiting};
}

test("disabled, General and unrelated chats do not write state or request decisions",async()=>{
  const {marks,store,calls,config}=setup();
  for (const [c,t] of [[chat,0],[-1007000002,topic]]) {marks.mark(c,t,"ask");marks.delivered(c,t,10,"решить?");}
  config.waitingMarkEnabled=false;
  marks.mark(chat,topic,"ask");marks.clear(chat,topic);marks.delivered(chat,topic,12,"решить?");
  assert.deepEqual(store.list("waiting:"),[]);assert.deepEqual(calls,[]);
});
test("questions with buttons and pending interactions require no decision; reading leaves the mark",()=>{
  const {marks,status,calls}=setup();
  marks.mark(chat,topic,"ask",41);
  assert.equal(status(),true);assert.equal(status(),true);
  marks.clear(chat,topic);assert.equal(status(),false);
  marks.interactions(chat,topic,["fiction-approval"],marks.seq(chat,topic));
  assert.equal(status(),true);
  marks.clear(chat,topic);
  marks.interactions(chat,topic,["fiction-approval"],marks.seq(chat,topic));
  assert.equal(status(),false);assert.deepEqual(calls,[]);
});
test("decision receives recent context and final text after confirmed delivery",async()=>{
  const {marks,status,calls,store}=setup();
  store.put(`group:context:${chat}:${topic}`,[{text:"Есть два срока."}]);
  marks.delivered(chat,topic,undefined,"черновик");
  marks.delivered(chat,topic,42,"Какой **срок** выбрать?");
  assert.equal(status(),false);await tick();assert.equal(status(),true);
  assert.deepEqual(calls,["Есть два срока.\nКакой срок выбрать?"]);
  assert.doesNotMatch(JSON.stringify(store.list("waiting:")),/срок/);
});
test("a later owner action wins over the decision; a new instance has no pending mark",async()=>{
  let resolve!:(s:string)=>void;
  const {marks,make,status}=setup(()=>new Promise(r=>resolve=r));
  marks.delivered(chat,topic,43,"выбрать?");
  assert.equal(make().snapshot().topics[0].waiting,false);
  await tick();marks.clear(chat,topic);resolve("yes");await tick();assert.equal(status(),false);
});
test("send followed by NO_REPLY checks only the last confirmed send from the completed turn",async()=>{
  const {marks,calls,status}=setup();
  marks.delivered(chat,topic,51,"Работаю","thread","turn");
  marks.delivered(chat,topic,52,"Подтвердить?","thread","turn");
  marks.completed("thread","old",true);assert.deepEqual(calls,[]);
  marks.completed("thread","turn",true);await tick();assert.equal(status(),true);
  assert.deepEqual(calls,["Подтвердить?"]);
  marks.clear(chat,topic);
  marks.delivered(chat,topic,53,"Ещё вопрос?","thread","next");marks.clear(chat,topic);
  marks.completed("thread","next",true);await tick();assert.equal(status(),false);
});
test("a report, decision failure and NO_REPLY leave the topic clear",async()=>{
  for (const result of ["no",undefined,"garbage","throw"]) {
    const {marks,status,calls}=setup(async()=>{if (result==="throw") throw Error();return result;});
    marks.delivered(chat,topic,41,"NO_REPLY");marks.delivered(chat,topic,42,"Готово.");
    await tick();assert.equal(status(),false);assert.deepEqual(calls,["Готово."]);
  }
});
test("exclusion clears waiting; configured names and IDs still apply after include",()=>{
  const {marks,status,calls,config,store}=setup();
  marks.mark(chat,topic,"ask");marks.exclude(chat,topic,true);assert.equal(status(),false);
  marks.delivered(chat,topic,41,"Решить?");assert.deepEqual(calls,[]);
  marks.exclude(chat,topic,false);
  store.put(`group:topic-name:${bot}:${chat}:${topic}`,{name:"Макет"});
  for (const value of ["Макет",String(topic)]) {config.waitingMarkExcludedTopics=value;marks.mark(chat,topic,"ask");assert.equal(status(),false);}
});
const change={version:1 as const,botId:bot,chatId:chat,topicId:topic,name:"Макет",waiting:true,changedAt:1};
test("ten rapid changes coalesce and only the final state follows the first notification",async t=>{
  t.mock.timers.enable({apis:["Date","setTimeout"],now:10000});
  const sends:boolean[]=[];
  const notify=createWaitingNotifier(async c=>{sends.push(c.waiting);},()=>{},()=>{},()=>true);
  notify(change);t.mock.timers.tick(0);await tick();
  for (let i=0;i<10;i++) notify({...change,waiting:i%2===0});
  t.mock.timers.tick(2499);assert.deepEqual(sends,[true]);
  t.mock.timers.tick(1);await tick();assert.deepEqual(sends,[true,false]);
});
test("notification stops after ten failures and a new transition restarts attempts",async t=>{
  t.mock.timers.enable({apis:["Date","setTimeout"],now:10000});
  let attempts=0,logs=0;
  const notify=createWaitingNotifier(async()=>{attempts++;throw Error();},()=>{},()=>{logs++;},()=>true);
  notify(change);
  for (const delay of [0,5000,30000,120000,...Array(6).fill(600000)]) {
    const before=attempts;
    if (delay) {t.mock.timers.tick(delay-1);assert.equal(attempts,before);}
    t.mock.timers.tick(delay?1:0);await tick();assert.equal(attempts,before+1);
  }
  t.mock.timers.tick(900000);await tick();assert.equal(attempts,10);assert.equal(logs,1);
  notify({...change,waiting:false});t.mock.timers.tick(0);await tick();assert.equal(attempts,11);
});

import {acceptGroupUpdate,clearWaitingOnUpdate} from "../ingress";
import {deliverScheduledResults} from "../group-schedule";

test("ingress clears on owner text and button even when the message itself requires no agent turn",()=>{
  const {marks,status,store}=setup();
  store.waiting=marks;
  const message={chat:{id:chat,type:"supergroup"},message_thread_id:topic,is_topic_message:true,from:{id:owner},text:"да",message_id:15};
  marks.mark(chat,topic,"ask",14);
  clearWaitingOnUpdate(store,{callback_query:{from:{id:owner+1},message}},owner);
  assert.equal(status(),true);
  acceptGroupUpdate(store,{message},owner,bot);
  assert.equal(status(),false);
  marks.mark(chat,topic,"ask",19);
  clearWaitingOnUpdate(store,{callback_query:{from:{id:owner},message}},owner);
  assert.equal(status(),false);
});

test("scheduled delivery finishes while its decision is pending; commentary and NO_REPLY stay silent",async()=>{
  let resolve!:(s:string)=>void;
  const {store,marks,calls,status}=setup(()=>new Promise(r=>resolve=r));
  store.waiting=marks;
  store.del(`group:policy:${chat}:0`);
  const events:any[]=[];
  const sdk={threads:{events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq ?? 0))}}};
  const sent:string[]=[];
  const run=()=>deliverScheduledResults(store,sdk as never,()=>async(method,p:any)=>{
    assert.equal(method,"sendMessage");sent.push(p.text);return {...p,message_id:61,chat:{id:chat}} as never;
  },new AbortController().signal,()=>true);
  await run();
  function event(type:string,data:unknown) {events.push({seq:events.length+1,type,data,scope:{kind:"turn",turnId:"fiction-run"}});}
  event("client/turn/requested",{requestId:"fiction-request",originPluginId:"automations"});
  event("turn/input/accepted",{clientRequestId:"fiction-request"});
  event("item/completed",{item:{type:"agentMessage",text:"Смотрю."}});
  await run();assert.deepEqual(calls,[]);assert.deepEqual(sent,[]);
  event("item/completed",{item:{type:"agentMessage",text:"Отправить?"}});
  event("turn/completed",{status:"completed"});
  await run();assert.deepEqual(sent,["Отправить?"]);assert.equal(status(),false);
  assert.deepEqual(calls,["Отправить?"]);resolve("yes");await tick();assert.equal(status(),true);
});

test("an interaction observed during an owner reply cannot put the mark back on the next poll",()=>{
  const {marks,status}=setup();
  const seq=marks.seq(chat,topic);marks.clear(chat,topic);
  marks.interactions(chat,topic,["fiction-question"],seq);
  marks.interactions(chat,topic,["fiction-question"],marks.seq(chat,topic));
  assert.equal(status(),false);
});

test("snapshot and changes are restricted to local calls, owner DM and the owner's own forum",()=>{
  const {marks,status}=setup();
  for (const caller of [undefined,{kind:"person",subject:owner+1},{kind:"group",chat:chat-1,topic} ] as const) {
    assert.equal(marks.command(caller,["waiting","--json"]).exitCode,1);
    assert.equal(marks.command(caller,["waiting","exclude","--topic",String(topic)]).exitCode,1);
  }
  for (const caller of ["local",{kind:"owner"},{kind:"group",chat,topic}] as const) {
    marks.mark(chat,topic,"ask");
    assert.equal(JSON.parse(marks.command(caller,["waiting","--json"]).stdout!).topics[0].waiting,true);
    assert.equal(marks.command(caller,["waiting","clear","--topic",String(topic)]).exitCode,0);
    assert.equal(status(),false);
  }
});

import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";

test("external notifier gets no arguments and one JSON event on stdin; companion sees the same state",async t=>{
  const {store,marks,config}=setup();
  const dir=await mkdtemp(join(process.cwd(),".waiting-test-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,"notify with spaces.cjs");
  await writeFile(command,`#!${process.execPath}
const fs=require("node:fs");
fs.writeFileSync(__dirname+"/event.json",JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,"utf8")}));
`,{mode:0o700});
  config.waitingNotifyCommand=command;config.companionDir=dir;
  store.put(`group:topic-name:${bot}:${chat}:${topic}`,{name:"Макет $(пример)"});
  marks.mark(chat,topic,"ask",93);
  async function json(name:string) {
    for (let attempt=0;attempt<200;attempt++) {
      try {return JSON.parse(await readFile(join(dir,name),"utf8"));} catch {await new Promise(r=>setTimeout(r,25));}
    }
    assert.fail("missing "+name);
  }
  const event=await json("event.json"),snapshot=await json("telegram-waiting.json");
  assert.deepEqual(event.args,[]);assert.equal(event.input.trimEnd().split("\n").length,1);
  assert.deepEqual(JSON.parse(event.input),{version:1,botId:bot,chatId:chat,topicId:topic,name:"Макет $(пример)",
    waiting:true,reason:"ask",messageId:93,changedAt:snapshot.topics[0].updatedAt});
});

test("turn checks are discarded on shutdown and after a reboot only confirmed marks survive",async()=>{
  let resolve!:(s:string)=>void;
  const {store,marks,make}=setup(()=>new Promise(r=>resolve=r));
  marks.delivered(chat,topic,64,"Когда отправлять?");
  await tick();marks.reset();resolve("yes");await tick();
  assert.equal(make().snapshot().topics[0].waiting,false);
  assert.doesNotMatch(JSON.stringify(store.list("waiting:")),/отправлять/);
  marks.mark(chat,topic,"ask",65);
  assert.equal(make().snapshot().topics[0].waiting,true);
});
