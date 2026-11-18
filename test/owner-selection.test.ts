import test from "node:test";
import assert from "node:assert/strict";
import {writeFileSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {acceptOwnerSelection,presentProposal,handleOwnerSelection,collectDecisionResults} from "../owner-selection";
import type {Store,Telegram} from "../model";

test("only an owner reply to the current draft releases selected operations",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"decision-"));
  const prior=process.env.BB_TELEGRAM_DECISION_OUTBOXES;
  const results=mkdtempSync(join(tmpdir(),"results-"));
  const previousResults=process.env.BB_TELEGRAM_DECISION_RESULTS;
  process.env.BB_TELEGRAM_DECISION_RESULTS=JSON.stringify({work:{host:"example.org",directory:results}});
  process.env.BB_TELEGRAM_DECISION_OUTBOXES=JSON.stringify({work:dir});
  try {
    let rows=new Map<string,any>();
    const store:Store={get:k=>rows.get(k),put:(k,v)=>{rows.set(k,v);},del:k=>{rows.delete(k);},
      atomic:f=>f(),list:p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value}))};
    const taskId=randomUUID(),actor=11,bot=22;
    const origin={chatId:-1,topicId:3,owner:actor,sender:actor,bot,threadId:"worker",projectId:"work",revision:"binding",messageId:5};
    store.put("group:origin:"+taskId,origin);
    store.put("group:policy:-1:3",{...origin,ownerId:actor,botId:bot,ownerOnly:true});
    store.put("group:thread:worker","group:policy:-1:3");store.put("group:project:work",true);
    let message=40;
    const tg:Telegram=async<T>(_method,p)=>{assert.equal(p.chat_id,actor);return {message_id:++message} as T;};
    const proposal={taskId,threadId:"coordinator",routeToken:randomUUID(),revision:1,items:["A","B","C"]};
    const old=await presentProposal(store,actor,bot,proposal,tg);
    const current=await presentProposal(store,actor,bot,{...proposal,revision:2,items:["A2","B2","C2"]},tg);
    const reply=(sender:number,id:number,text="Сделай первый и третий.")=>({message:{from:{id:sender},chat:{id:sender,type:"private"},
      reply_to_message:{message_id:id,from:{id:bot},chat:{id:sender}},text}});
    const run=(event:any)=>acceptOwnerSelection(store,event,actor,bot);
    run(reply(33,current.messageId));run(reply(actor,old.messageId));run(reply(actor,current.messageId,"/approve 1,4"));
    const forwarded=reply(actor,current.messageId);run({message:{...forwarded.message,forward_origin:{type:"user"}}});
    assert.deepEqual(readdirSync(dir),[]);
    for (const text of ["первый и третий?", "да", "не делай первый и третий", "сделай первый, если успеем", "давай сначала обсудим"]) {
      assert.equal(run(reply(actor,current.messageId,text)),false);
      assert.deepEqual(readdirSync(dir),[]);
    }
    const vague={...reply(actor,current.messageId,"да"),update_id:600};
    await handleOwnerSelection(store,vague,actor,bot,tg);
    const clarification=message;
    await handleOwnerSelection(store,vague,actor,bot,tg);
    assert.equal(message,clarification);
    assert.deepEqual(readdirSync(dir),[]);
    const valid=reply(actor,clarification,"Давай 1 и 3.");run(valid);
    const path=join(dir,taskId+".json"),inode=statSync(path).ino;
    const receipt=JSON.parse(readFileSync(path,"utf8"));
    assert.deepEqual(receipt,{actor,taskId,revision:2,draftHash:current.draftHash,selected:[1,3]});
    rows=new Map(JSON.parse(JSON.stringify([...rows])));
    run(valid);run(reply(actor,current.messageId,"/approve 1,3"));run(reply(actor,current.messageId,"/approve 2"));
    assert.equal(statSync(path).ino,inode);
    assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),receipt);
    const links=["https://example.org/task/1","https://example.org/task/3"];
    const resultFile=join(results,taskId+".json");
    const collect=()=>collectDecisionResults(store,actor,bot);
    const resultKey="group:result:"+taskId;
    for(const invalid of [{actor:99},{taskId:randomUUID()},{revision:1},{draftHash:"other"},
        {selected:[2,3]},{links:[links[0],links[0]]},{links:[links[0],"https://example.org.evil/task/3"]}]) {
      writeFileSync(resultFile,JSON.stringify({...receipt,links,...invalid}));
      collect();assert.equal(store.get(resultKey),undefined);
    }
    writeFileSync(resultFile,JSON.stringify({...receipt,links}));
    collect();collect();
    assert.deepEqual(store.get(resultKey),{state:"queued",text:links.join("\n")});
    assert.equal(store.list("group:result-queue:").length,1);
    assert.equal(store.list("selection:await-result:").length,0);
    await assert.rejects(presentProposal(store,actor,bot,{...proposal,revision:3},tg),/proposal_conflict/);
    // Synthetic adapter scans twice, including after restoring its own ledger.
    const external:number[]=[];
    let ledger=new Map<string,string>();
    function consume() {
      for(const file of readdirSync(dir)) {
        const decision=JSON.parse(readFileSync(join(dir,file),"utf8"));
        if(decision.taskId!==taskId || decision.revision!==2 || decision.draftHash!==current.draftHash) continue;
        for(const item of decision.selected) {
          const id=[taskId,2,decision.draftHash,item].join(":");
          if(ledger.has(id)) continue;
          external.push(item);
          ledger.set(id,"test-receipt-"+item);
        }
      }
      return [...ledger.values()];
    }
    assert.deepEqual(consume(),["test-receipt-1","test-receipt-3"]);
    ledger=new Map(JSON.parse(JSON.stringify([...ledger])));
    assert.deepEqual(consume(),["test-receipt-1","test-receipt-3"]);
    assert.deepEqual(external,[1,3]);
  } finally {
    if(prior===undefined) delete process.env.BB_TELEGRAM_DECISION_OUTBOXES;
    else process.env.BB_TELEGRAM_DECISION_OUTBOXES=prior;
    if(previousResults===undefined) delete process.env.BB_TELEGRAM_DECISION_RESULTS;
    else process.env.BB_TELEGRAM_DECISION_RESULTS=previousResults;
    rmSync(results,{recursive:true,force:true});
    rmSync(dir,{recursive:true,force:true});
  }
});
