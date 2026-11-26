import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {saveLocalTelegramFile} from "../telegram-files";
import test from "node:test";
import {authorOfTurn,turnStartedByMessage,deleteRefusal} from "../delete-command";
import {sendRefusal} from "../send-command";
import {ReplyRoutes} from "../reply-routing";
import assert from "node:assert/strict";
import {acceptGroupUpdate} from "../ingress";
import {bindGroupTopic,groupCliRestricted,processGroupInputs,sameWords,sentInTurnKey,tellCannotAnswer} from "../group-worker";
import {startAddedIntroduction} from "../group-result";
import {TelegramFailure} from "../model";
import {curatorsKey} from "../topic-mode";

const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=","base64");
const image={type:"image" as const,url:"data:image/png;base64,"+pixel.toString("base64")};

test("worker delivers only its completed turn into the bound forum topic",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 const events:any[]=[{type:"client/turn/requested",data:{requestId:"B",initiator:"agent",senderThreadId:"thr_sender"},
   seq:1,scope:{kind:"thread"}}];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   function event(type:string,data:any,turnId:string){events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId}});}
   for(const [id,text,input] of [["other","private",[]],["group","answer [лист](/макет\n• По просьбе Миры уточнили сроки)",q.input]] as const){
     event("client/turn/requested",{requestId:id,originPluginId:id==="group"?"telegram-projects":undefined,input},id);
     event("turn/input/accepted",{clientRequestId:id},id);
     if (id==="group") {
       event("turn/input/accepted",{clientRequestId:"B"},id);
     }
     event("item/completed",{item:{type:"agentMessage",text}},id);
     event("turn/completed",{status:"completed"},id);
   }
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([id,p]);return {} as T},new AbortController().signal);
 await tick();
 assert.equal(rows.has("group:in:5:8"),false);
 assert.equal(rows.get("group:receipt:5:8").state,"done");
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 assert.equal(rows.has("group:in:5:8"),false);
 await tick();
 assert.deepEqual(sent,[[-1001,{chat_id:-1001,message_thread_id:3,reply_parameters:{message_id:10,allow_sending_without_reply:false},text:"answer [лист](/макет\n• По просьбе Миры уточнили сроки)",parse_mode:"HTML",link_preview_options:{is_disabled:true}}]]);
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
  ownerOnly:true,allowedSenderIds:[],requireMention:true,ownerWithoutMention:false,includeTopicContext:true,ownerId:8});
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
 assert.match(sent[0].input[0].text,/first.pdf/);assert.match(sent[0].input[0].text,/№ 12 \(чат/);
 assert.match(sent[0].input[0].text,/убери третий пункт/);
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

test("an ordinary group turn that answers NO_REPLY stays silent in text, but the message keeps a visible reaction (С45)",async()=>{
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
   event("item/completed",{item:{type:"agentMessage",text:"NO_REPLY\n<!-- bb-telegram-child-result:thr_worker:turn-1 -->"}});
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const reactions:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction"){reactions.push(p);return {} as T;}sent.push([id,p]);return {} as T},new AbortController().signal);
 await tick(); await tick();
 assert.equal(rows.get("group:receipt:5:8").state,"done");
 assert.equal(sent.filter(([,p])=>typeof p.text==="string").length,0);
 assert.deepEqual(reactions.map(r=>[r.message_id,r.reaction[0]?.emoji]),[[10,"👀"]]);   // not a silence without a sign
});

test("group delivery replies with verified PDF and image bytes plus clean text exactly once", async () => {
  const rows = new Map<string, unknown>();
  const store = {
    get:<T>(key:string)=>rows.get(key) as T|undefined,
    put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},
    atomic:(fn:()=>void)=>fn(),
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:value as T})),
  };
  bindGroupTopic(store,{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",
    requireMention:false,ownerOnly:true,revision:"original"},"group-project");
  const directory = await mkdtemp(join(tmpdir(),"group-marker-"));
  try {
    await mkdir(join(directory,"outputs"));
    const path = join(directory,"outputs","report.pdf");
    await writeFile(path,"%PDF-1.4\nfixture");
    const photo=join(directory,"outputs","fixture.png");
    await writeFile(photo,pixel);
    const route={kind:"group",chatId:-1001,topicId:3,threadId:"t",senderId:7,updateId:43,messageId:9};
    store.put("group:in:5:43",{route,ownerId:7,revision:"original",state:"ready",
      answer:`Отчёт готов.\n  <!-- bb-telegram-child-result:thr_worker:turn-1 -->\n[PDF](${path})\n[Фото](${photo})\nbb-telegram-child-result:thr_other:turn-2`});
    const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible",environmentId:"env"})},
      environments:{get:async()=>({hostId:"host",path:directory})}};
    const sent: {method:string;payload:Record<string,unknown>}[]=[];
    const tick=()=>processGroupInputs(store,sdk as never,7,5,()=>async <T>(method:string,payload:Record<string,unknown>)=>{if(method==="setMessageReaction")return {} as T;
      sent.push({method,payload});
      return {message_id:sent.length,document:{file_id:"fixture"},photo:[{file_id:"image"}]} as T;
    },new AbortController().signal,undefined,"host");
    await tick();await tick();
    assert.deepEqual(sent.map(row=>row.method),["sendDocument","sendPhoto","sendMessage"]);
    assert.equal(sent[0].payload.caption,"report.pdf");
    assert.deepEqual(Buffer.from(await (sent[1].payload.photo as Blob).arrayBuffer()),pixel);
    assert.equal(sent[2].payload.text,"Отчёт готов.");
    for (const row of sent) {
      assert.equal(row.payload.message_thread_id,3);
      assert.deepEqual(row.payload.reply_parameters,{message_id:9,allow_sending_without_reply:false});
    }
    assert.equal(store.get<{state:string}>("group:receipt:5:43")?.state,"done");
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("addressed group messages preserve text, photo and opaque HTML with optional captions and reply IDs",async()=>{
  const rows=new Map<string,unknown>();
  const store={
    get:<T>(key:string)=>rows.get(key) as T|undefined,
    put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},atomic:(fn:()=>void)=>fn(),
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:value as T})),
  };
  const chat={id:-1001,type:"supergroup"};
  bindGroupTopic(store,{chatId:chat.id,topicId:3,threadId:"t",botId:5,botUsername:"bot",
    requireMention:true,ownerOnly:true,revision:"original"},"group-project");
  const workspace=await mkdtemp(join(tmpdir(),"group-routed-doc-"));
  try {
    const inbox=join(workspace,"inbox");
    const outputs=join(workspace,"outputs");
    const origin=join(workspace,"telegram");
    await mkdir(origin);await mkdir(outputs);
    const data=Buffer.from("<p>SYNTHETIC_NOT_MODEL_CONTEXT</p>");
    const html=join(origin,"sample.html"),png=join(outputs,"picture.png");
    await writeFile(html,data);await writeFile(png,pixel);
    const {localArtifacts}=await import("../telegram-ux");
    const events:any[]=[];
    let source=14,answer="",currentInput:any[]=[];
    const sdk={threads:{
      get:async()=>({id:"t",projectId:"group-project",visibility:"visible",environmentId:"env"}),
      events:{list:async(q:any)=>q.order==="desc"?events.slice(-1):events.filter(e=>e.seq>Number(q.afterSeq??0))},
      send:async(q:any)=>{
        currentInput=q.input;
        const handle=currentInput.flatMap(input=>localArtifacts(input.text??"")).find(link=>link.path.startsWith("/telegram-input/"));
        const text=handle ? answer.replace("HANDLE",handle.markdown) : answer;
        const push=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"t"+source}});
        push("client/turn/requested",{requestId:"q"+source,originPluginId:"telegram-projects",input:q.input});
        push("turn/input/accepted",{clientRequestId:"q"+source});
        push("item/completed",{item:{type:"agentMessage",text}});
        push("turn/completed",{status:"completed"});
      }},
      environments:{get:async()=>({hostId:"host",path:workspace})}};
    const sent:{method:string;payload:any}[]=[];
    const tick=()=>processGroupInputs(store,sdk as never,7,5,id=>async <T>(method:string,payload:Record<string,unknown>)=>{if(method==="setMessageReaction")return {} as T;
      assert.equal(id,chat.id);
      sent.push({method,payload});
      return {message_id:200+sent.length,document:{file_id:"document"},photo:[{file_id:"photo"}]} as T;
    },new AbortController().signal,undefined,"host",async (example,route)=>{
      if (example.image) return image;
      return saveLocalTelegramFile({sourcePath:html,localRoot:origin,inboxRoot:inbox,updateId:route.updateId,fileId:example.fileId,
        name:example.name,expectedBytes:data.length,signal:new AbortController().signal});
    });
    for (const ext of ["html","png","text"]) for (const caption of ext==="text"?["Сообщение без файла"]:[undefined,"Учебная подпись"]) {
      source++;
      const attachment=ext==="html"?{document:{file_id:"h"+source,file_name:"нейтральный.html",mime_type:"text/html",file_size:data.length}}
        : ext==="png"?{photo:[{file_id:"p"+source,file_size:pixel.length}]}:{text:caption};
      const message={chat,date:Math.floor(Date.now()/1000)+5,message_thread_id:3,message_id:source,from:{id:7},...attachment,
        ...(caption && ext!=="text" && {caption}),reply_to_message:{chat,message_thread_id:3,message_id:10,from:{id:5}}};
      const before=sent.length;
      answer=[caption ?? (ext==="html" ? "Прочитал файл." : undefined),ext==="png"?"[Фото]("+png+")":undefined].filter(Boolean).join("\n");
      assert.ok(acceptGroupUpdate(store,{update_id:source,message},7,5));
      await tick(); await tick();
      const deliveries=sent.slice(before);
      assert.equal(deliveries.length,1);
      assert.equal(deliveries[0].method,ext==="png"?"sendPhoto":"sendMessage");
      assert.equal(deliveries[0].payload.message_thread_id,3);
      assert.deepEqual(deliveries[0].payload.reply_parameters,{message_id:source,allow_sending_without_reply:false});
      if (ext==="png") {
        assert.equal(deliveries[0].payload.caption,caption);
        assert.deepEqual(Buffer.from(await deliveries[0].payload.photo.arrayBuffer()),pixel);
      } else assert.match(deliveries[0].payload.text,new RegExp(caption ?? "Прочитал файл"));
      if (ext==="html") {
        // Any file reaches the agent the same way: as the saved file it reads with its own tools.
        assert.ok(currentInput.some(input=>input.type==="localFile" && input.name==="нейтральный.html"));
      }
      if (caption) assert.ok(currentInput.some(input=>input.text?.includes(caption)));
    }
    const n=sent.length;
    const unauthorized={chat,date:Math.floor(Date.now()/1000)+5,message_thread_id:3,message_id:++source,from:{id:9},
      document:{file_id:"wrong",file_name:"private.html",mime_type:"text/html"},
      reply_to_message:{chat,message_thread_id:3,message_id:10,from:{id:5}}};
    assert.equal(acceptGroupUpdate(store,{update_id:source,message:unauthorized},7,5),false);
    await tick();
    assert.equal(sent.length,n);
  } finally {await rm(workspace,{recursive:true,force:true});}
});

