import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate} from "../ingress";
import {bindGroupTopic,processGroupInputs} from "../group-worker";

test("worker delivers only its completed turn into the bound forum topic",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 const events:any[]=[];
 const sdk={threads:{events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   function event(type:string,data:any,turnId:string){events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId}});}
   for(const [id,text,input] of [["other","private",[]],["group","answer",q.input]] as const){
     event("client/turn/requested",{requestId:id,originPluginId:id==="group"?"telegram-projects":undefined,input},id);
     event("turn/input/accepted",{clientRequestId:id},id);
     event("item/completed",{item:{type:"agentMessage",text}},id);
     event("turn/completed",{status:"completed"},id);
   }
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{sent.push([id,p]);return {} as T},new AbortController().signal);
 await tick();
 assert.equal(rows.has("group:in:5:8"),false);
 assert.equal(rows.get("group:receipt:5:8").state,"done");
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 assert.equal(rows.has("group:in:5:8"),false);
 await tick();
 assert.deepEqual(sent,[[-1001,{chat_id:-1001,message_thread_id:3,reply_parameters:{message_id:10},text:"answer"}]]);
});

test("a private project and another topic cannot claim the same group thread",()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 const policy={chatId:-1001,topicId:3,threadId:"group-thread",botId:5,botUsername:"bot",ownerOnly:true,requireMention:true,ownerId:7,revision:"one"};
 store.put("chat:binding:0",{threadId:"private",projectId:"private-project"});
 assert.throws(()=>bindGroupTopic(store,policy,"private-project"),/private_thread_or_project/);
 assert.throws(()=>bindGroupTopic(store,{...policy,threadId:"private"},"group-project"),/private_thread_or_project/);
 store.put("chat:thread-project:previously-used","formerly-private");
 assert.throws(()=>bindGroupTopic(store,policy,"formerly-private"),/private_thread_or_project/);
 store.put("private:project:previous-picker-choice",true);
 assert.throws(()=>bindGroupTopic(store,policy,"previous-picker-choice"),/private_thread_or_project/);
 bindGroupTopic(store,policy,"group-project");
 assert.equal(store.get("group:project:group-project"),true);
 bindGroupTopic(store,{...policy,revision:"unused"},"group-project");
 assert.equal(rows.get("group:policy:-1001:3").revision,"one");
 const cutoff=rows.get("group:policy:-1001:3").acceptAfterSecond;
 const message={message_id:11,chat:{type:"supergroup",id:-1001},from:{id:7},reply_to_message:{from:{id:5}},message_thread_id:3,text:"Q"};
 for(const date of [undefined,cutoff-1,cutoff]) assert.equal(acceptGroupUpdate(store,{update_id:9,message:{...message,date}},7,5),false);
 assert.equal(acceptGroupUpdate(store,{update_id:9,message:{...message,date:cutoff+1}},7,5),true);
 store.del("group:policy:-1001:3");
 assert.throws(()=>bindGroupTopic(store,{...policy,chatId:-1002},"group-project"),/thread_belongs_to_other_topic/);
 bindGroupTopic(store,{...policy,revision:"two"},"group-project");
 assert.equal(rows.get("group:policy:-1001:3").revision,"two");
});

test("pending group updates cross decimal boundaries in Telegram order",async()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(key:string)=>rows.get(key) as T,put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},atomic:(fn:()=>void)=>fn(),
    list:<T>(prefix:string)=>[...rows.keys()].sort().filter(k=>k.startsWith(prefix)).map(key=>({key,value:rows.get(key) as T}))};
  store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",ownerOnly:true,requireMention:false});
  for (const id of [99,100]) assert.ok(acceptGroupUpdate(store,{update_id:id,message:{message_id:id,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:String(id)}},7,5));
  const sent:string[]=[];
  const sdk={threads:{events:{list:async()=>[]},send:async(q:any)=>{sent.push(q.input[0].text);}}};
  await processGroupInputs(store,sdk as any,7,5,()=>async()=>{throw Error("unexpected delivery");},new AbortController().signal);
  assert.deepEqual(sent,["99","100"]);
});
