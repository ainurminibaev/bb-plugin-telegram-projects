import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate,type GroupTopicPolicy} from "../ingress";
import {sharedGroupThreads,sharedOwnerForum} from "../group-binding";
import {bindGroupTopic,groupCliRestricted,processGroupInputs} from "../group-worker";
import {saveGroupSettings,setAccess} from "../rights";
import type {Store,Telegram} from "../model";

const owner=7,bot=9;
const chat={type:"supergroup",id:-1007654321,is_forum:true};
const project="personal-project";
const policy:GroupTopicPolicy={chatId:chat.id,topicId:3,threadId:"topic-a",botId:bot,botUsername:"bot",ownerId:owner,
  ownerOnly:true,ownerSharedProject:true,requireMention:true,revision:"rev-a"};
const key=`group:policy:${chat.id}:3`;

function fixture() {
  const state=new Map<string,unknown>();
  const store:Store={
    get:key=>structuredClone(state.get(key)) as never,
    put:(key,value)=>{state.set(key,structuredClone(value));},
    del:key=>{state.delete(key);},
    list:prefix=>[...state].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never})),
    atomic:fn=>fn(),
  };
  store.put("chat:binding:0",{projectId:project,threadId:"private"});
  store.put("private:project:"+project,true);
  let sequence=100;
  const post=(extra:object={})=>acceptGroupUpdate(store,{update_id:++sequence,message:{
    message_id:sequence,chat,is_topic_message:true,message_thread_id:3,from:{id:owner},
    text:"@bot Проверь",date:Math.floor(Date.now()/1000)+2,
    entities:[{type:"mention",offset:0,length:4}],...extra,
  }},owner,bot);
  return {store,post};
}

test("only an exclusive private forum with the paired owner and bot qualifies",async()=>{
  for (const {membership=2,extra={},ownerRole="creator",ok=false} of [
    {ok:true},{membership:3},{extra:{active_usernames:["public"]}},
    {extra:{linked_chat_id:-10017}},{extra:{is_forum:false}},{ownerRole:"administrator"},
  ]) {
    const tg:Telegram=async <T>(method:string,args:Record<string,unknown>)=>{
      assert.equal(args.chat_id,chat.id);
      if (method==="getChat") return {...chat,...extra} as T;
      if (method==="getChatMemberCount") return membership as T;
      assert.equal(method,"getChatMember");
      return (args.user_id===owner ? {user:{id:owner},status:ownerRole} :
        {user:{id:bot,is_bot:true},status:"administrator"}) as T;
    };
    assert.equal(await sharedOwnerForum(tg,chat.id,owner,bot),ok);
  }
});

test("shared binding keeps the private project visible and protects existing or former private and group threads",async()=>{
  const {store}=fixture();
  assert.throws(()=>bindGroupTopic(store,{...policy,ownerSharedProject:undefined},project),/private_thread_or_project/);
  assert.throws(()=>bindGroupTopic(store,{...policy,threadId:"private"},project),/private_thread_or_project/);
  store.put("reply:watch:older",{threadId:"former-private"});
  assert.throws(()=>bindGroupTopic(store,{...policy,threadId:"former-private"},project),/private_thread_or_project/);
  for (const extra of [{ownerOnly:false},{allowedSenderIds:[20]},{isolated:true},{topicId:0},{deliverySources:["private-source"]}]) {
    assert.throws(()=>bindGroupTopic(store,{...policy,...extra},project),/private_owner_forum_binding_required/);
  }
  bindGroupTopic(store,policy,project);
  bindGroupTopic(store,{...policy,topicId:4,threadId:"topic-b",revision:"rev-b"},project);
  assert.equal(store.get("group:project:"+project),undefined);
  assert.equal(store.get<{threadId:string}>("chat:binding:0")?.threadId,"private");
  assert.equal(groupCliRestricted(store,project,"private"),false);
  assert.equal(groupCliRestricted(store,project,"topic-a"),true);
  const threads={experimental_listAncestors:async()=>({threads:[
    {threadId:"private",ancestorIds:[]},{threadId:"private-child",ancestorIds:["private"]},
    {threadId:"topic-child",ancestorIds:["topic-b"]},
  ]})};
  assert.deepEqual(await sharedGroupThreads(store,threads as never,
    ["topic-a","topic-child","private","private-child","unknown"]),new Set(["topic-a","topic-child","unknown"]));
  store.del(key);
  assert.throws(()=>bindGroupTopic(store,{...policy,ownerSharedProject:undefined},"elsewhere"),/cannot_change_audience/);
});

test("shared topic accepts only original scoped owner input, even with permissive rights elsewhere",()=>{
  const {store,post}=fixture();
  bindGroupTopic(store,{...policy,includeTopicContext:true,searchableHistory:true},project);
  saveGroupSettings(store,bot,chat.id,{who:"all",members:"read",reply:"auto"});
  setAccess(store,bot,[{id:22,name:"Granted elsewhere"}]);
  for (const rejected of [
    {from:{id:22},photo:[{file_id:"secret.png"}]}, {from:{id:99}},
    {from:{id:owner},forward_origin:{type:"user"}},{is_topic_message:false},
    {message_thread_id:4},
  ]) assert.equal(post(rejected),false);
  assert.deepEqual(store.list("group:in:"),[]);
  assert.deepEqual(store.list("group:history:"),[]);
  post({text:"Reply",entities:[],reply_to_message:{chat,from:{id:bot},message_id:5,message_thread_id:4}});
  assert.deepEqual(store.list("group:in:"),[]);
  assert.ok(post({}));
  assert.equal(store.list<{route:{threadId:string}}>("group:in:")[0].value.route.threadId,"topic-a");
});

test("owner-only forum answers return to the exact topic once and stop when its audience changes",async()=>{
  for (const audienceChanges of [false,true]) {
    const {store,post}=fixture();
    bindGroupTopic(store,policy,project);
    post();
    const events:any[]=[];
    const requestId="request-a";
    const turnId="turn-a";
    let sendCount=0,audience=2;
    const sdk={threads:{get:async()=>({id:"topic-a",projectId:project,visibility:"visible",parentThreadId:null}),
      events:{list:async({afterSeq}:any)=>events.filter(e=>e.seq>Number(afterSeq??0))},
      send:async(q:any)=>{
        assert.equal(q.threadId,"topic-a");
        sendCount++;
        const record=(type:string,data:object)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId}});
        record("client/turn/requested",{requestId,originPluginId:"telegram-projects",input:q.input});
        record("turn/input/accepted",{clientRequestId:requestId});
        record("item/completed",{item:{type:"agentMessage",text:"Synthetic private result"}});
        record("turn/completed",{status:"completed"});
        if (audienceChanges) audience=3;
      },
    }};
    const deliveries:object[]=[];
    const transport=()=>async <T>(method:string,payload:object)=>{
      assert.equal(method,"sendMessage");
      deliveries.push(payload);
      return {message_id:201} as T;
    };
    const tick=()=>processGroupInputs(store,sdk as never,owner,bot,transport,new AbortController().signal,
      undefined,undefined,undefined,true,async()=>audience===2);
    await tick();
    await tick();
    assert.equal(sendCount,1);
    assert.deepEqual(deliveries,audienceChanges?[]:[{chat_id:chat.id,message_thread_id:3,
      reply_parameters:{message_id:101,allow_sending_without_reply:false},text:"Synthetic private result",parse_mode:"HTML",link_preview_options:{is_disabled:true}}]);
    assert.equal(store.get<{state:string}>(`group:receipt:${bot}:101`)?.state,audienceChanges?"revoked":"done");
  }
});