for (const kind of ["photo","document"] as const) test(`forum ${kind} album submits once and answers in its source topic`,async t=>{
  let now=Date.now();
  t.mock.method(Date,"now",()=>now);
  const rows=new Map<string,any>();
  const store={get:<T>(key:string)=>structuredClone(rows.get(key)) as T,
    put:(key:string,value:unknown)=>{rows.set(key,structuredClone(value));},del:(key:string)=>{rows.delete(key);},
    atomic:(run:()=>void)=>run(),list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix))
      .map(([key,value])=>({key,value:structuredClone(value) as T}))};
  const chat={id:-111,type:"supergroup"}, bot=5, owner=7, topic=3;
  bindGroupTopic(store,{chatId:chat.id,topicId:topic,threadId:"t",botId:bot,botUsername:"bot",
    ownerOnly:true,requireMention:true,ownerWithoutMention:false,includeTopicContext:true,revision:"album-forum"},"group-project");
  now+=2000;
  const root=await mkdtemp(join(tmpdir(),"forum-album-"));
  const output=join(root,"outputs");
  const downloads:{id:number;file:string}[]=[];
  const sends:{method:string;body:any}[]=[];
  const events:any[]=[];
  const dispatches:any[]=[];
  const native=new AbortController().signal;
  try {
    await mkdir(output);
    const names=[1,2,3].map(index=>"sample-"+index+(kind==="photo"?".png":".txt"));
    const bytes=names.map((_,index)=>kind==="photo"?pixel:Buffer.from("synthetic "+index));
    for (const [index,name] of names.entries()) await writeFile(join(output,name),bytes[index]);
    const response=names.map((name,index)=>`[${index===1?"":"Caption "+(index+1)}](${join(output,name)})`).join("\n")+"\nSeparate text.";
    const sdk={threads:{
      get:async()=>({id:"t",projectId:"group-project",visibility:"visible",environmentId:"env"}),
      events:{list:async(q:any)=>q.order==="desc"?events.slice(-1):events.filter(e=>e.seq>Number(q.afterSeq??0))},
      send:async(q:any)=>{
        dispatches.push(q);
        const append=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"album-turn"}});
        append("client/turn/requested",{requestId:"q",originPluginId:"telegram-projects",input:q.input});
        append("turn/input/accepted",{clientRequestId:"q"});
        append("item/completed",{item:{type:"agentMessage",text:response}});
        append("turn/completed",{status:"completed"});
      }},environments:{get:async()=>({hostId:"test-host",path:root})}};
    const tick=()=>processGroupInputs(store,sdk as never,owner,bot,id=>async <T>(method:string,body:Record<string,unknown>)=>{if(method==="setMessageReaction")return {} as T;
      assert.equal(id,chat.id);
      sends.push({method,body});
      if (method==="sendMediaGroup") return (body.media as any[]).map((item,index)=>({
        chat:{id},message_id:300+index,message_thread_id:topic,media_group_id:"synthetic-result",
        ...(index===0 && {reply_to_message:body.reply_parameters}),
        ...(item.type==="photo"?{photo:[{file_id:"export"}]}:{document:{file_id:"export"}}),
      })) as T;
      return {message_id:400+sends.length} as T;
    },native,undefined,"test-host",async file=>{
      downloads.push({id:file.messageId,file:file.fileId});
      if (file.image) return image;
      return saveLocalTelegramFile({sourcePath:join(output,names[0]),localRoot:output,inboxRoot:join(root,"in"),
        updateId:file.sourceUpdateId!,fileId:file.fileId,name:file.name,signal:native});
    });
    const message=(id:number,updateId:number)=>({update_id:updateId,message:{
      date:Math.floor(now/1000),message_id:id,chat,message_thread_id:topic,from:{id:owner},
      media_group_id:"test-album",
      ...(kind==="photo"?{photo:[{file_id:id===22?"other":"repeat",width:20,height:20}]}:
        {document:{file_id:id===22?"other":"repeat",file_name:"same.txt",mime_type:"text/plain"}}),
      ...(id===21 && {caption:"@bot Album prompt",caption_entities:[{type:"mention",offset:0,length:4}]}),
    }});
    for (const [id,update] of [[23,103],[21,101],[23,103]]) assert.ok(acceptGroupUpdate(store,message(id,update),owner,bot));
    await tick();assert.equal(dispatches.length,0);
    now+=2700;
    assert.ok(acceptGroupUpdate(store,message(22,102),owner,bot));
    assert.ok(acceptGroupUpdate(store,{update_id:111,message:{date:Math.floor(now/1000),message_id:30,
      chat,message_thread_id:topic,from:{id:owner},text:"Adjacent text"}},owner,bot));
    now+=3000;
    await tick();await tick();await tick();
    assert.equal(dispatches.length,1);
    assert.deepEqual(downloads,[{id:21,file:"repeat"},{id:22,file:"other"},{id:23,file:"repeat"}]);
    assert.doesNotMatch(dispatches[0].input[0].text,/Adjacent text/);
    assert.deepEqual(sends.map(event=>event.method),["sendMediaGroup","sendMessage"]);
    assert.equal(sends[0].body.message_thread_id,topic);
    assert.equal(sends[0].body.reply_parameters.message_id,21);
    assert.deepEqual(sends[0].body.media.map((item:any)=>[item.type,item.caption]),
      [[kind,"Caption 1"],[kind,undefined],[kind,"Caption 3"]]);
    for (const [index,data] of bytes.entries())
      assert.deepEqual(Buffer.from(await sends[0].body["media"+index].arrayBuffer()),data);
    assert.equal(sends[1].body.text,"Separate text.");
    assert.ok(acceptGroupUpdate(store,message(23,103),owner,bot));
    assert.ok(acceptGroupUpdate(store,message(24,112),owner,bot));
    await tick();await tick();
    assert.equal(dispatches.length,1);
    assert.equal(sends.length,3);
    assert.match(sends[2].body.text,/дополнительный элемент/);
    assert.equal(sends[2].body.reply_parameters.message_id,21);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("a group message that arrives while the thread works joins the running turn and gets its own answer",async()=>{
 for (const starter of ["person","thread"] as const) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 const events:any[]=[]; const sends:any[]=[];
 let status="idle", enclose=true;
 const event=(type:string,data:any,turnId:string)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId}});
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status}),
   events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0) && e.seq<Number(q.beforeSeq??Infinity) && (!q.types || q.types.includes(e.type))).sort((a,b)=>q.order==="desc" ? b.seq-a.seq : a.seq-b.seq).slice(0,Number(q.limit??100))},
   send:async(q:any)=>{sends.push(q);
     const id="r"+sends.length;
     event("client/turn/requested",{requestId:id,originPluginId:"telegram-projects",input:q.input},sends.length===1||q.mode!=="steer-if-active"?id:"r1");
     if (q.mode==="steer-if-active") {
       event("turn/input/accepted",{clientRequestId:id},"r1");
       const label=/\[telegram-answer:([a-f0-9-]+)\]/.exec(q.input.map((b:any)=>b.text??"").join("\n"))![1];
       if (enclose) event("item/completed",{item:{type:"agentMessage",text:`[telegram-answer:${label}]\nбыстрый ответ\n[/telegram-answer]`}},"r1");
       event("item/completed",{item:{type:"agentMessage",text:"долгий ответ"}},"r1");
       event("turn/completed",{status:"completed"},"r1");
     } else {
       event("turn/input/accepted",{clientRequestId:id},id);
       if (sends.length===1) return; // the first turn keeps working
       event("item/completed",{item:{type:"agentMessage",text:"ответ по очереди"}},id);
       event("turn/completed",{status:"completed"},id);
     }
   }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([p.reply_parameters?.message_id,p.text]);return {} as T},new AbortController().signal);
 if (starter==="person") {
   assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"долгая задача"}},7,5));
   await tick();
 }
 event("client/turn/requested",{requestId:"B",initiator:"agent",senderThreadId:"thr_sender"},"r1");
 event("turn/input/accepted",{clientRequestId:"B"},"r1");
 status="active";
 assert.ok(acceptGroupUpdate(store,{update_id:9,message:{message_id:11,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"а сколько времени?"}},7,5));
 await tick(); await tick(); await tick();
 assert.equal(sends.at(-1).mode,"steer-if-active");
 assert.deepEqual(sent.sort(),starter==="person" ? [[10,"долгий ответ"],[11,"быстрый ответ"]] : [[11,"быстрый ответ"]]);
 }
});

