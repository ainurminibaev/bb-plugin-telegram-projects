import test from "node:test";
import assert from "node:assert/strict";
import {TelegramFailure} from "../model";
import {REPEAT_WINDOW_MS,recentlySentFiles,rememberSentFiles,sameTelegramFilename,sendOutcome,unsettledSendText} from "../send-outcome";

const memoryStore=()=>{const rows=new Map<string,any>();return {get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},
  del:(k:string)=>{rows.delete(k)},list:<T>(p:string)=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:value as T})),
  atomic:(fn:()=>void)=>fn()} as any;};

test("file names compare the way Telegram stores them",()=>{
  assert.ok(sameTelegramFilename("сопроводительное План _ Клиент.md","сопроводительное_План_Клиент.md"));
  assert.ok(sameTelegramFilename("a  b.txt","a_b.txt"));
  assert.ok(!sameTelegramFilename("a.txt","b.txt"));
});

test("unknown is not «not delivered»: Telegram's ok is delivered, no answer is unknown, a refusal is rejected",()=>{
  assert.equal(sendOutcome(Error("unconfirmed_album")),"delivered");
  assert.equal(sendOutcome(Error("outbound_receipt_missing")),"delivered");
  assert.equal(sendOutcome(new TelegramFailure("telegram_network",30,true)),"unknown");
  assert.equal(sendOutcome(new TelegramFailure("telegram_502",30,true)),"unknown");
  assert.equal(sendOutcome(new TelegramFailure("telegram_400",30,false)),"rejected");
  assert.equal(sendOutcome(new TelegramFailure("telegram_network",30,true,undefined,true)),"rejected","no connection — the request did not leave");
  for (const outcome of ["delivered","unknown"] as const) {
    const text=unsettledSendText({went:"текст",outcome,from:"/x/a.md",rest:["/x/a.md","/x/b.md"]});
    assert.match(text,/НЕ повторяй/);
    assert.doesNotMatch(text,/Повтори отправку/);
  }
  assert.match(unsettledSendText({went:"текст",outcome:"unknown",from:"/x/a.md",rest:["/x/a.md"]}),/исход не подтверждён, возможно, доставлено/);
});

test("the same files to the same place within the window are a repeat; another place or later — not",()=>{
  const store=memoryStore(); const now=1_000_000_000;
  const files=[{sha256:"a".repeat(64),name:"a.md"},{sha256:"b".repeat(64),name:"b.md"}];
  rememberSentFiles(store,5,-100,3,files,"unknown",now);
  assert.deepEqual(recentlySentFiles(store,5,-100,3,files,now+60_000).map(r=>[r.name,r.outcome,r.minutes]),[["a.md","unknown",1],["b.md","unknown",1]]);
  assert.equal(recentlySentFiles(store,5,-100,4,files,now+60_000).length,0,"another topic");
  assert.equal(recentlySentFiles(store,5,-100,3,files,now+REPEAT_WINDOW_MS+1).length,0,"after the window");
  rememberSentFiles(store,5,-100,3,[],"delivered",now+REPEAT_WINDOW_MS+1);
  assert.equal(store.list("send:recent-file:").length,0,"old rows are cleaned");
});
