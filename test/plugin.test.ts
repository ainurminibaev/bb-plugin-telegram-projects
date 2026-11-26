import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
test("local API preparation checks identity, returns no secret and does not repeat logout", async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").at(-1)!; methods.push(method);
    return new Response(JSON.stringify({ok: true, result: method === "getMe" ?
      {id: 123, username: "test_assistant_bot"} : true}), {status: 200});
  };
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", settings: {
    enabled: false, chatEnabled: false, botToken: "123:fake-token"}});
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", {expectedUsername: "different_bot", confirm: true}));
    assert.deepEqual(methods, ["getMe"]);
    const args = {expectedUsername: "test_assistant_bot", confirm: true};
    assert.deepEqual(await harness.behavior.callRpc("prepareLocalApi", args), {loggedOut: true, botId: 123});
    await harness.behavior.callRpc("prepareLocalApi", args);
    assert.deepEqual(methods, ["getMe", "getMe", "logOut"]);
    await harness.behavior.setSettings({enabled: true});
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    assert.equal(methods.length, 3);
  } finally {await harness.lifecycle.dispose(); globalThis.fetch = original;}
});

test("ambiguous cloud logout is never automatically repeated", async () => {
  const original = globalThis.fetch;
  let logouts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/logOut")) {logouts++; throw Error("connection lost");}
    return new Response(JSON.stringify({ok: true, result: {id: 123, username: "test_assistant_bot"}}), {status: 200});
  };
  const {bb, harness} = createFakePluginHost({pluginId: "telegram-projects", settings: {
    enabled: false, chatEnabled: false, botToken: "123:fake-token"}});
  try {
    await plugin(bb);
    const args = {expectedUsername: "test_assistant_bot", confirm: true};
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    await assert.rejects(harness.behavior.callRpc("prepareLocalApi", args));
    assert.equal(logouts, 1);
  } finally {await harness.lifecycle.dispose(); globalThis.fetch = original;}
});
test("disabled install has no external effects; CLI/RPC survive reload", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "telegram-projects",
  });
  await plugin(bb);
  const prefs = (await harness.behavior.callRpc("preferences", null)) as any;
  assert.equal(prefs.language, "ru");
  assert.ok(!("token" in prefs));
  const { tokenPresent, tokenSource, tokenEnv, ...editable } = prefs;
  await harness.behavior.callRpc("savePreferences", {
    ...editable,
    language: "en",
  });
  assert.equal(
    ((await harness.behavior.callRpc("preferences", null)) as any).language,
    "en",
  );
  const initial = (await harness.behavior.callRpc("status", null)) as any;
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.topics, []);
  await harness.behavior.callRpc("sync", null);
  assert.equal(harness.inspection.sdk.calls.length, 0);
  const cli = await harness.behavior.runCli(["status", "--json"]);
  assert.equal(cli.exitCode, 0);
  const next = await harness.lifecycle.reload(plugin);
  await next.harness.behavior.callRpc("status", null);
  await next.harness.lifecycle.dispose();
});

