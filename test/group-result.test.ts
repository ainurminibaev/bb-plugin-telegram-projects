import test from "node:test";
import assert from "node:assert/strict";
import {isDirectOwnerRequest,resolveGroupMessage,inspectGroupTask,deliverGroupResults, queueGroupResult, queueGroupReminder, type GroupOrigin} from "../group-result";
import type {Store, Telegram} from "../model";

function fixture(snapshot?:string) {
  const rows=new Map<string,unknown>(snapshot ? JSON.parse(snapshot) : []);
  const store:Store={get:<T>(k:string)=>rows.get(k) as T,put:(k,v)=>{rows.set(k,v);},
    del:k=>{rows.delete(k);},atomic:f=>f(),list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))};
  const origins: GroupOrigin[]=[-1001,-1002].map((chatId,i)=>({chatId,topicId:7,messageId:42,
    bot:1,owner:2,sender:2,revision:"bound",projectId:"team",threadId:"thread-"+i}));
  if (!snapshot) for (const [i,o] of origins.entries()) {
    const key="group:policy:"+o.chatId+":7";
    store.put("group:origin:"+i,o);
    store.put(key,{...o,ownerId:o.owner,botId:o.bot,ownerOnly:true});
    store.put("group:thread:"+o.threadId,key);
    store.put("group:project:team",true);
  }
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"team",visibility:"visible"})}};
  const sent:Record<string,unknown>[]=[];
  const tick=(transport:Telegram=async<T>(_method:string,payload:Record<string,unknown>)=>{sent.push(payload);return {message_id:90} as T;})=>
    deliverGroupResults(store,sdk as never,()=>true,()=>transport,new AbortController().signal);
  return {store,sent,tick,snapshot:()=>JSON.stringify([...rows]),queue:()=>queueGroupResult(store,2,1,"0","Approved")};
}
test("persisted group return goes only to the original message and replays its receipt",async()=>{
  const before=fixture();
  assert.throws(()=>queueGroupResult(before.store,9,1,"0","Approved"));
  assert.deepEqual(before.queue(),{state:"queued"});
  const {store,sent,tick,queue}=fixture(before.snapshot());
  await tick();
  assert.deepEqual(queue(),{state:"sent",messageId:90});
  await tick();
  assert.deepEqual(sent,[{chat_id:-1001,message_thread_id:7,reply_parameters:{message_id:42,allow_sending_without_reply:false},text:"Approved"}]);
  assert.throws(()=>queueGroupResult(store,2,1,"0","Changed"),/conflict/);
});
test("revocation after queuing suppresses delivery",async()=>{
  const {store,sent,tick,queue}=fixture();
  queue();store.del("group:policy:-1001:7");
  await tick();assert.deepEqual(queue(),{state:"revoked"});assert.equal(sent.length,0);
});
test("restart across an ambiguous Telegram write leaves an unknown outcome",async()=>{
  const before=fixture();
  before.queue();
  let atSend="";
  await before.tick(async()=>{atSend=before.snapshot();throw Error("connection lost");});
  assert.ok(atSend);
  const after=fixture(atSend);
  await after.tick();assert.deepEqual(after.queue(),{state:"unknown"});assert.equal(after.sent.length,0);
});

test("due reminders use the original group and survive restart without duplicate sends",async()=>{
  const f=fixture();
  const args={taskId:"0",text:"Still need the PDF?",dueAt:1,waitingFor:"pdf" as const,threadId:"dm",routeToken:"fixture"};
  assert.equal(queueGroupReminder(f.store,2,1,args).state,"queued");
  const restored=fixture(f.snapshot());
  await restored.tick();await restored.tick();
  assert.equal(restored.sent.length,1);
  assert.deepEqual(queueGroupReminder(restored.store,2,1,args),{state:"sent",messageId:90});
  assert.equal(restored.sent[0].chat_id,-1001);
  assert.equal(restored.sent[0].message_thread_id,7);
});

