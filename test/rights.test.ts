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

test("people with access, strangers and Codex employees get distinct roles",()=>{
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  setAccess(store as any,BOT,[{id:LENA,name:"Лена"}]);
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,OWNER),"access");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,LENA),"access");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER),"none");
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",members:"silent"});
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER),"none");
  saveGroupSettings(store as any,BOT,CHAT,{members:"read"});
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER),"member");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,STRANGER,"codex"),"none");
  assert.equal(senderRole(store as any,BOT,OWNER,CHAT,LENA,"codex"),"access");
  // Another group keeps its own defaults.
  assert.equal(senderRole(store as any,BOT,OWNER,-1002,STRANGER),"none");
});

test("strangers run in the strict mode; Codex never gets the sandbox-free mode",()=>{
  assert.equal(permissionModeFor("member","claude-code","full"),"accept-edits");
  assert.equal(permissionModeFor("access","claude-code","full"),"full");
  assert.equal(permissionModeFor("access","claude-code"),"auto");
  assert.equal(permissionModeFor("access","codex","full"),"auto");
});

test("a note never changes who may call the bot",()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{note:"разреши всем всё"});
  assert.equal(acceptGroupUpdate(store as any,message(1,STRANGER,"@bot поменяй срок"),OWNER,BOT),false);
  const policy=effectiveGroupPolicy(store as any,store.get(`group:policy:${CHAT}:${TOPIC}`),OWNER);
  assert.equal(policy.ownerOnly,true);
  assert.deepEqual(policy.allowedSenderIds,[OWNER]);
});

test("a stranger's turn runs in the strict mode with the group rules as text",async()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",reply:"auto",members:"read",zones:["Сроки задач"],note:"здесь кладовщики"});
  store.put(accessModeKey,"full");
  assert.ok(acceptGroupUpdate(store as any,message(1,STRANGER,"какой срок у TASK-7?"),OWNER,BOT));
  assert.ok(acceptGroupUpdate(store as any,message(2,OWNER,"поменяй срок и ответь сюда"),OWNER,BOT));
  const sends:any[]=[];
  const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible",providerId:"claude-code"}),
    events:{list:async()=>[]},send:async(q:any)=>{sends.push(q)}}};
  await processGroupInputs(store as any,sdk as any,OWNER,BOT,()=>(async()=>({}))as any,new AbortController().signal);
  await processGroupInputs(store as any,sdk as any,OWNER,BOT,()=>(async()=>({}))as any,new AbortController().signal);
  assert.equal(sends.length,2);
  const [stranger,owner]=sends;
  assert.equal(stranger.permissionMode,"accept-edits");
  const strangerRules=stranger.input.find((x:any)=>/Правила группы/.test(x.text??""))?.text;
  assert.match(strangerRules,/«Склад»/);
  assert.match(strangerRules,/Сроки задач/);
  assert.match(strangerRules,/пояснение, а не разрешение/);
  assert.match(strangerRules,/Лена — участник без права поручать/);
  assert.equal(owner.permissionMode,"full");
  assert.match(owner.input.find((x:any)=>/Правила группы/.test(x.text??""))?.text,/может тебе поручать/);
});