test("independent group inputs share a final only for the same author and topic",async()=>{
 for (const secondSender of [7,9]) {
   const rows=new Map<string,any>();
   const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
     list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
   store.put("group:project:project",true);
   store.put("group:thread:t","group:policy:-1001:3");
   store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",ownerOnly:false,requireMention:false});
   store.put("rights:5:access",[{id:9,name:"Анна"}]);
   const events:any[]=[], sent:any[]=[];
   const event=(type:string,data:any)=>events.push({seq:events.length+1,type,data,scope:{kind:"turn",turnId:"T"}});
   let submits=0;
   const sdk={threads:{get:async()=>({id:"t",projectId:"project",visibility:"visible",status:"idle"}),
     events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0) && e.seq<Number(q.beforeSeq??Infinity) &&
       (!q.types || q.types.includes(e.type))).sort((a,b)=>q.order==="desc" ? b.seq-a.seq : a.seq-b.seq).slice(0,Number(q.limit??100))},
     send:async(q:any)=>{
       assert.equal(q.mode,"queue-if-active");
       event("client/turn/requested",{requestId:String(++submits),originPluginId:"telegram-projects",input:q.input});
       if (submits===2) {
         for (const id of ["1","2"]) event("turn/input/accepted",{clientRequestId:id});
         event("item/completed",{item:{type:"agentMessage",text:"Общий итог"}});
         event("turn/completed",{status:"completed"});
       }
     }}};
   const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{
     if (m==="sendMessage") sent.push([p.reply_parameters.message_id,p.text]);
     return {message_id:123} as T;
   },new AbortController().signal);
   for (const [message,sender] of [[10,7],[11,secondSender]]) {
     assert.ok(acceptGroupUpdate(store,{update_id:message,message:{message_id:message,chat:{type:"supergroup",id:-1001},
       from:{id:sender},message_thread_id:3,text:"@bot вопрос",entities:[{type:"mention",offset:0,length:4}]}},7,5));
     await tick();
   }
   await tick();
   assert.deepEqual(sent,secondSender===7 ? [[11,"Общий итог"]] : []);
   if (secondSender===7) assert.equal(store.list("group:in:5:").length,0,"both requests are settled");
   assert.equal(submits,2);
 }
});

test("0.9.73 fix: a deferred task the bridge gives itself runs although the bot replied to its original message",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 // The follow-up as startAgentFollowUp puts it: a synthetic update, the original request's message number.
 store.put("group:in:5:-10",{ownerId:7,state:"pending",taskId:"task",route:{kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:-10,text:"Плановая проверка"}});
 let sends=0;
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async()=>{sends++;}}};
 // The bot already replied to message 10 («Поставил отправку…»).
 await processGroupInputs(store,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal,
   undefined,undefined,undefined,false,undefined,undefined,undefined,undefined,undefined,()=>[{message:11,replyTo:10}]);
 assert.equal(sends,1,"the deferred task is given to the agent");
 // The owner's answer to a group's question (queueAnswerTurn: updateId −Date.now()) under the same original message.
 store.put("group:in:5:-1795600000000",{ownerId:7,state:"pending",route:{kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:-1795600000000,text:"Ответ владельца: да"}});
 await processGroupInputs(store,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal,
   undefined,undefined,undefined,false,undefined,undefined,undefined,undefined,undefined,()=>[{message:11,replyTo:10}]);
 assert.equal(sends,2,"the owner's answer is given to the agent too");
});

test("С105: a message the bot already replied to is neither given again nor called lost; a later unrelated message does not count",async t=>{
 let now=Date.now();
 t.mock.method(Date,"now",()=>now);
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 let sends=0;
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async()=>{sends++;}}};
 const sent:any[]=[];
 // After №10 the bot wrote №12 — not a reply to it (another message's answer) — and then №13 as a reply to №10.
 const after:{message:number;replyTo?:number}[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m==="sendMessage")sent.push(p);return {message_id:1} as T},
   new AbortController().signal,undefined,undefined,undefined,false,undefined,undefined,undefined,undefined,undefined,undefined,
   ()=>after);
 await tick();
 assert.equal(sends,1);
 after.push({message:12});
 now+=16*60_000;
 await tick(); await tick();
 assert.equal(sends,2,"a later bot message that is not an answer does not count");
 after.push({message:13,replyTo:10});
 now+=16*60_000;
 await tick(); await tick();
 assert.equal(sends,2,"not given a third time");
 assert.equal(rows.has("group:in:5:8"),false);
 assert.ok(!sent.some(m=>/потерялось/.test(m.text ?? "")),"answered: no «lost» line");
});

test("a message the thread never took up is given once more, then closed with an honest line; typing stops",async t=>{
 let now=Date.now();
 t.mock.method(Date,"now",()=>now);
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 let sends=0;
 // The thread accepts the message but never starts a turn for it, and stays idle.
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async()=>{sends++;}}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m==="sendMessage")sent.push(p);return {message_id:1} as T},new AbortController().signal);
 await tick();
 assert.equal(sends,1);
 assert.equal(rows.get("group:in:5:8").state,"submitted");
 now+=16*60_000;
 await tick(); await tick();
 assert.equal(sends,2,"given once more");
 now+=16*60_000;
 await tick(); await tick();
 assert.equal(sends,2,"not a third time");
 assert.equal(rows.has("group:in:5:8"),false);
 assert.match(sent.at(-1).text,/потерялось/);
 // Typing would not be sent for a submission older than the limit.
 store.put("group:in:5:9",{route:{chatId:-1001,topicId:3,threadId:"t",senderId:7},ownerId:7,state:"submitted",submittedAt:now-11*60_000});
 const typed:any[]=[];
 const {groupTyping}=await import("../group-worker");
 const ac=new AbortController();
 groupTyping(store as any,()=>7,()=>5,()=>async <T>(m:string,p:any)=>{typed.push([m,p]);return {} as T},ac.signal);
 await new Promise(r=>setTimeout(r,50)); ac.abort();
 assert.equal(typed.length,0);
});

