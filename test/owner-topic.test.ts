import assert from "node:assert/strict";
import test from "node:test";
import { acceptGroupUpdate } from "../ingress";
import { bindGroupTopic, processGroupInputs } from "../group-worker";
import { ownerPrivateTopicInput, ownerTopicInput, ownerTopicTool } from "../owner-topic";
import { saveGroupSettings, setAccess } from "../rights";
import { TelegramFailure, type Store } from "../model";

const chatId = -1004242;
const owner = 7;
const bot = 5;
const title = "Проверки";
const text = "Обсудим результаты здесь.";
const scope = {threadId:"source",projectId:"team",signal:new AbortController().signal};
const explicit = {confirm:true as const,title,text};

async function fixture(message = `Создай тему ${title} и напиши туда ${text}`, sender = owner,
  extra: Record<string,unknown> = {}, shared=false,work=false) {
  const rows = new Map<string,unknown>();
  const store:Store = {
    get:<T>(key:string)=>structuredClone(rows.get(key)) as T|undefined,
    put:(key,value)=>{rows.set(key,structuredClone(value));},
    del:key=>{rows.delete(key);},
    list:<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix))
      .map(([key,value])=>({key,value:structuredClone(value) as T})),
    atomic:fn=>fn(),
  };
  bindGroupTopic(store,{chatId,topicId:3,threadId:"source",botId:bot,botUsername:"fixture_bot",
    requireMention:false,ownerOnly:true,ownerId:owner,revision:"source-revision",
    ...(shared && {ownerSharedProject:true}),
    ...(work && {ownerTopicManagerProjectId:"team"})},"team");
  // The new topic must stay owner-only even when group-level settings and
  // the bot's access list allow other people to start ordinary group work.
  setAccess(store,bot,[{id:9,name:"Other administrator"}]);
  saveGroupSettings(store,bot,chatId,{who:"all",members:"read",reply:"auto"});
  const start = (request:string, userId:number, topic=3, update=8, more:Record<string,unknown>={}) =>
    acceptGroupUpdate(store,{update_id:update,message:{message_id:update+10,date:Math.floor(Date.now()/1000)+2,
      chat:{type:"supergroup",id:chatId},from:{id:userId},message_thread_id:topic,is_topic_message:true,text:request,...more}},owner,bot);
  if (!shared) assert.ok(start(message,sender,3,8,extra));
  const events:any[]=[];
  const calls: {method:string; payload:Record<string,any>}[]=[];
  const forums=new Map([[chatId,"Первый форум"]]);
  const workForums=new Set(work?[chatId]:[]);
  const spawned=new Set<number>();
  let activeForum=chatId;
  const config = {forum:true,isPublic:false,botMayManage:true,ownerMayManage:true,fail:"",newThread:false,revokeAfterCreate:false,audience:2};
  const record = (type:string,data:Record<string,unknown>,turnId="turn")=>
    events.push({seq:events.length+1,type,scope:{kind:"turn",turnId},data});
  const sdk = {threads:{
    get:async ({threadId}:{threadId:string})=>({id:threadId,projectId:"team",environmentId:"env",
      providerId:"codex",visibility:"visible"}),
    events:{list:async (opts:any) => {
      const found=events.filter(e=>e.seq>Number(opts.afterSeq??0) && (!opts.types || opts.types.includes(e.type)));
      if (opts.order==="desc") found.reverse();
      return found.slice(0,Number(opts.limit??100));
    }},
    send:async (args:Record<string,unknown>)=>{
      record("client/turn/requested",{requestId:"request",originPluginId:"telegram-projects",input:args.input});
      record("turn/input/accepted",{clientRequestId:"request"});
    },
    spawn:async (args:Record<string,unknown>)=>{
      calls.push({method:"spawn",payload:args});
      if (config.fail==="spawn") throw Error("connection_lost");
      assert.ok(!spawned.has(activeForum));
      spawned.add(activeForum);
      config.newThread=true;
      return {id:activeForum===chatId?"new-thread":"another-thread",projectId:"team"};
    },
  }};
  const transport = (destination:number)=>async <T>(method:string,payload:Record<string,any>):Promise<T>=>{
    assert.ok(forums.has(destination));
    calls.push({method,payload});
    if (method==="getChat") return {id:destination,title:forums.get(destination),type:"supergroup",is_forum:config.forum,
      ...(config.isPublic && {active_usernames:["public"]})} as T;
    if (method==="getMe") return {id:bot,is_bot:true,username:"fixture_bot"} as T;
    if (method==="getChatMemberCount") return config.audience as T;
    if (method==="getChatMember") return {user:{id:payload.user_id,is_bot:payload.user_id===bot},
      status:shared && payload.user_id===owner ? "creator" : "administrator",
      can_manage_topics:payload.user_id===bot ? config.botMayManage : config.ownerMayManage} as T;
    if (method==="createForumTopic") {
      if (config.fail==="create") throw new TelegramFailure("telegram_network",30,true);
      if (config.revokeAfterCreate) config.botMayManage=false;
      activeForum=destination;
      return {message_thread_id:22} as T;
    }
    if (method==="sendMessage") {
      const binding=store.get<any>(`group:policy:${destination}:22`);
      assert.equal(binding?.threadId,workForums.has(destination)?undefined:destination===chatId?"new-thread":"another-thread");
      if (config.fail==="post") throw new TelegramFailure("telegram_network",30,true);
      if (config.fail==="post-rejected") throw new TelegramFailure("telegram_429",30,false);
      return {chat:{id:destination},message_thread_id:22,message_id:23} as T;
    }
    throw Error("unexpected "+method);
  };
  await processGroupInputs(store,sdk as never,owner,bot,transport,scope.signal);
  const makeTool=(provePrivate?:Parameters<typeof ownerTopicTool>[0]["provePrivate"])=>
    ownerTopicTool({store,sdk:sdk as never,identity:async()=>({owner,bot}),transport,provePrivate});
  const mutations=()=>calls.filter(c=>["createForumTopic","spawn","sendMessage"].includes(c.method));
  return {store,start,config,record,makeTool,mutations,forums,workForums};
}

