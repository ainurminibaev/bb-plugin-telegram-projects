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
  ev("item/completed",{item:{type:"agentMessage",text:"Статус: всё по плану"}},"ta");
  ev("turn/completed",{status:"completed"},"ta");
  ev("client/turn/requested",{requestId:"b",originPluginId:"telegram-projects"});
  ev("turn/input/accepted",{clientRequestId:"b"},"tb");
  ev("item/completed",{item:{type:"agentMessage",text:"ответ участнику"}},"tb");
  ev("turn/completed",{status:"completed"},"tb");
  ev("client/turn/requested",{requestId:"c",originPluginId:"automations"});
  ev("turn/input/accepted",{clientRequestId:"c"},"tc");
  ev("item/completed",{item:{type:"agentMessage",text:"NO_REPLY"}},"tc");
  ev("turn/completed",{status:"completed"},"tc");
  await run(); await run();
  assert.deepEqual(sent.map(p=>[p.chat_id,p.message_thread_id,p.text]),[[-1001,7,"Статус: всё по плану"]]);
});
