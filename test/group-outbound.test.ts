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
import {publishScheduledReport, registerSchedulePermit, schedulePermit} from "../scheduled-group-report";

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

test("ambiguous owner send and missing receipt never trigger another group send",async()=>{
  for (const fault of ["lost","wrongReceipt","reject"] as const) {
    const f=fixture();
    await previewOwnerGroupPost(f.ownerRoute,privateThread,{...ownerInput,reply:undefined});
    f.behavior[fault]=true;
    await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
    await handleOwnerGroupPost(f.ownerRoute,f.callback(),owner,bot);
    assert.equal(f.writes.filter(w=>w.chatId===chat).length,1);
    assert.match(f.writes.at(-1)!.body.text,fault === "reject" ? /отклонил/ : /не подтверждена/);
  }
});

function reportFixture(t:any, topicId=0) {
  const f=fixture(topicId);
  const directory=mkdtempSync(join(tmpdir(),"report-outbound-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const zip=join(directory,"report.zip");
  // ZIP with one synthetic report.pdf. The audit verifies PDF coverage before publication.
  writeFileSync(zip,Buffer.from("UEsDBBQAAAAAADWDdV2AddP/EgAAABIAAAAKAAAAcmVwb3J0LnBkZiVQREYtMS40CnN5bnRoZXRpY1BLAQIUAxQAAAAAADWDdV2AddP/EgAAABIAAAAKAAAAAAAAAAAAAACAAQAAAAByZXBvcnQucGRmUEsFBgAAAAABAAEAOAAAADoAAAAAAA==","base64"));
  const input={zip,summary:"Краткая сводка и ссылка https://example.com/pull/1"};
  const reportGrant={...target,groupThread,groupRevision,owner,bot,directory,automationId:permit.automationId,maxBytes:300};
  const scope={kind:"turn",turnId:"turn"};
  const requested={type:"client/turn/requested",seq:1,scope,data:{originPluginId:"automations",target:{kind:"new-turn"},requestId:"request",
    input:[{type:"text",visibility:"visible",text:scheduledText},{type:"text",visibility:"agent-only",text:`[bb-scheduled-group-report:${permit.nonce}]`}]}};
  const accepted={type:"turn/input/accepted",seq:2,scope,data:{clientRequestId:"request"}};
  const events:any[]=[accepted,requested];
  const report = {
    ...f.adapter,
    grants:()=>f.behavior.allow ? [reportGrant] : [],
    threads:{
      events:{list:async ()=>events},
      get:async ()=>({projectId:"work-project",deletedAt:null,archivedAt:null}),
    } as any,
  };
  return {...f,directory,input,report,events,requested,accepted};
}

test("schedule bridge sends one ZIP with its summary and keeps the confirmed receipt",async(t)=>{
  const f=reportFixture(t);
  await registerSchedulePermit(f.report,permit,scheduler);
  const [receiptA,receiptB]=await Promise.all([
    publishScheduledReport(f.report,target,f.input),publishScheduledReport(f.report,target,f.input),
  ]);
  assert.ok([receiptA.state,receiptB.state].includes("sent"));
  const receipt=await publishScheduledReport(f.report,target,f.input);
  assert.equal(receipt.state,"sent");
  assert.equal(receipt.messageId,42);
  assert.match(receipt.sha256!,/^[0-9a-f]{64}$/);
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].body.document.type,"application/octet-stream");
  assert.equal(f.writes[0].body.caption,f.input.summary);
});

test("forged, ordinary, manual, different-thread and steered runs lack publication authority",async(t)=>{
  const f=reportFixture(t);
  const send=()=>publishScheduledReport(f.report,target,f.input);
  await assert.rejects(send(),/report_schedule_unverified/);
  await assert.rejects(registerSchedulePermit(f.report,permit,{kind:"client"}),/report_scheduler_required/);
  assert.equal(schedulePermit.safeParse({...permit,trigger:"manual"}).success,false);
  await registerSchedulePermit(f.report,permit,scheduler);
  await assert.rejects(publishScheduledReport(f.report,{...target,threadId:groupThread},f.input),/report_schedule_unverified/);
  f.requested.data.originPluginId="other";
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.originPluginId="automations";
  f.requested.data.input[1].visibility="visible";
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.input[1].visibility="agent-only";
  f.requested.data.input[0].text="Чужой текст в том же запросе.";
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.input[0].text=scheduledText;
  f.requested.data.input.push({type:"text",visibility:"visible",text:"Дополнительный ввод."});
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.input.pop();
  f.requested.data.target.kind="existing-turn";
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.target.kind="new-turn";
  const permitMarker=f.requested.data.input[1].text;
  f.requested.data.input[1].text="[bb-scheduled-group-report:]";
  await assert.rejects(send(),/report_schedule_unverified/);
  f.requested.data.input[1].text=permitMarker;
  f.events.unshift({...f.accepted,seq:3});
  await assert.rejects(send(),/report_schedule_unverified/);
  f.events.shift();
  f.events.unshift({type:"turn/completed",scope:f.accepted.scope,seq:3});
  await assert.rejects(send(),/report_schedule_unverified/);
  assert.equal(f.writes.length,0);
});