test("a proven owner request creates a topic, binds a separate thread and posts once",async()=>{
  const f=await fixture();
  const send=f.makeTool();
  const receipt=await send(explicit,scope);
  assert.deepEqual(receipt,{topicId:22,threadId:"new-thread",messageId:23,url:"https://t.me/c/4242/22/23"});
  assert.deepEqual(await f.makeTool()(explicit,scope),receipt);
  assert.deepEqual(f.mutations().map(c=>c.method),["createForumTopic","spawn","sendMessage"]);
  assert.deepEqual(f.mutations()[0].payload,{chat_id:chatId,name:title});
  const spawn=f.mutations()[1].payload;
  assert.equal(spawn.projectId,"team");
  assert.deepEqual(spawn.environment,{type:"reuse",environmentId:"env"});
  assert.equal(spawn.permissionMode,"accept-edits");
  assert.equal(spawn.input.length,1);
  assert.equal(spawn.input[0].visibility,"agent-only");
  assert.ok(!spawn.input[0].text.includes(text));
  assert.equal(f.mutations()[2].payload.text,text);
  const policy=f.store.get<any>(`group:policy:${chatId}:22`);
  assert.equal(policy.ownerOnly,true);
  assert.equal(policy.requireMention,false);
  assert.equal(policy.ownerTopic,true);
  saveGroupSettings(f.store,bot,chatId,{reply:"mention"});
  f.start("Member tries to run this topic",9,22,9);
  assert.equal(f.store.get("group:in:5:9"),undefined);
  assert.ok(f.start("Owner writes without a mention",owner,22,10));
  assert.ok(f.store.get("group:in:5:10"));
});

test("a title-only request posts the fixed confirmation without copying context",async()=>{
  const f=await fixture(`Создай тему ${title}, давай туда. Другой контекст не переносить.`);
  await assert.rejects(f.makeTool()(explicit,scope),/explicit_owner_message_required/);
  const args={confirm:true as const,title};
  await f.makeTool()(args,scope);
  assert.equal(f.mutations()[2].payload.text,"Тема создана. Продолжим здесь.");
  assert.equal(f.mutations()[2].payload.message_thread_id,22);
});

test("the owner-only tool rejects all other authors and source contexts before writes",async()=>{
  assert.equal(ownerTopicInput.safeParse({...explicit,chatId:-1009}).success,false);
  assert.equal(ownerTopicInput.safeParse({...explicit,secret:"from text"}).success,false);
  assert.equal(ownerTopicInput.safeParse({...explicit,confirm:false}).success,false);
  const foreign=await fixture(undefined,9);
  await assert.rejects(foreign.makeTool()(explicit,scope),/current_owner_group_request_required/);
  const forwarded=await fixture(undefined,owner,{forward_origin:{type:"user"}});
  await assert.rejects(forwarded.makeTool()(explicit,scope),/explicit_owner_title_required/);
  const completed=await fixture();
  completed.record("turn/completed",{status:"completed"});
  await assert.rejects(completed.makeTool()(explicit,scope),/current_owner_group_request_required/);
  const unrelated=await fixture();
  unrelated.record("client/turn/requested",{requestId:"different",originPluginId:"telegram-projects",input:[]});
  unrelated.record("turn/input/accepted",{clientRequestId:"different"});
  await assert.rejects(unrelated.makeTool()(explicit,scope),/current_owner_group_request_required/);
  for (const f of [foreign,forwarded,completed,unrelated]) assert.deepEqual(f.mutations(),[]);
});