test("send --text-file reports every receipt and a later refusal for an ordinary thread", async (t) => {
  const {bb, harness} = createFakePluginHost({
    pluginId: "telegram-projects", settings: {enabled: false, botToken: "81:fiction"},
    sdk: {threads: {get: async () => ({title:"Макет"}), events: {list: async () => []}}} as any,
  });
  const {mkdtemp, writeFile, rm} = await import("node:fs/promises");
  const original = globalThis.fetch;
  const directory = await mkdtemp("/tmp/telegram-longtext-");
  const sent: any[] = [];
  let scenario = "ok";
  let echoText="";
  globalThis.fetch = async (_url, init) => {
    if(init?.body instanceof FormData){
      sent.push(String(_url).split("/").at(-1));
      return Response.json({ok:true,result:sent.length===1 ? [] : {chat:{id:82},message_id:91,document:{file_size:1}}});
    }
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    if (scenario==="echo") return Response.json({ok:true,result:{chat:{id:body.chat_id},
      message_thread_id:body.message_thread_id,message_id:71,text:echoText}});
    if (scenario==="fallback" && body.parse_mode) return Response.json({ok:false,error_code:400},{status:400});
    if (["html","fallback","short-receipt"].includes(scenario)) {
      const text=body.parse_mode ? body.text.replace(/<[^>]+>/g,"") : body.text;
      return Response.json({ok:true,result:{chat:{id:body.chat_id},message_thread_id:body.message_thread_id,
        message_id:41,text:scenario==="short-receipt" ? text.slice(0,1574) : text}});
    }
    if (scenario==="timeout" && sent.length===2) throw Error("timeout");
    if (scenario==="unverified" && sent.length===1) return Response.json({ok:true,result:{}});
    if (scenario==="reject" && sent.length === 2) return Response.json({ok:false,error_code:403},{status:403});
    return Response.json({ok:true,result:{chat:{id:body.chat_id},message_thread_id:body.message_thread_id,message_id:sent.length}});
  };
  try {
    await plugin(bb);
    const put = bb.storage.database().prepare("INSERT OR REPLACE INTO state VALUES (?,?)");
    put.run("owner:id","82");
    put.run("bot:id","81");
    const body = "• Сверили макет.\n".repeat(380) + "• По просьбе Миры [лист](/макет\n• Уточнили сроки)";
    const path = directory + "/report.txt";
    await writeFile(path, body);
    const run = () => harness.behavior.runCli(["send","--person","owner","--text-file",path],{threadId:"sample-thread"} as any);
    const result = await run();
    assert.equal(result.exitCode,0,result.stderr);
    const receipt=JSON.parse(result.stdout!);
    assert.equal(receipt.sent,true);
    assert.equal(receipt.messageId,2);
    assert.deepEqual(receipt.messageIds,[1,2]);
    assert.equal(sent.map(p=>p.text).join(""),"От: Макет\n"+body);
    sent.length=0; scenario="reject";
    const failed=await run();
    assert.equal(failed.exitCode,1);
    assert.match(failed.stderr!,/partial_send:.*messageIds=\[1\].*telegram_403/);
    assert.match(failed.stderr!,/Ушли части 1–1.*Повтори только оставшееся/);
    sent.length=0; scenario="timeout";
    const unknown=await run();
    assert.equal(unknown.exitCode,1);
    assert.match(unknown.stderr!,/messageIds=\[1\].*Не повторяй.*часть 2 могла дойти.*Проверь/);
    sent.length=0; scenario="unverified";
    const accepted=await run();
    assert.equal(accepted.exitCode,0,accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout!).sent,true);
    assert.match(JSON.parse(accepted.stdout!).note,/не повторяй/);
    assert.deepEqual(JSON.parse(accepted.stdout!).messageIds,[2]);
    assert.equal(sent.map(p=>p.text).join(""),"От: Макет\n"+body);
    sent.length=0; scenario="ok";
    const files:string[]=[];
    for(let i=0;i<11;i++){
      const name=directory+"/"+i+".txt";
      await writeFile(name,"x");
      files.push("--file",name);
    }
    const album=await harness.behavior.runCli(["send","--person","owner",...files],{threadId:"sample-thread"} as any);
    assert.equal(album.exitCode,0,album.stderr);
    assert.deepEqual(sent,["sendMediaGroup","sendDocument"]);
    assert.deepEqual(JSON.parse(album.stdout!).messageIds,[91]);
    assert.match(JSON.parse(album.stdout!).note,/не повторяй/);
    sent.length=0;
    const single=await harness.behavior.runCli(["send","--person","owner","--again",...files.slice(0,2)],{threadId:"sample-thread"} as any);
    assert.equal(single.exitCode,0,single.stderr);
    const singleReceipt=JSON.parse(single.stdout!);
    assert.equal(singleReceipt.sent,true);
    assert.deepEqual(singleReceipt.messageIds,[]);
    assert.match(singleReceipt.note,/не повторяй/);
    assert.deepEqual(sent,["sendDocument"]);
    sent.length=0;
    put.run("visibility:81:group:-10082",JSON.stringify({chat:-10082}));
    put.run("group:thread:sample-thread",JSON.stringify("group:policy:-10082:7"));
    put.run("group:policy:-10082:7",JSON.stringify({chatId:-10082,topicId:7,threadId:"sample-thread",botId:81}));
    const group=await harness.behavior.runCli(["send","--chat","-10082","--topic","7","--text-file",path],{threadId:"sample-thread"} as any);
    assert.equal(group.exitCode,0,group.stderr);
    assert.deepEqual(JSON.parse(group.stdout!).messageIds,[1,2]);
    assert.equal(sent.map(p=>p.text).join(""),body);
    assert.ok(sent.every(p=>p.chat_id===-10082 && p.message_thread_id===7));
    const lines=Array.from({length:13},(_,i)=>'• Проверили макет '+(i+1)+'.'+(i<9?' [Описание](https://example.invalid/test/'+i+')':''));
    const visible=(s:string)=>s.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1');
    const prefix='• По просьбе';
    let n=1574-visible(lines.join('\n')+'\n'+prefix).length;
    for(let i=0;i<13;i++){const k=Math.ceil(n/(13-i)); lines[i]+=(' '+ 'вымышленный макет '.repeat(20)).slice(0,k); n-=k;}
    lines.push(prefix+' Миры проверили макет CI/CD, сверили подписи и цвета. [Описание макета](https://example.invalid/team/review/#fig-12)');
    lines.push('• Завершили проверку [первого макета](https://example.invalid/review/first/sample/ru). [Ссылка на протокол](https://example.invalid/p/meeting/42)');
    const add=2475-lines.join('\n').length;
    lines[14]=lines[14].replace('Завершили',('Проверили подписи и согласовали цвета. '.repeat(100)).slice(0,add)+'Завершили');
    const src=lines.join('\n');
    assert.equal(src.length,2475);
    assert.equal(visible(src).indexOf(' Миры'),1574);
    await writeFile(path,src);
    // A scheduled turn in the owner's private conversation sends into a different group's topic.
    put.run("chat:binding:0",JSON.stringify({threadId:"scheduled-owner-thread"}));
    const fromOwner=()=>harness.behavior.runCli(["send","--chat","-10082","--topic","7","--text-file",path],{threadId:"scheduled-owner-thread"} as any);
    sent.length=0;
    const hold=await fromOwner();
    assert.match(hold.stderr!,/first_today_hold/);
    assert.equal(sent.length,0);
    for(const mode of ["html","fallback","short-receipt"]){
      sent.length=0; scenario=mode;
      const result=await fromOwner();
      const receipt=JSON.parse(result.stdout!);
      assert.equal(receipt.sent,true);
      assert.deepEqual(receipt.messageIds,[41]);
      assert.equal(result.exitCode,mode==="short-receipt"?1:0,result.stderr);
      assert.equal(sent[0].text.replace(/<[^>]+>/g,""),visible(src));
      assert.equal((sent[0].text.match(/href=/g)??[]).length,12);
      if(mode==="short-receipt") assert.match(receipt.note,/принято не полностью: дошло 1574 из 2032 знаков/);
      if(mode==="fallback") assert.equal(sent[1].text,src.replace(/\[([^\]]+)\]\(([^)]*)\)/g,"$1 ($2)"));
    }
    await t.test("send delivers ten nearly full parts in order and returns every message ID",async()=>{
      const boundaries=["\n\n","\n"," "];
      const expected=Array.from({length:10},(_,index)=>{
        const sentence=`Раздел ${String(index+1).padStart(2,"0")} сверил макет. `;
        const block=sentence.repeat(Math.floor(4090/sentence.length)).trimEnd();
        return block+(index===9 ? "" : boundaries[index%boundaries.length]);
      });
      const source=expected.join("");
      await writeFile(path,source);
      sent.length=0; scenario="ok";
      const result=await fromOwner();
      assert.equal(result.exitCode,0,result.stderr);
      const receipt=JSON.parse(result.stdout!);
      assert.equal(receipt.sent,true);
      assert.deepEqual(receipt.messageIds,[1,2,3,4,5,6,7,8,9,10]);
      assert.equal(receipt.messageId,10);
      assert.deepEqual(sent.map(p=>p.text),expected);
      assert.equal(sent.map(p=>p.text).join(""),source);
      assert.ok(sent.every(p=>p.chat_id===-10082 && p.message_thread_id===7 && p.text.length>4050 && p.text.length<=4096));
    });
    await t.test("normalized echoes and the 90 percent threshold determine the CLI outcome",async()=>{
      const cases=[
        {source:"  Строка 🙂\r\nСледующая — строка.  ",echo:" \nСтрока &#x1F642;\nСледующая &#8212; строка.\r\n",code:0},
        {source:"я".repeat(100),echo:"я".repeat(91),code:0,note:/принял сообщение с отличиями/},
        {source:"я".repeat(100),echo:"я".repeat(90),code:0,note:/принял сообщение с отличиями/},
        {source:"я".repeat(100),echo:"я".repeat(89),code:1,note:/принято не полностью: дошло 89 из 100/},
        {source:"я".repeat(2475),echo:"я".repeat(1574),code:1,note:/принято не полностью: дошло 1574 из 2475/},
      ];
      for(const {source,echo,code,note} of cases){
        await writeFile(path,source);
        sent.length=0; scenario="echo"; echoText=echo;
        const result=await fromOwner();
        const receipt=JSON.parse(result.stdout!);
        assert.equal(sent.length,1);
        assert.equal(receipt.sent,true);
        assert.deepEqual(receipt.messageIds,[71]);
        assert.equal(result.exitCode,code,result.stderr);
        if(note) assert.match(receipt.note,note);
        else assert.equal(receipt.note,undefined);
      }
    });
    const {openArchive}=await import("../archive");
    const history=openArchive(bb.storage.database());
    history.record(81,{message:{chat:{id:82,type:"private"},from:{id:82},message_id:614,date:1,text:src}});
    const read=async(args:string[])=>{
      const result=await harness.behavior.runCli(["search-history",...args],{threadId:"scheduled-owner-thread"} as any);
      assert.equal(result.exitCode,0,result.stderr);
      return JSON.parse(result.stdout!);
    };
    assert.equal((await read(["--message","82:614"])).text,src);
    put.run("reply:quote:82:615",JSON.stringify({t:"Отрывок",original:src,at:Date.now()}));
    assert.equal((await read(["--message","82:615"])).text,src);
  } finally {
    globalThis.fetch=original;
    await harness.lifecycle.dispose();
    await rm(directory,{recursive:true,force:true});
  }
});

