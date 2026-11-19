import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {saveLocalTelegramFile} from "../telegram-files";
import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate} from "../ingress";
import {bindGroupTopic,groupCliRestricted,processGroupInputs} from "../group-worker";

test("worker delivers only its completed turn into the bound forum topic",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
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
 assert.ok(groupCliRestricted(store,"group-project","group-thread"));
 assert.ok(groupCliRestricted(store,"group-project","child-thread"));
 assert.ok(groupCliRestricted(store,undefined,"group-thread"));
 assert.equal(groupCliRestricted(store,"private-project","private"),false);
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
  store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",ownerOnly:true,requireMention:false});
  for (const id of [99,100]) assert.ok(acceptGroupUpdate(store,{update_id:id,message:{message_id:id,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:String(id)}},7,5));
  const sent:string[]=[];
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async(q:any)=>{sent.push(q.input[0].text);}}};
  await processGroupInputs(store,sdk as any,7,5,()=>async()=>{throw Error("unexpected delivery");},new AbortController().signal);
  assert.deepEqual(sent,["99","100"]);
});

test("topic context is passive, scoped, editable and usable only by selected callers",async()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  const policy={chatId:-1001,topicId:3,threadId:"group",botId:5,botUsername:"bot",ownerOnly:true,
    allowedSenderIds:[],requireMention:true,includeTopicContext:true,revision:"one",ownerId:8};
  bindGroupTopic(store,policy,"group-project");
  let updateId=0;
  function post(id:number,sender:number,text:string,topic=3,edit=false) {
    return acceptGroupUpdate(store,{update_id:++updateId,[edit?"edited_message":"message"]:{message_id:id,
      date:Math.floor(Date.now()/1000)+2,from:{id:sender},chat:{id:-1001,type:"supergroup"},message_thread_id:topic,
      text,entities:text.startsWith("@bot")?[{type:"mention",offset:0,length:4}]:[]}},8,5);
  }
  assert.equal(post(1,9,"другая тема",4),false);
  post(2,9,"встреча в три");post(2,9,"встреча в четыре",3,true);post(3,9,"@bot вопрос");
  assert.equal(store.list("group:in:").length,0);
  post(4,8,"@bot когда встреча?");
  const sent:any[]=[];
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async(q:any)=>{sent.push(q);}}};
  await processGroupInputs(store,sdk as any,8,5,()=>async()=>{throw Error("unexpected delivery");},new AbortController().signal);
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
 store.put("group:project:group-project",true);
 store.put("group:thread:group","group:policy:-111:3");
 store.put("group:policy:-111:3",{chatId:-111,topicId:3,threadId:"group",botId:5,botUsername:"bot",
  ownerOnly:true,allowedSenderIds:[],requireMention:true,includeTopicContext:true,ownerId:8});
 const reply={message_id:12,message_thread_id:3,from:{id:5},chat,document:{file_name:"first.pdf"}};
 function voice(id:number,user:number,target?:typeof reply) {
  return acceptGroupUpdate(store,{update_id:id,message:{chat,date:20,message_id:id,message_thread_id:3,
   from:{id:user},reply_to_message:target,voice:{file_id:"audio",duration:3,file_size:30}}},8,5);
 }
 assert.equal(voice(20,9,reply),false);
 assert.equal(voice(21,8),false);
 assert.ok(voice(22,8,reply));
 let calls=0;const sent:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async(q:any)=>{sent.push(q);}}};
 for(let i=0;i<2;i++)await processGroupInputs(store,sdk as any,8,5,()=>async()=>{throw Error("unexpected delivery");},
  new AbortController().signal,async v=>{assert.equal(v.fileId,"audio");calls++;return "убери третий пункт";});
 assert.equal(calls,1);assert.equal(sent.length,1);assert.equal(sent[0].threadId,"group");
 assert.match(sent[0].input[0].text,/first.pdf/);assert.match(sent[0].input[0].text,/"messageId":12/);
 assert.match(sent[0].input[0].text,/убери третий пункт/);
});

