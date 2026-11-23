import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate,type GroupTopicPolicy} from "../ingress";
import {bindGroupTopic} from "../group-worker";
import {describeForumTopic,forumDefaultsKey,forumName,inheritedForumPolicy,inheritableForumTopic} from "../forum-defaults";
import {handleDelegatedForumCommand} from "../forum-delegation";
import {groupExecutor} from "../isolated-client";
import {ownerTopicTool} from "../owner-topic";
import type {Store,Telegram} from "../model";

const owner=7,member=8,otherMember=9,chat=-1001234,second=-1002345,topic=3;
const now=Math.floor(Date.now()/1000)+5;
const forum=(id:number)=>({id,type:"supergroup",is_forum:true});

function fixture(bot=5,username="alpha_bot",sender=member) {
  const rows=new Map<string,unknown>();
  const store:Store={
    get:key=>structuredClone(rows.get(key)) as never,
    put:(key,value)=>{rows.set(key,structuredClone(value));},
    del:key=>{rows.delete(key);},
    list:prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never})),
    atomic:fn=>fn(),
  };
  const bind=(id:number,number=topic,extra:Partial<GroupTopicPolicy>={})=>{
    const p:GroupTopicPolicy={botId:bot,botUsername:username,ownerId:owner,chatId:id,topicId:number,
      threadId:`worker-${bot}-${id}-${number}`,requireMention:true,ownerOnly:true,isolated:true,
      includeTopicContext:true,allowedSenderIds:[sender],ownerTopicManagerProjectId:"personal",
      revision:`rev-${bot}-${id}-${number}`,...extra};
    bindGroupTopic(store,p,`isolated-${bot}-${id}-${number}`);
    return p;
  };
  bind(chat);
  bind(second);
  store.put(forumDefaultsKey(bot,chat),{sourceTopicId:topic,managers:[sender],closeManagers:[sender],since:now-1});
  store.put(forumDefaultsKey(bot,second),{sourceTopicId:topic,managers:[otherMember],since:now-1});
  let sequence=100;
  const update=(from:number,id:number,text:string,extra:object={})=>({
    update_id:++sequence,
    message:{from:{id:from,first_name:"Tester"},chat:id>0?{id,type:"private"}:forum(id),
      ...(id<0 && {message_thread_id:topic,is_topic_message:true}),
      text,date:now,message_id:sequence,
      ...(text.startsWith("/") && {entities:[{type:"bot_command",offset:0,length:text.split(/\s/)[0].length}]}),
      ...extra},
  });
  const job=()=>store.list<{route:{text:string;chatId:number;topicId:number}}>("group:in:");
  return {store,bot,bind,update,job};
}

test("two receiving bots have independent rights and context in the same Telegram topic",()=>{
  const alpha=fixture(),beta=fixture(6,"beta_bot",otherMember);
  beta.bind(chat,topic,{includeTopicContext:false});
  const post=(update:ReturnType<typeof alpha.update>)=>{
    acceptGroupUpdate(alpha.store,update,owner,alpha.bot);
    acceptGroupUpdate(beta.store,update,owner,beta.bot);
  };
  const tag=(name:string)=>({entities:[{type:"mention",offset:0,length:name.length+1}]});
  post(alpha.update(member,chat,"Пассивный контекст"));
  assert.equal(alpha.job().length+beta.job().length,0);
  post(alpha.update(member,chat,"@alpha_bot Вопрос",tag("alpha_bot")));
  post(alpha.update(member,chat,"@beta_bot Чужое право",tag("beta_bot")));
  const reply={from:{id:6,is_bot:true},chat:forum(chat),message_thread_id:topic,message_id:75};
  post(alpha.update(otherMember,chat,"Ответ Бете",{reply_to_message:reply}));
  post(alpha.update(owner,chat,"@alpha_bot Ответ Бете",{...tag("alpha_bot"),reply_to_message:reply}));
  assert.equal(alpha.job().length,1);
  assert.equal(beta.job().length,2);
  assert.match(alpha.job()[0].value.route.text,/Пассивный контекст/);
  assert.doesNotMatch(beta.job()[0].value.route.text,/Пассивный контекст/);
  assert.equal(beta.job()[0].value.route.chatId,chat);
  assert.equal(beta.job()[0].value.route.topicId,topic);
});