test("schedule validates approved path and size, binding revision and grant revocation",async(t)=>{
  const f=reportFixture(t);
  await registerSchedulePermit(f.report,permit,scheduler);
  const link=join(f.directory,"alias.zip");
  symlinkSync(f.input.zip,link);
  await assert.rejects(publishScheduledReport(f.report,target,{...f.input,zip:link}),/report_zip_outside_output/);
  await assert.rejects(publishScheduledReport(f.report,target,{...f.input,zip:join(f.directory,"missing.zip")}),/report_zip_unreadable/);
  writeFileSync(f.input.zip,Buffer.from("PK\x03\x04truncated archive"));
  await assert.rejects(publishScheduledReport(f.report,target,f.input),/report_zip_must_contain_pdf_reports/);
  writeFileSync(f.input.zip,Buffer.alloc(301));
  await assert.rejects(publishScheduledReport(f.report,target,f.input),/report_zip_size_or_type/);
  f.behavior.allow=false;
  await assert.rejects(publishScheduledReport(f.report,target,f.input),/report_destination_unavailable/);
  f.behavior.allow=true;
  const key=`group:policy:${chat}:0`;
  f.store.put(key,{...f.store.get<object>(key),revision:"replacement",topicId:7});
  await assert.rejects(publishScheduledReport(f.report,target,f.input),/report_binding_revoked/);
  assert.equal(f.writes.length,0);
});