test("missing management rights and a public group stop before any mutation",async()=>{
  for (const [flag,value,message] of [
    ["botMayManage",false,"bot_requires_can_manage_topics"],["ownerMayManage",false,"forum_owner_rights_required"],
    ["isPublic",true,"closed_forum_supergroup_required"],
  ] as const) {
    const f=await fixture();
    f.config[flag]=value as never;
    await assert.rejects(f.makeTool()(explicit,scope),new RegExp(message));
    assert.deepEqual(f.mutations(),[]);
  }
});

test("uncertain writes are held across restarts without duplicating topics, threads or posts",async()=>{
  for (const [fail,expected] of [["create","creation"],["spawn","thread"],["post","post"]]) {
    const f=await fixture();
    f.config.fail=fail;
    await assert.rejects(f.makeTool()(explicit,scope));
    const count=f.mutations().length;
    f.config.fail="";
    await assert.rejects(f.makeTool()(explicit,scope),new RegExp("owner_topic_"+expected+"_unconfirmed"));
    assert.equal(f.mutations().length,count);
  }
});

test("a definite first-post rejection can resume the same bound topic, with a single write in flight",async()=>{
  const f=await fixture();
  f.config.fail="post-rejected";
  await assert.rejects(f.makeTool()(explicit,scope),/telegram_429/);
  f.config.fail="";
  const send=f.makeTool();
  const results=await Promise.allSettled([send(explicit,scope),send(explicit,scope)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.deepEqual(f.mutations().map(c=>c.method),["createForumTopic","spawn","sendMessage","sendMessage"]);
});

test("a revoked bot grant before the first post leaves a confirmed binding without sending",async()=>{
  const f=await fixture();
  f.config.revokeAfterCreate=true;
  await assert.rejects(f.makeTool()(explicit,scope),/bot_requires_can_manage_topics/);
  assert.deepEqual(f.mutations().map(c=>c.method),["createForumTopic","spawn"]);
  f.config.botMayManage=true;
  await f.makeTool()(explicit,scope);
  assert.deepEqual(f.mutations().map(c=>c.method),["createForumTopic","spawn","sendMessage"]);
});

test("a proven private Telegram request binds a clean topic thread and posts the exact first message once",async()=>{
  const f=await fixture(undefined,owner,{},true);
  const args=ownerPrivateTopicInput.parse({...explicit,routeToken:"5c8a898d-4b04-42f7-afe8-5a6bda456331"});
  const sourceText=`Создай тему «${title}» и напиши туда «${text}»`;
  const create=f.makeTool(async(thread,token,user)=>{
    assert.deepEqual([thread,token,user],[scope.threadId,args.routeToken,owner]);
    return {key:"private:"+token,text:sourceText};
  });
  await assert.rejects(create({...args,text:"A different first message"},scope),/explicit_owner_message_required/);
  f.config.audience=3;
  await assert.rejects(create(args,scope),/private_owner_forum_required/);
  assert.deepEqual(f.mutations(),[]);
  f.config.audience=2;
  const receipt=await create(args,scope);
  assert.deepEqual(await create(args,scope),receipt);
  assert.deepEqual(f.mutations().map(c=>c.method),["createForumTopic","spawn","sendMessage"]);
  assert.equal(f.store.get<any>(`group:policy:${chatId}:22`).ownerSharedProject,true);
  assert.equal(f.store.get("group:project:team"),undefined);
  assert.equal(f.mutations()[2].payload.text,text);
  assert.equal(f.mutations()[2].payload.message_thread_id,22);
});

test("private owner request chooses an explicitly named forum and same named topics in two forums stay independent",async()=>{
  const f=await fixture(undefined,owner,{},true);
  const other=-1009898;
  f.forums.set(other,"Второй форум");
  bindGroupTopic(f.store,{chatId:other,topicId:3,threadId:"other-source",botId:bot,botUsername:"fixture_bot",
    requireMention:true,ownerOnly:true,ownerSharedProject:true,ownerId:owner,revision:"other-revision"},"team");
  let original=`Создай тему «${title}» в «Первый форум».`;
  const create=f.makeTool(async(_id,token)=>({key:"private:"+token,text:original}));
  const args={confirm:true as const,title,routeToken:"5c8a898d-4b04-42f7-afe8-5a6bda456331"};
  await assert.rejects(create(args,scope),/explicit_private_forum_selection_required/);
  await assert.rejects(create({...args,forum:"Второй форум"},scope),/explicit_private_forum_selection_required/);
  assert.equal(f.mutations().length,0);
  f.forums.set(other,"Первый форум");
  await assert.rejects(create({...args,forum:"Первый форум"},scope),/private_forum_selection_unavailable/);
  assert.equal(f.mutations().length,0);
  f.forums.set(other,"Второй форум");
  const a=await create({...args,forum:"Первый форум"},scope);
  const link="https://t.me/c/9898/3";
  original=`Создай тему «${title}» в форуме ${link}.`;
  const b=await create({...args,forum:link,routeToken:"3139d265-e1de-4a77-ae95-f295edbecf20"},scope);
  assert.equal(a.url,"https://t.me/c/4242/22/23");
  assert.equal(b.url,"https://t.me/c/9898/22/23");
  assert.notEqual(a.threadId,b.threadId);
  assert.deepEqual(f.mutations().filter(m=>m.method==="sendMessage").map(m=>m.payload.chat_id),[chatId,other]);
});

test("a request originating inside a forum always creates its topic in that forum",async()=>{
  const f=await fixture();
  f.forums.set(-1009898,"Второй форум");
  bindGroupTopic(f.store,{chatId:-1009898,topicId:3,threadId:"other-source",botId:bot,botUsername:"fixture_bot",
    requireMention:false,ownerOnly:true,ownerId:owner,revision:"other-revision"},"different-project");
  const receipt=await f.makeTool()(explicit,scope);
  assert.equal(receipt.url,"https://t.me/c/4242/22/23");
  assert.equal(f.store.get("group:policy:-1009898:22"),undefined);
});

test("a work forum explicitly delegated to the owner project can be chosen in DM without binding the owner environment",async()=>{
  const f=await fixture(undefined,owner,{},true);
  const workChat=-1009898;
  f.forums.set(workChat,"Рабочий форум");
  f.workForums.add(workChat);
  bindGroupTopic(f.store,{chatId:workChat,topicId:3,threadId:"worker",botId:bot,botUsername:"fixture_bot",
    requireMention:true,ownerOnly:false,isolated:true,ownerId:owner,ownerTopicManagerProjectId:"team",revision:"work-rev"},"isolated-project");
  const args={...explicit,routeToken:"5c8a898d-4b04-42f7-afe8-5a6bda456331"};
  const create=f.makeTool(async(_id,token)=>({key:"private:"+token,text:`Создай тему «${title}» в «Рабочий форум». ${text}`}));
  await assert.rejects(create(args,scope),/explicit_private_forum_selection_required/);
  const receipt=await create({...args,forum:"Рабочий форум"},scope);
  assert.deepEqual(receipt,{topicId:22,requiresBinding:true,messageId:23,url:"https://t.me/c/9898/22/23"});
  assert.deepEqual(await create({...args,forum:"Рабочий форум"},scope),receipt);
  assert.deepEqual(f.mutations().map(m=>[m.method,m.payload.chat_id]),[["createForumTopic",workChat],["sendMessage",workChat]]);
  assert.equal(f.store.get("group:policy:-1009898:22"),undefined);
  assert.equal(f.store.get("group:project:team"),undefined);
});

test("an owner request in a delegated local work topic keeps its work forum even with a different private forum",async()=>{
  const f=await fixture(undefined,owner,{},false,true);
  f.config.isPublic=true;
  f.forums.set(-1009898,"Отдельный форум");
  const receipt=await f.makeTool()(explicit,scope);
  assert.deepEqual(receipt,{topicId:22,requiresBinding:true,messageId:23,url:"https://t.me/c/4242/22/23"});
  assert.deepEqual(f.mutations().map(m=>[m.method,m.payload.chat_id]),[["createForumTopic",chatId],["sendMessage",chatId]]);
});

test("delegated work still requires current Telegram topic management rights",async()=>{
  const f=await fixture(undefined,owner,{},false,true);
  f.config.ownerMayManage=false;
  await assert.rejects(f.makeTool()(explicit,scope),/forum_owner_rights_required/);
  assert.deepEqual(f.mutations(),[]);
});