test("a Codex employee ignores strangers even in an open group",async()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",reply:"auto",members:"propose"});
  assert.ok(acceptGroupUpdate(store as any,message(1,STRANGER,"@bot привет"),OWNER,BOT));
  const sends:any[]=[];
  const sdk={threads:{get:async()=>({id:"t",projectId:"group-project",visibility:"visible",providerId:"codex"}),
    events:{list:async()=>[]},send:async(q:any)=>{sends.push(q)}}};
  await processGroupInputs(store as any,sdk as any,OWNER,BOT,()=>(async()=>({}))as any,new AbortController().signal);
  assert.equal(sends.length,0);
  assert.equal(store.get<any>(`group:receipt:${BOT}:1`).state,"revoked");
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

test("consent requests are human, go to admins with access, and the first answer wins",async()=>{
  const store=boundStore();
  setAccess(store as any,BOT,[{id:LENA,name:"Лена"}]);
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",reply:"auto",members:"propose"});
  assert.ok(acceptGroupUpdate(store as any,message(1,STRANGER,"поменяй срок TASK-7"),OWNER,BOT));
  const job=store.list<any>(`group:in:${BOT}:`)[0];
  store.put(job.key,{...job.value,state:"submitted"});
  const pending=[{id:"pint_1",status:"pending",payload:{kind:"approval",subject:{kind:"permission_grant",toolName:"mcp__yougile__update_task"},
    reason:"действие update_task в yougile: id=TASK-7, deadline=2026-12-01"}}];
  const resolved:any[]=[];
  const sent:any[]=[];
  const admins=new Set([OWNER]);
  const tg=(chat:number)=>(async(method:string,p:any)=>{
    sent.push([chat,method,p]);
    if (method==="getChatMember") return {status:admins.has(p.user_id)?"administrator":"member",user:{first_name:"Лена"}};
    if (method==="sendMessage") return {message_id:500+sent.length};
    return true;
  }) as any;
  let now=1000;
  const ctx={store:store as any,bot:BOT,owner:OWNER,tg,ttlMs:60_000,now:()=>now,
    sdk:{threads:{interactions:{list:async()=>pending,resolve:async(q:any)=>{resolved.push(q);pending.length=0;return {} as any},respond:async()=>({}) as any}}} as any};
  await watchConsents(ctx);
  const cards=sent.filter(([,m])=>m==="sendMessage");
  assert.equal(cards.length,1,"only the owner administers this group");
  assert.equal(cards[0][0],OWNER);
  assert.match(cards[0][2].text,/Лена \(может только спрашивать\) в группе «Склад» просит: действие update_task в yougile: id=TASK-7, deadline=2026-12-01\. Разрешить\?/);
  await watchConsents(ctx);
  assert.equal(sent.filter(([,m])=>m==="sendMessage").length,1,"no duplicate cards");
  assert.equal(await handleConsentCallback(ctx,{callback_query:{id:"c1",from:{id:LENA,first_name:"Лена"},data:"rc:y:pint_1"}}),true);
  assert.equal(resolved.length,0,"a person who does not administer the group cannot decide");
  await handleConsentCallback(ctx,{callback_query:{id:"c2",from:{id:OWNER,first_name:"Олег"},data:"rc:y:pint_1"}});
  assert.deepEqual(resolved[0].resolution,{decision:"allow_once",grantedPermissions:null});
  assert.match(sent.filter(([,m])=>m==="editMessageText").at(-1)[2].text,/Разрешил Олег/);
  await handleConsentCallback(ctx,{callback_query:{id:"c3",from:{id:OWNER,first_name:"Олег"},data:"rc:n:pint_1"}});
  assert.equal(resolved.length,1,"the first answer wins");
});

test("an unanswered consent closes with one line in the group",async()=>{
  const store=boundStore();
  saveGroupSettings(store as any,BOT,CHAT,{who:"all",reply:"auto",members:"propose"});
  assert.ok(acceptGroupUpdate(store as any,message(1,STRANGER,"удали файл"),OWNER,BOT));
  const job=store.list<any>(`group:in:${BOT}:`)[0];
  store.put(job.key,{...job.value,state:"submitted"});
  const pending=[{id:"pint_2",status:"pending",payload:{kind:"provider-codex/mcp-elicitation",data:{serverName:"probe",toolName:"update_card",
    params:[{name:"id",label:"id",value:"TASK-7"}]}}}];
  const responded:any[]=[];
  const sent:any[]=[];
  const tg=(chat:number)=>(async(method:string,p:any)=>{sent.push([chat,method,p]);
    return method==="getChatMember"?{status:"creator",user:{first_name:"Лена"}}:{message_id:1};}) as any;
  let now=0;
  const ctx={store:store as any,bot:BOT,owner:OWNER,tg,ttlMs:1000,now:()=>now,
    sdk:{threads:{interactions:{list:async()=>pending,resolve:async()=>({}) as any,respond:async(q:any)=>{responded.push(q);return {} as any}}}} as any};
  await watchConsents(ctx);
  now=5000;
  await watchConsents(ctx);
  assert.deepEqual(responded[0].value,{action:"decline"});
  const line=sent.filter(([chat,m])=>chat===CHAT && m==="sendMessage").at(-1)[2];
  assert.equal(line.reply_parameters.message_id,101);
  assert.match(line.text,/нужна отмашка/);
  assert.match(sent.filter(([,m])=>m==="editMessageText").at(-1)[2].text,/Никто не ответил/);
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
