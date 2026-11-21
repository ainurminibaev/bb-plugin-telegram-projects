import test from "node:test";
import assert from "node:assert/strict";
import {acceptPrivateEmployeeUpdate,processPrivateEmployeeInputs} from "../employee-private";
import {groupExecutor,privateExecutor} from "../isolated-client";
import {submitIsolatedGroup,readIsolatedGroup,validateIsolatedPurpose} from "../isolated-group";
import {hasAccess} from "../rights";
import type {Store,Telegram} from "../model";
import {imageAttachment} from "../group-attachments";

const owner=7,bot=8,alice=21,bob=22,declined=23;
const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=","base64");

function fixture() {
  const rows=new Map<string,unknown>();
  const store:Store={
    get:key=>structuredClone(rows.get(key)) as never,
    put:(key,value)=>{rows.set(key,structuredClone(value));},
    del:key=>{rows.delete(key);},
    list:prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never})),
    atomic:fn=>fn(),
  };
  let seq=100,messageId=10;
  let failDelivery=false,waiting=false;
  let replyNext:string|undefined;
  let beforeExport:()=>Promise<unknown>=async()=>{};
  const messages:{target:number;method:string;payload:any;id:number}[]=[];
  const transport=(target:number):Telegram=>async <T>(method:string,payload:object)=>{
    assert.equal((payload as any).chat_id??target,target);
    messages.push({target,method,payload,id:++messageId});
    if (failDelivery && (payload as any).reply_parameters) throw Error("uncertain_send");
    return {message_id:messageId,document:{file_id:"pdf"},photo:[{file_id:"photo"}]} as T;
  };
  const submits:{subject:number;text:string;attachments:any[]}[]=[];
  const contexts=new Map<number,string>();
  const answers=new Map<string,{subject:number;text:string}>();
  const deps={store,owner,bot,current:()=>true,transport,executor:(_bot:number,_owner:number,subject:number)=>({
    binding:"binding-"+subject,
    read:async(token:string)=>{
      const result=answers.get(token);
      if (!result || result.subject!==subject) return {state:"missing"};
      return waiting ? {state:"waiting"} : {state:"finished",text:result.text};
    },
    submit:async(token:string,text:string,_signal:AbortSignal,attachments:any[])=>{
      submits.push({subject,text,attachments});
      assert.ok(!answers.has(token));
      const previous=contexts.get(subject)??"";
      answers.set(token,{subject,text:replyNext??["Общие знания: читать справочник.",previous,text].filter(Boolean).join(" ")});
      replyNext=undefined;
      if (!previous) contexts.set(subject,text);
      return {state:"accepted"};
    },
    pdf:async(_token:string,path:string)=>{
      await beforeExport();
      if (path!=="/own/outputs/result.pdf") throw Error("export_unavailable");
      return {name:"result.pdf",document:new Blob(["%PDF-1.4\nfixture"])};
    },
    image:async(_token:string,path:string)=>{
      await beforeExport();
      if (path!=="/own/outputs/result.png") throw Error("export_unavailable");
      return {name:"result.png",photo:new Blob([new Uint8Array(pixel)])};
    },
    document:async(_token:string,path:string)=>{
      await beforeExport();
      if (path!=="/own/outputs/нейтральный.html") throw Error("export_unavailable");
      return {name:"нейтральный.html",document:new Blob(["<p>opaque bytes</p>"],{type:"application/octet-stream"})};
    },
    upload:async(file:any)=>({...file,path:file.path.replace("/bridge/","/receiver/")}),
  }) as never};
  const post=(subject:number,text?:string,extra:object={},replayUpdate?:number)=>{
    const id=++seq;
    return acceptPrivateEmployeeUpdate(deps,{update_id:replayUpdate??id,message:{
      chat:{id:subject,type:"private"},from:{id:subject,first_name:"Тестовый пользователь",username:"fixture_name"},
      message_id:id,text,...extra,
    }});
  };
  const notice=(subject:number)=>messages.find(m=>m.target===owner && m.method==="sendMessage" &&
    m.payload.text.endsWith("ID: "+subject))!;
  const action=async(subject:number,choice:"allow"|"deny"|"revoke",options:{sender?:number;chat?:number;botId?:number;id?:number}={})=>{
    const receipt=notice(subject);
    const data=receipt.payload.reply_markup.inline_keyboard[0][0].callback_data.replace(":allow:",":"+choice+":");
    return acceptPrivateEmployeeUpdate({...deps,bot:options.botId??bot},{update_id:++seq,callback_query:{
      id:String(seq),data,from:{id:options.sender??owner},
      message:{chat:{id:options.chat??owner,type:"private"},message_id:options.id??receipt.id},
    }});
  };
  const tick=()=>processPrivateEmployeeInputs(deps,new AbortController().signal,async file=>file.image?imageAttachment(pixel):{
    path:"/bridge/1-aaaaaaaaaaaaaaaaaaaa/"+file.name,name:file.name,bytes:5,sha256:"a".repeat(64),
  });
  return {store,post,notice,action,tick,messages,submits,sequence:()=>seq,wait:()=>{waiting=true;},
    fail:()=>{failDelivery=true;},answerNext:(text:string)=>{replyNext=text;}, onExport:(fn:()=>Promise<unknown>)=>{beforeExport=fn;}};
}