for (const transcript of ["Сейчас скину примеры","Возьми эти фото для обложки"]) test(`voice with arriving examples: ${transcript}`,async()=>{
 const rows=new Map<string,unknown>();
 const store={get:<T>(k:string)=>structuredClone(rows.get(k)) as T,put:(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},
  del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
  list:<T>(prefix:string)=>Array.from(rows).filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:structuredClone(v) as T}))};
 const chat={id:-111,type:"supergroup"};
 store.put("group:project:group-project",true);
 store.put("group:thread:group","group:policy:-111:3");
 store.put("group:policy:-111:3",{chatId:-111,topicId:3,threadId:"group",botId:5,botUsername:"bot",
  ownerOnly:true,allowedSenderIds:[],requireMention:true,includeTopicContext:true});
 function post(id:number,user:number,m:object,topic=3){
  return acceptGroupUpdate(store,{update_id:id,message:{chat,date:20,message_id:id,message_thread_id:topic,from:{id:user},...m}},8,5);
 }
 const calls:string[]=[];const sent:string[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async(q:any)=>{sent.push(q.input[0].text);}}};
 const tick=()=>processGroupInputs(store,sdk as any,8,5,()=>async()=>{throw Error("unexpected delivery");},
  new AbortController().signal,async()=>transcript,"host",async(f)=>{
   calls.push(f.fileId);return {path:"/inbox/"+f.name,name:f.name,bytes:12,sha256:"hash"};
  });
 post(10,8,{voice:{file_id:"voice"},reply_to_message:{message_id:9,chat,message_thread_id:3,from:{id:5}}});
 const photo=(id:string)=>({photo:[{file_id:id}],media_group_id:"sample"});
 post(11,8,photo("one")); post(12,7,photo("other sender"));post(13,8,photo("other topic"),4);
 await tick();assert.deepEqual(sent,[]);
 post(14,8,photo("two"));post(15,8,{text:"Всё, делай!"});await tick();await tick();
 assert.deepEqual(calls,["one","two"]);assert.equal(sent.length,1);
 assert.ok(sent[0].includes(transcript));assert.match(sent[0],/photo-14.jpg/);
});

for (const requireMention of [true,false]) test(`voice correction selects its sender’s earlier album (requireMention=${requireMention})`,async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>structuredClone(rows.get(k)) as T,put:(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},
  del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
  list:<T>(prefix:string)=>Array.from(rows).filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:structuredClone(v) as T}))};
 const chat={id:-111,type:"supergroup"};
 store.put("group:project:group-project",true);
 store.put("group:thread:group","group:policy:-111:3");
 store.put("group:policy:-111:3",{chatId:-111,topicId:3,threadId:"group",botId:5,botUsername:"bot",
  ownerOnly:true,allowedSenderIds:[],requireMention,includeTopicContext:true});
 function post(id:number,user:number,m:object){
  return acceptGroupUpdate(store,{update_id:id,message:{chat,date:20,message_id:id,message_thread_id:3,from:{id:user},...m}},8,5);
 }
 post(11,8,{photo:[{file_id:"p1"}],media_group_id:"a"});
 post(12,7,{photo:[{file_id:"private"}],media_group_id:"a"});
 post(13,8,{photo:[{file_id:"p2"}],media_group_id:"a"});
 post(14,8,{voice:{file_id:"voice"},reply_to_message:{message_id:7,chat,message_thread_id:3,from:{id:5},document:{file_name:"one.pdf"}}});
 const files:string[]=[],turns:string[]=[];
 const directory=await mkdtemp(join(tmpdir(),"group-example-"));
 try {
  const source=join(directory,"api");
  await mkdir(source);
  await writeFile(join(source,"p1"),"first example");
  await writeFile(join(source,"p2"),"second example");
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async(q:any)=>{
   const text=q.input[0].text;
   const saved=JSON.parse(text.split("\n").at(-1)) as {path:string}[];
   assert.deepEqual(await Promise.all(saved.map(f=>readFile(f.path,"utf8"))),["first example","second example"]);
   turns.push(text);
  }}};
  const signal=new AbortController().signal;
  await processGroupInputs(store,sdk as any,8,5,()=>async()=>{throw Error("unexpected delivery");},signal,
   async()=>"Используй эти примеры для обложки","host",async(f,r)=>{
    files.push(f.fileId);return saveLocalTelegramFile({sourcePath:join(source,f.fileId),localRoot:source,
     inboxRoot:join(directory,"inbox"),updateId:r.updateId,fileId:f.fileId,name:f.name,signal});
   });
  assert.deepEqual(files,["p1","p2"]);assert.equal(turns.length,1);assert.match(turns[0],/one.pdf/);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test("parallel requests accept explicit replies and skip closed collections",()=>{
 const rows=new Map<string,unknown>();
 const store={get:<T>(k:string)=>structuredClone(rows.get(k)) as T,put:(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},
  del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
  list:<T>(prefix:string)=>Array.from(rows).filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:structuredClone(v) as T}))};
 const chat={id:-111,type:"supergroup"};
 store.put("group:project:group-project",true);
 store.put("group:thread:group","group:policy:-111:3");
 store.put("group:policy:-111:3",{chatId:-111,topicId:3,threadId:"group",botId:5,botUsername:"bot",
  ownerOnly:true,requireMention:true,includeTopicContext:true});
 const post=(id:number,body:object)=>acceptGroupUpdate(store,{update_id:id,message:{chat,date:50,message_id:id,message_thread_id:3,from:{id:7},...body}},7,5);
 const request={text:"@bot сейчас скину примеры",entities:[{type:"mention",offset:0,length:4}]};
 post(20,request);post(21,request);
 const photo=(file_id:string)=>({photo:[{file_id}]});
 post(22,photo("ambiguous"));
 assert.equal(store.list("group:examples:").length,0);
 const reply={message_id:21,message_thread_id:3,chat,from:{id:7}};
 post(23,{...photo("second"),reply_to_message:reply});
 post(24,{text:"Всё, делай",reply_to_message:reply});
 post(25,photo("first"));post(25,photo("first"));
 const bag=(id:number)=>store.get<{files:{fileId:string}[]}>(`group:examples:5:${id}`).files.map(f=>f.fileId);
 assert.deepEqual(bag(20),["first"]);assert.deepEqual(bag(21),["second"]);
});