test("the rules in force come with the turn: in full once per version, then one line (0.9.59)",async()=>{
 for (const ownerForum of [false,true]) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true,projectId:"group-project",...(ownerForum && {ownerSharedProject:true,ownerId:7})});
 if (ownerForum) store.put("group:shared-thread:t",true);
 const events:any[]=[]; const inputs:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),
   events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
   send:async(q:any)=>{inputs.push(q.input);const id="turn"+inputs.length;
     const ev=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:id}});
     ev("client/turn/requested",{requestId:id,originPluginId:"telegram-projects",input:q.input});ev("turn/input/accepted",{clientRequestId:id});
     ev("item/completed",{item:{type:"agentMessage",text:"ok"}});ev("turn/completed",{status:"completed"});}}};
 let rules={version:"v1aaaaaaaaaa",text:"Принцип: делай там, где просят."};
 const tick=()=>processGroupInputs(store as any,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal,
   undefined,undefined,undefined,false,async()=>true,undefined,async()=>rules);
 const say=(id:number)=>acceptGroupUpdate(store,{update_id:id,message:{message_id:id,chat:{type:"supergroup",id:-1001},from:{id:7,is_bot:false},is_topic_message:true,message_thread_id:3,text:"Q"+id}},7,5);
 const ruleText=(i:number)=>inputs[i].map((x:any)=>x.text??"").join("\n");
 say(10); await tick();
 const routingRule=/Итог хода в этом разговоре уходит человеку, чьё сообщение начало ход; ответ другому треду отправляй командой bb thread tell, не итогом/;
 assert.match(ruleText(0),routingRule);
 assert.match(ruleText(0),/Правила обновлены \(версия v1aaaaaaaaaa\)[\s\S]*делай там, где просят/);
 say(11); await tick();
 assert.match(ruleText(1),/Правила организации без изменений \(версия v1aaaaaaaaaa\)/);
 assert.doesNotMatch(ruleText(1),routingRule);
 assert.doesNotMatch(ruleText(1),/делай там, где просят/);
 rules={version:"v2bbbbbbbbbb",text:"Принцип: новое правило."};
 say(12); await tick();
 assert.match(ruleText(2),/Правила обновлены \(версия v2bbbbbbbbbb\)[\s\S]*новое правило/);
 assert.match(ruleText(2),routingRule);
 }
});

test("0.9.66: the agent already wrote into this topic during the turn — the final answer is not posted again; no service line without text",async()=>{
 for (const wrote of [true,false]) {
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
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   // A limit-guard notice joins the running turn (24.11): the task must still see its end.
   event("client/turn/requested",{requestId:"guard",originPluginId:"limit-guard",initiator:"user",senderThreadId:null,input:[]});
   event("turn/input/accepted",{clientRequestId:"guard"});
   if (wrote) { store.put(sentInTurnKey("t"),{chat:-1001,topic:3,at:Date.now(),sent:[{t:sameWords("**Готово**, написал выше."),at:Date.now()}]}); event("item/completed",{item:{type:"agentMessage",text:"Готово, написал выше."}}); }
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([_m,p]);return {} as T},new AbortController().signal);
 await tick(); await tick();
 assert.equal(rows.get("group:receipt:5:8")?.state,"done",wrote ? "wrote" : "silent");
 assert.equal(sent.filter(([m])=>m==="sendMessage").length,0,"nothing more is posted");
 }
});

test("0.9.76: a turn the bridge started itself (deferred task) that already sent here by command posts no report; a person's turn and the owner's answer keep their final",async()=>{
 for (const [synthetic,ownerAnswer] of [[true,false],[false,false],[false,true]]) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 const updateId=synthetic ? -10 : ownerAnswer ? -1795600000000 : 8;   // the owner's answer (queueAnswerTurn) is synthetic too
 store.put(`group:in:5:${updateId}`,{ownerId:7,state:"pending",...(synthetic && {followUp:true}),route:{kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId,text:"Q"}});
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   // After the owner's «да» the agent sends a file with a caption by command; its final explains it — that must go.
   store.put(sentInTurnKey("t"),{chat:-1001,topic:3,at:Date.now(),sent:[{t:sameWords(ownerAnswer ? "Договор на подпись" : "Итог: всё перевёл."),at:Date.now()}]});
   event("item/completed",{item:{type:"agentMessage",text:"Отправил итог в тему, жду решения."}});
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([_m,p]);return {message_id:20} as T},new AbortController().signal);
 await tick(); await tick(); await tick();
 assert.equal(sent.filter(([m,p])=>m==="sendMessage" && /Отправил итог/.test(p.text)).length,synthetic ? 0 : 1,synthetic ? "deferred task" : "a person's message");
 }
});

test("0.9.76: the owner's answer given to a person's conversation keeps that person as the author of the request for the next question",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:false,allowedSenderIds:[42]});
 store.put("group:turn-message:t",{chat:-1001,topic:3,message:10,sender:42,senderName:"Тестовый Иван",text:"дай доступ"});
 store.put("group:in:5:-1795600000000",{ownerId:7,state:"pending",route:{kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:-1795600000000,text:"Ответ владельца: да"}});
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async()=>{}}};
 await processGroupInputs(store,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal);
 assert.equal((store.get("group:turn-message:t") as any).sender,42,"still the person, not the owner");
});

test("0.9.76: a voice gets 👀 at once and its reaction by meaning from the transcript, not from empty text",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 store.put("group:in:5:8",{ownerId:7,state:"pending",route:{kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:8,text:"",voice:{fileId:"v",mime:"audio/ogg",size:1,duration:3}}});
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async()=>{}}};
 const prompts:string[]=[]; const reactions:string[]=[];
 const chooser=async(prompt:string)=>{prompts.push(prompt); return "🔥";};
 const tg=()=>(async <T>(m:string,p:any)=>{if(m==="setMessageReaction") reactions.push(p.reaction[0]?.emoji); return {message_id:1} as T}) as any;
 const tick=()=>processGroupInputs(store,sdk as any,7,5,tg,new AbortController().signal,async()=>"Отличные новости, контракт подписан!",
   undefined,undefined,false,undefined,()=>({chooser:chooser as any,options:[{emoji:"👀",meaning:"увидел"},{emoji:"🔥",meaning:"огонь"}]}));
 await tick(); await tick(); await new Promise(r=>setTimeout(r,10));
 assert.equal(reactions[0],"👀","seen at once");
 assert.equal(prompts.length,1,"chosen once — from the transcript");
 assert.match(prompts[0],/контракт подписан/);
 assert.equal(reactions.at(-1),"🔥");
});

test("a plugin veto requests only the finished result once and settles the original message",async()=>{
 for (const labelled of [false,true]) {
 for (const outcome of ["result","plugin again","wrong label","no receipt"] as const) {
   const rows=new Map<string,any>();
   const store={get:<T>(k:string)=>structuredClone(rows.get(k)) as T,put:(k:string,v:unknown)=>{rows.set(k,structuredClone(v))},
     del:(k:string)=>{rows.delete(k)},list:<T>(p:string)=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value) as T})),atomic:(fn:()=>void)=>fn()};
   store.put("group:project:project",true);
   store.put("group:thread:t","group:policy:-1001:3");
   store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",ownerOnly:true,requireMention:false});
   const events:any[]=[], delivered:any[]=[], submissions:any[]=[];
   const event=(type:string,data:any,turn:string)=>events.push({seq:events.length+1,type,data,scope:{kind:"turn",turnId:turn}});
   const say=(body:string,turn:string)=>event("item/completed",{item:{type:"agentMessage",text:body}},turn);
   event("client/turn/requested",{requestId:"guard",originPluginId:"limit-guard",initiator:"system"},"one");
   const sdk={threads:{get:async()=>({id:"t",projectId:"project",visibility:"visible",status:labelled ? "active" : "idle"}),
     events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0) && e.seq<Number(q.beforeSeq??Infinity) &&
       (!q.types || q.types.includes(e.type))).sort((a,b)=>q.order==="desc" ? b.seq-a.seq : a.seq-b.seq).slice(0,Number(q.limit??100))},
     send:async(q:any)=>{
       submissions.push([q.mode,q.input[0].text]);
       const turn=submissions.length===1 ? "one" : "two";
       if (turn==="two" && outcome==="no receipt") return;
       event("client/turn/requested",{requestId:turn,originPluginId:"telegram-projects",input:q.input},turn);
       event("turn/input/accepted",{clientRequestId:turn},turn);
       if (turn==="one") {
         if (labelled) {
           const label=q.input.map((b:any)=>b.text).join("\n").match(/\[telegram-answer:([a-f0-9-]+)\]/)[1];
           say(`[telegram-answer:${label}]\nПроверяю\n[/telegram-answer]`,turn);
         }
         event("turn/input/accepted",{clientRequestId:"guard"},turn);
         say("Принял, работаю короткими шагами",turn);
       } else {
         assert.equal(q.input.length,2);
         assert.equal(q.input[1].visibility,"agent-only");
         assert.doesNotMatch(q.input.map((block:any)=>block.text).join("\n"),/Как дела\?/);
         const label=q.input[0].text.match(/\[telegram-answer:([a-f0-9-]+)\]/)[1];
         if (outcome==="plugin again") {
           event("client/turn/requested",{requestId:"guard-2",originPluginId:"limit-guard"},turn);
           event("turn/input/accepted",{clientRequestId:"guard-2"},turn);
           say("Принял, работаю короткими шагами",turn);
         } else {
           const selector=outcome==="wrong label" ? "wrong" : label;
           say(`[telegram-answer:${selector}]\nРабота закончена\n[/telegram-answer]`,turn);
         }
       }
       event("turn/completed",{status:"completed"},turn);
     }}};
   const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{
     if (m==="sendMessage") delivered.push([p.reply_parameters.message_id,p.text]);
     return {message_id:20} as T;
   },new AbortController().signal,undefined,undefined,undefined,false,undefined,undefined,undefined,undefined,undefined,undefined,
     ()=>delivered.map(()=>({message:20,replyTo:10})));
   assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},
     from:{id:7},message_thread_id:3,text:"Как дела?"}},7,5));
   await tick();
   assert.deepEqual(delivered,labelled ? [[10,"Проверяю"]] : []);
   await tick();
   await tick();
   if (outcome==="no receipt") {
     const key="group:in:5:8";
     store.put(key,{...store.get<any>(key),submittedAt:0});
   }
   await tick();
   await tick();
   assert.equal(submissions.length,2);
   assert.equal(submissions.filter(([,text])=>text.includes("Как дела?")).length,1);
   assert.equal(submissions[1][0],"queue-if-active");
   assert.match(submissions[1][1],/Итог по сообщению №10.*Работу не повторяй/);
   const final=outcome==="result" ? "Работа закончена" : "Не удалось получить итог по вашему сообщению.";
   assert.deepEqual(delivered,[...(labelled ? [[10,"Проверяю"]] : []),[10,final]]);
   assert.equal(store.list("group:in:5:").length,0);
 }
 }
});

