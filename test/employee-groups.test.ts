import test from "node:test";
import assert from "node:assert/strict";
import {acceptGroupUpdate,unboundAddressedGroupMessage} from "../ingress";
import {bindGroupTopic} from "../group-worker";
import {announceInGroup} from "../setup-screens";
import {defaultEmployeeGroupSettings,saveGroupSettings} from "../rights";

const OWNER=7, BOT=5, CHAT=-1001234, MEMBER=42;
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}
const msg=(id:number,text:string,extra:any={})=>({update_id:id,message:{message_id:100+id,date:2_000_000_000,is_topic_message:true,message_thread_id:9,
  chat:{id:CHAT,type:"supergroup"},from:{id:MEMBER,first_name:"Лена"},text,entities:[{type:"mention",offset:0,length:8}],...extra}});

test("a topic of a group the employee is in is bound on its first mention and the mention is answered",()=>{
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  store.put(`visibility:${BOT}:group:${CHAT}`,{chat:CHAT,title:"Склад",administrator:true,event:1});
  const u=msg(1,"@acmebot привет");
  const unbound=unboundAddressedGroupMessage(store as any,u,BOT,"acmebot");
  assert.deepEqual(unbound,{chatId:CHAT,topicId:9,date:2_000_000_000,title:"Склад"});
  assert.equal(unboundAddressedGroupMessage(store as any,msg(2,"просто сообщение",{entities:[]}),BOT,"acmebot"),undefined,"only an address binds");
  bindGroupTopic(store as any,{chatId:CHAT,topicId:9,threadId:"thr_topic",inOwnerProject:true,ownerOnly:false,requireMention:true,
    botId:BOT,botUsername:"acmebot",ownerId:OWNER,revision:"r",acceptAfterSecond:unbound!.date-1},"employee-project");
  assert.equal(store.get("group:project:employee-project"),undefined,"the owner's project keeps its bridge commands");
  assert.equal(acceptGroupUpdate(store as any,u,OWNER,BOT),true,"the first mention itself is accepted");
  assert.equal(store.list<any>(`group:in:${BOT}:`)[0].value.route.threadId,"thr_topic");
  assert.equal(unboundAddressedGroupMessage(store as any,msg(3,"@acmebot ещё"),BOT,"acmebot"),undefined,"bound once");
});

test("a colleague agent of the organization starts a topic's conversation by a mention; another bot does not",()=>{
  const store=memoryStore();
  store.put("rights:install-kind","employee");
  store.put(`visibility:${BOT}:group:${CHAT}`,{chat:CHAT,title:"Склад",administrator:true,event:1});
  store.put("rights:agent-bots",[77]);
  const fromBot=(id:number,bot:number)=>msg(id,"@acmebot привет",{from:{id:bot,is_bot:true,first_name:"Коллега"}});
  assert.deepEqual(unboundAddressedGroupMessage(store as any,fromBot(1,77),BOT,"acmebot"),{chatId:CHAT,topicId:9,date:2_000_000_000,title:"Склад"});
  assert.equal(unboundAddressedGroupMessage(store as any,fromBot(2,78),BOT,"acmebot"),undefined,"a bot outside the organization");
});

test("a group the bot is not in is never bound",()=>{
  const store=memoryStore();
  assert.equal(unboundAddressedGroupMessage(store as any,msg(1,"@acmebot привет"),BOT,"acmebot"),undefined);
});

test("an employee announces once in a group open to all members",async()=>{
  const store=memoryStore(); store.put("rights:install-kind","employee");
  const sent:any[]=[];
  const ctx={store:store as any,bot:BOT,owner:OWNER,botUsername:"acmebot",tg:(chat:number)=>(async(m:string,p:any)=>{sent.push({chat,...p});return {};}) as any} as any;
  await announceInGroup(ctx,CHAT,defaultEmployeeGroupSettings());
  await announceInGroup(ctx,CHAT,defaultEmployeeGroupSettings());
  assert.equal(sent.length,1);
  assert.equal(sent[0].chat,CHAT);
  assert.match(sent[0].text,/отвечаю здесь всем участникам: отметьте @acmebot/);
  assert.match(sent[0].text,/нажмите «Старт»/);
  const closed=saveGroupSettings(store as any,BOT,-1009,{who:"access"});
  await announceInGroup(ctx,-1009,closed);
  assert.equal(sent.length,1,"a closed group gets no announcement");
});
