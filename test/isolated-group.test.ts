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

test("isolated documents use the worker's validated cache receipt",async()=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {createHash}=await import("node:crypto");
  const {isolatedFile}=await import("../group-attachments");
  const root=await realpath(await mkdtemp(join(tmpdir(),"isolated-document-")));
  try {
    const cacheId="1-"+"f".repeat(20);
    const name="synthetic.txt";
    const directory=join(root,cacheId);
    const path=join(directory,name);
    const bytes=Buffer.from("synthetic document");
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const file={path,name,bytes:bytes.length,sha256};
    const turns:any[]=[];
    const {sdk,store,args}=fixture(async q=>{turns.push(q);});
    await mkdir(directory);
    await writeFile(path,bytes);
    const receiptPath=join(directory,".complete.json");
    const input=isolatedGroupInput.parse({...args,attachments:[isolatedFile(file)]});
    await writeFile(receiptPath,JSON.stringify({...file,threadId:"other-thread"}));
    await assert.rejects(submitIsolatedGroup(sdk,store,"group",input,root),/invalid_attachment_receipt/);
    assert.equal(turns.length,0);
    await writeFile(receiptPath,JSON.stringify({...file,threadId:args.threadId}));
    await submitIsolatedGroup(sdk,store,"group",input,root);
    assert.deepEqual(turns[0].input[1],{type:"localFile",path,name,sizeBytes:bytes.length});
  } finally {await rm(root,{recursive:true,force:true});}
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

test("isolated image export requires an exact completed task link, matching project, host and safe output path",async()=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath,symlink}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {readIsolatedImage}=await import("../isolated-group");
  const {collectIsolatedImage}=await import("../isolated-client");
  const root=await realpath(await mkdtemp(join(tmpdir(),"synthetic-group-image-")));
  try {
    const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=","base64");
    const dir=join(root,"outputs");
    await mkdir(dir);
    const photoPath=join(dir,"result.png");
    const outside=join(root,"private.png");
    const link=join(dir,"alias.png");
    await writeFile(photoPath,pixel);
    await writeFile(outside,pixel);
    await symlink(outside,link);
    const {sdk,store,args}=fixture(async()=>{});
    sdk.threads.get=async()=>({id:"thread",projectId:"group",environmentId:"env",visibility:"visible"});
    sdk.environments={get:async()=>({projectId:"group",hostId:"worker",path:root})};
    const read=(path:string,offset:number,host="worker")=>readIsolatedImage(sdk,store,"group",host,{...args,path,offset});
    await assert.rejects(read(photoPath,0),/export_unavailable/);
    store.put("group:submission:"+args.routeToken,{finished:true,projectId:"group",threadId:"thread",
      answer:`[image](${photoPath}) [outside](${outside}) [alias](${link})`});
    const result=await collectIsolatedImage(photoPath,offset=>read(photoPath,offset));
    assert.equal(result.photo.type,"image/png");
    assert.deepEqual(Buffer.from(await result.photo.arrayBuffer()),pixel);
    await assert.rejects(read(outside,0),/export_path_required/);
    await assert.rejects(read(link,0),/export_path_required/);
    await assert.rejects(read(join(dir,"unlinked.png"),0),/export_unavailable/);
    await assert.rejects(read(photoPath,0,"other-host"),/export_unavailable/);
    const request={...args,path:photoPath,offset:0};
    await assert.rejects(readIsolatedImage(sdk,store,"group","worker",request,true),/export_unavailable/);
    const receipt=store.get("group:submission:"+args.routeToken);
    store.put("group:submission:"+args.routeToken,undefined);
    store.put("private:submission:"+args.routeToken,receipt);
    const privateResult=await readIsolatedImage(sdk,store,"group","worker",request,true);
    assert.deepEqual(Buffer.from(privateResult.data,"base64"),pixel);
    await assert.rejects(read(photoPath,0),/export_unavailable/);
    await assert.rejects(readIsolatedImage(sdk,store,"group","worker",{...request,threadId:"other"},true),/export_unavailable/);

  } finally {await rm(root,{recursive:true,force:true});}
});

test("opaque inbound files enter only their own finished receipt and can be returned byte for byte",async()=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {createHash}=await import("node:crypto");
  const {isolatedFile,opaqueFileReference}=await import("../group-attachments");
  const {readIsolatedDocument}=await import("../isolated-group");
  const {collectIsolatedDocument}=await import("../isolated-client");
  const {localArtifacts}=await import("../telegram-ux");
  const root=await realpath(await mkdtemp(join(tmpdir(),"opaque-route-")));
  try {
    const media=[
      ["résultat (1).html",Buffer.from("<html>NO_INPUT_BYTES</html>")],
      ["neutral.wav",Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000","hex")],
      ["neutral.zip",Buffer.from("504b0506000000000000000000000000000000000000","hex")],
      ["neutral.unknown",Buffer.from([0,255,143,7])],
      ["empty.dat",Buffer.alloc(0)],
    ] as const;
    for (const personal of [false,true]) for (const [i,[name,data]] of media.entries()) {
      const dir=join(root,(i+(personal?media.length:0))+"-0123456789abcdef0123");
      await mkdir(dir);
      const file={path:join(dir,name),name,bytes:data.length,
        sha256:createHash("sha256").update(data).digest("hex")};
      await writeFile(file.path,data);
      const sent:any[]=[];
      const {sdk,store,args}=fixture(async q=>{sent.push(q);});
      await writeFile(join(dir,".complete.json"),JSON.stringify({...file,threadId:args.threadId}));
      sdk.threads.get=async()=>({id:args.threadId,projectId:"group",visibility:"visible",environmentId:"scope"});
      sdk.environments={get:async()=>({projectId:"group",hostId:"worker",path:root})};
      await submitIsolatedGroup(sdk,store,"group",{...args,attachments:[isolatedFile(file,true)]},root,personal);
      assert.doesNotMatch(JSON.stringify(sent),/NO_INPUT_BYTES|localFile|opaque-route-/);
      const reference=opaqueFileReference(file);
      assert.equal(localArtifacts(sent[0].input[1].text)[0].path,reference);
      const key=(personal?"private":"group")+":submission:"+args.routeToken;
      const receipt={...store.get(key),finished:true,answer:"[Вернуть]("+encodeURI(reference).replaceAll(")","%29")+")"};
      store.put(key,receipt);
      const read=(offset:number)=>readIsolatedDocument(sdk,store,"group","worker",{...args,path:reference,offset},personal);
      const result=await collectIsolatedDocument(reference,read);
      assert.equal(result.name,file.name);
      assert.equal(result.document.type,"application/octet-stream");
      assert.deepEqual(Buffer.from(await result.document.arrayBuffer()),data);
      await assert.rejects(readIsolatedDocument(sdk,store,"group","worker",{...args,path:reference,offset:0},!personal),/export_unavailable/);
      await assert.rejects(readIsolatedDocument(sdk,store,"group","worker",{...args,routeToken:randomUUID(),path:reference,offset:0},personal),/export_unavailable/);
      await writeFile(file.path,Buffer.alloc(Math.max(data.length,1),42));
      await assert.rejects(read(0),/invalid_attachment_receipt/);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