test("a labelled reply leaves the final with the proven starter of the turn",async()=>{
 for (const starter of ["own","another person","BB","unknown"] as const) {
 for (const joined of ["none","agent","child","queued plugin","command result","duplicate send","previous turn send","next turn send"] as const) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 const route={kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:8,text:"посчитай файлы"};
 store.put("group:turn-watch:5:t:T1",{threadId:"t",turn:"T1",afterSeq:5,route,ownerId:7,at:Date.now(),labelAt:1000});
 const routes=new ReplyRoutes(store as any);
 if (starter!=="unknown") {
   routes.record("t","first",starter==="BB" ? {kind:"bb"} :
     {kind:"telegram",chatId:-1001,topicId:3,updateId:starter==="own" ? 8 : 4,messageId:starter==="own" ? 10 : 9});
   routes.accept("t","T1","first");
 }
 if (joined==="command result" || joined==="duplicate send" || joined==="previous turn send" || joined==="next turn send") {
   store.put(sentInTurnKey("t"),{chat:-1001,topic:3,sent:[{at:joined==="previous turn send" ? 999 : joined==="next turn send" ? 2001 : 1500,t:sameWords(
     joined==="duplicate send" ? "Нашёл 8 файлов .md." : "Итог уже передан.")}]});
 }
 const ev=(seq:number,type:string,data:any,turn?:string)=>({seq,type,data,scope:turn ? {kind:"turn",turnId:turn} : {kind:"thread"}});
 const events=[
   ev(2,"turn/input/accepted",{clientRequestId:"first"},"T1"),
   ...(joined==="queued plugin" ? [ev(6,"client/turn/requested",{requestId:"queued",originPluginId:"codex-watch"})] : []),
   ...((joined!=="agent" && joined!=="child") ? [] : [ev(6,"client/turn/requested",joined==="agent" ?
     {requestId:"join",initiator:"agent",senderThreadId:"thr_sender"} :
     {requestId:"join",initiator:"system",originPluginId:"provider-codex",systemMessageKind:"child-completed"}),
     ev(7,"turn/input/accepted",{clientRequestId:"join"},"T1")]),
   ev(8,"item/completed",{item:{type:"agentMessage",text:joined==="command result" ? "Отправил выше" : "Нашёл 8 файлов .md.\n<!-- bb-telegram-child-result:thr_c:T9 -->"}},"T1"),
   {...ev(9,"turn/completed",{status:"completed"},"T1"),createdAt:2000}];
 const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0) && (!q.types || q.types.includes(e.type)))},send:async()=>{}}};
 const sent:any[]=[];
 await processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m==="sendMessage") sent.push(p); return {message_id:1} as T},new AbortController().signal);
 if (starter==="own" && joined!=="duplicate send" && joined!=="command result") {
   assert.equal(sent.length,1,"the result is posted");
   assert.match(String(sent[0].text),/Нашёл 8 файлов/);
   assert.doesNotMatch(String(sent[0].text),/bb-telegram-child-result/);
   assert.equal(sent[0].reply_parameters?.message_id,10,"as a reply to the same message");
 } else assert.equal(sent.length,0,"only the proven starter receives the final");
 assert.equal(rows.has("group:turn-watch:5:t:T1"),false,"the watch ends with the turn");
 }
 }
});

test("0.9.77: a message the agent wrote before working on is interim — not the answer when it writes again",async()=>{
 for (const [then,expected] of [["Готово: 8 файлов.","Готово: 8 файлов."],["[telegram-answer:abcdef12]\nОтвет другому.\n[/telegram-answer]",null],[null,"Посчитаю файлы."]] as const) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"посчитай"}},7,5));
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   event("item/completed",{item:{type:"agentMessage",text:"Посчитаю файлы."}});
   event("item/started",{item:{type:"commandExecution",command:"find . -name '*.md'"}});
   if (then) event("item/completed",{item:{type:"agentMessage",text:then}});
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m==="sendMessage")sent.push(p.text);return {message_id:1} as T},new AbortController().signal);
 await tick(); await tick(); await tick();
 if (expected===null) assert.equal(sent.filter(t=>/Посчитаю/.test(t)).length,0,"the note between calls is not an answer");
 else assert.ok(sent.some(t=>t.includes(expected)),String(then));
 }
});

test("0.9.67: an interim message the agent sent («взял») never hides the turn's real result; a failed turn says so",async()=>{
 for (const status of ["completed","failed"]) {
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
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   store.put(sentInTurnKey("t"),{chat:-1001,topic:3,at:Date.now(),sent:[{t:sameWords("Взял, отчёт будет готов через 10 минут."),at:Date.now()},
     {t:sameWords("Итог: отчёт готов."),at:Date.now()-24*3600_000}]});
   if (status==="completed") event("item/completed",{item:{type:"agentMessage",text:"Итог: отчёт готов."}});
   event("turn/completed",{status});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([_m,p]);return {} as T},new AbortController().signal);
 await tick(); await tick();
 const texts=sent.filter(([m])=>m==="sendMessage").map(([,p])=>p.text);
 assert.equal(texts.length,1,status);
 assert.match(texts[0],status==="completed" ? /Итог: отчёт готов/ : /Не получилось сделать/);
 }
});

test("0.9.70: the final answer is hidden only by an exact repeat sent in this very turn",async()=>{
 for (const [sent,at,shown] of [["Готово, будет готово через 10 минут.",0,true],["Отчёт готов, файл выше.",-24*3600_000,true],["**Отчёт  готов**, файл выше.",0,false]] as const) {
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
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   store.put(sentInTurnKey("t"),{chat:-1001,topic:3,at:Date.now(),sent:[{t:sameWords(sent),at:Date.now()+at}]});
   event("item/completed",{item:{type:"agentMessage",text:sent.startsWith("Готово,") ? "Готово." : "Отчёт готов, файл выше."}});
   event("turn/completed",{status:"completed"});
 }}};
 const out:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;out.push([_m,p]);return {} as T},new AbortController().signal);
 await tick(); await tick();
 assert.equal(out.filter(([m])=>m==="sendMessage").length,shown ? 1 : 0,sent);
 }
});