test("a queued Telegram request cannot follow its thread into another group project",async()=>{
  const rows = new Map<string,any>();
  const store = {
    get:<T>(key:string)=>rows.get(key) as T,
    put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},
    atomic:(fn:()=>void)=>fn(),
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:value as T})),
  };
  bindGroupTopic(store,{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",
    requireMention:false,ownerOnly:true,revision:"original"},"original-group");
  store.put("group:project:other-group",true);
  const update={update_id:42,message:{message_id:42,date:Math.floor(Date.now()/1000)+2,
    chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"prepare a PDF"}};
  assert.ok(acceptGroupUpdate(store,update,7,5));
  const sdk={threads:{get:async()=>({id:"t",projectId:"other-group",visibility:"visible"})}};
  await processGroupInputs(store,sdk as any,7,5,()=>{throw Error("unexpected delivery");},new AbortController().signal);
  assert.equal(rows.get("group:receipt:5:42").state,"revoked");
});

test("a prepared answer stays private when the group thread has moved before delivery",async()=>{
  const rows = new Map<string,any>();
  const store = {
    get:<T>(key:string)=>rows.get(key) as T,
    put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},
    atomic:(fn:()=>void)=>fn(),
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:value as T})),
  };
  bindGroupTopic(store,{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",
    requireMention:false,ownerOnly:true,revision:"original"},"group-project");
  const route={kind:"group",chatId:-1001,topicId:3,threadId:"t",senderId:7,updateId:43,messageId:9};
  store.put("group:in:5:43",{route,ownerId:7,revision:"original",state:"ready",answer:"fixture"});
  const sdk={threads:{get:async()=>({id:"t",projectId:"personal-project",visibility:"visible"})}};
  await processGroupInputs(store,sdk as any,7,5,()=>{throw Error("unexpected Telegram delivery");},new AbortController().signal);
  assert.equal(rows.get("group:receipt:5:43").state,"revoked");
});

test("removing an isolated executor does not dispatch queued group work to the personal BB",async()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  bindGroupTopic(store,{chatId:-345678,topicId:7,threadId:"isolated",botId:5,botUsername:"bot",
    ownerOnly:true,requireMention:false,revision:"r",isolated:true},"group-project");
  store.put("group:in:5:24",{route:{chatId:-345678,topicId:7,threadId:"isolated",messageId:24,updateId:24,senderId:7},
    ownerId:7,revision:"r",state:"pending"});
  await processGroupInputs(store,{} as any,7,5,()=>{throw Error("unexpected Telegram delivery")},new AbortController().signal);
  assert.equal(rows.get("group:receipt:5:24").state,"revoked");
});

test("work queued by a participant under an old local policy is revoked before any tool or model call", async()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);},atomic:(f:()=>void)=>f(),
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  for(const local of [{ownerOnly:false},{ownerOnly:true,allowedSenderIds:[8]}]){
    const chatId=-333,topicId=3,threadId="group";
    store.put("group:policy:-333:3",{...local,chatId,topicId,threadId,botId:5,revision:"old"});
    store.put("group:in:5:2",{route:{chatId,topicId,threadId,senderId:8,messageId:2,updateId:2,
      voice:{fileId:"fixture"}},ownerId:7,revision:"old",state:"pending"});
    await processGroupInputs(store,{} as any,7,5,()=>{throw Error("unexpected delivery");},new AbortController().signal,
      async()=>{throw Error("unexpected transcription");});
    assert.equal(rows.get("group:receipt:5:2").state,"revoked");
    assert.equal(rows.has("group:in:5:2"),false);
  }
});

test("an ordinary group turn that answers NO_REPLY stays silent",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"через 5 минут проверь, только если срок прошёл"}},7,5));
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   event("item/completed",{item:{type:"agentMessage",text:"NO_REPLY"}});
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{sent.push([id,p]);return {} as T},new AbortController().signal);
 await tick(); await tick();
 assert.equal(rows.get("group:receipt:5:8").state,"done");
 assert.equal(sent.filter(([,p])=>typeof p.text==="string").length,0);
});