test("a PDF receipt or a decision cancels only the matching reminder",async()=>{
  for (const waitingFor of ["pdf","decision"] as const) {
    const f=fixture();
    const args={taskId:"0",text:"Reminder",dueAt:1,waitingFor,routeToken:"fixture",threadId:"dm"};
    queueGroupReminder(f.store,2,1,args);
    f.store.put(waitingFor==="pdf"?"group:completed-pdf:0":"group:result:0",waitingFor==="pdf"?91:{text:"Approved",state:"sent",messageId:92});
    await f.tick();
    assert.equal(queueGroupReminder(f.store,2,1,args).state,"cancelled");assert.equal(f.sent.length,0);
  }
});

test("a future reminder waits, and withdrawn access stops a due reminder",async()=>{
  const f=fixture(),args={taskId:"0",text:"Reminder",dueAt:Date.now()+60000,waitingFor:"pdf" as const,routeToken:"fixture",threadId:"dm"};
  queueGroupReminder(f.store,2,1,args);await f.tick();assert.equal(f.sent.length,0);
  const other={...args,taskId:"1",dueAt:1};
  queueGroupReminder(f.store,2,1,other);f.store.del("group:policy:-1002:7");await f.tick();
  assert.equal(queueGroupReminder(f.store,2,1,other).state,"revoked");assert.equal(f.sent.length,0);
});

test("an identical reminder can be retried but its condition, text and deadline cannot change", () => {
  const {store}=fixture();
  const args={taskId:"0",threadId:"dm",routeToken:"fixture",waitingFor:"pdf" as const,text:"PDF pending",dueAt:10};
  assert.throws(()=>queueGroupReminder(store,3,1,args),/group_task_unavailable/);
  assert.deepEqual(queueGroupReminder(store,2,1,args),{state:"queued"});
  assert.deepEqual(queueGroupReminder(store,2,1,args),{state:"queued"});
  for (const change of [{text:"Another message"},{dueAt:11},{waitingFor:"decision" as const}]) {
    assert.throws(()=>queueGroupReminder(store,2,1,{...args,...change}),/group_reminder_conflict/);
  }
  assert.equal(store.list("group:reminder-queue:").length,1);
});

test("paired owner inspects an exact return address without opening a thread or enqueueing work",async()=>{
  const f=fixture();
  const before=f.snapshot();
  assert.deepEqual(inspectGroupTask(f.store,2,1,"0"),{binding:"active",delivery:"unsubmitted"});
  for (const [owner,bot,id] of [[9,1,"0"],[2,9,"0"],[2,1,"missing"]] as const)
    assert.throws(()=>inspectGroupTask(f.store,owner,bot,id),/group_task_unavailable/);
  assert.equal(f.snapshot(),before);
  await f.tick();assert.equal(f.sent.length,0);
  f.queue();await f.tick();
  assert.deepEqual(inspectGroupTask(f.store,2,1,"0"),{binding:"active",delivery:"sent",messageId:90});
  f.store.del("group:policy:-1001:7");
  assert.deepEqual(inspectGroupTask(f.store,2,1,"0"),{binding:"revoked"});
});

test("native owner reminders accept direct BB turns only",()=>{
  const direct={initiator:"user",senderThreadId:null,target:{kind:"new-turn"}};
  assert.ok(isDirectOwnerRequest(direct));
  assert.ok(isDirectOwnerRequest({...direct,systemMessageKind:"unlabeled"}));
  for (const change of [{initiator:"agent"},{initiator:"system"},{senderThreadId:"child"},
    {originPluginId:"telegram-projects"},{systemMessageKind:"child-completed"},
    {retryOfRequestId:"old"},{target:{kind:"steer"}}]) {
    assert.equal(isDirectOwnerRequest({...direct,...change}),false);
  }
});

