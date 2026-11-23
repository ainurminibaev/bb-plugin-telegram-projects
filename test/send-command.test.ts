import test from "node:test";
import assert from "node:assert/strict";
import {askNotes,ownerAskNotes,findGroup,findPerson,findTopic,openAsks,rememberAsk,sendRefusal,sendTargets} from "../send-command";
import {setAccess} from "../rights";
import {learnTopicName} from "../forum-defaults";
import {migrateGroupChat} from "../group-migration";

const OWNER=7, BOT=5, TEAM=-1001, OTHER=-1002, ALICE=21, BOB=22;
function memoryStore(){
  const rows=new Map<string,any>();
  return {get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}
function setup(){
  const store=memoryStore();
  store.put(`visibility:${BOT}:group:${TEAM}`,{chat:TEAM,title:"Штурвал"});
  store.put(`visibility:${BOT}:group:${OTHER}`,{chat:OTHER,title:"Склад"});
  setAccess(store as any,BOT,[{id:ALICE,name:"Алиса"},{id:BOB,name:"Боб"}]);
  store.put(`group:policy:${ALICE}:0`,{chatId:ALICE,topicId:0,threadId:"thr_alice",privateChat:true});
  return store;
}
const groupsOf=(p:number)=>p===ALICE ? [TEAM] : [];

test("who may send where follows the calling conversation",()=>{
  const s=setup() as any;
  const no=(caller:any,t:any)=>sendRefusal(s,BOT,OWNER,caller,t,groupsOf);
  assert.equal(no({kind:"owner"},{chat:OTHER,topic:3}),undefined,"owner: any group and topic");
  assert.equal(no({kind:"owner"},{chat:ALICE,topic:0}),undefined,"owner: a person with access who started the bot");
  assert.match(no({kind:"owner"},{chat:BOB,topic:0})!,/person_has_not_started_the_bot/);
  assert.equal(no({kind:"group",chat:TEAM},{chat:TEAM,topic:9}),undefined,"group: its own topics");
  assert.match(no({kind:"group",chat:TEAM},{chat:OTHER,topic:0})!,/group_not_allowed/);
  // С44: from a group, a person's private chat only when the owner asked in this turn; otherwise answer in the group.
  assert.match(no({kind:"group",chat:TEAM},{chat:ALICE,topic:0})!,/person_only_on_the_owners_request_from_a_group/);
  assert.match(sendRefusal(s,BOT,OWNER,{kind:"group",chat:TEAM},{chat:ALICE,topic:0},groupsOf,undefined,ALICE)!,/person_only_on_the_owners_request/);
  assert.equal(sendRefusal(s,BOT,OWNER,{kind:"group",chat:TEAM},{chat:ALICE,topic:0},groupsOf,undefined,OWNER),undefined,"group: the owner's own request");
  assert.match(no({kind:"group",chat:OTHER},{chat:ALICE,topic:0})!,/person_not_allowed/);
  assert.match(no({kind:"person",subject:ALICE},{chat:TEAM,topic:0})!,/group_not_allowed/);
  // С43: any conversation asks the owner only with a question whose answer comes back.
  assert.match(no({kind:"group",chat:TEAM},{chat:OWNER,topic:0})!,/owner_only_with_a_question: send --person owner --ask/);
  assert.equal(sendRefusal(s,BOT,OWNER,{kind:"person",subject:ALICE},{chat:OWNER,topic:0},groupsOf,undefined,undefined,true),undefined);
  assert.equal(sendRefusal(s,BOT,OWNER,{kind:"group",chat:TEAM},{chat:OWNER,topic:0},groupsOf,undefined,ALICE,true),undefined);
  assert.match(no({kind:"group",chat:TEAM},{chat:-1009,topic:0})!,/bot_is_not_in_this_group/);
});

test("a remembered question lets the answer go back where it was asked, once",()=>{
  const s=setup() as any;
  const ask=rememberAsk(s,BOT,ALICE,{chat:OWNER,topic:0},"когда будет макет?");
  assert.equal(openAsks(s,BOT,ALICE).length,1);
  assert.match(askNotes(s,BOT,ALICE),/«когда будет макет\?».*--answer /);
  assert.equal(sendRefusal(s,BOT,OWNER,{kind:"person",subject:ALICE},{chat:OWNER,topic:0},groupsOf,ask.id),undefined);
  assert.match(sendRefusal(s,BOT,OWNER,{kind:"person",subject:BOB},{chat:OWNER,topic:0},groupsOf,ask.id)!,/no_open_question/);
});

test("names are found by the agent; ambiguity is refused",()=>{
  const s=setup() as any;
  assert.equal(findPerson(s,BOT,"алис"),ALICE);
  assert.equal(findGroup(s,BOT,"склад"),OTHER);
  setAccess(s,BOT,[{id:ALICE,name:"Алиса Иванова"},{id:BOB,name:"Алиса Петрова"}]);
  assert.throws(()=>findPerson(s,BOT,"алиса"),/person_ambiguous/);
});

test("a topic is found by its name without the group; the agent can list where it may write",()=>{
  const s=setup() as any;
  s.put(`group:topic-name:${BOT}:${TEAM}:64`,{name:"Стенд: этап 2"});
  s.put(`group:topic-name:${BOT}:${OTHER}:9`,{name:"Отчёты"});
  s.put(`group:topic-name:${BOT}:${TEAM}:10`,{name:"Отчёты"});
  assert.deepEqual(findTopic(s,BOT,undefined,"«Стенд: этап 2»"),{chat:TEAM,topic:64});
  assert.deepEqual(findTopic(s,BOT,OTHER,"отчеты"),{chat:OTHER,topic:9});
  assert.throws(()=>findTopic(s,BOT,undefined,"отчёты"),/topic_ambiguous: .*Штурвал \/ Отчёты/);
  assert.throws(()=>findTopic(s,BOT,undefined,"нет такой"),/topic_unknown; known topics: .*Стенд: этап 2/);
  assert.equal(findPerson(s,BOT,"Алисе"),ALICE,"a name in another case");
  const owner=sendTargets(s,BOT,OWNER,{kind:"owner"},groupsOf);
  assert.deepEqual(owner.groups.map((g:any)=>g.title).sort(),["Склад","Штурвал"]);
  assert.ok(owner.groups.find((g:any)=>g.chat===TEAM).topics.some((t:any)=>t.name==="Стенд: этап 2"));
  assert.deepEqual(owner.people.map((p:any)=>[p.name,!!p.note]),[["Алиса",false],["Боб",true]]);
  const group=sendTargets(s,BOT,OWNER,{kind:"group",chat:OTHER},groupsOf);
  assert.deepEqual(group.groups.map((g:any)=>g.title),["Склад"]);
  assert.deepEqual(group.people.map((p:any)=>p.name),["Боб"],"only people it may reach, and who to mention");
});

test("topic names are learned from any topic message of any group",()=>{
  const s=setup() as any;
  const chat={id:TEAM,type:"supergroup",is_forum:true};
  learnTopicName(s,BOT,{update_id:5,message:{chat,message_thread_id:64,message_id:70,text:"привет",
    reply_to_message:{message_id:64,forum_topic_created:{name:"Стенд: этап 2"}}}});
  assert.deepEqual(findTopic(s,BOT,undefined,"стенд"),{chat:TEAM,topic:64});
  learnTopicName(s,BOT,{update_id:6,message:{chat,message_thread_id:64,message_id:71,forum_topic_edited:{name:"Стенд: этап 3"}}});
  learnTopicName(s,BOT,{update_id:7,message:{chat,message_thread_id:64,message_id:72,text:"ещё",
    reply_to_message:{message_id:64,forum_topic_created:{name:"Стенд: этап 2"}}}});
  assert.deepEqual(findTopic(s,BOT,undefined,"этап 3"),{chat:TEAM,topic:64},"a rename wins over the old creation message");
  learnTopicName(s,BOT,{update_id:8,message:{chat,message_thread_id:65,message_id:73,text:"Стенд: подмена",
    reply_to_message:{message_id:60,text:"Стенд: подмена"}}});
  assert.throws(()=>findTopic(s,BOT,undefined,"подмена"),/topic_unknown/,"text never names a topic");
});

test("a group named by its number before it became a supergroup is found under the new number",()=>{
  const s=setup() as any;
  migrateGroupChat(s,BOT,TEAM,-1009000);
  s.put(`visibility:${BOT}:group:-1009000`,{chat:-1009000,title:"Штурвал"});
  assert.equal(findGroup(s,BOT,String(TEAM)),-1009000);
});

test("the same question asked again stays one open question",()=>{
  const s=setup() as any;
  const a=rememberAsk(s,BOT,ALICE,{chat:OWNER,topic:0},"когда будет смета?");
  const b=rememberAsk(s,BOT,ALICE,{chat:OWNER,topic:0},"когда будет смета?");
  assert.equal(a.id,b.id);
  assert.equal(openAsks(s,BOT,ALICE).length,1);
  rememberAsk(s,BOT,ALICE,{chat:OWNER,topic:0},"а макет?");
  assert.equal(openAsks(s,BOT,ALICE).length,2);
});

test("a question to the owner from a person's private chat reaches the owner's turn and its answer goes back",()=>{
  const rows=new Map<string,any>();
  const s={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},del:(k:string)=>{rows.delete(k);},
    atomic:(f:()=>void)=>f(),list:<T>(p:string)=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:value as T}))};
  const OWNER=7, ALICE=11, BOT=5;
  const ask=rememberAsk(s as never,BOT,OWNER,{chat:ALICE,topic:0},"Вопрос из лички «Алиса»: закрыть задачу 12? да/нет");
  const notes=ownerAskNotes(s as never,OWNER);
  assert.match(notes,/закрыть задачу 12/);
  assert.match(notes,new RegExp("--answer "+ask.id));
  assert.equal(sendRefusal(s as never,BOT,OWNER,{kind:"owner"},{chat:ALICE,topic:0},()=>[],ask.id),undefined);
  assert.equal(ownerAskNotes(s as never,ALICE),"");
});
