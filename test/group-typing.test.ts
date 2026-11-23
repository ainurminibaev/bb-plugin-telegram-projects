import test from "node:test";
import assert from "node:assert/strict";
import {groupTyping} from "../group-worker";
import type {Store} from "../model";

test("typing is scoped, deduplicated, renewed and stopped with the task",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const rows=new Map<string,any>();
  const store:Store={get:k=>rows.get(k),put:(k,v)=>rows.set(k,v),del:k=>{rows.delete(k);},
    list:p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),atomic:f=>f()};
  const policy={botId:5,ownerId:7,ownerOnly:true,revision:"a",threadId:"worker"};
  rows.set("group:policy:-10:3",policy);
  for(const [id,sender,topic] of [[1,7,3],[2,7,3],[3,8,3],[4,7,4]]) {
    rows.set("group:in:5:"+id,{route:{chatId:-10,topicId:topic,senderId:sender,threadId:"worker"},
      revision:"a",ownerId:7,state:"submitted",submittedAt:Date.now()});
  }
  const actions:unknown[]=[];
  const controller=new AbortController();
  const pulse=groupTyping(store,()=>7,()=>5,()=>async(method,body)=>{
    actions.push([method,body]);throw Error("temporary Telegram failure");
  },controller.signal);
  await pulse();await pulse();
  assert.deepEqual(actions,[["sendChatAction",{chat_id:-10,message_thread_id:3,action:"typing"}]]);
  t.mock.timers.tick(3600);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(actions.length,2);
  rows.delete("group:in:5:1");rows.delete("group:in:5:2");
  t.mock.timers.tick(3600);await pulse();assert.equal(actions.length,2);
  controller.abort();
});
