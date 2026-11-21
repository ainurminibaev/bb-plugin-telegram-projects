import test from "node:test";
import assert from "node:assert/strict";
import {handleOwnerForumCommand} from "../forum-commands";
import {bindGroupTopic} from "../group-worker";
import {ownerTopicTool} from "../owner-topic";
import {acceptGroupUpdate} from "../ingress";
import {historyPrefix} from "../topic-search";
import {isTopicPaused,topicStateKey} from "../topic-lifecycle";
import {TelegramFailure,type Store,type Telegram} from "../model";

const owner=7,bot=5,first=-1004242,second=-1009898,topic=3,project="personal";
const topicLink=(chat:number)=>"https://t.me/c/"+String(chat).slice(4)+"/3";

function fixture() {
  const storage=new Map<string,unknown>();
  const store:Store={
    get:key=>structuredClone(storage.get(key)) as never,
    put:(key,value)=>{storage.set(key,structuredClone(value));},
    del:key=>{storage.delete(key);},
    list:prefix=>[...storage].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as never})),
    atomic:fn=>fn(),
  };
  const main={projectId:project,threadId:"existing-private"};
  for (const chat of [first,second]) {
    bindGroupTopic(store,{chatId:chat,topicId:topic,threadId:"seed-"+chat,ownerSharedProject:true,ownerId:owner,
      botId:bot,botUsername:"fixture_bot",ownerOnly:true,requireMention:false,revision:"binding-"+chat},project);
    store.put(`group:managed-topic:${bot}:${chat}:${topic}`,{title:"Проверка"});
    store.put(historyPrefix(chat,topic)+"8",{text:"old history"});
    store.put(`group:context:${chat}:${topic}`,[{id:8,text:"context"}]);
  }
  let seq=30,outgoing=100;
  const calls:{destination:number;method:string;body:any;id:number}[]=[];
  const rights={manageOwner:true,manageBot:true,deleteBot:true,deleteOwner:true,audience:2,duplicateNames:true,fail:""};
  const names=(id:number)=>rights.duplicateNames?"Один форум":id===first?"Первый форум":"Второй форум";
  const transport=(destination:number):Telegram=>async <T>(method:string,body:any)=>{
    if (body.chat_id!==undefined) assert.equal(body.chat_id,destination);
    calls.push({destination,method,body,id:++outgoing});
    if (method==="getChat") return {id:destination,type:"supergroup",is_forum:true,title:names(destination)} as T;
    if (method==="getChatMemberCount") return rights.audience as T;
    if (method==="getChatMember") return (body.user_id===owner ?
      {user:{id:owner},status:rights.manageOwner?"creator":"member",can_delete_messages:rights.deleteOwner} :
      {user:{id:bot,is_bot:true},status:"administrator",can_manage_topics:rights.manageBot,can_delete_messages:rights.deleteBot}) as T;
    if (method==="getMe") return {id:bot,is_bot:true,username:"fixture_bot"} as T;
    if (method==="createForumTopic") return {message_thread_id:22} as T;
    if (method==="sendMessage") return {chat:{id:destination},message_thread_id:body.message_thread_id,message_id:outgoing} as T;
    if (method==="answerCallbackQuery") return true as T;
    if (["deleteForumTopic","closeForumTopic","reopenForumTopic"].includes(method)) {
      if (rights.fail==="ambiguous") throw new TelegramFailure("telegram_network",30,true);
      if (rights.fail==="rejected") throw new TelegramFailure("telegram_403",30,false);
      return true as T;
    }
    throw Error("unexpected method "+method);
  };
  const sdk={threads:{
    get:async({threadId}:any)=>({id:threadId,projectId:project,environmentId:"same-env",providerId:"codex",visibility:"visible"}),
    spawn:async (body:any)=>{calls.push({destination:0,method:"spawn",body,id:0});return {id:"created-topic",projectId:project};},
  }};
  // The test runs stock topic creation without a live provider or a synthetic agent route.
  const create=ownerTopicTool({store,sdk:sdk as never,identity:async()=>({owner,bot}),transport});
  const deps={store,owner,bot,signal:new AbortController().signal,transport,
    binding:(id:number)=>id===0?main:undefined,current:()=>true,create};
  const since=Math.floor(Date.now()/1000);
  const post=(text:string,extra:object={},messageId=++seq)=>{
    return handleOwnerForumCommand({...deps,since},{update_id:++seq,message:{
      message_id:messageId,chat:{id:owner,type:"private"},from:{id:owner},text,date:since,
      entities:[{type:"bot_command",offset:0,length:text.split(/\s/)[0].length}],...extra,
    }});
  };
  const oldCard=()=>handleOwnerForumCommand(deps,{callback_query:{
    id:"old",from:{id:owner},message:{message_id:33,chat:{id:owner,type:"private"},from:{id:bot}},
    data:"ft:confirm:"+"a".repeat(32),
  }});
  const groupPost=(chat:number)=>acceptGroupUpdate(store,{update_id:++seq,message:{
    message_id:seq,date:Math.floor(Date.now()/1000)+3,
    chat:{id:chat,type:"supergroup"},is_topic_message:true,message_thread_id:topic,from:{id:owner},text:"Owner topic request",
  }},owner,bot);
  const writes=()=>calls.filter(c=>c.method==="createForumTopic" || c.method==="spawn" ||
    ["deleteForumTopic","closeForumTopic","reopenForumTopic"].includes(c.method) || (c.method==="sendMessage" && c.destination!==owner));
  return {store,calls,rights,post,oldCard,since,groupPost,writes};
}

