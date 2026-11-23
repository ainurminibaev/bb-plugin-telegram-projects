import test from "node:test";
import assert from "node:assert/strict";
import {peopleNote, setAccess} from "../rights";

const store=()=>{const m=new Map<string,any>();return {get:(k:string)=>m.get(k),put:(k:string,v:any)=>{m.set(k,v)},del:(k:string)=>{m.delete(k)},
  list:(p:string)=>[...m].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),atomic:(f:()=>void)=>f()} as any;};

test("the owner sees who may write privately and whose requests wait; others only that it is not shown (С43)",()=>{
  const s=store(); const BOT=1, OWNER=10;
  setAccess(s,BOT,[{id:20,name:"Мария"}]);
  s.put(`employee:private:access:${BOT}:${OWNER}:30`,{state:"pending",name:"Олег"});
  const owner=peopleNote(s,BOT,OWNER,OWNER);
  assert.match(owner,/Пишет владелец/);
  assert.match(owner,/открыта: Мария/);
  assert.match(owner,/Ждут одобрения владельца: Олег/);
  const member=peopleNote(s,BOT,OWNER,20);
  assert.doesNotMatch(member,/Мария|Олег/);
  assert.match(member,/здесь не показываешь/);
  assert.match(member,/Память:/);
});
