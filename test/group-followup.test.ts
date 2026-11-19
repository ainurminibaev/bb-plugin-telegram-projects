import test from "node:test";
import assert from "node:assert/strict";
import {deliverGroupResults,queueGroupReminder,type GroupOrigin} from "../group-result";
import {processGroupInputs} from "../group-worker";

function fixture(answer:string, snapshot?:string) {
  const rows=new Map<string,any>(snapshot ? JSON.parse(snapshot) : []);
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
  if (!snapshot) {
    const origin:GroupOrigin={owner:7,bot:5,sender:7,chatId:-1001,topicId:3,messageId:10,threadId:"t",revision:"r1",projectId:"team"};
    store.put("group:project:team",true);
    store.put("group:thread:t","group:policy:-1001:3");
    store.put("group:policy:-1001:3",{chatId:-1001,topicId:3,threadId:"t",projectId:"team",revision:"r1",
      ownerId:7,botId:5,botUsername:"bot",requireMention:true,ownerOnly:true});
    store.put("group:origin:task",origin);
    store.put("group:context:-1001:3",[{id:9,sender:8,name:"Лена",date:1,text:"раньше"},{id:11,sender:8,name:"Лена",date:2,text:"Прислала файл"}]);
  }
  const events:any[]=[];
  const inputs:any[]=[];
  const sdk={threads:{get:async({threadId}:{threadId:string})=>({id:threadId,projectId:"team",visibility:"visible"}),
    events:{list:async(q:any)=>events.filter(e=>e.seq>Number(q.afterSeq??0))},
    send:async(q:any)=>{
      inputs.push(q.input);
      const ev=(type:string,data:any)=>events.push({type,data,seq:events.length+1,scope:{kind:"turn",turnId:"turn"}});
      ev("client/turn/requested",{requestId:"req",originPluginId:"telegram-projects",input:q.input});
      ev("turn/input/accepted",{clientRequestId:"req"});
      ev("item/completed",{item:{type:"agentMessage",text:answer}});
      ev("turn/completed",{status:"completed"});
    }}};
  const sent:any[]=[];
  const transport=()=>async <T>(_m:string,p:any)=>{sent.push(p);return {message_id:99} as T;};
  const signal=new AbortController().signal;
  const tick=async()=>{
    await deliverGroupResults(store as any,sdk as any,()=>true,transport,signal);
    await processGroupInputs(store as any,sdk as any,7,5,transport,signal);
  };
  return {rows,store,sent,inputs,tick,snapshot:()=>JSON.stringify([...rows])};
}
const args={taskId:"task",dueAt:1,waitingFor:"agent" as const,text:"Проверь, прислала ли Лена файл, и отпишись сюда"};

test("at the due time the employee's own turn re-reads the task and answers under the original message",async()=>{
  const f=fixture("Файл от Лены пришёл, Олег, можно проверять.");
  assert.equal(queueGroupReminder(f.store as any,7,5,args).state,"queued");
  await f.tick();
  assert.equal(queueGroupReminder(f.store as any,7,5,args).state,"started");
  assert.equal(f.inputs.length,1);
  const prompt=f.inputs[0][0].text as string;
  assert.match(prompt,/Проверь, прислала ли Лена файл/);
  assert.match(prompt,/Прислала файл/);
  assert.doesNotMatch(prompt,/раньше/);
  assert.match(f.inputs[0].map((x:any)=>x.text).join("\n"),/Group taskId: task/);
  assert.deepEqual(f.sent,[{chat_id:-1001,message_thread_id:3,reply_parameters:{message_id:10},text:"Файл от Лены пришёл, Олег, можно проверять."}]);
  await f.tick();
  assert.equal(f.inputs.length,1);
  assert.equal(f.sent.length,1);
});

test("NO_REPLY keeps the topic silent",async()=>{
  const f=fixture("NO_REPLY");
  queueGroupReminder(f.store as any,7,5,args);
  await f.tick();
  assert.equal(f.inputs.length,1);
  assert.equal(f.sent.length,0);
  assert.equal([...f.rows.keys()].some(k=>k.startsWith("group:in:")),false);
});

test("a restart after the due time starts exactly one turn, and revoked access starts none",async()=>{
  const f=fixture("ok");
  queueGroupReminder(f.store as any,7,5,args);
  await deliverGroupResults(f.store as any,{} as any,()=>true,()=>async()=>({}) as any,new AbortController().signal);
  const restored=fixture("ok",f.snapshot());
  await restored.tick();
  assert.equal(restored.inputs.length,1);
  const revoked=fixture("ok");
  queueGroupReminder(revoked.store as any,7,5,args);
  revoked.store.del("group:policy:-1001:3");
  await revoked.tick();
  assert.equal(queueGroupReminder(revoked.store as any,7,5,args).state,"revoked");
  assert.equal(revoked.inputs.length,0);
});