test("0.9.70: on the employee's pause a waiting message shows no «thinking» line until its turn starts",async()=>{
 for (const paused of [true,false]) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async()=>[]},send:async()=>{}}};
 const out:any[]=[];
 const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m!=="setMessageReaction")out.push([m,p]);return {message_id:99} as T},
   new AbortController().signal,undefined,undefined,undefined,true,undefined,undefined,undefined,async()=>paused);
 await tick();
 const key=[...rows.keys()].find(k=>k.startsWith("group:in:"))!;
 rows.set(key,{...rows.get(key),startedAt:0,progressAt:0,submittedAt:Date.now()});
 await tick();
 assert.equal(out.filter(([m])=>m==="sendMessage").length,paused ? 0 : 1,paused ? "paused" : "running");
 }
});

test("0.9.75: two forwards and a comment of the owner in a place without mentions are one turn", async t => {
 let now=Date.now();
 t.mock.method(Date,"now",()=>now);
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:0");
 store.put("group:policy:-1001:0",{chatId:-1001,topicId:0,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 const job=(u:number,text:string,extra:any={})=>store.put(`group:in:5:${u}`,{ownerId:7,state:"pending",
   route:{kind:"group",chatId:-1001,topicId:0,senderId:7,threadId:"t",messageId:u+100,updateId:u,text,arrivedAt:now,...extra}});
 job(1,"[Пересланное сообщение. Автор оригинала: Пётр (человек).]\n",{collectUntil:now+10_000,voice:{fileId:"a",mime:"audio/ogg",size:1,duration:3}});
 job(2,"[Пересланное сообщение. Автор оригинала: Пётр (человек).]\n",{collectUntil:now+10_000,voice:{fileId:"b",mime:"audio/ogg",size:1,duration:4}});
 job(3,"Передай это Потапычу");
 const inputs:string[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"idle"}),
   events:{list:async()=>[]},send:async(q:any)=>{inputs.push(q.input.map((x:any)=>x.text ?? "").join("\n"));}}};
 const transcribe=async(v:any)=>v.fileId==="a" ? "первая мысль" : "вторая мысль";
 const tick=()=>processGroupInputs(store,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal,transcribe as any);
 for (let i=0;i<4;i++) await tick();
 assert.equal(inputs.length,0,"the forward's window is still open");
 now+=11_000;
 for (let i=0;i<4;i++) await tick();
 assert.equal(inputs.length,1,"one turn");
 assert.match(inputs[0],/первая мысль[\s\S]*вторая мысль[\s\S]*Передай это Потапычу/);
 assert.match(inputs[0],/Автор оригинала: Пётр/);
 assert.equal(inputs[0].split("вторая мысль").length,2,"a merged voice's transcript is there once");
});

test("С112: a forward gives no cross-group or deletion authority; a typed comment carries its sender’s rights",async t=>{
 let now=Date.now();
 t.mock.method(Date,"now",()=>now);
 for (const sender of [7,8]) for (const busy of [false,true]) for (const comment of [false,true]) {
   const rows=new Map<string,any>();
   const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
     list:<T>(p:string)=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
   store.put("group:project:project",true);
   store.put("group:thread:t","group:policy:-1001:0");
   store.put("group:policy:-1001:0",{chatId:-1001,topicId:0,threadId:"t",botId:5,botUsername:"bot",ownerOnly:true,requireMention:false});
   store.put("rights:5:access",[{id:8,name:"Анна"}]);
   store.put("visibility:5:group:-1002",{chat:-1002});
   const post=(id:number,text:string,extra:object)=>acceptGroupUpdate(store,{update_id:id,message:{
     chat:{type:"supergroup",id:-1001},from:{id:sender},message_id:id,text,...extra}},7,5);
   assert.ok(post(10,"Чужая просьба",sender===7 ? {forward_date:1} : {forward_origin:{type:"hidden_user",sender_user_name:"Антон"}}));
   if (comment) assert.ok(post(11,"Мой комментарий",{}));
   now+=60_000;
   const routes=new ReplyRoutes(store);
   const initial={kind:"telegram" as const,chatId:-1001,topicId:0,updateId:3};
   if (busy) {
     routes.record("t","own",initial);
     routes.accept("t","turn","own");
     store.put("group:turn-author:t:3",sender);
     assert.equal(turnStartedByMessage(store,"t","turn"),true);
   }
   const prompts:string[]=[];
   const sdk={threads:{get:async()=>({id:"t",projectId:"project",visibility:"visible",status:busy ? "active" : "idle"}),
     events:{list:async(q:any)=>busy && q.types?.includes("turn/started") ? [{scope:{kind:"turn",turnId:"turn"}}] : []},
     send:async(q:any)=>{
       prompts.push(q.input[0].text);
       if (busy) assert.equal(turnStartedByMessage(store,"t","turn"),comment);
     }}};
   await processGroupInputs(store,sdk as any,7,5,()=>async<T>()=>({} as T),new AbortController().signal);
   assert.equal(prompts.length,1);
   const [prompt]=prompts;
   assert.match(prompt,/Пересланное[\s\S]*Чужая просьба/);
   if (comment) assert.match(prompt,/Чужая просьба[\s\S]*Собственный комментарий отправителя\]\nМой комментарий/);
   const [{value}]=store.list<any>("reply:ingress:");
   routes.record("t","request",value.route);
   if (!busy) routes.accept("t","turn","request");
   if (busy && !comment) {
     routes.record("t","later",initial);
     routes.accept("t","turn","later");
     routes.accept("t","next-turn","later");
     assert.equal(turnStartedByMessage(store,"t","next-turn"),true);
   }
   const own=turnStartedByMessage(store,"t","turn");
   const author=authorOfTurn(store,"t","turn",7);
   assert.equal(own,comment);
   assert.equal(author,comment ? sender : undefined);
   const caller={kind:"group" as const,chat:-1001};
   assert.equal(await sendRefusal(store,5,7,caller,{chat:-1002,topic:0},()=>[-1001,-1002],undefined,author,false,own,
     async()=>({status:"member"}))===undefined,comment);
   assert.equal(deleteRefusal({caller,owner:7,bot:5,chat:-1001,sender:9,author})===undefined,comment && sender===7);
 }
});

test("С113: the bot just added — the agent introduces itself once, as a plain message; Telegram forbids writing — one line to the curator",async()=>{
 for (const forbidden of [false,true]) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:0");
 store.put("group:policy:-1001:0",{chatId:-1001,topicId:0,threadId:"t",botId:5,botUsername:"bot",requireMention:true,ownerOnly:false});
 store.put("visibility:5:group:-1001",{chat:-1001,title:"Отдел (тестовая группа)"});
 store.put(curatorsKey,[42]);
 const args={chatId:-1001,threadId:"t",bot:5,owner:7,title:"Отдел (тестовая группа)",inviterName:"Анна",botUsername:"bot",reply:"mention" as const,seesAll:false};
 assert.equal(startAddedIntroduction(store as any,args),true);
 assert.equal(startAddedIntroduction(store as any,args),false,"once per group");
 const inputs:string[]=[];
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   inputs.push(q.input.map((b:any)=>b.text).join("\n"));
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   event("item/completed",{item:{type:"agentMessage",text:"Здравствуйте! Я помощник отдела, отвечайте на моё сообщение."}});
   event("turn/completed",{status:"completed"});
 }}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store as any,sdk as any,7,5,(chat:number)=>async <T>(m:string,p:any)=>{
   if (forbidden && chat<0) throw new TelegramFailure("telegram_rights");
   sent.push({chat,...p}); return {message_id:1} as T},new AbortController().signal);
 await tick(); await tick(); await tick();
 assert.match(inputs[0],/Тебя добавили в группу «Отдел \(тестовая группа\)»; добавил: Анна/);
 assert.match(inputs[0],/только ответы на свои сообщения и команды \/ask@bot/,"privacy: the agent knows people must reply to it");
 if (!forbidden) {
   const intro=sent.filter(x=>x.chat===-1001);
   assert.equal(intro.length,1);
   assert.match(intro[0].text,/Здравствуйте/);
   assert.equal(intro[0].reply_parameters,undefined,"no message to reply to");
 } else {
   assert.equal(sent.length,1,"one line, and the job is not retried");
   assert.equal(sent[0].chat,42,"to the curator");
   assert.match(sent[0].text,/Не могу ответить в «Отдел \(тестовая группа\)»: Telegram не даёт мне писать там/);
   assert.equal([...rows.keys()].some(k=>k.startsWith("group:in:")),false,"closed");
 }
 }
});

