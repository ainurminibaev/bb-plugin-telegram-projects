import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {bindGroupTopic} from "../group-worker";
import {historyPrefix} from "../topic-search";
import {topicHasWork, topicStateKey} from "../topic-lifecycle";
import {TelegramFailure, type Store} from "../model";
import {handleOwnerGroupPost, ownerGroupPostInput, previewOwnerGroupPost} from "../owner-group-post";

const owner = 71, bot = 51, chat = -424242;
const destination = "Рабочая группа";
const privateThread = "owner", groupThread = "work", projectId = "source";
const groupRevision = "bound", routeToken = randomUUID();
const ownerGrant = {owner,bot,destination,privateThread,groupThread,groupRevision};
const target = {threadId:privateThread,projectId,signal:new AbortController().signal};
const scheduledText = "Запланированный тестовый отчёт.";
const permit = {inputSha256:createHash("sha256").update(scheduledText).digest("hex"),trigger:"schedule" as const,automationId:"auto_test",runId:"run_test",nonce:randomUUID(),
  threadId:privateThread,projectId,scheduledFor:1795417200000};
const scheduler = {kind:"plugin",pluginId:"automations"};
const validReply = {messageId:12,author:"Участник",excerpt:"Реплика для ответа."};
const ownerInput = {routeToken,destination,text:"Подтверждённый ответ.",reply:validReply};
const archiveKey = historyPrefix(chat,0) + validReply.messageId;

function fixture(topicId = 0) {
  const state = new Map<string,unknown>();
  const store: Store = {
    get:<T>(key:string)=>structuredClone(state.get(key)) as T|undefined,
    put:(key,value)=>{state.set(key,structuredClone(value));},
    del:key=>{state.delete(key);},
    list:<T>(prefix:string)=>[...state].filter(([key])=>key.startsWith(prefix))
      .map(([key,value])=>({key,value:structuredClone(value) as T})),
    atomic:fn=>fn(),
  };
  bindGroupTopic(store,{chatId:chat,topicId,threadId:groupThread,revision:groupRevision,
    ownerOnly:true,requireMention:true,ownerId:owner,botId:bot,botUsername:"test",
    includeTopicContext:true,searchableHistory:true},"work-project");
  store.put(historyPrefix(chat,topicId) + validReply.messageId,{id:validReply.messageId,sender:45,name:validReply.author,text:validReply.excerpt});
  const writes: {chatId:number; method:string; body:Record<string,any>}[] = [];
  const behavior = {reject:false, lost:false, wrongReceipt:false, allow:true,
    onGroupSend:undefined as (()=>Promise<void>) | undefined};
  const adapter = {
    store,
    async current() {return {owner,bot};},
    transport:(chatId:number)=>async <T>(method:string,body:Record<string,any>):Promise<T>=>{
      writes.push({chatId,method,body});
      if (chatId === chat) await behavior.onGroupSend?.();
      if (chatId === chat && behavior.lost) throw new TelegramFailure("telegram_network",30,true);
      if (chatId === chat && behavior.reject) throw new TelegramFailure("telegram_400");
      return {chat:{id:behavior.wrongReceipt && chatId === chat ? -1 : chatId},message_id:42,
        message_thread_id:body.message_thread_id,
        reply_to_message:body.reply_parameters,
        document:body.document && {file_size:body.document.size,file_name:body.document_filename},
        photo:body.photo && [{file_id:"synthetic-photo"}]} as T;
    },
  };
  const ownerRoute = {
    ...adapter,
    grants:()=>behavior.allow ? [ownerGrant] : [],
    async privateRequest(threadId:string,token:string) {
      if (threadId !== privateThread || token !== routeToken) throw Error("current_owner_request_required");
      return {text:"Ответь в рабочей группе."};
    },
    async checkThread() {return true;},
    exactReplies:(prefix:string)=>store.list<{id:number;sender:number;name:string;text:string}>(prefix).map(row=>row.value),
  };
  const callback = (sender = owner) => ({
    callback_query:{id:"callback",data:writes[0].body.reply_markup.inline_keyboard[0][0].callback_data,
      from:{id:sender},message:{from:{id:bot},chat:{id:owner,type:"private"},message_id:42}},
  });
  return {store,adapter,writes,behavior,ownerRoute,callback};
}

test("private request stages text and exact reply, with one send after the paired owner approves",async()=>{
  const f=fixture();
  assert.deepEqual(await previewOwnerGroupPost(f.ownerRoute,privateThread,ownerInput),{state:"awaiting"});
  await previewOwnerGroupPost(f.ownerRoute,privateThread,ownerInput);
  await handleOwnerGroupPost(f.ownerRoute,f.callback(999),owner,bot);
  assert.equal(f.writes.length,1);
  await Promise.all([
    handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot),
    handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot),
  ]);
  await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
  const posts=f.writes.filter(w=>w.chatId===chat);
  assert.deepEqual(posts.map(w=>w.body),[{
    chat_id:chat,text:ownerInput.text,reply_parameters:{message_id:validReply.messageId,allow_sending_without_reply:false},
    link_preview_options:{is_disabled:true},
  }]);
  assert.match(f.writes.at(-1)!.body.text,/№42/);
});

