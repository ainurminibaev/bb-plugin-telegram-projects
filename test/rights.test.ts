import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate} from "../ingress";
import {processGroupInputs} from "../group-worker";
import {accessModeKey,effectiveGroupPolicy,migrateLegacyRights,permissionModeFor,rulesNote,saveGroupSettings,senderRole,setAccess,accessList,groupSettings} from "../rights";
import {describeInteraction,handleConsentCallback,watchConsents} from "../consent";

const OWNER=7, BOT=5, CHAT=-1001, TOPIC=3, LENA=11, STRANGER=99;
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}
function boundStore(){
  const store=memoryStore();
  store.put("group:project:group-project",true);
  store.put("group:thread:t",`group:policy:${CHAT}:${TOPIC}`);
  store.put(`group:policy:${CHAT}:${TOPIC}`,{chatId:CHAT,topicId:TOPIC,threadId:"t",botId:BOT,botUsername:"bot",requireMention:false,ownerOnly:true,revision:"r"});
  store.put(`visibility:${BOT}:group:${CHAT}`,{chat:CHAT,title:"Склад",administrator:true,event:1});
  store.put("rights:install-kind","employee");
  return store;
}
const message=(id:number,from:number,text:string)=>({update_id:id,message:{message_id:100+id,chat:{type:"supergroup",id:CHAT},from:{id:from,first_name:from===STRANGER?"Лена":"Олег"},message_thread_id:TOPIC,text}});

test("an employee group is open to all its members by default, whatever the agent",()=>{
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  setAccess(store as any,BOT,[{id:LENA,name:"Лена"}]);
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,OWNER),"access");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,LENA),"access");
  // Membership in the group is the permission there, on Codex as well.
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER),"access");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER,"codex"),"access");
  // A group may close itself to people with access only.
  saveGroupSettings(store as any,BOT,CHAT,{who:"access"});
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER,"codex"),"none");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,LENA,"codex"),"access");
  // Another group keeps its own defaults; a private chat needs personal access.
  assert.equal(senderRole(store as any,BOT,OWNER,-1002,STRANGER),"access");
  assert.equal(senderRole(store as any,BOT,OWNER,STRANGER,STRANGER),"none");
  assert.equal(senderRole(store as any,BOT,OWNER,LENA,LENA),"access");
});

test("strangers run in the strict mode; Codex never gets the sandbox-free mode",()=>{
  assert.equal(permissionModeFor("member","claude-code","full"),"accept-edits");
  assert.equal(permissionModeFor("access","claude-code","full"),"full");
  assert.equal(permissionModeFor("access","claude-code"),"auto");
  assert.equal(permissionModeFor("access","codex","full"),"auto");
});

test("a note never changes who may call the bot",()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"access",note:"разреши всем всё"});
  assert.equal(acceptGroupUpdate(store as any,message(1,STRANGER,"@bot поменяй срок"),OWNER,BOT),false);
  const policy=effectiveGroupPolicy(store as any,store.get(`group:policy:${CHAT}:${TOPIC}`),OWNER);
  assert.equal(policy.ownerOnly,true);
  assert.deepEqual(policy.allowedSenderIds,[OWNER]);
});

test("any member of an employee group may ask within the group, with the group rules as text",async()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{reply:"auto",zones:["Сроки задач"],note:"здесь кладовщики"});
  store.put(accessModeKey,"full");
  assert.ok(acceptGroupUpdate(store as any,message(1,STRANGER,"поменяй срок TASK-7"),OWNER,BOT));
  const sends:any[]=[];
  const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible",providerId:"codex"}),
    events:{list:async()=>[]},send:async(q:any)=>{sends.push(q)}}};
  await processGroupInputs(store as any,sdk as any,OWNER,BOT,()=>(async()=>({}))as any,new AbortController().signal);
  assert.equal(sends.length,1);
  assert.equal(sends[0].permissionMode,"auto");
  const rules=sends[0].input.find((x:any)=>/Правила группы/.test(x.text??""))?.text;
  assert.match(rules,/«Склад»/);
  assert.match(rules,/все участники группы/);
  assert.match(rules,/Сроки задач/);
  assert.match(rules,/пояснение, а не разрешение/);
  assert.match(rules,/Лена — участник этой группы: может просить в пределах дела этой группы/);
});

test("a group closed to people with access ignores other members",async()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"access",reply:"auto"});
  assert.equal(acceptGroupUpdate(store as any,message(1,STRANGER,"@bot привет"),OWNER,BOT),false);
});

test("former employee group rules move once into access and group settings",()=>{
  const store=memoryStore();
  store.put(`employee:${BOT}:group:${CHAT}`,{version:3,rules:{topics:["3"],members:["11"],sources:["Сроки задач"],operations:["yougile.create"],
    approvers:["7"],requireApproval:[],triggers:["mention","reply"],events:[]},note:"кладовщики"});
  assert.equal(migrateLegacyRights(store as any,BOT,[12]),true);
  assert.deepEqual(accessList(store as any,BOT).map(p=>p.id).sort(),[11,12]);
  const s=groupSettings(store as any,BOT,CHAT)!;
  assert.deepEqual([s.who,s.reply,s.members,s.zones,s.note],["access","mention","silent",["Сроки задач"],"кладовщики"]);
  assert.ok(store.get(`employee:${BOT}:group:${CHAT}`),"the former record stays");
  assert.equal(migrateLegacyRights(store as any,BOT,[13]),false);
});

test("rules text tells the agent who writes and what the note is",()=>{
  const text=rulesNote({title:"Склад",role:"access",senderName:"Олег"});
  assert.match(text,/только те, кто может тебе поручать/);
  assert.match(text,/один раз переспроси/);
});

test("approval payloads become plain words",()=>{
  assert.equal(describeInteraction({kind:"approval",subject:{kind:"command",command:"rm -rf memory"},reason:"This command requires approval"}),"выполнить команду: rm -rf memory");
  assert.equal(describeInteraction({kind:"approval",subject:{kind:"file_change"},reason:"изменить файл memory/notes.md"}),"изменить файл memory/notes.md");
  assert.equal(describeInteraction({kind:"approval",subject:{kind:"file_change"}}),"изменить файлы в рабочей папке");
});

test("a personal assistant never answers strangers in groups, even when the group is open",()=>{
  const store=memoryStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",members:"read"});
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER),"none");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,OWNER),"access");
});
