import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {acceptGroupUpdate,routeUpdate,type GroupTopicPolicy} from "../ingress";
import {bindGroupTopic,processGroupInputs} from "../group-worker";
import {historyPrefix,openTopicSearch} from "../topic-search";
import type {Store} from "../model";

function fixture(isolated:boolean,topicId:number) {
  const owner=7,bot=9,participant=10,chatId=topicId ? -1009876543 : -7654321;
  const chat={id:chatId,type:topicId ? "supergroup" : "group",is_forum:!!topicId};
  const db=new Database(":memory:");
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const search=openTopicSearch(db);
  const store:Store={
    get(key){
      const row=db.prepare("SELECT value FROM state WHERE key=?").get(key) as {value:string}|undefined;
      return row && JSON.parse(row.value);
    },
    put(key,value){db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(key,JSON.stringify(value));},
    del(key){db.prepare("DELETE FROM state WHERE key=?").run(key);},
    list(prefix){
      const rows=db.prepare("SELECT key,value FROM state WHERE key GLOB ?").all(prefix+"*") as {key:string;value:string}[];
      return rows.map(({key,value})=>({key,value:JSON.parse(value)}));
    },
    atomic(fn){db.transaction(fn)();},
    findTopicHistory:search.find,
  };
  let sequence=10;
  const policy:GroupTopicPolicy={chatId,topicId,ownerId:owner,botId:bot,botUsername:"fixture_bot",
    threadId:"group-worker",ownerOnly:true,allowedSenderIds:isolated?[participant]:[],requireMention:true,addressName:"Вахтенный",
    isolated,includeTopicContext:true,searchableHistory:true,revision:"origin"};
  bindGroupTopic(store,policy,"group-project");
  const sibling={...policy,topicId:5,threadId:"sibling-worker",revision:"sibling"};
  const other={...policy,chatId:-1008765432,threadId:"other-worker",revision:"other",addressName:"Другой",
    ownerOnly:true,allowedSenderIds:[]};
  bindGroupTopic(store,sibling,"sibling-project");
  bindGroupTopic(store,other,"other-project");
  const post=(text:string,sender=participant,extra:object={})=>acceptGroupUpdate(store,{update_id:++sequence,message:{
    message_id:sequence,chat,is_topic_message:!!topicId,message_thread_id:topicId||undefined,date:Math.floor(Date.now()/1000)+2,
    from:{id:sender,first_name:sender===owner?"Михаил":"Денис"},text,...extra,
  }},owner,bot);
  const mention=[{type:"mention",offset:0,length:"@fixture_bot".length}];
  const reply_to_message={chat,from:{id:bot},message_thread_id:topicId||undefined,message_id:8,text:"Какой вопрос?"};
  const jobs=()=>store.list<{route:{text:string;threadId:string;examples?:unknown[]}}>("group:in:");
  return {owner,bot,participant,chat,post,mention,reply_to_message,jobs,policy,store,search,db};
}

for (const topicId of [0,3]) for (const isolated of [false,true]) {
  test(`group scope ${topicId}: mentions, replies and opt-in names preserve privacy (isolated=${isolated})`,()=>{
    const f=fixture(isolated,topicId);
    try {
      const privateMarker="SYNTHETIC_PRIVATE_LEDGER_61";
      const siblingMarker="SYNTHETIC_SIBLING_LEDGER_73";
      const otherGroupMarker="SYNTHETIC_OTHER_LEDGER_85";
      const dm={message_id:1,text:"Сколько составила выручка? Маркер "+privateMarker,
        chat:{id:f.owner,type:"private"},from:{id:f.owner}};
      assert.equal(routeUpdate({update_id:1,message:dm},f.owner).kind,"chat");
      f.store.put("chat:in:1",{input:dm});
      f.post("выручка "+siblingMarker,f.owner,{message_thread_id:5});
      f.post("выручка "+otherGroupMarker,f.owner,{chat:{...f.chat,id:-1008765432}});
      f.post("Другой, какая выручка?",f.participant,{chat:{...f.chat,id:-1008765432}});
      f.post("выручка обсуждалась раньше. Объявили только дату закрытия.",f.owner);
      for (let i=0;i<26;i++) f.post("Повседневная реплика "+i);
      f.post("Михаил, сколько заработал? Какая выручка?");
      f.post("Не скажу",f.owner);
      f.post("Я спросил вахтенного, посмотрим.");
      f.post("Вахтенный знает правила");
      f.post("Он написал: «Вахтенный, помоги»");
      f.post("Вахтенный, какая выручка?",f.participant,{forward_origin:{type:"user"}});
      assert.deepEqual(f.jobs(),[]);
      for (const [text,extra] of [
        ["@fixture_bot какая выручка?",{entities:f.mention}],
        ["Какая выручка?",{reply_to_message:f.reply_to_message}],
        ["Вахтенный, какая выручка?",{}],
      ] as const) f.post(text,f.participant,extra);
      assert.equal(f.jobs().length,isolated?3:0);
      if (!isolated) f.post("@fixture_bot какая выручка?",f.owner,{entities:f.mention});
      for (const {value:{route}} of f.jobs()) {
        assert.equal(route.threadId,"group-worker");
        assert.match(route.text,/Не скажу/);
        assert.match(route.text,/объявили только дату закрытия/iu);
        assert.doesNotMatch(route.text,new RegExp([privateMarker,siblingMarker,otherGroupMarker].join("|")));
        assert.equal(route.examples,undefined);
      }
      const history=JSON.stringify(f.search.find(historyPrefix(f.chat.id,topicId),"выручка",Number.MAX_SAFE_INTEGER));
      assert.match(history,/выручка/);
      for (const marker of [privateMarker,siblingMarker,otherGroupMarker]) {
        assert.doesNotMatch(history,new RegExp(marker));
        assert.deepEqual(f.search.find(historyPrefix(f.chat.id,topicId),marker,Number.MAX_SAFE_INTEGER),[]);
      }
    } finally { f.db.close(); }
  });
}