test("empty confirmation preserves the draft and sends nothing to the group",async()=>{
  const f=fixture();
  assert.equal(ownerGroupPostInput.safeParse({...ownerInput,text:"   "}).success,false);
  await previewOwnerGroupPost(f.ownerRoute,privateThread,ownerInput);
  for (const data of [undefined,"","outpost:"]) {
    const event=f.callback();
    await handleOwnerGroupPost(f.ownerRoute,{callback_query:{...event.callback_query,data}},owner,bot);
  }
  assert.equal(f.writes.filter(w=>w.chatId===chat).length,0);
  await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
  assert.equal(f.writes.filter(w=>w.chatId===chat).length,1);
});

test("group, stale authorization, arbitrary destination fields, ambiguity and reply mismatch stop before preview",async()=>{
  const f=fixture();
  const run=(input=ownerInput,thread=privateThread)=>previewOwnerGroupPost(f.ownerRoute,thread,input);
  assert.equal(ownerGroupPostInput.safeParse({...ownerInput,chatId:chat}).success,false);
  await assert.rejects(run(ownerInput,groupThread),/current_owner_request_required/);
  await assert.rejects(run({...ownerInput,routeToken:randomUUID()}),/current_owner_request_required/);
  await assert.rejects(run({...ownerInput,destination:"Чужая группа"}),/outbound_destination/);
  await assert.rejects(previewOwnerGroupPost({...f.ownerRoute,grants:()=>[ownerGrant,ownerGrant]},
    privateThread,ownerInput),/outbound_destination/);
  await assert.rejects(run({...ownerInput,reply:{...validReply,messageId:13}}),/outbound_reply_unverified/);
  await assert.rejects(run({...ownerInput,reply:{...validReply,author:"Другой"}}),/outbound_reply_unverified/);
  await assert.rejects(run({...ownerInput,reply:{...validReply,excerpt:"Другой текст"}}),/outbound_reply_unverified/);
  assert.equal(f.writes.length,0);
});

test("an exact author and excerpt can identify a reply without a message ID only when unique",async()=>{
  const f=fixture();
  const input={...ownerInput,reply:{author:validReply.author,excerpt:validReply.excerpt}};
  const first=f.store.get<object>(archiveKey);
  const second=historyPrefix(chat,0) + "13";
  f.store.put(second,{...first,id:13});
  await assert.rejects(previewOwnerGroupPost(f.ownerRoute,privateThread,input),/outbound_reply_unverified_or_ambiguous/);
  assert.equal(f.writes.length,0);
  f.store.del(second);
  await previewOwnerGroupPost(f.ownerRoute,privateThread,input);
  await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
  assert.equal(f.writes.find(w=>w.chatId===chat)?.body.reply_parameters.message_id,12);
});

test("a revoked grant, rebound destination or edited reply stops a confirmed private draft",async()=>{
  for (const change of ["grant","binding","reply"]) {
    const f=fixture();
    await previewOwnerGroupPost(f.ownerRoute,privateThread,ownerInput);
    if (change==="grant") f.behavior.allow=false;
    if (change==="binding") f.store.del("group:thread:" + groupThread);
    if (change==="reply") f.store.put(archiveKey,{id:validReply.messageId,sender:46,name:validReply.author,text:validReply.excerpt});
    await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
    assert.equal(f.writes.filter(w=>w.chatId===chat).length,0);
    assert.match(f.writes.at(-1)!.body.text,/не отправлено/);
  }
});

test("closing a forum topic invalidates a private draft and reopening permits a new draft",async()=>{
  const topicId=3;
  const closed=fixture(topicId);
  const key=topicStateKey(bot,chat,topicId);
  await previewOwnerGroupPost(closed.ownerRoute,privateThread,ownerInput);
  closed.store.put(key,"closed");
  await handleOwnerGroupPost(closed.ownerRoute,closed.callback(),owner,bot);
  assert.equal(closed.writes.filter(w=>w.chatId===chat).length,0);

  const reopened=fixture(topicId);
  reopened.store.put(key,"closed");
  await assert.rejects(previewOwnerGroupPost(reopened.ownerRoute,privateThread,ownerInput),/outbound_binding_revoked/);
  reopened.store.put(key,"open");
  await previewOwnerGroupPost(reopened.ownerRoute,privateThread,ownerInput);
  await handleOwnerGroupPost(reopened.ownerRoute,reopened.callback(),owner,bot);
  assert.equal(reopened.writes.find(w=>w.chatId===chat)?.body.message_thread_id,topicId);
});

test("owner attachment needs its grant and exact bytes from the confirmation card",async(t)=>{
  const f=fixture();
  const directory=mkdtempSync(join(tmpdir(),"confirmed-outbound-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,"report.html");
  writeFileSync(path,"four");
  const input={...ownerInput,artifact:{path}};
  await assert.rejects(previewOwnerGroupPost(f.ownerRoute,privateThread,input),/outbound_file_not_granted/);
  const route={...f.ownerRoute,grants:()=>[{...ownerGrant,directory,maxBytes:4}]};
  await previewOwnerGroupPost(route,privateThread,input);
  writeFileSync(path,"five");
  await handleOwnerGroupPost(route,f.callback(),owner,bot);
  assert.equal(f.writes.filter(w=>w.chatId===chat).length,0);
});

