import test from "node:test";
import assert from "node:assert/strict";
import type {Store} from "../model";
import {applyThreadTitles,groupName,rememberGroupTitle,threadTitlesPass,TITLE_KEY,wantedTitles} from "../thread-titles";
import {rememberForumName} from "../forum-defaults";
import {saveGroupSettings,setAccess} from "../rights";

const bot=5, forum=-1001, plain=-1002;
function setup() {
  const rows=new Map<string,unknown>();
  const store:Store={get:k=>structuredClone(rows.get(k)) as never,put:(k,v)=>{rows.set(k,structuredClone(v));},del:k=>{rows.delete(k);},
    atomic:fn=>fn(),list:p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value) as never}))};
  const titles=new Map<string,string|null>();
  const updates:string[]=[];
  const sdk={threads:{
    get:async({threadId}:{threadId:string})=>({title:titles.get(threadId) ?? null}),
    update:async({threadId,title}:{threadId:string;title:string})=>{titles.set(threadId,title);updates.push(threadId);},
  }};
  const bind=(chatId:number,topicId:number,threadId:string,extra={})=>store.put(`group:policy:${chatId}:${topicId}`,
    {chatId,topicId,threadId,botId:bot,botUsername:"b",ownerId:7,ownerOnly:true,requireMention:false,revision:"r",...extra});
  store.put(`visibility:${bot}:group:${forum}`,{chat:forum,title:"Рабочий форум"});
  store.put(`visibility:${bot}:group:${plain}`,{chat:plain,title:"Склад"});
  return {store,sdk,titles,updates,bind};
}

test("С66: the bridge names threads after their place: topic, General, a group without topics, a person's chat", async () => {
  const {store,sdk,titles,bind}=setup();
  rememberForumName(store,bot,forum,21,"Долги",1);
  bind(forum,21,"t-debts"); bind(forum,0,"t-general"); bind(plain,0,"t-plain");
  setAccess(store,bot,[{id:42,name:"Олег"}]);
  bind(42,0,"t-oleg",{privateChat:true});
  titles.set("t-debts","Долги"); titles.set("t-general",null); titles.set("t-plain","Склад"); titles.set("t-oleg","Олег");
  await applyThreadTitles(store,sdk,bot);
  assert.equal(titles.get("t-debts"),"Долги — группа «Рабочий форум»");
  assert.equal(titles.get("t-general"),"General — группа «Рабочий форум»");
  assert.equal(titles.get("t-plain"),"группа «Склад»");
  assert.equal(titles.get("t-oleg"),"личка «Олег»");
});

test("С66: a title set by hand is kept — in the one pass and after the bridge has named the thread", async () => {
  const {store,sdk,titles,updates,bind}=setup();
  rememberForumName(store,bot,forum,21,"Долги",1);
  rememberForumName(store,bot,forum,22,"Рецепты",1);
  bind(forum,21,"t-debts"); bind(forum,22,"t-recipes");
  titles.set("t-debts","Мой форум · Долги");              // the owner's own name, before the update
  titles.set("t-recipes","Рецепты");
  assert.equal(await threadTitlesPass(store,sdk,bot),1);
  assert.equal(titles.get("t-debts"),"Мой форум · Долги");
  assert.equal(titles.get("t-recipes"),"Рецепты — группа «Рабочий форум»");
  assert.equal(await threadTitlesPass(store,sdk,bot),0);         // one pass only
  // Renamed by hand after the bridge: kept on the next rename of the topic.
  titles.set("t-recipes","Кухня");
  rememberForumName(store,bot,forum,22,"Рецепты на неделю",2);
  updates.length=0;
  await applyThreadTitles(store,sdk,bot,forum);
  assert.equal(titles.get("t-recipes"),"Кухня");
  assert.deepEqual(updates,[]);
});

test("С66: a renamed topic or group renames the thread; the short name setting replaces the group's title", async () => {
  const {store,sdk,titles,bind}=setup();
  rememberForumName(store,bot,forum,21,"Долги",1);
  bind(forum,21,"t-debts");
  titles.set("t-debts","Долги");
  await applyThreadTitles(store,sdk,bot);
  rememberForumName(store,bot,forum,21,"Долги и займы",2);
  await applyThreadTitles(store,sdk,bot,forum);
  assert.equal(titles.get("t-debts"),"Долги и займы — группа «Рабочий форум»");
  assert.equal(rememberGroupTitle(store,bot,{message:{chat:{id:forum},new_chat_title:"Форум"}}),forum);
  await applyThreadTitles(store,sdk,bot,forum);
  assert.equal(titles.get("t-debts"),"Долги и займы — группа «Форум»");
  saveGroupSettings(store,bot,forum,{shortName:"Мой форум"} as never);
  assert.equal(groupName(store,bot,forum),"Мой форум");
  await applyThreadTitles(store,sdk,bot,forum);
  assert.equal(titles.get("t-debts"),"Долги и займы — группа «Мой форум»");
  assert.equal(store.get(TITLE_KEY+"t-debts"),"Долги и займы — группа «Мой форум»");
});

test("С66: the assistant pair's threads are never renamed", async () => {
  const {store,sdk,titles,bind}=setup();
  rememberForumName(store,bot,forum,21,"Долги",1);
  bind(forum,21,"pair-a");
  store.put("chat:pair:state",{titles:{"pair-a":"Помощник · Claude"}});
  titles.set("pair-a","Долги");
  assert.equal(wantedTitles(store,bot).has("pair-a"),false);
  await applyThreadTitles(store,sdk,bot);
  assert.equal(titles.get("pair-a"),"Долги");
});
