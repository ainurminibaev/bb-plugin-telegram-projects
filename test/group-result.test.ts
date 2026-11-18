import test from "node:test";
import assert from "node:assert/strict";
import {deliverGroupResults, queueGroupResult, type GroupOrigin} from "../group-result";
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
  assert.equal(before.queue().state,"queued");
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
  await tick();assert.equal(queue().state,"revoked");assert.equal(sent.length,0);
});
test("restart across an ambiguous Telegram write leaves an unknown outcome",async()=>{
  const before=fixture();
  before.queue();
  let atSend="";
  await before.tick(async()=>{atSend=before.snapshot();throw Error("connection lost");});
  assert.ok(atSend);
  const after=fixture(atSend);
  await after.tick();assert.equal(after.queue().state,"unknown");assert.equal(after.sent.length,0);
});
