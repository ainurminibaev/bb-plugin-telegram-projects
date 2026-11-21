import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acceptGroupUpdate} from "../ingress";
import {processGroupInputs} from "../group-worker";

const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=","base64");
const expectedImage={type:"image" as const,url:"data:image/png;base64,"+pixel.toString("base64")};
const chat={type:"supergroup",id:-1001};
const now=Math.floor(Date.now()/1000);
const owner=7, sender=12, bot=5, topic=0;
const photo=[{file_id:"synthetic",file_size:pixel.length}];
const member={id:sender,first_name:"Арсений Александрович"};
const mention=[{type:"mention",offset:0,length:4}];

function fixture(isolated=false, includeTopicContext=true) {
  const rows=new Map<string,unknown>();
  const store={
    get:<T>(key:string)=>structuredClone(rows.get(key)) as T,
    put:(key:string,value:unknown)=>{rows.set(key,structuredClone(value));},
    del:(key:string)=>{rows.delete(key);},
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix))
      .map(([key,value])=>({key,value:structuredClone(value) as T})),
    atomic:(fn:()=>void)=>fn(),
  };
  const policy={chatId:chat.id,topicId:topic,threadId:"group-thread",botId:bot,botUsername:"bot",ownerOnly:true,
    allowedSenderIds:[],requireMention:true,includeTopicContext,isolated,ownerId:owner,revision:"one",
    acceptAfterSecond:now-7200,projectId:"group"};
  const policyKey=`group:policy:${chat.id}:${topic}`;
  store.put(policyKey,policy);
  store.put("group:thread:group-thread",policyKey);
  store.put("group:project:group",true);
  let next=0;
  const post=(body:object)=>acceptGroupUpdate(store,{update_id:++next,message:{
    message_id:100+next,date:now,chat,from:{id:owner},...body,
  }},owner,bot);
  const botReply={message_id:99,chat,from:{id:bot,is_bot:true}};
  const turns:any[]=[];
  const messages:string[]=[];
  const sdk={threads:{get:async()=>({id:"group-thread",projectId:"group",visibility:"visible",providerId:"codex"}),
    events:{list:async()=>[]},send:async(q:any)=>{turns.push(q);}}};
  return {store,post,policy,policyKey,sdk,turns,messages,botReply,
    tick:async(receive?:Parameters<typeof processGroupInputs>[8])=>processGroupInputs(store,sdk as any,owner,bot,
      ()=>async <T>(_method:string,body:Record<string,unknown>)=>{
        messages.push(String(body.text));return {message_id:999} as T;
      },new AbortController().signal,undefined,undefined,receive)};
}

const ownerRequest={text:"@bot ответь Арсению\n\nПодключусь, если потребуется",entities:mention};
const participantPhoto=(reply:object,extra:object={})=>({
  from:member,photo,caption:"Не вижу",reply_to_message:reply,date:now-360,...extra,
});

test("owner-only: a named participant's six-minute-old photo arrives as native image bytes",async()=>{
  const f=fixture();
  assert.ok(f.post(participantPhoto(f.botReply)));
  await f.tick();
  assert.equal(f.turns.length,0);
  assert.ok(f.post(ownerRequest));
  assert.deepEqual(f.store.list<{route:{examples?:{fileId:string}[]}}>("group:in:")[0]
    .value.route.examples?.map(file=>file.fileId),["synthetic"]);
  const {downloadGroupImage}=await import("../adapters");
  const received:string[]=[];
  await f.tick(async file=>{
    received.push(file.fileId);
    return downloadGroupImage(async()=>"synthetic-token",{file_path:"photos/fixture.png",file_size:pixel.length},
      file.size,new AbortController().signal,async()=>new Response(new Uint8Array(pixel)));
  });
  assert.deepEqual(received,["synthetic"]);
  assert.equal(f.turns.length,1);
  assert.deepEqual(f.turns[0].input.filter((part:any)=>part.type==="image"),[expectedImage]);
  assert.match(f.turns[0].input[0].text,/Не вижу/);
  assert.doesNotMatch(f.turns[0].input[0].text,/synthetic|base64|\/inbox/);
  assert.deepEqual(f.messages,[]);
});

test("explicit reply to an original participant photo selects it even without a recent-media record",async()=>{
  const f=fixture();
  assert.ok(f.post({...ownerRequest,reply_to_message:{chat,message_id:90,date:now-600,from:member,photo}}));
  await f.tick(async file=>{
    assert.equal(file.messageId,90); return expectedImage;
  });
  assert.deepEqual(f.turns[0].input[1],expectedImage);
});

test("an addressed message carries its own image with topic context disabled",async()=>{
  const f=fixture(false,false);
  f.post({caption:"@bot посмотри",caption_entities:mention,photo});
  await f.tick(async()=>expectedImage);
  assert.deepEqual(f.turns[0].input[1],expectedImage);
});

test("ambiguous participant photos request a precise reply without downloading media or starting a turn",async()=>{
  for (const secondAuthor of [member,{...member,id:13}]) {
    const f=fixture();
    assert.ok(f.post(participantPhoto(f.botReply)));
    assert.ok(f.post(participantPhoto(f.botReply,{from:secondAuthor,photo:[{file_id:"other"}]})));
    assert.ok(f.post(ownerRequest));
    await f.tick(async()=>{assert.fail("unexpected download");});
    assert.equal(f.turns.length,0);
    assert.match(f.messages[0],/Ответьте на нужное фото/);
  }
});

