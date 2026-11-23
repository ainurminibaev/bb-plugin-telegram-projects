import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {saveLocalTelegramFile} from "../telegram-files";
import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate} from "../ingress";
import {bindGroupTopic,groupCliRestricted,processGroupInputs} from "../group-worker";

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
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push([id,p]);return {} as T},new AbortController().signal);
 await tick();
 assert.equal(rows.has("group:in:5:8"),false);
 assert.equal(rows.get("group:receipt:5:8").state,"done");
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"Q"}},7,5));
 assert.equal(rows.has("group:in:5:8"),false);
 await tick();
 assert.deepEqual(sent,[[-1001,{chat_id:-1001,message_thread_id:3,reply_parameters:{message_id:10,allow_sending_without_reply:false},text:"answer",parse_mode:"HTML",link_preview_options:{is_disabled:true}}]]);
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
 assert.match(sent[0].input[0].text,/first.pdf/);assert.match(sent[0].input[0].text,/"messageId":12/);
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
   events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
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
 const tick=()=>processGroupInputs(store,sdk as any,7,5,id=>async <T>(_m:string,p:any)=>{if(_m==="setMessageReaction")return {} as T;sent.push(p.text);return {} as T},new AbortController().signal);
 assert.ok(acceptGroupUpdate(store,{update_id:8,message:{message_id:10,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"долгая задача"}},7,5));
 await tick();
 status="active";
 assert.ok(acceptGroupUpdate(store,{update_id:9,message:{message_id:11,chat:{type:"supergroup",id:-1001},from:{id:7},message_thread_id:3,text:"а сколько времени?"}},7,5));
 await tick(); await tick(); await tick();
 assert.equal(sends[1].mode,"steer-if-active");
 assert.deepEqual(sent.sort(),["быстрый ответ","долгий ответ"],"each message gets its own answer; the enclosed one is not the long answer");
});
