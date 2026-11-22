import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {archiveRow,latToCyr,localSeconds,normalize,openArchive,searchText} from "../archive";
import {conversationOfThread,groupMemory,guardGroupMemory,readableChats} from "../archive-access";

const OWNER=7, BOT=5, TEAM=-1001, OTHER=-1002, ALICE=21, BOB=22;
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}
let id=100;
const msg=(chat:number,from:number,name:string,text:string,extra:any={})=>({update_id:++id,message:{message_id:++id,date:extra.date??1_795_300_000,
  chat:{id:chat,type:chat<0?"supergroup":"private",title:chat===TEAM?"Команда":chat===OTHER?"Склад":undefined},from:{id:from,first_name:name},text,...extra}});

test("every message is kept with its real Telegram IDs, files as file IDs",()=>{
  const row=archiveRow({update_id:1,message:{message_id:9,date:5,is_topic_message:true,message_thread_id:3,chat:{id:TEAM,type:"supergroup",title:"Команда"},
    from:{id:ALICE,first_name:"Алиса"},caption:"макет",media_group_id:"g1",reply_to_message:{message_id:7},
    document:{file_id:"F",file_name:"Макет.pdf",file_size:10}}})!;
  assert.deepEqual([row.chat,row.topic,row.message,row.sender,row.replyTo,row.album,row.fileId,row.fileName,row.fileKind],
    [TEAM,3,9,ALICE,7,"g1","F","Макет.pdf","document"]);
  assert.equal(archiveRow({update_id:2,message:{message_id:1,date:1,chat:{id:TEAM},migrate_to_chat_id:-100}}),undefined);
});

test("search ignores case, «ё», small typos and the alphabet",()=>{
  assert.equal(normalize("Ёлка, ПРИВЕТ!"),"елка привет");
  assert.equal(latToCyr("prezentaciya"),"презентация");
  const db=new Database(":memory:"); const a=openArchive(db as any);
  a.record(BOT,msg(TEAM,ALICE,"Алиса","Утром согласовали презентацию для Ростеха"));
  a.record(BOT,msg(TEAM,BOB,"Боб","Обед в два"));
  const all=()=>true;
  for (const words of ["презентацию","презинтацию","PREZENTACIYU","ростех"])
    assert.equal(a.find(BOT,all,{words},"UTC").length,1,words);
  assert.equal(a.find(BOT,all,{author:"боб"},"UTC")[0].text,"Обед в два");
  assert.equal(a.find(BOT,all,{last:1},"UTC").length,1);
  assert.ok(searchText("x","Алиса").includes("alisa"));
});

test("a period is read in the given time zone",()=>{
  assert.equal(localSeconds("2026-11-22T09:00","Europe/Moscow",false),Date.UTC(2026,10,22,6,0)/1000);
  assert.equal(localSeconds("2026-11-22","Europe/Moscow",true),Date.UTC(2026,10,22,20,59,59)/1000);
});

test("a conversation reads what its memory allows; another person's private chat never",()=>{
  const store=memoryStore(); store.put("rights:install-kind","employee");
  store.put("chat:binding:0",{threadId:"thr_owner",projectId:"p"});
  store.put(`group:policy:${TEAM}:0`,{chatId:TEAM,topicId:0,threadId:"thr_team"}); store.put("group:thread:thr_team",`group:policy:${TEAM}:0`);
  store.put(`group:policy:${ALICE}:0`,{chatId:ALICE,topicId:0,threadId:"thr_alice",privateChat:true}); store.put("group:thread:thr_alice",`group:policy:${ALICE}:0`);
  const db=new Database(":memory:"); const a=openArchive(db as any);
  a.record(BOT,msg(TEAM,ALICE,"Алиса","срок завтра"));
  const conv=(t:string)=>conversationOfThread(store as any,t)!;
  assert.deepEqual(conv("thr_owner"),{kind:"owner"});
  assert.deepEqual(conv("thr_alice"),{kind:"person",subject:ALICE});
  const owner=readableChats(store as any,a,BOT,OWNER,conv("thr_owner"));
  assert.deepEqual([owner(TEAM),owner(OTHER),owner(OWNER),owner(ALICE),owner(BOB)],[true,true,true,false,false]);
  assert.equal(groupMemory(store as any,BOT,TEAM),"separate","an employee's group keeps its own memory by default");
  const team=readableChats(store as any,a,BOT,OWNER,conv("thr_team"));
  assert.deepEqual([team(TEAM),team(OTHER),team(OWNER),team(ALICE)],[true,false,false,false]);
  store.put(`rights:${BOT}:group:${TEAM}`,{version:1,who:"all",reply:"mention",members:"propose",zones:[],note:"",memory:"shared"});
  store.put(`rights:${BOT}:group:${OTHER}`,{version:1,who:"all",reply:"mention",members:"propose",zones:[],note:"",memory:"shared"});
  const shared=readableChats(store as any,a,BOT,OWNER,conv("thr_team"));
  assert.deepEqual([shared(TEAM),shared(OTHER),shared(OWNER),shared(ALICE)],[true,true,true,false],"only the owner is there: reads like the owner's chat");
  const alice=readableChats(store as any,a,BOT,OWNER,conv("thr_alice"));
  assert.deepEqual([alice(ALICE),alice(TEAM),alice(OWNER),alice(BOB)],[true,true,false,false]);
});