test("passive photos respect time, context, source and binding boundaries",async()=>{
  const cases=[
    {extra:{date:now-601}},
    {extra:{reply_to_message:{...fixture().botReply,message_thread_id:4}}},
    {extra:{reply_to_message:{...fixture().botReply,from:{id:20,is_bot:true}}}},
    {extra:{forward_origin:{type:"user"}}},
    {extra:{sender_chat:chat}},
    {extra:{chat:{...chat,id:-1002}}},
    {extra:{message_thread_id:4}},
    {extra:{},reset:true},
    {extra:{},context:false},
    {extra:{},differentParticipant:true},
  ];
  for (const row of cases) {
    const f=fixture(false,row.context!==false);
    f.post(participantPhoto(f.botReply,row.extra));
    if (row.reset) f.store.put(f.policyKey,{...f.policy,revision:"two"});
    f.post(row.differentParticipant ? {...ownerRequest,text:"@bot ответь Петру"} : ownerRequest);
    await f.tick(async()=>{assert.fail("unexpected download");});
    assert.equal(f.turns.length,1);
    assert.ok(f.turns[0].input.every((part:any)=>part.type==="text"));
  }
});

test("explicit replies do not grant rights or pull cross-scope, forwarded or pre-binding media",async()=>{
  for (const extra of [{message_thread_id:4},{chat:{...chat,id:-1002}},
    {from:{id:5,is_bot:true}},{date:now-8000},{forward_origin:{type:"user"}},{sender_chat:chat}]) {
    const f=fixture();
    const reply={chat,message_id:90,date:now,from:member,photo,...extra};
    f.post({...ownerRequest,from:member,reply_to_message:reply});
    assert.equal(f.store.list("group:in:").length,0);
    f.post({...ownerRequest,reply_to_message:reply});
    await f.tick(async()=>{assert.fail("unexpected download");});
    assert.equal(f.turns.length,1);
    assert.ok(f.turns[0].input.every((part:any)=>part.type==="text"));
  }
});

test("owner-only: uses only still-visible media and keeps Telegram file IDs out of the text archive",async()=>{
  const {contextMediaPrefix}=await import("../ingress");
  const f=fixture();
  f.store.put(f.policyKey,{...f.policy,searchableHistory:true,retainFullHistory:true});
  f.post(participantPhoto(f.botReply));
  assert.equal(f.store.list(contextMediaPrefix(bot,chat.id,topic)).length,1);
  assert.doesNotMatch(JSON.stringify(f.store.list("group:history:")),/synthetic/);
  for (let i=0;i<24;i++) f.post({text:"Another topic message",from:{id:20}});
  assert.equal(f.store.list(contextMediaPrefix(bot,chat.id,topic)).length,0);
});

test("isolated: uses the dedicated executor and includes verified bytes in its native BB turn",async()=>{
  const f=fixture(true);
  const dir=await mkdtemp(join(tmpdir(),"synthetic-isolated-media-"));
  const launcher=join(dir,"cli");
  const log=join(dir,"request.json");
  const saved=process.env.BB_TELEGRAM_GROUP_EXECUTORS;
  try {
    await writeFile(launcher,'#!/bin/sh\ncase "$5" in\nsubmitIsolatedGroup) cp "$7" '+JSON.stringify(log)+'; echo \'{"state":"accepted"}\';;\nreadIsolatedGroup) echo \'{"state":"waiting"}\';;\n*) exit 1;;\nesac\n');
    await chmod(launcher,0o700);
    process.env.BB_TELEGRAM_GROUP_EXECUTORS=JSON.stringify({[chat.id+":"+topic]:{
      projectId:"group",threadId:"group-thread",cli:launcher,
    }});
    f.post(participantPhoto(f.botReply));
    f.post(ownerRequest);
    await f.tick(async()=>expectedImage);
    assert.equal(f.turns.length,0);
    const {isolatedGroupInput,submitIsolatedGroup}=await import("../isolated-group");
    const args=isolatedGroupInput.parse(JSON.parse(await readFile(log,"utf8")));
    assert.deepEqual(args.attachments,[expectedImage]);
    assert.deepEqual(await submitIsolatedGroup(f.sdk as any,f.store,"group",args),{state:"accepted"});
    assert.deepEqual(f.turns[0].input[1],expectedImage);
    assert.deepEqual(await submitIsolatedGroup(f.sdk as any,f.store,"group",args),{state:"accepted"});
    assert.equal(f.turns.length,1);
    assert.deepEqual(f.messages,[]);
  } finally {
    if (saved===undefined) delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    else process.env.BB_TELEGRAM_GROUP_EXECUTORS=saved;
    await rm(dir,{force:true,recursive:true});
  }
});

test("cloud getFile streams bounded image bytes with no token or URL in the attachment",async()=>{
  const {downloadGroupImage}=await import("../adapters");
  const signal=new AbortController().signal;
  const token=async()=>"synthetic-token";
  const file={file_path:"photos/file_123.png",file_size:pixel.length};
  let called=0;
  const request:typeof fetch=async (url,opts)=>{
    called++;
    assert.equal(url,"https://api.telegram.org/file/botsynthetic-token/photos/file_123.png");
    assert.equal(opts?.redirect,"error");
    return new Response(new Uint8Array(pixel));
  };
  assert.deepEqual(await downloadGroupImage(token,file,pixel.length,signal,request),expectedImage);
  await assert.rejects(downloadGroupImage(token,{...file,file_path:"/../unsafe"},pixel.length,signal,request),/invalid_image/);
  await assert.rejects(downloadGroupImage(token,file,pixel.length-1,signal,request),/invalid_image/);
  await assert.rejects(downloadGroupImage(token,{...file,file_size:pixel.length+1},0,signal,request),/size_mismatch/);
  assert.equal(called,2);
});