test("unapproved /start and ordinary DM produce one owner notice, no task, and owner decisions are scoped",async()=>{
  const f=fixture();
  await Promise.all([f.post(alice,"/start"),f.post(alice,"/start"),f.post(alice,"private synthetic text")]);
  await f.post(bob,"ordinary first text");
  await f.post(declined,"/start");
  assert.equal(f.messages.filter(m=>m.target===owner && m.method==="sendMessage").length,3);
  assert.match(f.notice(alice).payload.text,/@fixture_name/);
  assert.doesNotMatch(JSON.stringify(f.store.list("employee:private:")),/private synthetic text|ordinary first text/);
  await f.action(alice,"allow",{sender:bob});
  await f.action(alice,"allow",{id:200});
  await f.action(alice,"allow",{chat:bob});
  await f.action(alice,"allow",{botId:9});
  await f.post(alice,"still unapproved");
  await f.tick();
  assert.deepEqual(f.submits,[]);
  await f.action(declined,"deny");
  await f.action(declined,"allow");
  await f.post(declined,"cannot use it");
  await f.tick();
  assert.deepEqual(f.submits,[]);
  assert.equal(f.messages.filter(m=>m.target===declined && m.payload.text==="В доступе отказано.").length,1);
});

test("two approved users keep their own history and replies under username changes and Telegram duplicates",async()=>{
  const f=fixture();
  await f.post(alice,"/start");
  await f.post(bob,"first request");
  const preapproval=f.sequence();
  await f.action(alice,"allow");
  await f.action(alice,"allow");
  await f.action(bob,"allow");
  await f.post(bob,"first request",{message_id:preapproval},preapproval);
  await f.post(alice,"SYNTHETIC_ALICE_HISTORY");
  const a=f.sequence();
  await f.post(alice,"SYNTHETIC_ALICE_HISTORY",{message_id:a});
  await f.post(bob,"SYNTHETIC_BOB_HISTORY");
  await f.tick();
  await f.post(alice,"напомни мой текст",{from:{id:alice,username:"changed_alias"},
    photo:[{file_id:"synthetic_photo"}]});
  await f.post(bob,"напомни мой текст",{document:{file_id:"synthetic_file",file_name:"test.txt",mime_type:"text/plain"}});
  await f.tick();
  await f.tick();
  assert.equal(f.submits.length,4);
  assert.deepEqual(f.submits.find(s=>s.subject===alice && s.attachments.length)?.attachments,[imageAttachment(pixel)]);
  assert.deepEqual(f.submits.find(s=>s.subject===bob && s.attachments.length)?.attachments,[{
    type:"opaque",file:{cacheId:"1-aaaaaaaaaaaaaaaaaaaa",name:"test.txt",bytes:5,sha256:"a".repeat(64)},
  }]);
  const answers=f.messages.filter(m=>m.method==="sendMessage" && m.payload.reply_parameters);
  assert.equal(answers.length,4);
  for (const m of answers) {
    assert.match(m.payload.text,/Общие знания/);
    assert.doesNotMatch(m.payload.text,m.target===alice?/SYNTHETIC_BOB_HISTORY/:/SYNTHETIC_ALICE_HISTORY/);
  }
  assert.equal(hasAccess(f.store,bot,owner,alice),false);
  assert.equal(hasAccess(f.store,bot,owner,bob),false);
  assert.equal(await f.post(alice,"group tries to use direct history",{chat:{id:-10091,type:"supergroup"}}),false);
  await f.tick();
  assert.equal(f.submits.length,4);
});

