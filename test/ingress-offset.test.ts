import test from "node:test";
import assert from "node:assert/strict";
import {offsetForServer} from "../ingress";

test("switching Telegram servers starts the update offset over; an unrecorded install keeps it",()=>{
  const rows=new Map<string,any>();
  const store={get:(k:string)=>rows.get(k),put:(k:string,v:any)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},list:()=>[],atomic:(f:()=>void)=>f()} as any;
  store.put("ingress:offset",921392554);
  assert.equal(offsetForServer(store,"https://api.telegram.org"),921392554,"first record keeps the offset");
  assert.equal(offsetForServer(store,"https://api.telegram.org"),921392554);
  assert.equal(offsetForServer(store,"http://127.0.0.1:8083"),0,"the local server numbers updates anew");
  store.put("ingress:offset",151221810);
  assert.equal(offsetForServer(store,"http://127.0.0.1:8083"),151221810);
  assert.equal(offsetForServer(store,"https://api.telegram.org"),0,"and back");
});
