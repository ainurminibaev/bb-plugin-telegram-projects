import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import {receiveCloudTelegramPdf} from "../adapters";
import {acceptGroupUpdate,groupExample} from "../ingress";
import {bindGroupTopic,processGroupInputs} from "../group-worker";

const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture\n");
const bot = "123:fixture_only";
const getToken = async () => bot;
const file = {file_id: "bound-file", file_path: "documents/file_1.pdf", file_size: bytes.length};
const cloud = (response: () => Response | Promise<Response>) => (async () => response()) as typeof fetch;
async function usingInbox<T>(run:(root:string)=>Promise<T>) {
  const root = await mkdtemp(join(tmpdir(),"cloud-pdf-test-"));
  try { return await run(root); }
  finally { await rm(root,{recursive:true,force:true}); }
}
const input = (inboxRoot:string, signal=new AbortController().signal) => ({
  inboxRoot, signal, updateId:21, threadId:"isolated:fixture", name:"fixture.pdf",
  size:bytes.length, fileId:file.file_id,
});

test("ingress only marks a declared PDF document with a .pdf name", () => {
  const example = (name:string,mime:string) => groupExample({
    message_id:20, document:{file_id:"A",file_name:name,file_size:50,mime_type:mime},
  });
  assert.equal(example("ok.PDF","application/pdf")?.pdf,true);
  assert.equal(example("fake.zip","application/pdf")?.pdf,undefined);
  assert.equal(example("fake.pdf","application/zip")?.pdf,undefined);
});

test("cloud download locks origin, disables redirects and reuses the scoped receipt", () => usingInbox(async root => {
  const request = (async (url,options) => {
    assert.equal(url,`https://api.telegram.org/file/bot${bot}/documents/file_1.pdf`);
    assert.equal(options.redirect,"error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes);
  }) as typeof fetch;
  const a = await receiveCloudTelegramPdf(getToken,file,input(root),request);
  const b = await receiveCloudTelegramPdf(getToken,file,input(root),request);
  assert.deepEqual(b,a);
  assert.equal(dirname(dirname(a.path)),root);
  assert.deepEqual(await readFile(a.path),bytes);
  assert.equal(a.sha256,createHash("sha256").update(bytes).digest("hex"));
  assert.equal((await stat(a.path)).mode & 0o777,0o640,"the inbox group reads it, others cannot");
  const receipt = JSON.parse(await readFile(join(dirname(a.path),".complete.json"),"utf8"));
  assert.equal(receipt.threadId,"isolated:fixture");
  assert.equal((await readdir(root)).length,1);
}));

test("foreign file identity, invalid paths and oversized metadata never fetch", () => usingInbox(async root => {
  const notCalled = (async () => {throw new Error("unexpected fetch");}) as typeof fetch;
  const cases = [{...file,file_id:"unbound-file"},{...file,file_size:8*1024*1024},
    ...["../document.pdf","https://other.invalid/file.pdf","//other.invalid/path","%2e%2e/path.pdf",
      "documents/path.pdf?query"].map(file_path=>({...file,file_path}))];
  for (const candidate of cases)
    await assert.rejects(receiveCloudTelegramPdf(getToken,candidate,input(root),notCalled),/attachment_invalid_pdf/);
  assert.deepEqual(await readdir(root),[]);
}));

test("bad payload, overrun, truncation, redirect and transport errors leave no receipt", () => usingInbox(async root => {
  const cases = [
    [cloud(()=>new Response(Buffer.alloc(bytes.length,65))),/attachment_invalid_pdf/],
    [cloud(()=>new Response(Buffer.concat([bytes,Buffer.from("X")]))),/attachment_too_large/],
    [cloud(()=>new Response(bytes.subarray(0,-1))),/attachment_size_mismatch/],
    [cloud(()=>new Response("redirect",{status:302,headers:{location:"https://other.invalid"}})),/attachment_download_failed/],
    [cloud(()=>{throw new Error(bot);}),/^Error: attachment_download_failed$/],
  ] as const;
  for (const [request,error] of cases)
    await assert.rejects(receiveCloudTelegramPdf(getToken,file,input(root),request),error);
  assert.deepEqual(await readdir(root),[]);
}));

test("a cancelled download leaves no cache", () => usingInbox(async root => {
  const abort = new AbortController();
  const request=cloud(()=>{abort.abort();return new Response(bytes);});
  await assert.rejects(receiveCloudTelegramPdf(getToken,file,input(root,abort.signal),request),{name:"AbortError"});
  assert.deepEqual(await readdir(root),[]);
}));

test("revocation during a PDF download blocks handoff and delivery", () => usingInbox(async root => {
  const owner = 101, sender = 102, botId = 103, chatId = -8001;
  const policyKey = "group:policy:-8001:0";
  const rows = new Map<string,any>();
  const store = {get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>{rows.set(key,value);},
    del:(key:string)=>{rows.delete(key);},
    list:(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value})),
    atomic:(fn:()=>void)=>fn()};
  bindGroupTopic(store as any,{chatId,topicId:0,threadId:"fixture",botId,botUsername:"fixture_bot",
    ownerOnly:true,allowedSenderIds:[sender],requireMention:true,isolated:true,revision:"initial"},"group");
  const previous=process.env.BB_TELEGRAM_GROUP_EXECUTORS;
  process.env.BB_TELEGRAM_GROUP_EXECUTORS=JSON.stringify({
    "-8001:0":{threadId:"fixture",projectId:"group",cli:"/missing/executor"},
  });
  try {
    const accepted=acceptGroupUpdate(store as any,{update_id:21,message:{message_id:21,
      date:Math.floor(Date.now()/1000)+2,chat:{id:chatId,type:"group"},from:{id:sender},
      caption:"@fixture_bot fixture",caption_entities:[{type:"mention",offset:0,length:12}],
      document:{file_id:file.file_id,file_name:"fixture.pdf",file_size:bytes.length,mime_type:"application/pdf"},
    }},owner,botId);
    assert.equal(accepted,true);
    const response=cloud(()=>{store.del(policyKey);return new Response(bytes);});
    let downloads=0;
    const signal=new AbortController().signal;
    await processGroupInputs(store as any,{} as any,owner,botId,
      ()=>{throw new Error("revoked delivery");},signal,undefined,undefined,async()=> {
        downloads++;
        return receiveCloudTelegramPdf(getToken,file,input(root,signal),response);
      });
    assert.equal(downloads,1);
    assert.equal(rows.get("group:receipt:103:21").state,"revoked");
    assert.equal(rows.has("group:in:103:21"),false);
  } finally {
    if(previous===undefined) delete process.env.BB_TELEGRAM_GROUP_EXECUTORS;
    else process.env.BB_TELEGRAM_GROUP_EXECUTORS=previous;
  }
}));

