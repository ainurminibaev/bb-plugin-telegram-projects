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

test("topic context is passive, scoped, editable and usable only by selected callers",async()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  const policy={chatId:-1001,topicId:3,threadId:"group",botId:5,botUsername:"bot",ownerOnly:true,
    allowedSenderIds:[8],requireMention:true,includeTopicContext:true,revision:"one",ownerId:7};
  bindGroupTopic(store,policy,"group-project");
  let updateId=0;
  function post(id:number,sender:number,text:string,topic=3,edit=false) {
    return acceptGroupUpdate(store,{update_id:++updateId,[edit?"edited_message":"message"]:{message_id:id,
      date:Math.floor(Date.now()/1000)+2,from:{id:sender},chat:{id:-1001,type:"supergroup"},message_thread_id:topic,
      text,entities:text.startsWith("@bot")?[{type:"mention",offset:0,length:4}]:[]}},7,5);
  }
  assert.equal(post(1,9,"другая тема",4),false);
  post(2,9,"встреча в три");post(2,9,"встреча в четыре",3,true);post(3,9,"@bot вопрос");
  assert.equal(store.list("group:in:").length,0);
  post(4,8,"@bot когда встреча?");
  const sent:any[]=[];
  const sdk={threads:{events:{list:async()=>[]},send:async(q:any)=>{sent.push(q);}}};
  await processGroupInputs(store,sdk as any,7,5,()=>async()=>{throw Error("unexpected delivery");},new AbortController().signal);
  assert.equal(sent.length,1);
  assert.equal(sent[0].threadId,"group");
  assert.match(sent[0].input[0].text,/встреча в четыре/);
  assert.doesNotMatch(sent[0].input[0].text,/другая тема|встреча в три/);
  for(let i=5;i<40;i++)post(i,9,String(i));
  assert.equal(rows.get("group:context:-1001:3").length,24);
  bindGroupTopic(store,{...policy,includeTopicContext:false,revision:"two"},"group-project");
  assert.equal(rows.has("group:context:-1001:3"),false);
  assert.equal(post(45,9,"дальше без контекста"),false);
});

test("only an authorized voice reply is transcribed and queued with the chosen Telegram message",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
  del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
  list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
 const chat={id:-111,type:"supergroup"};
 store.put("group:policy:-111:3",{chatId:-111,topicId:3,threadId:"group",botId:5,botUsername:"bot",
  ownerOnly:true,allowedSenderIds:[8],requireMention:true,includeTopicContext:true,ownerId:7});
 const reply={message_id:12,message_thread_id:3,from:{id:5},chat,document:{file_name:"first.pdf"}};
 function voice(id:number,user:number,target?:typeof reply) {
  return acceptGroupUpdate(store,{update_id:id,message:{chat,date:20,message_id:id,message_thread_id:3,
   from:{id:user},reply_to_message:target,voice:{file_id:"audio",duration:3,file_size:30}}},7,5);
 }
 assert.equal(voice(20,9,reply),false);
 assert.equal(voice(21,8),false);
 assert.ok(voice(22,8,reply));
 let calls=0;const sent:any[]=[];
 const sdk={threads:{events:{list:async()=>[]},send:async(q:any)=>{sent.push(q);}}};
 for(let i=0;i<2;i++)await processGroupInputs(store,sdk as any,7,5,()=>async()=>{throw Error("unexpected delivery");},
  new AbortController().signal,async v=>{assert.equal(v.fileId,"audio");calls++;return "убери третий пункт";});
 assert.equal(calls,1);assert.equal(sent.length,1);assert.equal(sent[0].threadId,"group");
 assert.match(sent[0].input[0].text,/first.pdf/);assert.match(sent[0].input[0].text,/"messageId":12/);
 assert.match(sent[0].input[0].text,/убери третий пункт/);
});