test("0.9.77: «отвечаю сам» — a message nobody addressed gets no 👀 and no live line, only the answer if the agent gives one; in «по отметке» a mention gets 👀 at once",async()=>{
 for (const [mode,text,answer] of [["auto","кто-нибудь видел отчёт?","NO_REPLY"],["auto","кто-нибудь видел отчёт?","Отчёт лежит в общей папке."],["mention","@bot где отчёт?","В общей папке."]] as const) {
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:mode==="mention",ownerOnly:false});
 store.put("rights:5:access",[{id:9,name:"Анна"}]);
 const accepted=acceptGroupUpdate(store as any,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:9,first_name:"Анна"},message_thread_id:3,text,
   ...(mode==="mention" && {entities:[{type:"mention",offset:0,length:4}]})}},7,5);
 assert.ok(accepted,mode);
 const events:any[]=[];
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
 send:async(q:any)=>{
   const event=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"g"}});
   event("client/turn/requested",{requestId:"g",originPluginId:"telegram-projects",input:q.input});
   event("turn/input/accepted",{clientRequestId:"g"});
   event("item/started",{item:{type:"commandExecution",command:"ls"}});
   event("item/completed",{item:{type:"agentMessage",text:answer}});
   event("turn/completed",{status:"completed"});
 }}};
 const calls:{m:string;p:any}[]=[];
 const tick=()=>processGroupInputs(store as any,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{calls.push({m,p});return (m==="sendMessage" ? {message_id:20} : true) as T},new AbortController().signal);
 for (let i=0;i<4;i++) await tick();
 await new Promise(r=>setTimeout(r,20));
 const reactions=calls.filter(c=>c.m==="setMessageReaction");
 const texts=calls.filter(c=>c.m==="sendMessage").map(c=>String(c.p.text));
 if (mode==="mention") assert.ok(reactions.length>0,"a mention is seen at once");
 else {
   assert.equal(reactions.length,0,"no 👀 on talk not addressed to the agent: "+answer);
   assert.equal(texts.filter(t=>t!==answer).length,0,"no live line: "+texts.join(" | "));
   assert.equal(texts.includes(answer),answer!=="NO_REPLY");
 }
 }
});

test("С113 review: the once-a-day line is marked only when it reached someone; media-only refusal says so",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("visibility:5:group:-1001",{chat:-1001,title:"Отдел (тестовая группа)"});
 store.put(curatorsKey,[42]);
 let open=false; const got:any[]=[];
 const transport=(chat:number)=>async <T>(_m:string,p:any)=>{if (!open) throw new TelegramFailure("telegram_403"); got.push({chat,...p}); return {message_id:1} as T};
 await tellCannotAnswer(store as any,5,7,{chatId:-1001,senderName:"Анна"},"telegram_rights",transport as any,1000);
 assert.equal(got.length,0);
 assert.equal(rows.has("group:cannot-answer:5:-1001"),false,"nobody got it — not marked");
 open=true;
 await tellCannotAnswer(store as any,5,7,{chatId:-1001,senderName:"Анна"},"files",transport as any,2000);
 assert.equal(got.length,1); assert.equal(got[0].chat,42);
 assert.match(got[0].text,/нет права отправлять файлы и фото: ответ для Анна ушёл текстом/);
 await tellCannotAnswer(store as any,5,7,{chatId:-1001},"telegram_rights",transport as any,3000);
 assert.equal(got.length,1,"once a day");
});

test("0.9.77 review: a person's message joining the owner's running turn marks that turn with its author before it is sent",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:true,ownerOnly:false});
 store.put("rights:5:access",[{id:9,name:"Анна"}]);
 assert.ok(acceptGroupUpdate(store as any,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:9,first_name:"Анна"},message_thread_id:3,
   text:"@bot напиши в группу Склад",entities:[{type:"mention",offset:0,length:4}]}},7,5));
 const events:any[]=[{type:"turn/started",data:{},seq:1,scope:{kind:"turn",turnId:"T-owner"}}];
 let markedBeforeSend:unknown;
 const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"group-project",visibility:"visible",status:"active"}),
   events:{list:async(q:any)=>events.filter(e=>(!q.types || q.types.includes(e.type)) && e.seq>Number(q.afterSeq??0)).sort((a,b)=>q.order==="desc" ? b.seq-a.seq : a.seq-b.seq).slice(0,Number(q.limit ?? 100))},
   send:async()=>{markedBeforeSend=rows.get("group:turn-mixed:t:T-owner");}}};
 await processGroupInputs(store as any,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal);
 assert.equal(markedBeforeSend,9);
 // A person with access joining after a stranger does not raise the turn back.
 rows.set("group:turn-mixed:t:T-owner",31);
 assert.ok(acceptGroupUpdate(store as any,{update_id:9,message:{message_id:11,chat:{type:"supergroup",id:-1001},from:{id:9,first_name:"Анна"},message_thread_id:3,
   text:"@bot и ещё",entities:[{type:"mention",offset:0,length:4}]}},7,5));
 await processGroupInputs(store as any,sdk as any,7,5,()=>async <T>()=>({message_id:1} as T),new AbortController().signal);
 assert.equal(rows.get("group:turn-mixed:t:T-owner"),31,"the least trusted stays");
});

test("0.9.79: two answers with the same label in one turn — «прочитаю и пришлю», then the result — both reach the person, in order; a word-for-word repeat does not",async()=>{
 const rows=new Map<string,any>();
 const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
   list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
 store.put("group:project:group-project",true);
 store.put("group:thread:t","group:policy:-1001:3");
 store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",botId:5,botUsername:"bot",requireMention:false,ownerOnly:true});
 const route={kind:"group",chatId:-1001,topicId:3,senderId:7,threadId:"t",messageId:10,updateId:8,text:"пришли список разделов"};
 // The turn is this message's own: its unlabelled final goes to it too.
 { const routes=new ReplyRoutes(store as any); routes.record("t","req",{kind:"telegram",chatId:-1001,topicId:3,updateId:8,messageId:10} as any); routes.accept("t","T1","req"); }
 store.put("group:turn-watch:5:t:T1",{threadId:"t",turn:"T1",afterSeq:5,route,ownerId:7,at:Date.now(),label:"b317b4ed",labelled:"Прочитаю план и пришлю список разделов."});
 const ev=(seq:number,type:string,data:any)=>({seq,type,data,scope:{kind:"turn",turnId:"T1"}});
 const events=[
   {seq:1,type:"client/turn/requested",data:{requestId:"req",originPluginId:"telegram-projects"},scope:{kind:"thread"}},
   ev(2,"turn/input/accepted",{clientRequestId:"req"}),
   ev(6,"item/completed",{item:{type:"agentMessage",text:"[telegram-answer:b317b4ed]\nПрочитаю план и пришлю список разделов.\n[/telegram-answer]"}}),
   ev(7,"item/completed",{item:{type:"agentMessage",text:"[telegram-answer:b317b4ed]\n- «План стенда» — единственный раздел.\n[/telegram-answer]"}}),
   ev(8,"item/completed",{item:{type:"agentMessage",text:"[telegram-answer:b317b4ed]\nЕщё: подразделов нет.\n[/telegram-answer]"}}),
   ev(9,"item/completed",{item:{type:"agentMessage",text:"Итог: список выше."}}),
   ev(10,"turn/completed",{status:"completed"})];
 const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible"}),events:{list:async(q:any)=>{
   const r=events.filter(e=>e.seq>Number(q.afterSeq??0) && (q.beforeSeq===undefined || e.seq<Number(q.beforeSeq)) && (!q.types || q.types.includes(e.type)));
   return q.order==="desc" ? r.reverse() : r;}},send:async()=>{}}};
 const sent:any[]=[];
 const tick=()=>processGroupInputs(store as any,sdk as any,7,5,()=>async <T>(m:string,p:any)=>{if(m==="sendMessage") sent.push(p); return {message_id:1} as T},new AbortController().signal);
 for (let i=0;i<5;i++) await tick();
 assert.deepEqual(sent.map(x=>String(x.text).replace(/\s+/g," ").trim()),["• «План стенда» — единственный раздел.","Ещё: подразделов нет.","Итог: список выше."],
   "the repeat of the first is dropped; the rest in the order written, from one batch of events");
 assert.equal(sent[0].reply_parameters?.message_id,10,"as a reply to the same message");
});

test("0.9.80: verifyOwnerForumState retries on transient Telegram API failures and revokes only on definitive refusal", async () => {
  const { verifyOwnerForumState } = await import("../group-binding");
  const { TelegramFailure } = await import("../model");
  assert.equal(await verifyOwnerForumState(async () => true, () => true), true);
  assert.equal(await verifyOwnerForumState(async () => false, () => true), false);
  assert.equal(await verifyOwnerForumState(async () => true, () => false), false);
  for (const err of [
    new TelegramFailure("telegram_400"),
    new TelegramFailure("telegram_401"),
    new TelegramFailure("telegram_403"),
    new TelegramFailure("telegram_rights"),
    new TelegramFailure("topic_missing"),
    new Error("unexpected"),
  ]) {
    assert.equal(await verifyOwnerForumState(async () => { throw err; }, () => true), false, String(err));
  }
  const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
  const timeoutErr = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  for (const err of [
    new TelegramFailure("telegram_502", 30, true),
    new TelegramFailure("telegram_429", 10, false),
    new TelegramFailure("telegram_network", 30, true),
    abortErr,
    timeoutErr,
  ]) {
    assert.equal(await verifyOwnerForumState(async () => { throw err; }, () => true), "retry", String(err));
  }
});