test("С112: send checks the requester again after listing targets and delivers their text verbatim",async()=>{
  const threadId="sample-member";
  const ctx={threadId} as any;
  const bot=81,owner=82,author=83,origin=-10083,target=-10084;
  const {bb,harness}=createFakePluginHost({pluginId:"telegram-projects",settings:{enabled:false,botToken:"81:fiction"},
    sdk:{threads:{get:async()=>({title:"Макет"}),events:{list:async()=>[{scope:{kind:"turn",turnId:"turn"}}]}}} as any});
  const previous=globalThis.fetch;
  const sent:string[]=[];
  let status="member";
  globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if (String(url).endsWith("/getChatMember")) {
      assert.deepEqual([body.chat_id,body.user_id],[target,author]);
      return Response.json({ok:true,result:{status}});
    }
    assert.ok(String(url).endsWith("/sendMessage"));
    assert.equal(body.chat_id,target);
    sent.push(body.text);
    return Response.json({ok:true,result:{chat:{id:target},message_id:51,text:body.text}});
  };
  try {
    await plugin(bb);
    const write=bb.storage.database().prepare("INSERT OR REPLACE INTO state VALUES (?,?)");
    const put=(key:string,value:unknown)=>write.run(key,JSON.stringify(value));
    put("bot:id",bot); put("owner:id",owner);
    put("rights:81:access",[{id:author,name:"Мира"}]);
    put("group:thread:"+threadId,"group:policy:-10083:0");
    put("group:policy:-10083:0",{chatId:origin,topicId:0,threadId,botId:bot});
    put("visibility:81:group:-10084",{chat:target,title:"Макет"});
    put('reply:turn:["sample-member","turn"]',{requestIds:["request"]});
    put('reply:request:["sample-member","request"]',{kind:"telegram",chatId:origin,topicId:0,updateId:10});
    put("group:turn-author:sample-member:10",author);
    const targets=await harness.behavior.runCli(["send","--targets"],ctx);
    assert.ok(JSON.parse(targets.stdout!).groups.some((g:any)=>g.chat===target));
    const send=()=>harness.behavior.runCli(["send","--chat",String(target),"--text","Макет готов"],ctx);
    status="left";
    const hidden=await harness.behavior.runCli(["send","--targets"],ctx);
    assert.equal(JSON.parse(hidden.stdout!).groups.some((g:any)=>g.chat===target),false);
    assert.match((await send()).stderr!,/его нет в этой группе/);
    status="member";
    const first=await send();
    const result=first.stderr?.includes("first_today_hold") ? await send() : first;
    assert.equal(result.exitCode,0,result.stderr);
    put("group:turn-mixed:sample-member:turn",99);
    assert.match((await send()).stderr!,/group_not_allowed/);
    const ownerThread="private-owner";
    put("chat:binding:0",{threadId:ownerThread});
    put('reply:turn:["private-owner","turn"]',{requestIds:["forward"]});
    put('reply:request:["private-owner","forward"]',{kind:"telegram",chatId:owner,topicId:0,updateId:11,forwardedOnly:true});
    const denied=await harness.behavior.runCli(["send","--chat",String(target),"--text","Пересланная просьба"],{threadId:ownerThread} as any);
    assert.equal(denied.exitCode,1);
    assert.match(denied.stderr!,/group_not_allowed_from_forward/);
    assert.deepEqual(sent,["Макет готов"]);
  } finally {globalThis.fetch=previous;await harness.lifecycle.dispose();}
});