test("revocation blocks queued output and an uncertain Telegram send is never replayed",async()=>{
  const f=fixture();
  for (const who of [alice,bob]) {
    await f.post(who,"/start");
    await f.action(who,"allow");
  }
  f.wait();
  await f.post(alice,"delayed job");
  await f.tick();
  await f.action(alice,"revoke");
  await f.action(alice,"allow");
  await f.post(alice,"another job");
  await f.tick();
  assert.deepEqual(f.submits.map(x=>x.subject),[alice]);
  assert.equal(f.messages.filter(m=>m.target===alice && m.payload.reply_parameters).length,0);
  const g=fixture();
  await g.post(bob,"/start");
  await g.action(bob,"allow");
  await g.post(bob,"delayed job");
  g.fail();
  await g.tick();await g.tick();await g.tick();
  assert.equal(g.messages.filter(m=>m.target===bob && m.payload.reply_parameters).length,1);
  assert.equal(g.store.list<{state:string}>("employee:private:receipt:")[0].value.state,"unknown");
});

test("private worker configuration rejects shared launchers, projects or threads, including group routes",()=>{
  const cases=["cli","projectId","threadId"] as const;
  const orig=process.env.BB_TELEGRAM_PRIVATE_EXECUTORS;
  const groups=process.env.BB_TELEGRAM_GROUP_EXECUTORS;
  try {
    const a={projectId:"project-a",threadId:"thread-a",cli:"/fixture/launch-a"};
    const b={projectId:"project-b",threadId:"thread-b",cli:"/fixture/launch-b"};
    const userKey=(who:number)=>`${bot}:${owner}:${who}`;
    delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    for (const key of cases) {
      process.env.BB_TELEGRAM_PRIVATE_EXECUTORS=JSON.stringify({[userKey(alice)]:a,[userKey(bob)]:{...b,[key]:a[key]}});
      assert.throws(()=>privateExecutor(bot,owner,alice),/isolation_required/);
    }
    process.env.BB_TELEGRAM_PRIVATE_EXECUTORS=JSON.stringify({[userKey(alice)]:a});
    process.env.BB_TELEGRAM_GROUP_EXECUTORS=JSON.stringify({"-10099:4":a});
    assert.throws(()=>privateExecutor(bot,owner,alice),/isolation_required/);
    assert.throws(()=>groupExecutor(-10099,4),/isolation_required/);
    delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    assert.equal(privateExecutor(bot,owner,bob),undefined);
    assert.equal(privateExecutor(bot,owner,alice)?.threadId,a.threadId);
  } finally {
    if (orig===undefined) delete process.env.BB_TELEGRAM_PRIVATE_EXECUTORS;
    else process.env.BB_TELEGRAM_PRIVATE_EXECUTORS=orig;
    if (groups===undefined) delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    else process.env.BB_TELEGRAM_GROUP_EXECUTORS=groups;
  }
});

test("isolated personal BB sends native input only in the private receipt namespace",async()=>{
  const {store}=fixture();
  const args={projectId:"private-worker",threadId:"subject-thread",routeToken:"02735224-c840-437b-983a-ea41fc9719b1",
    text:"synthetic original message",attachments:[imageAttachment(pixel)]};
  const sends:any[]=[];
  const sdk={threads:{get:async()=>({id:args.threadId,projectId:args.projectId,visibility:"visible"}),
    events:{list:async()=>[]},send:async(q:any)=>{sends.push(q);}}};
  assert.deepEqual(await submitIsolatedGroup(sdk as never,store,args.projectId,args,undefined,true),{state:"accepted"});
  assert.deepEqual(await submitIsolatedGroup(sdk as never,store,args.projectId,args,undefined,true),{state:"accepted"});
  assert.equal(sends.length,1);
  assert.equal(sends[0].input[0].text,args.text);
  assert.deepEqual(sends[0].input[1],args.attachments[0]);
  assert.deepEqual(await readIsolatedGroup(sdk as never,store,args.projectId,args),{state:"missing"});
  assert.deepEqual(await readIsolatedGroup(sdk as never,store,args.projectId,args,true),{state:"waiting"});
});

test("an isolated worker cannot recycle private histories into another subject or group",()=>{
  const {store}=fixture();
  validateIsolatedPurpose(store,"private-project","private-thread");
  validateIsolatedPurpose(store,"private-project","private-thread");
  assert.throws(()=>validateIsolatedPurpose(store,"private-project","other"),/isolation_required/);
  assert.throws(()=>validateIsolatedPurpose(store,"group-project"),/isolation_required/);
  const prior=fixture();
  prior.store.put("group:submission:old-receipt",true);
  assert.throws(()=>validateIsolatedPurpose(prior.store,"private-project","private-thread"),/isolation_required/);
});


