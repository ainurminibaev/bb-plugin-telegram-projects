import test from "node:test";
import assert from "node:assert/strict";
import {albumChanged,albumKey,albumQuietMs,collectAlbum,copyAlbum,maxAlbumItems,releaseAlbums,sendAlbum} from "../media-album";
import type {Store,Telegram} from "../model";

function fixture() {
  const rows=new Map<string,unknown>();
  const store:Store={get:key=>structuredClone(rows.get(key)) as never,
    put:(key,value)=>{rows.set(key,structuredClone(value));}, del:key=>{rows.delete(key);},
    list:prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never})),
    atomic:fn=>fn()};
  return {rows,store};
}

for (const kind of ["photo","document"]) test(`${kind} album survives reorder, restart, repeated update and repeated file IDs`,()=>{
  const {store,rows}=fixture();
  const prefix="album:";
  const key=albumKey(prefix,[5,7,3,21],"bundle");
  const capture=(messageId:number,updateId:number,now:number)=>collectAlbum(store,key,
    {messageId,updateId,fileId:messageId===32?"distinct":"shared",kind},now);
  capture(33,101,100);
  capture(31,102,200);
  capture(33,101,250);
  let jobs:{messageId:number;fileId:string}[][]=[];
  const flush=(now:number)=>releaseAlbums<{messageId:number;updateId:number;fileId:string}>(store,prefix,(items,_,changed)=>{
    assert.equal(changed,false);
    jobs.push(items);
    return items[0].messageId;
  },now);
  flush(200+albumQuietMs-1);
  assert.equal(jobs.length,0);
  // The timer expired but a restarted consumer has not released the persisted row.
  capture(32,103,200+albumQuietMs+500);
  flush(200+2*albumQuietMs+500);
  assert.deepEqual(jobs.map(j=>j.map(x=>[x.messageId,x.fileId])),[[[31,"shared"],[32,"distinct"],[33,"shared"]]]);
  assert.equal(capture(33,101,10_000),undefined);
  assert.equal(albumChanged(store,key),false);
  assert.equal(capture(34,104,10_001),31);
  assert.equal(capture(34,104,10_002),undefined);
  assert.equal(albumChanged(store,key),true);
  flush(11_000);
  assert.equal(jobs.length,1);
  assert.doesNotMatch(JSON.stringify([...rows.values()]),/shared|distinct/);
  assert.notEqual(albumKey(prefix,[5,7,4,21],"bundle"),key);
  assert.notEqual(albumKey(prefix,[6,7,3,21],"bundle"),key);
});

test("more than Telegram's ten positions invalidates the assembled album",()=>{
  const {store}=fixture();
  const key=albumKey("album:",[1,2,3],"bundle");
  for (let i=1;i<=maxAlbumItems+1;i++) collectAlbum(store,key,{messageId:i,updateId:i},100);
  releaseAlbums(store,"album:",(items,_key,changed)=>{
    assert.equal(items.length,maxAlbumItems);
    assert.equal(changed,true);
    return items[0].messageId;
  },3000);
});

test("copyMessages retains grouping contract, order and captures partial receipt without reply parameters",async()=>{
  let calls=0;
  const receipt=await copyAlbum(async <T>(method:string,body:Record<string,unknown>)=>{
    calls++;
    assert.equal(method,"copyMessages");
    assert.deepEqual(body,{chat_id:7,message_thread_id:3,from_chat_id:7,message_ids:[10,12,17]});
    return [{message_id:31},{message_id:32}] as T;
  },{chatId:7,topicId:3},{chatId:7,messageIds:[17,10,12]});
  assert.deepEqual(receipt,{messageIds:[31,32],complete:false});
  assert.equal(calls,1);
});

test("sendMediaGroup rejects mixed media, partial results and missing native reply",async()=>{
  const target={chatId:-7,topicId:3,replyTo:126};
  const files=[{kind:"photo" as const,data:"synthetic-1",caption:"Первая"},
    {kind:"photo" as const,data:"synthetic-1",caption:"Вторая"},
    {kind:"photo" as const,data:"synthetic-2"}];
  const transport=(count:number,hasReply:boolean):Telegram=>async <T>(method:string,body:Record<string,unknown>)=>{
    assert.equal(method,"sendMediaGroup");
    assert.deepEqual(body.reply_parameters,{message_id:126,allow_sending_without_reply:false});
    assert.deepEqual(body.media,files.map(x=>({type:"photo",media:x.data,...(x.caption && {caption:x.caption})})));
    return files.slice(0,count).map((f,i)=>({chat:{id:-7},message_thread_id:3,message_id:20+i,media_group_id:"fixture",
      photo:[{file_id:f.data}],...(hasReply && i===0 && {reply_to_message:{message_id:126}})})) as T;
  };
  await assert.rejects(sendAlbum(transport(3,true),target,[...files.slice(0,2),{kind:"document",data:"doc"}]),/invalid_album/);
  await assert.rejects(sendAlbum(transport(2,true),target,files),/unconfirmed_album/);
  await assert.rejects(sendAlbum(transport(3,false),target,files),/unconfirmed_album/);
  assert.deepEqual((await sendAlbum(transport(3,true),target,files)).messageIds,[20,21,22]);
});

test("an album without a reply in a forum topic is confirmed though Telegram marks it a reply to the topic's root",async()=>{
  const files=[{kind:"document" as const,data:new Blob(["a"]),name:"a.txt"},{kind:"document" as const,data:new Blob(["bb"]),name:"b.txt"}];
  const tg=(async <T>(_m:string,_b:Record<string,unknown>)=>files.map((f,i)=>({chat:{id:-7},message_thread_id:3,message_id:40+i,
    media_group_id:"g",document:{file_id:"f"+i,file_name:f.name,file_size:(f.data as Blob).size},reply_to_message:{message_id:3}})) as T) as Telegram;
  const r=await sendAlbum(tg,{chatId:-7,topicId:3,replyTo:0},files);
  assert.deepEqual(r.messageIds,[40,41]);
});

test("Telegram's own spelling of a file name (spaces → «_») is a confirmed album, not an unconfirmed one",async()=>{
  const files=[{kind:"document" as const,data:new Blob(["a"]),name:"сопроводительное План _ Клиент.md"},
    {kind:"document" as const,data:new Blob(["bb"]),name:"записка.md"}];
  const stored=["сопроводительное_План_Клиент.md","записка.md"];
  const tg=(async <T>()=>files.map((f,i)=>({chat:{id:-7},message_thread_id:3,message_id:50+i,media_group_id:"g",
    document:{file_id:"f"+i,file_name:stored[i],file_size:(f.data as Blob).size},reply_to_message:{message_id:3}})) as T) as Telegram;
  assert.deepEqual((await sendAlbum(tg,{chatId:-7,topicId:3,replyTo:0},files)).messageIds,[50,51]);
});