test("only authentic new topics inherit, across independently named groups and explicit overrides",()=>{
  const f=fixture(),newTopic=11;
  const service=(id:number,name:string)=>f.update(owner,id,"",{message_id:newTopic,message_thread_id:newTopic,
    forum_topic_created:{name}});
  const update=service(chat,"Одинаковая");
  const a=describeForumTopic(f.store,f.bot,owner,update);
  const b=describeForumTopic(f.store,f.bot,owner,service(second,"Одинаковая"));
  assert.equal(inheritableForumTopic(f.store,f.bot,owner,a)?.source.chatId,chat);
  assert.equal(inheritableForumTopic(f.store,f.bot,owner,b)?.source.chatId,second);
  f.bind(chat,newTopic,{allowedSenderIds:[otherMember],includeTopicContext:false});
  assert.equal(inheritableForumTopic(f.store,f.bot,owner,describeForumTopic(f.store,f.bot,owner,update)),undefined);
  describeForumTopic(f.store,f.bot,owner,f.update(owner,chat,"Новое имя",{message_thread_id:newTopic}));
  assert.equal(forumName(f.store,f.bot,chat,newTopic),"Одинаковая");
  describeForumTopic(f.store,f.bot,owner,f.update(owner,chat,"",{message_thread_id:newTopic,forum_topic_edited:{name:"Новое\nимя"}}));
  describeForumTopic(f.store,f.bot,owner,update);
  assert.equal(forumName(f.store,f.bot,chat,newTopic),"Новое имя");
  assert.equal(forumName(f.store,f.bot,second,newTopic),"Одинаковая");

  const seed=inheritableForumTopic(f.store,f.bot,owner,b)!.source;
  const dest={threadId:"new-isolated-worker",projectId:"new-isolated-project"};
  const inherited=inheritedForumPolicy({...seed,deliverySources:["configured-artifacts"]},newTopic,dest,"new-revision");
  bindGroupTopic(f.store,inherited,dest.projectId);
  assert.deepEqual(inherited.allowedSenderIds,seed.allowedSenderIds);
  assert.equal(inherited.deliverySources,undefined);
  assert.equal(inherited.requireMention,true);
  const caption="@alpha_bot посмотри вложение";
  acceptGroupUpdate(f.store,f.update(member,second,caption,{text:undefined,caption,message_thread_id:newTopic,
    caption_entities:[{type:"mention",offset:0,length:"@alpha_bot".length}],photo:[{file_id:"other-group-photo"}]}),owner,f.bot);
  acceptGroupUpdate(f.store,f.update(member,chat,caption,{text:undefined,caption,message_thread_id:newTopic,
    caption_entities:[{type:"mention",offset:0,length:"@alpha_bot".length}],photo:[{file_id:"forbidden-photo"}]}),owner,f.bot);
  const routes=f.store.list<{route:{threadId:string;chatId:number;topicId:number;text:string;examples:unknown[]}}>("group:in:");
  assert.equal(routes.length,1);
  const route=routes[0].value.route;
  assert.equal(route.threadId,dest.threadId);
  assert.equal(route.chatId,second);
  assert.equal(route.topicId,newTopic);
  assert.match(route.text,/Название темы Telegram \(справочные данные\): "Одинаковая"/);
  assert.match(JSON.stringify(route.examples),/other-group-photo/);
  assert.doesNotMatch(JSON.stringify(route.examples),/forbidden-photo/);
});

