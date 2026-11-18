import test from "node:test";
import assert from "node:assert/strict";
import {channelPost} from "../channel-post";
import type {Store,Telegram} from "../model";

test("channel receipts survive retries and restrict subsequent changes to owned messages",async()=>{
  const rows=new Map(), methods:string[]=[];
  const store:Store={get:k=>rows.get(k),put:(k,v)=>{rows.set(k,v)},del:k=>{rows.delete(k)},atomic:f=>f(),list:()=>[]};
  const tg:Telegram=async <T>(method:string,params?:any)=>{
    if(method==="getChat")return {id:-4,type:"channel"} as T;
    if(method==="getChatMember")return {status:"administrator",can_post_messages:true,can_edit_messages:true} as T;
    methods.push(method);return (method==="deleteMessage"?true:{message_id:8,chat:{type:"channel",id:-4}}) as T};
  const base={operationId:"one",channelId:-4,threadId:"t",routeToken:"marker"};
  const post={...base,action:"publish" as const,text:"hello"};
  await assert.rejects(channelPost(store,tg,2,3,"9:2:-4",post),/not_configured/);
  await assert.rejects(channelPost(store,tg,2,3,"3:2:-4",{...base,action:"delete",messageId:8}),/not_owned/);
  for(let i=0;i<2;i++)assert.deepEqual(await channelPost(store,tg,2,3,"3:2:-4",post),{messageId:8});
  await assert.rejects(channelPost(store,tg,2,3,"3:2:-4",{...post,text:"changed"}),/conflict/);
  await channelPost(store,tg,2,3,"3:2:-4",{...base,operationId:"two",action:"edit",messageId:8,text:"changed"});
  await channelPost(store,tg,2,3,"3:2:-4",{...base,operationId:"three",action:"delete",messageId:8});
  assert.deepEqual(methods,["sendMessage","editMessageText","deleteMessage"]);
  await channelPost(store,tg,2,3,"3:2:-4",{...base,operationId:"manual",action:"edit",manual:true,messageId:8,text:"manual edit"});
  await assert.rejects(channelPost(store,tg,2,3,"3:2:-4",{...base,operationId:"manual-delete",action:"delete",messageId:8}),/not_owned/);
  const failed={...post,operationId:"unknown"};
  await assert.rejects(channelPost(store,async(method,params)=>{if(method==="sendMessage")throw Error("timeout");return tg(method,params)},2,3,"3:2:-4",failed),/timeout/);
  await assert.rejects(channelPost(store,tg,2,3,"3:2:-4",failed),/unconfirmed/);
});
