import test from "node:test";
import assert from "node:assert/strict";
import {basicGroupChats,groupMigration,migrateGroupChat} from "../group-migration";
import {acceptGroupUpdate} from "../ingress";

const OWNER=7, BOT=5, OLD=-5486241476, NEW=-1004499219562;
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}

test("a basic group turned into a supergroup keeps its thread, settings and saved conversation",()=>{
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  store.put(`group:policy:${OLD}:0`,{chatId:OLD,topicId:0,threadId:"thr_group",projectId:"p",botId:BOT,botUsername:"bot",
    ownerOnly:true,requireMention:true,ownerId:OWNER,revision:"r",searchableHistory:true,acceptAfterSecond:1});
  store.put("group:thread:thr_group",`group:policy:${OLD}:0`);
  store.put(`rights:${BOT}:group:${OLD}`,{version:2,who:"access",reply:"mention",members:"silent",zones:[],note:"руководители"});
  store.put(`group:history:${OLD}:0:57`,{id:57,text:"срок SVO-62"});
  assert.deepEqual(basicGroupChats(store as any),[OLD]);
  assert.deepEqual(groupMigration({message:{chat:{id:OLD},migrate_to_chat_id:NEW}}),{from:OLD,to:NEW});
  assert.deepEqual(groupMigration({message:{chat:{id:NEW},migrate_from_chat_id:OLD}}),{from:OLD,to:NEW});
  assert.equal(migrateGroupChat(store as any,BOT,OLD,NEW),true);
  assert.equal(migrateGroupChat(store as any,BOT,OLD,NEW),false,"a second notice changes nothing");
  assert.equal(store.get<any>(`group:policy:${NEW}:0`).threadId,"thr_group");
  assert.equal(store.get("group:thread:thr_group"),`group:policy:${NEW}:0`);
  assert.equal(store.get(`group:policy:${OLD}:0`),undefined);
  assert.equal(store.get<any>(`rights:${BOT}:group:${NEW}`).note,"руководители");
  assert.equal(store.get<any>(`group:history:${NEW}:0:57`).text,"срок SVO-62");
  assert.equal(store.get(`rights:${BOT}:announced:${NEW}`),"migrated","no automatic announcement after a move");
  assert.deepEqual(basicGroupChats(store as any),[]);
  const u={update_id:9,message:{message_id:200,date:2_000_000_000,chat:{id:NEW,type:"supergroup"},from:{id:OWNER,first_name:"А"},
    text:"@bot привет",entities:[{type:"mention",offset:0,length:4}]}};
  assert.equal(acceptGroupUpdate(store as any,u,OWNER,BOT),true,"the owner is answered in the General topic");
});
