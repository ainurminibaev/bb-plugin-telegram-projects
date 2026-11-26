import test from "node:test";
import assert from "node:assert/strict";
import {deliverScheduledResults} from "../group-schedule";

function memoryStore(){
  const rows=new Map<string,any>();
  return {get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}

test("a schedule's result goes to the topic where it was set; silent runs and other turns stay in BB",async()=>{
  const store=memoryStore() as any;
  store.put("group:policy:-1001:7",{chatId:-1001,topicId:7,threadId:"t",botId:5});
  const events:any[]=[{seq:1,type:"turn/completed",scope:{kind:"turn",turnId:"old"},data:{status:"completed"}}];
  const ev=(type:string,data:any,turnId?:string)=>events.push({seq:events.length+1,type,data,scope:turnId?{kind:"turn",turnId}:{kind:"thread"}});
  const sdk={threads:{events:{list:async(q:any)=>{
    const after=Number(q.afterSeq??0);
    const list=events.filter(e=>e.seq>after && (!q.types || q.types.includes(e.type)));
    return q.order==="desc" ? list.reverse().slice(0,Number(q.limit)) : list;
  }}}};
  const sent:any[]=[];
  const tg=()=>(async(_m:string,p:any)=>{sent.push(p);return {...p,message_id:sent.length,chat:{id:p.chat_id}};}) as any;
  const run=()=>deliverScheduledResults(store,sdk as any,tg,new AbortController().signal,()=>true);
  await run(); // starts at the present
  ev("client/turn/requested",{requestId:"a",originPluginId:"automations"});
  ev("turn/input/accepted",{clientRequestId:"a"},"ta");
  ev("item/completed",{item:{type:"agentMessage",text:"Статус: всё по плану [лист](/макет\n• По просьбе Миры уточнили сроки)"}},"ta");
  ev("turn/completed",{status:"completed"},"ta");
  ev("client/turn/requested",{requestId:"b",originPluginId:"telegram-projects"});
  ev("turn/input/accepted",{clientRequestId:"b"},"tb");
  ev("item/completed",{item:{type:"agentMessage",text:"ответ участнику"}},"tb");
  ev("turn/completed",{status:"completed"},"tb");
  ev("client/turn/requested",{requestId:"c",originPluginId:"automations"});
  ev("turn/input/accepted",{clientRequestId:"c"},"tc");
  ev("item/completed",{item:{type:"agentMessage",text:"NO_REPLY"}},"tc");
  ev("turn/completed",{status:"completed"},"tc");
  ev("client/turn/requested",{requestId:"d",initiator:"system",systemMessageKind:"child-completed"});
  ev("turn/input/accepted",{clientRequestId:"d"},"td");
  ev("item/completed",{item:{type:"agentMessage",text:"Подтред посчитал: 16 файлов [лист](/макет\n• По просьбе Миры уточнили сроки)"}},"td");
  ev("turn/completed",{status:"completed"},"td");
  await run(); await run();
  assert.deepEqual(sent.map(p=>[p.chat_id,p.message_thread_id,p.text]),[[-1001,7,"Статус: всё по плану [лист](/макет\n• По просьбе Миры уточнили сроки)"],[-1001,7,"Подтред посчитал: 16 файлов [лист](/макет\n• По просьбе Миры уточнили сроки)"]]);
  // A subthread's notice that joined a running Telegram task: the task's own delivery answers, nothing twice.
  store.put("group:in:5:77",{state:"submitted",route:{threadId:"t"}});
  ev("client/turn/requested",{requestId:"e",initiator:"system",systemMessageKind:"child-completed"});
  ev("turn/input/accepted",{clientRequestId:"e"},"te");
  ev("item/completed",{item:{type:"agentMessage",text:"Итог поручения из Telegram"}},"te");
  ev("turn/completed",{status:"completed"},"te");
  await run(); await run();
  assert.equal(sent.length,2,"not sent a second time");
});

test("a thread deleted in BB while its topic stays bound does not stop the pass for the other threads",async()=>{
  const store=memoryStore() as any;
  store.put("group:policy:-100:3",{chatId:-100,topicId:3,threadId:"gone"});
  store.put("group:policy:-100:4",{chatId:-100,topicId:4,threadId:"alive"});
  const read:string[]=[];
  const sdk={threads:{events:{list:async(q:any)=>{read.push(q.threadId);if(q.threadId==="gone")throw Error("HTTP 404: Thread not found");return [];}}}};
  await deliverScheduledResults(store,sdk as any,()=>(async()=>({})) as any,new AbortController().signal,()=>true);
  assert.deepEqual(read.sort(),["alive","gone"]);
  assert.ok(store.get("group:schedule-cursor:alive") ?? [...store.list("")].some(({key}:any)=>key.includes("alive")),"the live thread is read");
});