test("an uncertain scheduled send stays blocked for the same release even with a different run ID",async(t)=>{
  const f=reportFixture(t);
  await registerSchedulePermit(f.report,permit,scheduler);
  f.behavior.lost=true;
  const first=await publishScheduledReport(f.report,target,f.input);
  assert.equal(first.state,"unknown");
  f.behavior.lost=false;
  const retry={...permit,nonce:randomUUID(),runId:"another_run"};
  await registerSchedulePermit(f.report,retry,scheduler);
  f.requested.data.input[1].text=`[bb-scheduled-group-report:${retry.nonce}]`;
  assert.deepEqual(await publishScheduledReport(f.report,target,f.input),first);
  assert.equal(f.writes.length,1);
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

test("a scheduled permit cannot send in a closed or mutating topic and can send after reopen",async(t)=>{
  const topicId=3;
  const f=reportFixture(t,topicId);
  const key=topicStateKey(bot,chat,topicId);
  await registerSchedulePermit(f.report,permit,scheduler);
  for (const state of ["closed","working","uncertain","deleted"]) {
    f.store.put(key,state);
    await assert.rejects(publishScheduledReport(f.report,target,f.input),/report_binding_revoked/);
  }
  assert.equal(f.writes.length,0);
  f.store.put(key,"open");
  assert.equal((await publishScheduledReport(f.report,target,f.input)).state,"sent");
  assert.equal(f.writes[0].body.message_thread_id,topicId);
});

test("both outbound requests keep a forum topic busy until their transport settles",async(t)=>{
  const topicId=3;
  const privatePost=fixture(topicId);
  const report=reportFixture(t,topicId);
  await previewOwnerGroupPost(privatePost.ownerRoute,privateThread,ownerInput);
  await registerSchedulePermit(report.report,permit,scheduler);

  for (const [f,send] of [
    [privatePost,()=>handleOwnerGroupPost(privatePost.ownerRoute,privatePost.callback(),owner,bot)],
    [report,()=>publishScheduledReport(report.report,target,report.input)],
  ] as const) {
    const started=Promise.withResolvers<void>();
    const unblock=Promise.withResolvers<void>();
    f.behavior.onGroupSend=()=>{
      started.resolve();
      return unblock.promise;
    };
    f.behavior.lost=true;
    const pending=send();
    await started.promise;
    try {
      assert.equal(topicHasWork(f.store,bot,chat,topicId),true);
      assert.equal(topicHasWork(f.store,bot,chat,topicId+1),false);
    } finally {
      unblock.resolve();
      await pending;
    }
    assert.equal(topicHasWork(f.store,bot,chat,topicId),false);
  }
});

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgqGf4DwACgQF/Y85xKgAAAABJRU5ErkJggg==","base64");

for (const kind of ["document","photo"] as const) {
  for (const text of [undefined,"Сопроводительный текст <без разметки>"]) {
    test(`private and scheduled ${kind} ${text===undefined ? "without" : "with"} caption preserve one upload`,async(t)=>{
      const directory=mkdtempSync(join(tmpdir(),"ordinary-outbound-"));
      t.after(()=>rmSync(directory,{recursive:true,force:true}));
      const name=kind==="photo" ? "image.png" : "report.html";
      const bytes=kind==="photo" ? png : Buffer.from("<p>Opaque attachment</p>");
      const path=join(directory,name);
      writeFileSync(path,bytes);
      const artifact={path,kind};
      const ownerSide=fixture(3);
      const route={...ownerSide.ownerRoute,grants:()=>[{...ownerGrant,directory,maxBytes:1024}]};
      await previewOwnerGroupPost(route,privateThread,{...ownerInput,text,artifact});
      assert.match(ownerSide.writes[0].body.text,new RegExp(name));
      await handleOwnerGroupPost(route,ownerSide.callback(),owner,bot);
      await handleOwnerGroupPost(route,ownerSide.callback(),owner,bot);
      const groupCalls=ownerSide.writes.filter(w=>w.chatId===chat);
      assert.equal(groupCalls.length,1);
      assert.deepEqual(groupCalls[0].body.reply_parameters,{message_id:validReply.messageId,allow_sending_without_reply:false});
      assert.equal(groupCalls[0].body.message_thread_id,3);
      const scheduled=reportFixture(t,3);
      const source={...scheduled.report,grants:()=>scheduled.report.grants().map(g=>({...g,directory,maxBytes:1024}))};
      await registerSchedulePermit(source,permit,scheduler);
      const first=await publishScheduledReport(source,target,{artifact,text});
      assert.equal(first.state,"sent");
      assert.deepEqual(await publishScheduledReport(source,target,{artifact,text}),first);
      assert.equal(scheduled.writes.length,1);
      for (const w of [groupCalls[0],scheduled.writes[0]]) {
        assert.equal(w.method,kind==="photo" ? "sendPhoto" : "sendDocument");
        assert.equal(w.body[kind+"_filename"],name);
        assert.equal(w.body.caption,text);
        assert.equal(Object.hasOwn(w.body,"caption"),text!==undefined);
        const body=w.body[kind] as Blob;
        assert.equal(body.type,kind==="photo" ? "image/png" : "application/octet-stream");
        assert.deepEqual(Buffer.from(await body.arrayBuffer()),bytes);
      }
    });
  }
}

test("scheduled text uses one message and an ordinary ZIP, WAV or EXE uses the document transport",async(t)=>{
  const text=reportFixture(t,3);
  await registerSchedulePermit(text.report,permit,scheduler);
  assert.equal((await publishScheduledReport(text.report,target,{text:"Plain report"})).state,"sent");
  assert.deepEqual(text.writes[0].body,{chat_id:chat,message_thread_id:3,text:"Plain report",link_preview_options:{is_disabled:true}});
  for (const name of ["opaque.zip","neutral.wav","neutral.exe","keep.png","empty.bin"]) {
    const f=reportFixture(t);
    const path=join(f.directory,name);
    const bytes=name.endsWith(".png") ? png : Buffer.from(name==="empty.bin" ? "" : "Synthetic opaque bytes");
    writeFileSync(path,bytes);
    await registerSchedulePermit(f.report,permit,scheduler);
    assert.equal((await publishScheduledReport(f.report,target,{artifact:{path}})).state,"sent");
    const [{method,body}]=f.writes;
    assert.equal(method,"sendDocument");
    assert.equal(body.document_filename,name);
    assert.deepEqual(Buffer.from(await body.document.arrayBuffer()),bytes);
  }
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

test("invalid photo, unsafe name, oversized caption and unknown marker fail closed",async(t)=>{
  const f=reportFixture(t);
  const html=join(f.directory,"report.html");
  const name=join(f.directory,"unsafe\nname.html");
  writeFileSync(html,"Synthetic opaque bytes");
  writeFileSync(name,"Synthetic opaque bytes");
  await registerSchedulePermit(f.report,permit,scheduler);
  await assert.rejects(publishScheduledReport(f.report,target,{artifact:{path:html,kind:"photo"}}),/outbound_file_invalid_photo/);
  await assert.rejects(publishScheduledReport(f.report,target,{artifact:{path:name}}),/outbound_file_unsafe_name/);
  await assert.rejects(publishScheduledReport(f.report,target,{artifact:{path:html},text:"a".repeat(1025)}),/outbound_content_invalid/);
  await assert.rejects(publishScheduledReport(f.report,target,{text:"[bb-scheduled-group-report:internal]"}),/report_private_metadata/);
  assert.equal(f.writes.length,0);
});