test("a source-only revocation survives restart and suppresses all queued payloads",async()=>{
  const {mkdtemp,writeFile,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {processGroupInputs}=await import("../group-worker");
  const dir=await mkdtemp(join(tmpdir(),"source-grants-"));
  const file=join(dir,"grants.json");
  const previous=process.env.BB_TELEGRAM_SOURCE_GRANTS;
  process.env.BB_TELEGRAM_SOURCE_GRANTS=file;
  try {
    for(const revoke of [true,false]) {
      const before=fixture();
      const key="group:policy:-1001:7";
      before.store.put(key,{...before.store.get<object>(key),deliverySources:["D"]});
      const text="D: approved https://example.invalid/D";
      const grant={"1:-1001:7":["D"]};
      await writeFile(file,JSON.stringify(grant));
      queueGroupResult(before.store,2,1,"0",text);
      if(revoke) {
        // A second pending path would normally send a PDF followed by text.
        before.store.put("group:in:1:43",{ownerId:2,revision:"bound",state:"ready",
          route:{chatId:-1001,topicId:7,messageId:43,updateId:43,threadId:"thread-0",senderId:2},
          answer:text+" [D.pdf](/tmp/outputs/D.pdf)"});
        await writeFile(file,JSON.stringify({"1:-1002:7":["D"]}));
      }
      const after=fixture(before.snapshot());
      const methods:string[]=[];
      const transport:Telegram=async<T>(method,payload)=>{
        methods.push(method);after.sent.push(payload);return {message_id:90} as T;
      };
      await after.tick(transport);
      await processGroupInputs(after.store,{} as never,2,1,()=>transport,new AbortController().signal);
      const replay=fixture(after.snapshot());
      await replay.tick(transport);
      assert.deepEqual(queueGroupResult(replay.store,2,1,"0",text),revoke?
        {state:"source_unavailable"}:{state:"sent",messageId:90});
      assert.equal(inspectGroupTask(replay.store,2,1,"0").binding,"active");
      assert.deepEqual(methods,revoke?[]:["sendMessage"]);
      if(revoke) assert.equal(replay.store.get<{reason:string}>("group:receipt:1:43")?.reason,"source_unavailable");
      else assert.equal(after.sent[0].text,text);
    }
  } finally {
    if(previous===undefined) delete process.env.BB_TELEGRAM_SOURCE_GRANTS;
    else process.env.BB_TELEGRAM_SOURCE_GRANTS=previous;
    await rm(dir,{recursive:true,force:true});
  }
});

test("private forum links identify only an active original message for this owner and bot",()=>{
  const {store}=fixture();
  for (const [i,chat] of ["1","2"].entries()) {
    store.put(`group:task-message:1:-100${chat}:7:42`,String(i));
    assert.deepEqual(resolveGroupMessage(store,2,1,`https://t.me/c/${chat}/7/42`),{taskId:String(i),projectId:"team"});
  }
  const link="https://t.me/c/1/7/42";
  for (const input of [link+"?x",link.replace("/7/","/8/"),link.replace("/42","/43")])
    assert.throws(()=>resolveGroupMessage(store,2,1,input));
  assert.throws(()=>resolveGroupMessage(store,3,1,link));
  assert.throws(()=>resolveGroupMessage(store,2,3,link));
  store.put("group:task-message:1:-1001:7:43","0");
  assert.throws(()=>resolveGroupMessage(store,2,1,link.replace("/42","/43")));
  store.del("group:policy:-1001:7");
  assert.throws(()=>resolveGroupMessage(store,2,1,link));
});

test("checkpoint reads fresh project state at the deadline, rechecks access and preserves one receipt across restart",async()=>{
  const {createServer}=await import("node:http");
  const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");
  const dir=mkdtempSync("/tmp/bb-cp-"),socket=dir+"/read.sock",cfg=dir+"/adapters",sources=dir+"/sources";
  const mode=process.env.BB_TELEGRAM_CHECKPOINT_ADAPTERS,grants=process.env.BB_TELEGRAM_SOURCE_GRANTS;
  const grant=(yes:boolean)=>writeFileSync(sources,JSON.stringify({"1:-1001:7":yes?["file"]:[]}));
  let file=false,confirmed=false,fail=false,calls=0,revoke=()=>{};
  const server=createServer(async(req,res)=>{
    let json="";for await(const part of req)json+=part;
    const data=JSON.parse(json);calls++;
    assert.equal(req.method,"POST");assert.equal(data.chatId,-1001);assert.equal(data.topicId,7);
    assert.equal(data.messageId,42);assert.equal(data.projectId,"team");assert.equal(data.taskId,"0");
    assert.equal(data.kind,"checkpoint");revoke();
    res.writeHead(fail?503:200);res.end(JSON.stringify(confirmed?{kind:"complete"}:{kind:"reply",text:file?"Олег, подтвердите файл":"Лена, приложите файл"}));
  });
  await new Promise<void>(r=>server.listen(socket,r));
  const now=Date.now;let clock=now();
  try {
    Date.now=()=>clock;
    process.env.BB_TELEGRAM_CHECKPOINT_ADAPTERS=cfg;process.env.BB_TELEGRAM_SOURCE_GRANTS=sources;
    writeFileSync(cfg,JSON.stringify({team:{socket,sources:["file"]}}));grant(true);
    for(const scenario of ["missing","present","confirmed","read-error","revoked","binding-revoked"]){
      const before=fixture(),args={taskId:"0",dueAt:clock+500,waitingFor:"checkpoint" as const};
      file=false;confirmed=false;fail=false;revoke=()=>{};grant(true);
      queueGroupReminder(before.store,2,1,args);
      const count=calls;await before.tick();assert.equal(calls,count);
      const f=fixture(before.snapshot());clock+=501;
      file=scenario!=="missing";confirmed=scenario==="confirmed";
      if(scenario==="revoked") revoke=()=>grant(false);
      if(scenario==="binding-revoked") revoke=()=>f.store.del("group:policy:-1001:7");
      if(scenario==="read-error"){
        fail=true;await f.tick();await f.tick();
        assert.equal(calls,count+1);assert.equal(f.sent.length,0);
        assert.equal(queueGroupReminder(f.store,2,1,args).state,"queued");
        clock+=30001;fail=false;
      }
      await f.tick();
      const status=queueGroupReminder(f.store,2,1,args);
      if(["missing","present","read-error"].includes(scenario)){
        assert.deepEqual(status,{state:"sent",messageId:90});
        assert.equal(f.sent[0].text,file?"Олег, подтвердите файл":"Лена, приложите файл");
        assert.deepEqual(f.sent[0].reply_parameters,{message_id:42,allow_sending_without_reply:false});
      }else{
        assert.equal(f.sent.length,0);
        assert.equal(status.state,scenario==="confirmed"?"cancelled":scenario==="revoked"?"source_unavailable":"revoked");
      }
      const restored=fixture(f.snapshot()),after=calls;await restored.tick();
      assert.equal(calls,after);assert.equal(restored.sent.length,0);
    }
  }finally{
    Date.now=now;
    if(mode===undefined) delete process.env.BB_TELEGRAM_CHECKPOINT_ADAPTERS;else process.env.BB_TELEGRAM_CHECKPOINT_ADAPTERS=mode;
    if(grants===undefined) delete process.env.BB_TELEGRAM_SOURCE_GRANTS;else process.env.BB_TELEGRAM_SOURCE_GRANTS=grants;
    await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
  }
});


test("owner return removes internal lines without changing the approved reply target", async () => {
  const f=fixture();
  queueGroupResult(f.store,2,1,"0","Approved\n<!-- bb-telegram-child-result:thr_worker:turn-1 -->");
  await f.tick();
  assert.equal(f.sent[0].text,"Approved");
  assert.deepEqual(f.sent[0].reply_parameters,{message_id:42,allow_sending_without_reply:false});
});