test("ordinary HTML, WAV, ZIP, unknown and empty documents are identical after scoped cloud receipt", () => usingInbox(async root => {
  const {receiveCloudTelegramDocument}=await import("../adapters");
  const fixtures=[
    ["учебный образец.html",Buffer.from("<p>synthetic &amp; neutral</p>")],
    ["neutral.wav",Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000","hex")],
    ["neutral.zip",Buffer.from("504b0506000000000000000000000000000000000000","hex")],
    ["unknown.zzz",Buffer.from([0,255,143,7])],
    ["empty.dat",Buffer.alloc(0)],
  ] as const;
  for (const [i,[name,data]] of fixtures.entries()) {
    const fileId="document-"+i;
    const found={file_id:fileId,file_path:"documents/file_"+i+".dat",file_size:data.length};
    const request=(async (url,opts)=>{
      assert.equal(url,`https://api.telegram.org/file/bot${bot}/${found.file_path}`);
      assert.equal(opts.redirect,"error");
      return new Response(data);
    }) as typeof fetch;
    const params={...input(root),name,fileId,size:data.length};
    const saved=await receiveCloudTelegramDocument(getToken,found,params,request);
    assert.equal(saved.name,name);
    assert.deepEqual(await readFile(saved.path),data);
    assert.equal(saved.sha256,createHash("sha256").update(data).digest("hex"));
    await assert.rejects(receiveCloudTelegramDocument(getToken,{...found,file_id:"another-task"},params,request),/invalid_document/);
  }
  const max=2*1024*1024;
  await assert.rejects(receiveCloudTelegramDocument(getToken,{...file,file_size:undefined},
    {...input(root),size:0},cloud(()=>new Response(new Uint8Array(max+1)))),/too_large/);
}));
