import test from "node:test";
import assert from "node:assert/strict";
import {recoverMention} from "../mention-recovery";
import {acceptGroupUpdate,type GroupTopicPolicy} from "../ingress";
import type {Store} from "../model";

const source={chatId:-10045,topicId:4,messageId:81};
const bot=52,owner=77,sender=125;
const text="Предложи варианты, @demo_bot пожалуйста";
const bindingKey="group:policy:-10045:4";
const historyKey="group:history:-10045:4:81";
function fixture() {
  const rows=new Map<string,unknown>();
  const store:Store={get:<T>(k:string)=>rows.get(k) as T,put:(k,v)=>{rows.set(k,v)},del:k=>{rows.delete(k)},
    list:<T>(p:string)=>Array.from(rows).filter(([k])=>k.startsWith(p)).map(([key,v])=>({key,value:v as T})),
    atomic:f=>f()};
  const policy:GroupTopicPolicy={...source,projectId:"p",threadId:"t",ownerId:owner,ownerOnly:true,requireMention:true,
    isolated:false,revision:"old",botId:bot,botUsername:"demo_bot",includeTopicContext:true,searchableHistory:true};
  store.put(bindingKey,policy);
  store.put("group:thread:t",bindingKey);
  const msg={chat:{id:source.chatId,type:"supergroup"},message_thread_id:4,message_id:81,
    date:Math.floor(Date.now()/1000),from:{id:sender,first_name:"Member"},text,
    entities:[{type:"mention",offset:text.indexOf("@"),length:9}]};
  acceptGroupUpdate(store,{update_id:100,message:msg},owner,bot);
  const run=(action:"select"|"queue"|"discard")=>recoverMention(store,action,owner,bot,source,{projectId:"p",threadId:"t"});
  const allow=()=>store.put(bindingKey,{...policy,isolated:true,ownerOnly:false,revision:"new"});
  return {store,run,allow,msg,policy};
}

test("a real ignored mention remains bound to its original sender, topic and message after migration",()=>{
  const {store,run,allow}=fixture();
  assert.equal(run("select"),"selected");
  assert.throws(()=>run("queue"),/isolated/);
  allow();
  store.del(historyKey);
  assert.equal(run("queue"),"queued");
  assert.equal(run("queue"),"already_handled");
  const jobs=store.list<{route:unknown,revision:string}>("group:in:");
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].value.revision,"new");
  assert.deepEqual(jobs[0].value.route,{kind:"group",...source,threadId:"t",senderId:sender,senderName:"Member",text,updateId:-1});
  assert.equal(store.get("ingress:offset"),101);
});

test("sender revocation, destination mismatch and edits prevent recovery",()=>{
  const {store,run,allow,policy,msg}=fixture();
  run("select");
  store.put(bindingKey,{...policy,isolated:true});
  assert.throws(()=>run("queue"),/permitted/);
  allow();
  assert.throws(()=>recoverMention(store,"queue",owner,bot,source,{projectId:"other",threadId:"t"}),/permitted/);
  acceptGroupUpdate(store,{update_id:101,edited_message:{...msg,text:"updated"}},owner,bot);
  assert.throws(()=>run("queue"),/missing|source_changed/);
  assert.throws(()=>run("select"),/direct_mention/);
});

test("legacy archives require a leading address and review; live receipts suppress duplicates",()=>{
  const {store,run}=fixture();
  const row=store.get<object>(historyKey)!;
  store.put(historyKey,{...row,directMention:undefined,text:"quoted @demo_bot here"});
  assert.throws(()=>run("select"),/direct_mention/);
  store.put(historyKey,{...row,directMention:undefined,text:"@demo_bot\nhello"});
  assert.equal(run("select"),"selected");
  assert.equal(run("discard"),"discarded");
  assert.throws(()=>run("queue"),/missing/);
  store.put("group:receipt:52:14",{...source,state:"sending"});
  assert.equal(run("select"),"already_handled");
});

test("group worker delivers once under the original message and records its actual sender",async t=>{
  const {mkdtemp,writeFile,rm}=await import("node:fs/promises");
  const {join}=await import("node:path");
  const {tmpdir}=await import("node:os");
  const {processGroupInputs}=await import("../group-worker");
  const dir=await mkdtemp(join(tmpdir(),"mention-worker-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const cli=join(dir,"executor");
  await writeFile(cli,`#!/bin/sh
case "$5" in
  submitIsolatedGroup) echo '{"state":"accepted"}';;
  readIsolatedGroup) echo '{"state":"finished","text":"Reply from the group worker"}';;
  *) exit 1;;
esac
`,{mode:0o700});
  const before=process.env.BB_TELEGRAM_GROUP_EXECUTORS;
  t.after(()=>{
    if (before===undefined) delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    else process.env.BB_TELEGRAM_GROUP_EXECUTORS=before;
  });
  process.env.BB_TELEGRAM_GROUP_EXECUTORS=JSON.stringify({"-10045:4":{threadId:"t",projectId:"p",cli}});
  const {store,run,allow}=fixture();
  run("select");allow();run("queue");
  const sent:unknown[]=[];
  const tick=()=>processGroupInputs(store,{} as never,owner,bot,chat=>async<T>(method:string,args?:object)=>{
    sent.push([chat,method,args]);
    return {message_id:93} as T;
  },new AbortController().signal);
  await tick();await tick();
  assert.deepEqual(sent,[[-10045,"sendMessage",{chat_id:-10045,message_thread_id:4,
    reply_parameters:{message_id:81},text:"Reply from the group worker"}]]);
  assert.equal(store.list<{sender:number}>("group:origin:")[0].value.sender,sender);
  assert.equal(store.get<{sentId:number}>("group:receipt:52:-1")?.sentId,93);
  assert.equal(run("queue"),"already_handled");
});

test("member recovery uses only the bound member thread with a current grant",async()=>{
  const {store,policy,run}=fixture();
  const {saveGroupSettings,groupThreadFor,setAccess}=await import("../rights");
  const binding={...policy,memberThreadId:"member-thread"};
  store.put(bindingKey,binding);
  store.put("rights:install-kind","employee");
  store.put("group:thread:member-thread",bindingKey);
  run("select");
  assert.throws(()=>run("queue"),/permitted/);
  saveGroupSettings(store,bot,source.chatId,{who:"all",members:"read",reply:"mention"});
  assert.equal(groupThreadFor(store,binding,owner,owner),"t");
  setAccess(store,bot,[{id:555,name:"authorised"}]);
  assert.equal(groupThreadFor(store,binding,owner,555),"t");
  assert.equal(run("queue"),"queued");
  assert.equal(run("queue"),"already_handled");
  const jobs=store.list<{route:{threadId:string,senderId:number}}>("group:in:");
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].value.route.threadId,"member-thread");
  assert.equal(jobs[0].value.route.senderId,sender);
});