test("private replies export PDF and photo to the originating subject exactly once",async()=>{
  const f=fixture();
  await f.post(alice,"/start");
  await f.action(alice,"allow");
  await f.post(alice,"[pdf](/own/outputs/result.pdf) [photo](/own/outputs/result.png) [foreign](/other/outputs/private.pdf)");
  const source=f.sequence();
  await f.tick(); await f.tick();
  const deliveries=f.messages.filter(m=>m.payload.reply_parameters);
  assert.deepEqual(deliveries.map(x=>x.method),["sendDocument","sendPhoto","sendMessage"]);
  for (const d of deliveries) {
    assert.equal(d.target,alice);
    assert.deepEqual(d.payload.reply_parameters,{message_id:source,allow_sending_without_reply:false});
  }
  assert.equal(await deliveries[0].payload.document.text(),"%PDF-1.4\nfixture");
  assert.deepEqual(Buffer.from(await deliveries[1].payload.photo.arrayBuffer()),pixel);
  assert.match(deliveries[2].payload.text,/Вложение недоступно/);
  assert.doesNotMatch(deliveries[2].payload.text,/outputs|private\.pdf/);
});

test("revocation during private export suppresses delivery and an uncertain file send is never replayed",async()=>{
  for (const revoke of [true,false]) {
    const f=fixture();
    await f.post(alice,"/start");
    await f.action(alice,"allow");
    await f.post(alice,"[pdf](/own/outputs/result.pdf) [photo](/own/outputs/result.png)");
    if (revoke) f.onExport(()=>f.action(alice,"revoke"));
    else f.fail();
    await f.tick(); await f.tick();
    assert.deepEqual(f.messages.filter(m=>m.payload.reply_parameters).map(x=>x.method),revoke?[]:["sendDocument"]);
  }
});


test("private route accepts text, file-only, and optional captions on photo and HTML document replies",async()=>{
  const f=fixture();
  await f.post(alice,"/start");
  await f.action(alice,"allow");
  let n=0;
  for (const ext of ["html","png"]) for (const caption of [undefined,"Нейтральная подпись"]) {
    const attachment=ext==="html" ? {document:{file_id:"html-"+n,file_name:"нейтральный.html",mime_type:"text/html"}}
      : {photo:[{file_id:"photo-"+n}]};
    const link=ext==="html" ? "[Документ](/own/outputs/нейтральный.html)" : "[Фото](/own/outputs/result.png)";
    const before=f.messages.length;
    // The fixture's worker returns the explicit reply independently of whether the incoming attachment has a caption.
    f.answerNext(caption ? caption+"\n"+link : link);
    await f.post(alice,undefined,{...attachment,...(caption && {caption})});
    const source=f.sequence();
    await f.tick();await f.tick();
    const delivery=f.messages.slice(before);
    assert.equal(delivery.length,1);
    assert.equal(delivery[0].method,ext==="html"?"sendDocument":"sendPhoto");
    assert.equal(delivery[0].target,alice);
    assert.equal(delivery[0].payload.caption,caption);
    assert.deepEqual(delivery[0].payload.reply_parameters,{message_id:source,allow_sending_without_reply:false});
    assert.deepEqual(Buffer.from(await (delivery[0].payload.document??delivery[0].payload.photo).arrayBuffer()),
      ext==="html" ? Buffer.from("<p>opaque bytes</p>") : pixel);
    assert.equal(f.submits[n].attachments[0].type,ext==="html"?"opaque":"image");
    assert.equal(f.submits[n].text,caption??"Посмотри приложенный файл.");
    n++;
  }
  await f.post(alice,"Один текст без файла");
  await f.tick();
  assert.deepEqual(f.submits[n].attachments,[]);
  assert.equal(f.messages.at(-1)?.method,"sendMessage");
});


test("a configured private pilot silently ignores other Telegram users",async()=>{
  const key="BB_TELEGRAM_PRIVATE_PILOT_SUBJECT";
  const previous=process.env[key];
  process.env[key]=String(alice);
  try {
    const f=fixture();
    await f.post(bob,"/start");
    await f.post(bob,"foreign document",{document:{file_id:"foreign",file_name:"private.html"}});
    assert.deepEqual(f.messages,[]);
    await f.post(alice,"/start");
    assert.ok(f.notice(alice));
    await f.tick();
    assert.deepEqual(f.submits,[]);
  } finally {
    if (previous===undefined) delete process.env[key];
    else process.env[key]=previous;
  }
});