test("the same named topic in two work supergroups sends only its own bytes and answer to its chat",async()=>{
  const f=fixture(false,3);
  const second={...f.chat,id:-1001237654};
  const p={...f.policy,chatId:second.id,threadId:"second-thread",revision:"second",
    ownerTopicManagerProjectId:"owner-project"};
  bindGroupTopic(f.store,{...f.policy,ownerTopicManagerProjectId:"owner-project"},"group-project");
  bindGroupTopic(f.store,p,"group-project");
  const fixturePixels={first:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",second:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"};
  try {
    for (const [chat,label] of [[f.chat,"first"],[second,"second"]] as const) {
      f.post("Контекст "+label,f.owner,{chat});
      f.post("@fixture_bot проверь",f.owner,{chat,text:undefined,caption:"@fixture_bot проверь",
        caption_entities:f.mention,photo:[{file_id:label}]});
    }
    const turns=new Map<string,any[]>();
    const events=new Map<string,any[]>();
    const sdk={threads:{get:async({threadId}:any)=>({id:threadId,projectId:"group-project",visibility:"visible"}),
      events:{list:async(q:any)=>(events.get(q.threadId)??[]).filter(e=>e.seq>Number(q.afterSeq??0))},
      send:async(q:any)=>{
        turns.set(q.threadId,q.input);
        const seq:any[]=[];
        const add=(type:string,data:object)=>seq.push({type,data,seq:seq.length+1,scope:{kind:"turn",turnId:q.threadId}});
        add("client/turn/requested",{requestId:q.threadId,originPluginId:"telegram-projects",input:q.input});
        add("turn/input/accepted",{clientRequestId:q.threadId});
        add("item/completed",{item:{type:"agentMessage",text:"result "+q.threadId}});
        add("turn/completed",{status:"completed"});
        events.set(q.threadId,seq);
      }}};
    const sent:any[]=[];
    const tick=()=>processGroupInputs(f.store,sdk as never,f.owner,f.bot,id=>async <T>(method:string,payload:any)=>{
      assert.equal(method,"sendMessage");
      sent.push({id,...payload});
      return {message_id:200} as T;
    },new AbortController().signal,undefined,undefined,async file=>{
      const label=file.fileId as keyof typeof fixturePixels;
      return {type:"image",url:fixturePixels[label]};
    });
    await tick();await tick();
    for (const [thread,label,chat] of [["group-worker","first",f.chat],["second-thread","second",second]] as const) {
      const input=turns.get(thread)!;
      assert.match(input[0].text,new RegExp("Контекст "+label));
      assert.doesNotMatch(input[0].text,new RegExp("Контекст "+(label==="first"?"second":"first")));
      assert.deepEqual(input.filter(x=>x.type==="image"),[{type:"image",url:fixturePixels[label]}]);
      assert.equal(sent.filter(m=>m.id===chat.id).length,1);
      assert.equal(sent.find(m=>m.id===chat.id).message_thread_id,3);
      assert.equal(sent.find(m=>m.id===chat.id).text,"result "+thread);
    }
  } finally { f.db.close(); }
});