test("delegated topic commands prove admission and exact forum, run once with separate action grants",async()=>{
  const f=fixture(),calls:{id:number;method:string;body:any}[]=[];
  let memberStatus="member",mayDelete=false,nextTopic=15;
  const transport=(id:number):Telegram=>async <T>(method:string,body:any)=>{
    calls.push({id,method,body});
    if (method==="getChat") return {...forum(id),title:id===chat?"Рабочий форум":"Другой форум"} as T;
    if (method==="getMe") return {id:f.bot,is_bot:true,username:"alpha_bot"} as T;
    if (method==="getChatMember") return (body.user_id===owner ? {user:{id:owner},status:"creator"} :
      body.user_id===f.bot ? {user:{id:f.bot},status:"administrator",can_manage_topics:true,can_delete_messages:true} :
      {user:{id:body.user_id},status:memberStatus,can_delete_messages:mayDelete}) as T;
    if (method==="createForumTopic") return {message_thread_id:nextTopic++} as T;
    if (method==="sendMessage") return {chat:{id},message_thread_id:body.message_thread_id,message_id:66} as T;
    return true as T;
  };
  const create=ownerTopicTool({store:f.store,identity:async()=>({owner,bot:f.bot}),
    sdk:{threads:{get:async()=>{throw Error("work forum must not access BB personal threads");}}} as never,transport});
  const d={store:f.store,owner,bot:f.bot,signal:new AbortController().signal,transport,current:()=>true,create};
  const run=(u:ReturnType<typeof f.update>)=>handleDelegatedForumCommand(d,u);
  const writes=(method:string)=>calls.filter(row=>row.method===method);
  const group=f.update(member,chat,"/topic_create@alpha_bot Новая тема");
  assert.equal(await run(group),true);
  assert.equal(await run(group),true);
  assert.equal(await run(f.update(member,member,"/topic_create Личная команда | Рабочий форум | Первый текст")),true);
  await run(f.update(member,member,"/topic_create Без адресата"));
  await run(f.update(member,member,"/topic_create Чужой форум | Другой форум"));
  assert.equal(await run(f.update(otherMember,chat,"/topic_create@alpha_bot Нет прав")),false);
  memberStatus="left";
  await run(f.update(member,chat,"/topic_create@alpha_bot Вышел"));
  memberStatus="member";
  assert.equal(writes("createForumTopic").length,2);
  assert(writes("createForumTopic").every(row=>row.id===chat));
  assert(writes("sendMessage").every(row=>!row.body.reply_markup));
  assert.equal(forumName(f.store,f.bot,chat,15),"Новая тема");
  assert.equal(forumName(f.store,f.bot,chat,16),"Личная команда");
  assert(writes("sendMessage").some(row=>row.id===member && row.body.text.startsWith("Тема создана")));
  assert(writes("sendMessage").some(row=>row.id===chat && row.body.message_thread_id===16 && row.body.text==="Первый текст"));
  assert.equal(await run(f.update(member,chat,"/topic_delete@alpha_bot")),false);
  const close=f.update(member,chat,"/topic_close@alpha_bot");
  await run(close);
  await run(close);
  await run(f.update(member,chat,"/topic_reopen@alpha_bot"));
  await run(f.update(member,chat,"/topic_close@alpha_bot https://t.me/c/2345/3"));
  assert.deepEqual(writes("closeForumTopic").map(row=>[row.id,row.body.message_thread_id]),[[chat,topic]]);
  assert.deepEqual(writes("reopenForumTopic").map(row=>[row.id,row.body.message_thread_id]),[[chat,topic]]);
  assert.equal(writes("deleteForumTopic").length,0);

  f.store.put(forumDefaultsKey(f.bot,chat),{sourceTopicId:topic,managers:[],closeManagers:[],
    deleteManagers:[member],since:now-1});
  assert.equal(await run(f.update(member,chat,"/topic_create@alpha_bot Только удаление")),false);
  assert.equal(await run(f.update(member,chat,"/topic_close@alpha_bot")),false);
  await run(f.update(member,chat,"/topic_delete@alpha_bot"));
  await run(f.update(member,chat,"/topic_delete@alpha_bot https://t.me/c/2345/3"));
  await run(f.update(member,chat,"/topic_delete@alpha_bot https://t.me/c/1234/3"));
  memberStatus="administrator";
  await run(f.update(member,chat,"/topic_delete@alpha_bot https://t.me/c/1234/3"));
  assert.equal(writes("deleteForumTopic").length,0);
  mayDelete=true;
  const deletion=f.update(member,chat,"/topic_delete@alpha_bot https://t.me/c/1234/3");
  await Promise.all([run(deletion),run(deletion)]);
  assert.deepEqual(writes("deleteForumTopic").map(row=>[row.id,row.body.message_thread_id]),[[chat,topic]]);
  assert(f.store.get(`group:policy:${second}:${topic}`));
  assert(writes("sendMessage").every(row=>!row.body.reply_markup));
});

test("inherited bindings require a distinct isolated executor for the exact topic",()=>{
  const groupKey="BB_TELEGRAM_GROUP_EXECUTORS",privateKey="BB_TELEGRAM_PRIVATE_EXECUTORS";
  const savedGroup=process.env[groupKey],savedPrivate=process.env[privateKey];
  const selected={cli:"/fixture/group/alpha",projectId:"group-alpha",threadId:"thread-alpha"};
  const target=`${chat}:${topic}`,sibling=`${chat}:${topic+1}`;
  try {
    delete process.env[privateKey];
    process.env[groupKey]=JSON.stringify({[target]:selected});
    assert.equal(groupExecutor(chat,topic,true)?.threadId,selected.threadId);
    assert.equal(groupExecutor(second,topic,true),undefined);
    assert.equal(groupExecutor(chat,topic+1,true),undefined);
    process.env[groupKey]=JSON.stringify({[target]:selected,[sibling]:{...selected,threadId:"thread-beta"}});
    assert.throws(()=>groupExecutor(chat,topic,true),/distinct_executor/);
    process.env[privateKey]=JSON.stringify({"5:7:8":{...selected}});
    assert.throws(()=>groupExecutor(chat,topic,true),/private_worker_isolation_required/);
  } finally {
    if (savedGroup===undefined) delete process.env[groupKey]; else process.env[groupKey]=savedGroup;
    if (savedPrivate===undefined) delete process.env[privateKey]; else process.env[privateKey]=savedPrivate;
  }
});

// ---------- С54 / П29: picking up new topics by default; a topic with an archived thread ----------
import {forumAutoKey,forumAutoOffKey,forumDefaults,reviveArchivedForumTopic} from "../forum-defaults";