test("a voice message keeps the bridge's transcript, and search finds it",()=>{
  const a=openArchive(new Database(":memory:") as any);
  a.record(BOT,{update_id:1,message:{message_id:50,date:1_795_300_000,chat:{id:OWNER,type:"private"},from:{id:OWNER,first_name:"Айнур"},
    voice:{file_id:"V",file_unique_id:"v",duration:4}}});
  assert.equal(a.transcript(BOT,OWNER,50,"опубликуй выпуск пятьдесят два"),true);
  const found=a.find(BOT,()=>true,{words:"пятьдесят"},"UTC");
  assert.equal(found.length,1);
  assert.equal(found[0].transcript,"опубликуй выпуск пятьдесят два");
});

test("the first other person makes a shared group a guest conversation at once, and tells the owner once",()=>{
  const store=memoryStore(); store.put("rights:install-kind","assistant");
  const msg=(from:any,extra:any={})=>({update_id:1,message:{message_id:1,date:1,chat:{id:TEAM,type:"supergroup",title:"Команда"},from,text:"x",...extra}});
  assert.equal(groupMemory(store as any,BOT,TEAM),"shared","an assistant's group starts shared");
  assert.equal(guardGroupMemory(store as any,BOT,OWNER,msg({id:OWNER})),undefined,"the owner alone changes nothing");
  assert.equal(guardGroupMemory(store as any,BOT,OWNER,msg({id:99,is_bot:true})),undefined,"another bot changes nothing");
  assert.deepEqual(guardGroupMemory(store as any,BOT,OWNER,msg({id:OWNER},{new_chat_members:[{id:ALICE,first_name:"Алиса"}]})),{chat:TEAM,title:"Команда"});
  assert.equal(groupMemory(store as any,BOT,TEAM),"separate");
  assert.equal(guardGroupMemory(store as any,BOT,OWNER,msg({id:ALICE})),undefined,"told once");
});

test("retention: a text older than the term is found, its file is removed by term",()=>{
  const a=openArchive(new Database(":memory:"));
  const old=1_780_000_000, fresh=1_795_300_000;
  a.record(BOT,msg(TEAM,ALICE,"Алиса","макет согласован",{date:old,document:{file_id:"OLD",file_name:"Макет.pdf",file_size:10}}));
  a.record(BOT,msg(TEAM,ALICE,"Алиса","новый вариант",{date:fresh,document:{file_id:"NEW",file_name:"Вариант.pdf",file_size:10}}));
  const gone=a.expireFiles(fresh-86400);
  assert.equal(gone.length,1);
  const [found]=a.find(BOT,()=>true,{words:"макет согласован"},"UTC");
  assert.equal(found.text,"макет согласован","the text stays");
  assert.deepEqual(found.file,{kind:"document",name:"Макет.pdf",removed:"файл удалён по сроку"});
  assert.equal(a.file(BOT,TEAM,found.message)!.file_id,null);
  assert.equal(a.file(BOT,TEAM,found.message)!.file_removed,1);
  assert.equal(a.find(BOT,()=>true,{files:true},"UTC").length,2,"files only still lists the removed file with its mark");
  assert.equal(a.find(BOT,()=>true,{words:"новый вариант"},"UTC")[0].file!.name,"Вариант.pdf");
  assert.equal(a.expireFiles(fresh-86400).length,0,"once");
});

test("history kept before the archive moves into it once, without duplicates or clashes",()=>{
  const a=openArchive(new Database(":memory:"));
  a.record(BOT,msg(TEAM,ALICE,"Алиса","уже в архиве",{date:1_795_300_100}));
  const live=a.find(BOT,()=>true,{words:"уже в архиве"},"UTC")[0];
  const items=[
    {chat:TEAM,topic:0,id:live.message,sender:ALICE,name:"Алиса",date:1_795_300_100,text:"уже в архиве"},
    {chat:TEAM,topic:0,id:live.message,sender:BOB,name:"Боб",date:1_795_000_000,text:"предложи варианты названия домена",title:"Команда"},
  ];
  assert.equal(a.importHistory(BOT,items),1,"the message already archived is not added again");
  assert.equal(a.importHistory(BOT,items),0,"repeating adds nothing");
  const [old]=a.find(BOT,()=>true,{words:"домена"},"UTC");
  assert.equal(old.author,"Боб");
  assert.ok(old.message<0,"an old number never clashes with the group's current messages");
  assert.equal(old.link,undefined);
  assert.equal(a.find(BOT,()=>true,{words:"уже в архиве"},"UTC")[0].message,live.message,"the live message is untouched");
});
