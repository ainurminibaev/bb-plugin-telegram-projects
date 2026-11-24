import test from "node:test";
import assert from "node:assert/strict";
import type {Store} from "../model";
import {groupModelCommand,parseModelCommand} from "../group-model";

const owner=7,bot=5,chat=-1003;
function setup(status="idle") {
  const rows=new Map<string,unknown>();
  const store:Store={get:k=>structuredClone(rows.get(k)) as never,put:(k,v)=>{rows.set(k,structuredClone(v));},del:k=>{rows.delete(k);},
    atomic:fn=>fn(),list:p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value) as never}))};
  const policy=(topicId:number,threadId:string)=>({chatId:chat,topicId,threadId,botId:bot,botUsername:"emp_bot",ownerId:owner,
    ownerOnly:false,requireMention:true,revision:"r"+topicId});
  store.put(`group:policy:${chat}:4`,policy(4,"t4"));
  store.put(`group:policy:${chat}:9`,policy(9,"t9"));
  store.put(`group:project:proj`,true);
  const threads:Record<string,any>={t4:{id:"t4",projectId:"proj",environmentId:"env",providerId:"codex",model:"gpt-6.2-astra",status},
    t9:{id:"t9",projectId:"proj",environmentId:"env",providerId:"codex",model:"gpt-6.2-astra",status:"idle"}};
  const sent:string[]=[], updated:any[]=[], spawned:any[]=[];
  const sdk={threads:{get:async({threadId}:any)=>threads[threadId],update:async(a:any)=>{updated.push(a);threads[a.threadId].model=a.model;},
      spawn:async(a:any)=>{spawned.push(a);return {id:"new-thread",projectId:a.projectId};},
      events:{list:async()=>[{type:"item/completed",data:{item:{type:"agentMessage",text:"Обещал прислать смету к пятнице."}}},
        {type:"item/completed",data:{item:{type:"agentMessage",text:"NO_REPLY"}}}]}},
    providers:{list:async()=>[{id:"codex",displayName:"Codex"},{id:"claude-code",displayName:"Claude Code"}],
      models:async({providerId}:any)=>({models:providerId==="codex" ? [{model:"gpt-6.2-astra"},{model:"gpt-6.2-sol"}] : [{model:"claude-opus-5-5"}]})}};
  const msg=(text:string,extra:object={})=>({update_id:1,message:{message_id:1,chat:{id:chat,type:"supergroup",is_forum:true},
    is_topic_message:true,message_thread_id:4,from:{id:owner},text,...extra}});
  const run=(u:any)=>groupModelCommand({store,sdk:sdk as never,owner,bot,update:u,send:()=>async t=>{sent.push(t);}});
  return {store,sent,updated,spawned,threads,msg,run};
}

test("С71: /model is parsed only for this bot", () => {
  assert.deepEqual(parseModelCommand("/model","emp_bot"),[]);
  assert.deepEqual(parseModelCommand("/model@emp_bot gpt-6.2-sol","emp_bot"),["gpt-6.2-sol"]);
  assert.equal(parseModelCommand("/model@other_bot x","emp_bot"),undefined);
  assert.equal(parseModelCommand("модель","emp_bot"),undefined);
});

test("С71: the owner sees the current model and the choices; changes the model of this topic only", async () => {
  const {sent,updated,threads,msg,run}=setup();
  assert.equal(await run(msg("/model")),true);
  assert.match(sent[0],/Сейчас: Codex · gpt-6\.2-astra/);
  assert.match(sent[0],/gpt-6\.2-sol/);
  assert.match(sent[0],/claude-code/);
  assert.equal(await run(msg("/model gpt-6.2-sol")),true);
  assert.deepEqual(updated,[{threadId:"t4",model:"gpt-6.2-sol"}]);
  assert.equal(threads.t9.model,"gpt-6.2-astra");                       // another topic keeps its own
  assert.match(sent.at(-1)!,/со следующего сообщения/);
  assert.equal(await run(msg("/model nope")),true);
  assert.match(sent.at(-1)!,/Нет такой модели/);
});

test("С71: another provider moves this topic to a new thread of it; other topics and non-owners are untouched", async () => {
  const {store,sent,spawned,msg,run}=setup();
  assert.equal(await run(msg("/model claude-code claude-opus-5-5")),true);
  assert.equal(spawned[0].providerId,"claude-code");
  assert.equal(spawned[0].model,"claude-opus-5-5");
  assert.deepEqual(spawned[0].environment,{type:"reuse",environmentId:"env"});
  // The new executor reads the former conversation itself and continues its open tasks.
  assert.match(spawned[0].input[0].text,/former thread t4/);
  assert.match(spawned[0].input[0].text,/смету к пятнице/);
  assert.doesNotMatch(spawned[0].input[0].text,/1\. NO_REPLY/);
  assert.equal(store.get<any>(`group:policy:${chat}:4`).threadId,"new-thread");
  assert.equal(store.get<any>(`group:policy:${chat}:9`).threadId,"t9");
  assert.match(sent.at(-1)!,/новый разговор/);
  // Not the owner: swallowed, nothing changes, no answer.
  const before=sent.length;
  assert.equal(await run(msg("/model gpt-6.2-sol",{from:{id:42}})),true);
  assert.equal(sent.length,before);
  // Not a bound topic or not the command: the message goes on as usual.
  assert.equal(await run(msg("/model",{message_thread_id:77})),false);
  assert.equal(await run(msg("привет")),false);
});

test("С71: a running answer is not interrupted", async () => {
  const {sent,updated,msg,run}=setup("active");
  await run(msg("/model gpt-6.2-sol"));
  assert.deepEqual(updated,[]);
  assert.match(sent[0],/идёт ответ/);
});
