import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedGroupInput,submitIsolatedGroup} from "../isolated-group";

function fixture(send: (arg: any)=>Promise<void>) {
  const rows = new Map();
  const store = {get:(key:string)=>rows.get(key),put:(k:string,v:unknown)=>rows.set(k,v),atomic:(f:()=>void)=>f()};
  const sdk = {threads:{events:{list:async()=>[]},get:async()=>({projectId:"group",id:"thread",visibility:"visible"}),send}};
  return {sdk:sdk as any, store:store as any, args:{projectId:"group",threadId:"thread",routeToken:randomUUID(),text:"Prepare the report"}};
}

test("isolated executor submits one turn across concurrent duplicate calls",async()=>{
  const inputs:any[]=[];
  const {sdk,store,args}=fixture(async q=>{ inputs.push(q); });
  const submit=()=>submitIsolatedGroup(sdk,store,"group",args);
  await Promise.all([submit(),submit()]);
  assert.deepEqual(await submit(),{state:"accepted"});
  assert.equal(inputs.length,1);
  assert.ok(inputs[0].input[0].text.endsWith(args.text));
  assert.match(inputs[0].input[0].text,/outputs\/.*new filename.*absolute PDF path/);
  assert.ok(inputs[0].input[1].text.includes(args.routeToken));
  await assert.rejects(submitIsolatedGroup(sdk,store,"group",{...args,text:"Changed"}),/conflict/);
  assert.equal(isolatedGroupInput.safeParse({...args,chatId:123}).success,false);
});

test("ambiguous submissions cannot be retried into a duplicate turn",async()=>{
  let calls=0;
  const {sdk,store,args}=fixture(async()=>{ calls++; throw Error("interrupted"); });
  await assert.rejects(submitIsolatedGroup(sdk,store,undefined,args),/project_required/);
  await assert.rejects(submitIsolatedGroup(sdk,store,"private",args),/project_required/);
  await assert.rejects(submitIsolatedGroup(sdk,store,"group",{...args,threadId:"private"}),/thread_required/);
  await assert.rejects(submitIsolatedGroup(sdk,store,"group",args),/interrupted/);
  assert.deepEqual(await submitIsolatedGroup(sdk,store,"group",args),{state:"unconfirmed"});
  assert.equal(calls,1);
});

test("isolated replies follow the accepted request even when turns finish in reverse order",async()=>{
  const {sdk,store,args}=fixture(async()=>{});
  const other={...args,text:"Other work",routeToken:randomUUID()};
  await submitIsolatedGroup(sdk,store,"group",args);
  await submitIsolatedGroup(sdk,store,"group",other);
  const {routeMarker}=await import("../reply-routing");
  const {readIsolatedGroup}=await import("../isolated-group");
  const events:any[]=[];
  function event(type:string,turnId:string,data:unknown) {
    events.push({type,threadId:args.threadId,seq:events.length+1,scope:{kind:"turn",turnId},data});
  }
  for (const [id,q] of [["a",args],["b",other]] as const) {
    event("client/turn/requested",id,{originPluginId:"telegram-projects",requestId:id,input:[routeMarker(q.routeToken)]});
    event("turn/input/accepted",id,{clientRequestId:id});
  }
  for (const id of ["b","a"]) {
    event("item/completed",id,{item:{type:"agentMessage",text:"reply "+id}});
    event("turn/completed",id,{status:"completed"});
  }
  sdk.threads.events.list=async()=>events;
  assert.deepEqual(await readIsolatedGroup(sdk,store,"group",args),{state:"finished",text:"reply a"});
  assert.deepEqual(await readIsolatedGroup(sdk,store,"group",other),{state:"finished",text:"reply b"});
});

test("the personal bridge receives the exact PDF named by the completed isolated turn",async()=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {createHash}=await import("node:crypto");
  const {readIsolatedPdf}=await import("../isolated-group");
  const {collectIsolatedPdf}=await import("../isolated-client");
  const {pdfChunkSize}=await import("../group-pdf");
  const root=await realpath(await mkdtemp(join(tmpdir(),"group-result-")));
  try {
    const path=join(root,"outputs","report.pdf");
    await mkdir(join(root,"outputs"));
    const bytes=Buffer.alloc(pdfChunkSize+123,65);
    bytes.write("%PDF-1.5");await writeFile(path,bytes);
    const {sdk,store,args}=fixture(async()=>{});
    sdk.threads.get=async()=>({id:"thread",projectId:"group",environmentId:"env",visibility:"visible"});
    sdk.environments={get:async()=>({projectId:"group",hostId:"worker",path:root})};
    store.put("group:submission:"+args.routeToken,{finished:true,projectId:"group",threadId:"thread",answer:"[Report]("+path+")"});
    const read=(offset:number)=>readIsolatedPdf(sdk,store,"group","worker",{...args,path,offset});
    const pdf=await collectIsolatedPdf(path,read);
    assert.equal(pdf.sha256,createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(Buffer.from(await pdf.document.arrayBuffer()),bytes);
    await assert.rejects(readIsolatedPdf(sdk,store,"group","worker",{...args,path:path+".pdf",offset:0}),/export_unavailable/);
    await assert.rejects(readIsolatedPdf(sdk,store,"group","another-host",{...args,path,offset:0}),/export_unavailable/);
    await assert.rejects(collectIsolatedPdf(path,async offset=>{
      const part=await read(offset);return offset?{...part,revision:"changed"}:part;
    }),/pdf_changed/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("isolated upload streams verified bytes, reuses the receipt and rejects a partial transfer",async()=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm,readdir,realpath}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join,resolve}=await import("node:path");
  const {createHash}=await import("node:crypto");
  const {groupExecutor}=await import("../isolated-client");
  const root=await realpath(await mkdtemp(join(tmpdir(),"group-inbox-")));
  const prior=process.env.BB_TELEGRAM_GROUP_EXECUTORS;
  try {
    const cached=join(root,"private","71-"+ "a".repeat(20)), remote=join(root,"worker");
    await mkdir(cached,{recursive:true});
    const cli=join(root,"launcher"),receiver=resolve("companion/isolated-inbox.mjs");
    await writeFile(cli,`#!/bin/sh
set -eu
test "$1" = isolated-upload
shift
export BB_TELEGRAM_ISOLATED_INBOX="${remote}" BB_TELEGRAM_ISOLATED_THREAD=worker
exec "${process.execPath}" "${receiver}" "$@"
`,{mode:0o700});
    process.env.BB_TELEGRAM_GROUP_EXECUTORS=JSON.stringify({"-77:3":{cli,threadId:"worker",projectId:"group"}});
    const executor=groupExecutor(-77,3)!,name="План 1.pdf",bytes=Buffer.alloc(2*1024*1024+7,32);
    const file={name,path:join(cached,name),bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    await writeFile(file.path,bytes);
    const saved=await executor.upload(file,new AbortController().signal);
    assert.notEqual(saved.path,file.path);
    assert.deepEqual(await readFile(saved.path),bytes);
    assert.deepEqual(await executor.upload(file,new AbortController().signal),saved);
    await assert.rejects(executor.upload({...file,sha256:"a".repeat(64)},new AbortController().signal));
    assert.deepEqual(await readdir(remote),["71-"+"a".repeat(20)]);
    assert.equal(JSON.parse(await readFile(join(remote,"71-"+"a".repeat(20),".complete.json"),"utf8")).threadId,"worker");
  } finally {
    if(prior===undefined) delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;else process.env.BB_TELEGRAM_GROUP_EXECUTORS=prior;
    await rm(root,{recursive:true,force:true});
  }
});