test("owner command in the same DM creates once, selects the exact forum and uses a new childless BB conversation",async()=>{
  const f=fixture();
  f.rights.duplicateNames=false;
  await f.post("/topic_create Счётчик");
  assert.deepEqual(f.writes(),[]);
  await f.post("/topic_create Счётчик | Второй форум | Начинаем.");
  await f.post("/topic_create Счётчик | Второй форум | Начинаем.");
  assert(!f.calls.some(c=>c.body.reply_markup));
  assert.deepEqual(f.writes().map(c=>c.method),["createForumTopic","spawn","sendMessage"]);
  assert.equal(f.writes()[0].destination,second);
  assert.equal(f.writes()[2].body.text,"Начинаем.");
  assert.equal(f.writes()[2].body.message_thread_id,22);
  assert.equal(f.writes()[1].body.parentThreadId,undefined);
  assert.equal(f.store.get<{threadId:string}>(`group:policy:${second}:22`)?.threadId,"created-topic");
});

test("closing preserves context, reopening allows new work, and the other forum stays independent",async()=>{
  const f=fixture();
  await f.post("/topic_close "+topicLink(first));
  assert.equal(isTopicPaused(f.store,bot,first,topic),true);
  assert.ok(f.store.get(historyPrefix(first,topic)+"8"));
  assert.equal(f.groupPost(first),false);
  assert.equal(f.groupPost(second),true);
  await f.post("/topic_reopen "+topicLink(first));
  assert.equal(isTopicPaused(f.store,bot,first,topic),false);
  assert.equal(f.groupPost(first),true);
  assert.deepEqual(f.writes().map(c=>[c.method,c.destination]),[["closeForumTopic",first],["reopenForumTopic",first]]);
});

test("deletion requires one explicit topic and fresh Telegram permissions",async()=>{
  const f=fixture();
  const command="/topic_delete "+topicLink(second);
  await f.post("/topic_delete Проверка"); // Equal titles alone are ambiguous.
  await f.post("/topic_delete "+topicLink(first)+" "+topicLink(second));
  await f.post(command,{from:{id:9}});
  await f.post(command,{forward_origin:{type:"user"}});
  await f.post(command,{entities:[]});
  await f.post(command,{entities:[{type:"blockquote",offset:0,length:command.length},
    {type:"bot_command",offset:0,length:"/topic_delete".length}]});
  await f.post(command,{date:f.since-1});
  await f.oldCard();
  assert.deepEqual(f.writes(),[]);
  f.rights.deleteBot=false;
  await f.post(command,{},4002);
  assert.deepEqual(f.writes(),[]);
  f.rights.deleteBot=true;
  await f.post(command,{},4002); // Redelivery after gaining rights does not gain authorization.
  assert.deepEqual(f.writes(),[]);
  await Promise.all([f.post(command,{},4003),f.post(command,{},4003)]);
  await f.oldCard();
  assert.deepEqual(f.writes().map(c=>[c.method,c.destination,c.body.message_thread_id]),[["deleteForumTopic",second,topic]]);
  assert(!f.calls.some(c=>c.body.reply_markup));
  assert.equal(f.store.get(historyPrefix(second,topic)+"8"),undefined);
  assert.ok(f.store.get(historyPrefix(first,topic)+"8"));
  assert.equal(f.store.get(topicStateKey(bot,second,topic)),"deleted");
  assert.ok(f.store.get("group:thread:seed-"+second));
});

test("active work and uncertain sends fail without retrying the mutation",async()=>{
  const f=fixture();
  assert.equal(f.groupPost(first),true);
  await f.post("/topic_delete "+topicLink(first));
  assert.deepEqual(f.writes(),[]);
  const other=fixture();
  other.rights.fail="ambiguous";
  await other.post("/topic_delete "+topicLink(first));
  assert.equal(other.store.get(topicStateKey(bot,first,topic)),"uncertain");
  assert.ok(other.store.get(historyPrefix(first,topic)+"8"));
  await other.post("/topic_delete "+topicLink(first));
  assert.equal(other.writes().length,1);
});