test("0.9.80: transient verifyOwnerForum error keeps owner forum message in queue with backoff and delivers after recovery; real false revokes", async () => {
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put("group:shared-thread:t", true);
  store.put("group:thread:t", "group:policy:-1001234567890:3");
  store.put("group:policy:-1001234567890:3", {
    chatId: -1001234567890, topicId: 3, threadId: "t", projectId: "p-owner",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: true, requireMention: false,
    ownerSharedProject: true, revision: "r1",
  });
  const route = { kind: "group", chatId: -1001234567890, topicId: 3, senderId: 7, threadId: "t", messageId: 10, updateId: 100, text: "привет" };
  store.put("group:in:5:100", { ownerId: 7, revision: "r1", state: "ready", answer: "Ответ владельцу", route });

  const sdk = {
    threads: {
      get: async () => ({ id: "t", projectId: "p-owner", visibility: "visible", parentThreadId: null }),
      events: { list: async () => [] },
      send: async () => {},
    },
  };
  const sent: any[] = [];
  let verdict: boolean | "retry" = "retry";
  const tick = () => processGroupInputs(
    store as any, sdk as any, 7, 5,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 20 } as T; },
    new AbortController().signal,
    undefined, undefined, undefined, false,
    async () => verdict,
  );

  // 1) Transient error: not revoked, stays in queue with backoff
  await tick();
  assert.equal(sent.length, 0);
  const deferred = store.get<any>("group:in:5:100");
  assert.ok(deferred, "job must stay queued on transient verify error");
  assert.equal(deferred.verifyFailures, 1);
  assert.ok(deferred.verifyRetryAt > Date.now(), "backoff retryAt set");
  assert.equal(store.get("group:receipt:5:100"), undefined, "not revoked");

  // Still waiting during backoff
  verdict = true;
  await tick();
  assert.equal(sent.length, 0, "skipped while backoff active");

  // Backoff elapsed: delivers cleanly
  deferred.verifyRetryAt = Date.now() - 1;
  store.put("group:in:5:100", deferred);
  await tick();
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /Ответ владельцу/);
  assert.equal(store.get<any>("group:receipt:5:100")?.state, "done");

  // 2) Definitive false: revokes immediately as before
  const route2 = { ...route, messageId: 11, updateId: 101 };
  store.put("group:in:5:101", { ownerId: 7, revision: "r1", state: "ready", answer: "Не должно уйти", route: route2 });
  verdict = false;
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(store.get("group:in:5:101"), undefined);
  assert.equal(store.get<any>("group:receipt:5:101")?.state, "revoked");
});

test("0.9.80: verifyOwnerForum retry limit (24h) closes job as revoked instead of retrying forever", async () => {
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put("group:shared-thread:t", true);
  store.put("group:thread:t", "group:policy:-1001234567890:3");
  store.put("group:policy:-1001234567890:3", {
    chatId: -1001234567890, topicId: 3, threadId: "t", projectId: "p-owner",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: true, requireMention: false,
    ownerSharedProject: true, revision: "r1",
  });
  const route = { kind: "group", chatId: -1001234567890, topicId: 3, senderId: 7, threadId: "t", messageId: 12, updateId: 102, text: "привет" };
  store.put("group:in:5:102", {
    ownerId: 7, revision: "r1", state: "ready", answer: "Просроченное", route,
    verifyFirstAt: Date.now() - 25 * 3600_000, verifyFailures: 10,
  });
  const sdk = {
    threads: {
      get: async () => ({ id: "t", projectId: "p-owner", visibility: "visible", parentThreadId: null }),
      events: { list: async () => [] },
      send: async () => {},
    },
  };
  const sent: any[] = [];
  await processGroupInputs(
    store as any, sdk as any, 7, 5,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 21 } as T; },
    new AbortController().signal,
    undefined, undefined, undefined, false,
    async () => "retry",
  );
  assert.equal(sent.length, 0);
  assert.equal(store.get("group:in:5:102"), undefined);
  assert.equal(store.get<any>("group:receipt:5:102")?.state, "revoked");
});

test("0.9.80: deliverGroupResults defers on transient verifyOwnerForum error and delivers after recovery", async () => {
  const { deliverGroupResults } = await import("../group-result");
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put("group:shared-thread:t", true);
  store.put("group:thread:t", "group:policy:-1001234567890:3");
  store.put("group:policy:-1001234567890:3", {
    chatId: -1001234567890, topicId: 3, threadId: "t", projectId: "p-owner",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: true, requireMention: false,
    ownerSharedProject: true, revision: "r1",
  });
  store.put("group:origin:task-1", {
    owner: 7, bot: 5, sender: 7, chatId: -1001234567890, topicId: 3, messageId: 10,
    threadId: "t", projectId: "p-owner", revision: "r1",
  });
  store.put("group:result:task-1", { state: "queued", text: "Итог подтреда" });
  store.put("group:result-queue:task-1", true);

  const sdk = {
    threads: { get: async () => ({ id: "t", projectId: "p-owner", visibility: "visible", parentThreadId: null }) },
  };
  const sent: any[] = [];
  let verdict: boolean | "retry" = "retry";
  const tick = () => deliverGroupResults(
    store as any, sdk as any, () => true,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 30 } as T; },
    new AbortController().signal,
    async () => verdict,
  );
  await tick();
  assert.equal(sent.length, 0);
  const res = store.get<any>("group:result:task-1");
  assert.equal(res.state, "queued");
  assert.equal(res.verifyFailures, 1);
  assert.ok(res.verifyRetryAt > Date.now());

  verdict = true;
  res.verifyRetryAt = Date.now() - 1;
  store.put("group:result:task-1", res);
  await tick();
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /Итог подтреда/);
  assert.equal(store.get<any>("group:result:task-1")?.state, "sent");
});

test("0.9.80: transient verifyOwnerForum error on part 2 of a multipart message resumes at part 2 without duplicating part 1", async () => {
  const rows = new Map<string, any>();
  const store = {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
  store.put("group:shared-thread:t", true);
  store.put("group:thread:t", "group:policy:-1001234567890:3");
  store.put("group:policy:-1001234567890:3", {
    chatId: -1001234567890, topicId: 3, threadId: "t", projectId: "p-owner",
    botId: 5, botUsername: "bot", ownerId: 7, ownerOnly: true, requireMention: false,
    ownerSharedProject: true, revision: "r1",
  });
  const longAnswer = "ЧАСТЬ1 " + "а".repeat(3600) + "\n\nЧАСТЬ2 " + "б".repeat(2000);
  const route = { kind: "group", chatId: -1001234567890, topicId: 3, senderId: 7, threadId: "t", messageId: 15, updateId: 105, text: "привет" };
  store.put("group:in:5:105", { ownerId: 7, revision: "r1", state: "ready", answer: longAnswer, route });
  const sdk = {
    threads: {
      get: async () => ({ id: "t", projectId: "p-owner", visibility: "visible", parentThreadId: null }),
      events: { list: async () => [] },
      send: async () => {},
    },
  };
  const sent: any[] = [];
  let calls = 0;
  const tick = () => processGroupInputs(
    store as any, sdk as any, 7, 5,
    () => async <T>(m: string, p: any) => { if (m === "sendMessage") sent.push(p); return { message_id: 50 + sent.length } as T; },
    new AbortController().signal,
    undefined, undefined, undefined, false,
    async () => { calls++; return calls === 2 ? "retry" : true; },
  );
  await tick();
  assert.equal(sent.length, 1, "only part 1 sent before transient error on part 2");
  const deferred = store.get<any>("group:in:5:105");
  assert.equal(deferred.part, 1, "part index preserved on deferVerify");
  deferred.verifyRetryAt = Date.now() - 1;
  store.put("group:in:5:105", deferred);
  await tick();
  assert.equal(sent.length, 2, "part 2 sent on retry without duplicating part 1");
  assert.match(String(sent[0].text), /^ЧАСТЬ1/);
  assert.match(String(sent[1].text), /ЧАСТЬ2/);
  assert.equal(store.get<any>("group:receipt:5:105")?.state, "done");
});
