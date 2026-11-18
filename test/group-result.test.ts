import test from "node:test";
import assert from "node:assert/strict";
import {deliverGroupResults, queueGroupResult, queueGroupReminder, type GroupOrigin} from "../group-result";
import type {Store, Telegram} from "../model";

function fixture(snapshot?:string) {
  const rows=new Map<string,unknown>(snapshot ? JSON.parse(snapshot) : []);
  const store:Store={get:<T>(k:string)=>rows.get(k) as T,put:(k,v)=>{rows.set(k,v);},
    del:k=>{rows.delete(k);},atomic:f=>f(),list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  const origins: GroupOrigin[]=[-1001,-1002].map((chatId,i)=>({chatId,topicId:7,messageId:42,
    bot:1,owner:2,sender:2,revision:"bound",projectId:"team",threadId:"thread-"+i}));
  if (!snapshot) for (const [i,o] of origins.entries()) {
    const key="group:policy:"+o.chatId+":7";
    store.put("group:origin:"+i,o);
    store.put(key,{...o,ownerId:o.owner,botId:o.bot,ownerOnly:true});
    store.put("group:thread:"+o.threadId,key);
    store.put("group:project:team",true);
  }
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"team",visibility:"visible"})}};
  const sent:Record<string,unknown>[]=[];
  const tick=(transport:Telegram=async<T>(_method:string,payload:Record<string,unknown>)=>{sent.push(payload);return {message_id:90} as T;})=>
    deliverGroupResults(store,sdk as never,()=>true,()=>transport,new AbortController().signal);
  return {store,sent,tick,snapshot:()=>JSON.stringify([...rows]),queue:()=>queueGroupResult(store,2,1,"0","Approved")};
}
test("persisted group return goes only to the original message and replays its receipt",async()=>{
  const before=fixture();
  assert.throws(()=>queueGroupResult(before.store,9,1,"0","Approved"));
  assert.deepEqual(before.queue(),{state:"queued"});
  const {store,sent,tick,queue}=fixture(before.snapshot());
  await tick();
  assert.deepEqual(queue(),{state:"sent",messageId:90});
  await tick();
  assert.deepEqual(sent,[{chat_id:-1001,message_thread_id:7,reply_parameters:{message_id:42,allow_sending_without_reply:false},text:"Approved"}]);
  assert.throws(()=>queueGroupResult(store,2,1,"0","Changed"),/conflict/);
});
test("revocation after queuing suppresses delivery",async()=>{
  const {store,sent,tick,queue}=fixture();
  queue();store.del("group:policy:-1001:7");
  await tick();assert.deepEqual(queue(),{state:"revoked"});assert.equal(sent.length,0);
});
test("restart across an ambiguous Telegram write leaves an unknown outcome",async()=>{
  const before=fixture();
  before.queue();
  let atSend="";
  await before.tick(async()=>{atSend=before.snapshot();throw Error("connection lost");});
  assert.ok(atSend);
  const after=fixture(atSend);
  await after.tick();assert.deepEqual(after.queue(),{state:"unknown"});assert.equal(after.sent.length,0);
});

test("due reminders use the original group and survive restart without duplicate sends",async()=>{
  const f=fixture();
  const args={taskId:"0",text:"Still need the PDF?",dueAt:1,waitingFor:"pdf" as const,threadId:"dm",routeToken:"fixture"};
  assert.equal(queueGroupReminder(f.store,2,1,args).state,"queued");
  const restored=fixture(f.snapshot());
  await restored.tick();await restored.tick();
  assert.equal(restored.sent.length,1);
  assert.deepEqual(queueGroupReminder(restored.store,2,1,args),{state:"sent",messageId:90});
  assert.equal(restored.sent[0].chat_id,-1001);
  assert.equal(restored.sent[0].message_thread_id,7);
});

test("a PDF receipt or a decision cancels only the matching reminder",async()=>{
  for (const waitingFor of ["pdf","decision"] as const) {
    const f=fixture();
    const args={taskId:"0",text:"Reminder",dueAt:1,waitingFor,routeToken:"fixture",threadId:"dm"};
    queueGroupReminder(f.store,2,1,args);
    f.store.put(waitingFor==="pdf"?"group:completed-pdf:0":"group:result:0",waitingFor==="pdf"?91:{text:"Approved",state:"sent",messageId:92});
    await f.tick();
    assert.equal(queueGroupReminder(f.store,2,1,args).state,"cancelled");assert.equal(f.sent.length,0);
  }
});

test("a future reminder waits, and withdrawn access stops a due reminder",async()=>{
  const f=fixture(),args={taskId:"0",text:"Reminder",dueAt:Date.now()+60000,waitingFor:"pdf" as const,routeToken:"fixture",threadId:"dm"};
  queueGroupReminder(f.store,2,1,args);await f.tick();assert.equal(f.sent.length,0);
  const other={...args,taskId:"1",dueAt:1};
  queueGroupReminder(f.store,2,1,other);f.store.del("group:policy:-1002:7");await f.tick();
  assert.equal(queueGroupReminder(f.store,2,1,other).state,"revoked");assert.equal(f.sent.length,0);
});

test("an identical reminder can be retried but its condition, text and deadline cannot change", () => {
  const {store}=fixture();
  const args={taskId:"0",threadId:"dm",routeToken:"fixture",waitingFor:"pdf" as const,text:"PDF pending",dueAt:10};
  assert.throws(()=>queueGroupReminder(store,3,1,args),/group_task_unavailable/);
  assert.deepEqual(queueGroupReminder(store,2,1,args),{state:"queued"});
  assert.deepEqual(queueGroupReminder(store,2,1,args),{state:"queued"});
  for (const change of [{text:"Another message"},{dueAt:11},{waitingFor:"decision" as const}]) {
    assert.throws(()=>queueGroupReminder(store,2,1,{...args,...change}),/group_reminder_conflict/);
  }
  assert.equal(store.list("group:reminder-queue:").length,1);
});
