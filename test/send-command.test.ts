import test from "node:test";
import assert from "node:assert/strict";
import {askNotes,findGroup,findPerson,findTopic,openAsks,rememberAsk,sendRefusal,sendTargets} from "../send-command";
import {setAccess} from "../rights";

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
  assert.equal(no({kind:"group",chat:TEAM},{chat:ALICE,topic:0}),undefined,"group: a person with access from this group");
  assert.match(no({kind:"group",chat:OTHER},{chat:ALICE,topic:0})!,/person_not_allowed/);
  assert.match(no({kind:"person",subject:ALICE},{chat:TEAM,topic:0})!,/group_not_allowed/);
  assert.match(no({kind:"group",chat:TEAM},{chat:OWNER,topic:0})!,/owner_only_through_an_open_question/);
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