function plainStore() {
  const rows=new Map<string,unknown>();
  const store:Store={get:key=>structuredClone(rows.get(key)) as never,put:(key,value)=>{rows.set(key,structuredClone(value));},
    del:key=>{rows.delete(key);},atomic:fn=>fn(),
    list:prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never}))};
  return store;
}
const employeeTopic=(store:Store,topicId:number,extra:Partial<GroupTopicPolicy>={})=>{
  const p:GroupTopicPolicy={botId:5,botUsername:"alpha_bot",ownerId:owner,chatId:chat,topicId,threadId:`emp-${topicId}`,
    requireMention:true,ownerOnly:false,includeTopicContext:true,allowedSenderIds:[],inOwnerProject:true,revision:`r-${topicId}`,
    acceptAfterSecond:1000+topicId,...extra} as GroupTopicPolicy;
  bindGroupTopic(store,p,"employee-project");
  return p;
};
const topicMessage=(topicId:number,created?:boolean)=>({update_id:900+topicId,message:{message_id:900+topicId,date:now,
  chat:forum(chat),from:{id:member,first_name:"M"},message_thread_id:topicId,is_topic_message:true,text:"hi",
  ...(created ? {forum_topic_created:{name:"Новая тема"},message_id:topicId} : {})}});

test("С54: a group bound before the update picks up a new topic by default, with the group's mention rule", () => {
  const store=plainStore();
  employeeTopic(store,2); employeeTopic(store,17);            // stored by an older bridge: no defaults key at all
  const d=forumDefaults(store,5,owner,chat);
  assert.equal(d?.implicit,true);
  assert.equal(d?.source.topicId,17);                          // the latest bound topic is the template
  const topic=describeForumTopic(store,5,owner,topicMessage(40));   // a topic created by hand, creation unseen
  const inherit=inheritableForumTopic(store,5,owner,topic);
  assert.ok(inherit);
  const policy=inheritedForumPolicy(inherit.source,40,{threadId:"new",projectId:"employee-project"},"rev");
  assert.equal(policy.requireMention,true);                     // answering with or without mention is unchanged
  assert.equal(policy.inOwnerProject,true);
});

test("С54: the pickup can be turned off for the bridge or for one group; an unbound topic stays unbound", () => {
  const store=plainStore();
  employeeTopic(store,2);
  store.put(forumAutoOffKey(5,chat),true);
  assert.equal(forumDefaults(store,5,owner,chat),undefined);
  store.del(forumAutoOffKey(5,chat));
  store.put(forumAutoKey,false);
  assert.equal(forumDefaults(store,5,owner,chat),undefined);
  store.put(forumAutoKey,true);
  store.put(`group:forum-opt-out:5:${chat}:41`,true);          // a topic unbound on purpose
  assert.equal(inheritableForumTopic(store,5,owner,describeForumTopic(store,5,owner,topicMessage(41))),undefined);
});

test("С54: a separate-executor topic is not a template; explicit defaults keep their boundary", () => {
  const store=plainStore();
  employeeTopic(store,3,{isolated:true,inOwnerProject:undefined});
  assert.equal(forumDefaults(store,5,owner,chat),undefined);
});

test("П29: a topic whose thread was archived gets a new thread with the same settings", async () => {
  const store=plainStore();
  const p=employeeTopic(store,21,{ownerSharedProject:true,inOwnerProject:undefined,requireMention:false,ownerOnly:true,
    projectId:"assistant"} as never);
  const bound:GroupTopicPolicy[]=[];
  const spawned:any[]=[];
  const threads={
    get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"employee-project",environmentId:"env",providerId:"claude-code",
      title:"Master Marketplace",archivedAt:threadId===p.threadId ? "2026-11-23" : null}),
    spawn:async(a:any)=>{spawned.push(a);return {id:"fresh",projectId:a.projectId};},
  };
  const deps={owner,bot:5,check:async()=>{},current:()=>true,signal:new AbortController().signal,threads,
    bind:(policy:GroupTopicPolicy)=>{bound.push(policy);}};
  const live=store.get<GroupTopicPolicy>(`group:policy:${chat}:21`);
  assert.equal(await reviveArchivedForumTopic(store,deps,{chat,topic:21,policy:live,metadata:{name:"Master Marketplace"}}),true);
  assert.equal(spawned[0].environment.environmentId,"env");
  assert.equal(spawned[0].providerId,"claude-code");
  assert.deepEqual([bound[0].threadId,bound[0].requireMention,bound[0].ownerOnly,bound[0].acceptAfterSecond],
    ["fresh",false,true,live.acceptAfterSecond]);
  bound.length=0;
  const active={...live,threadId:"alive"};
  assert.equal(await reviveArchivedForumTopic(store,deps,{chat,topic:21,policy:active}),false);   // not archived: nothing
  assert.equal(bound.length,0);
});
