import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {openTopicSearch,historyPrefix,historyCutoff} from "../topic-search";

test("SQLite topic search isolates topics, old revisions, time and future messages",()=>{
 const db=new Database(":memory:");
 try {
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const h=openTopicSearch(db);
  const put=db.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const a=historyPrefix(-100123,3), b=historyPrefix(-100123,30);
  const add=(scope:string,id:number,text:string,date=historyCutoff()+100)=>put.run(scope+id,JSON.stringify({id,text,name:"Виктор",date}));
  add(a,3,"Смета Чистополь 4500");add(b,6,"Чистополь 100");add(a,31,"Чистополь другая версия");add(a,4,"Чистополь архив",historyCutoff()-1);
  assert.deepEqual(h.find(a,"@bot найди Чистополь",30).map(m=>m.id),[3]);
  add(a,3,"согласовали Елабугу");assert.deepEqual(h.find(a,"Чистополь",30),[]);
  assert.equal(h.find(a,'Елабугу + * " OR',30)[0]?.id,3);
  add(a,7,"приложение ".repeat(240)+"контрольная сумма 917");
  assert.match(h.find(a,"контрольная",30)[0].text.slice(0,900),/контрольная сумма 917/);
  h.prune();assert.equal(db.prepare("SELECT 1 FROM state WHERE key=?").get(a+4),undefined);
  db.prepare("DELETE FROM state WHERE key=?").run(a+3);assert.deepEqual(h.find(a,"Елабугу",30),[]);
  assert.equal(openTopicSearch(db).find(b,"Чистополь",30)[0]?.id,6);
 } finally {db.close();}
});

import {acceptGroupUpdate,type GroupTopicPolicy} from "../ingress";
import type {Store} from "../model";

test("a permitted mention gets an older passage from its topic, with no ambient model work",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 try {
  const history=openTopicSearch(db);
  const store:Store={
   get(k){const row=db.prepare("SELECT value FROM state WHERE key=?").get(k) as {value:string}|undefined;return row && JSON.parse(row.value);},
   put(k,v){db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,JSON.stringify(v));},
   del(k){db.prepare("DELETE FROM state WHERE key=?").run(k);},
   list(){throw Error("unexpected scan");},atomic(f){db.transaction(f)();},findTopicHistory:history.find,
  };
  const p:GroupTopicPolicy={chatId:-100123,topicId:3,threadId:"t",ownerOnly:true,requireMention:true,includeTopicContext:true,searchableHistory:true,botId:1,botUsername:"bot"};
  store.put("group:policy:-100123:3",p);
  function send(id:number,text:string,edit=false){
   acceptGroupUpdate(store,{update_id:edit?32:id,[edit?"edited_message":"message"]:{chat:{type:"supergroup",id:p.chatId},message_id:id,message_thread_id:3,from:{id:2},
    date:Math.floor(Date.now()/1000),text,entities:text.startsWith("@bot")?[{type:"mention",offset:0,length:4}]:[]}},2,1);
  }
  send(1,"Смета Меркурий 3000");for(let id=2;id<=31;id++) send(id,"другой разговор");
  send(1,"Смета Меркурий 4500",true);
  assert.equal(db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'group:in:*'").get()?.n,0);
  send(33,"@bot какая смета Меркурий?");
  const job=store.get<{route:{text:string}}>("group:in:1:33")!;
  assert.match(job.route.text,/4500/);assert.doesNotMatch(job.route.text,/3000/);assert.match(job.route.text,/t.me\/c\/123\/1/);
 } finally {db.close();}
});

test("permanent group history survives cleanup and remains scoped to a group without topics",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 try{
  const h=openTopicSearch(db),scope=historyPrefix(-11,0);
  db.prepare("INSERT INTO state VALUES(?,?)").run(scope+42,JSON.stringify({id:42,sender:1,name:"Автор",text:"архив Java",date:1,permanent:true}));
  h.prune();assert.equal(h.find(scope,"Java",50)[0].id,42);
  assert.equal(h.find(historyPrefix(-12,0),"Java",50).length,0);
 }finally{db.close();}
});
