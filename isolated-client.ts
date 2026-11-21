import {imageFormat,type IsolatedAttachment} from "./group-attachments";
import {createHash} from "node:crypto";
import {pdfChunkSize} from "./group-pdf";
import {constants} from "node:fs";
import type {SavedTelegramFile} from "./telegram-files";
import {execFile,spawn} from "node:child_process";
import {mkdtemp,writeFile,rm,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,dirname,isAbsolute,join} from "node:path";
import {promisify} from "node:util";
import {z} from "zod";
import {isolatedGroupResult,isolatedAnswer,isolatedPdfPart,isolatedImagePart} from "./isolated-group";

const exec=promisify(execFile);
const target=z.object({projectId:z.string().min(1),threadId:z.string().min(1),cli:z.string().refine(isAbsolute)}).strict();

const targetsSchema=z.record(z.string(),target);
type Target=z.infer<typeof target>;
function configuredTargets(raw?:string) {
  return raw ? targetsSchema.parse(JSON.parse(raw)) : {};
}

const sameIsolation=(a:Target,b:Target)=>a.cli===b.cli || a.projectId===b.projectId || a.threadId===b.threadId;

export function privateExecutor(bot:number,owner:number,subject:number) {
  const targets=configuredTargets(process.env.BB_TELEGRAM_PRIVATE_EXECUTORS);
  const key=[bot,owner,subject].join(":");
  const entry=targets[key];
  if (!entry) return;
  if (Object.entries(targets).some(([id,other])=>id!==key && sameIsolation(entry,other)) ||
      Object.values(configuredTargets(process.env.BB_TELEGRAM_GROUP_EXECUTORS)).some(other=>sameIsolation(entry,other)))
    throw Error("private_worker_isolation_required");
  return {...isolatedExecutor(entry,true),binding:createHash("sha256").update(JSON.stringify(entry)).digest("hex")};
}

// The administrator supplies a BB CLI launcher pointing only at the isolated instance.
// No file path or command from the group conversation is executed by the bridge.
export function groupExecutor(chatId:number,topicId:number) {
  const entry=configuredTargets(process.env.BB_TELEGRAM_GROUP_EXECUTORS)[chatId+":"+topicId];
  if (entry && Object.values(configuredTargets(process.env.BB_TELEGRAM_PRIVATE_EXECUTORS)).some(other=>sameIsolation(entry,other)))
    throw Error("private_worker_isolation_required");
  return entry && isolatedExecutor(entry,false);
}

function isolatedExecutor(entry:Target,personal:boolean) {
  async function call(method:string,input:object,signal:AbortSignal) {
    const dir=await mkdtemp(join(tmpdir(),"bb-group-"));
    try {
      const path=join(dir,"input.json");
      await writeFile(path,JSON.stringify(input),{mode:0o600});
      const {stdout}=await exec(entry.cli,["plugin","rpc","call","telegram-projects",method,"--input-file",path,"--json"],{
        env:{PATH:process.env.PATH,HOME:process.env.HOME},timeout:30000,maxBuffer:2*1024*1024,signal,
      });
      return JSON.parse(stdout);
    } catch {throw Error("isolated_executor_unavailable");}
    finally {await rm(dir,{recursive:true,force:true});}
  }
  const ids={projectId:entry.projectId,threadId:entry.threadId};
  return {...ids,
    upload:(file:SavedTelegramFile,signal:AbortSignal)=>uploadGroupFile(entry.cli,entry.threadId,file,signal),
    pdf:async(routeToken:string,path:string,signal:AbortSignal)=>collectIsolatedPdf(path,async offset=>
      isolatedPdfPart.parse(await call("readIsolatedPdf",{...ids,routeToken,path,offset},signal))),
    image:async(routeToken:string,path:string,signal:AbortSignal)=>collectIsolatedImage(path,async offset=>
      isolatedImagePart.parse(await call("readIsolatedImage",{...ids,routeToken,path,offset},signal))),
    submit:async(routeToken:string,text:string,signal:AbortSignal,attachments:IsolatedAttachment[])=>
      isolatedGroupResult.parse(await call(personal?"submitIsolatedPrivate":"submitIsolatedGroup",{...ids,routeToken,text,...(attachments.length && {attachments})},signal)),
    read:async(routeToken:string,signal:AbortSignal)=>
      isolatedAnswer.parse(await call(personal?"readIsolatedPrivate":"readIsolatedGroup",{...ids,routeToken},signal)),
  };
}

async function collectIsolatedArtifact(part:(offset:number)=>Promise<z.infer<typeof isolatedPdfPart>>,
  validHeader:(bytes:Buffer)=>boolean) {
  const chunks:Uint8Array<ArrayBuffer>[]=[];
  const hash=createHash("sha256");
  let size=0,revision="",offset=0;
  do {
    const next=await part(offset);
    if (offset && (next.revision!==revision || next.size!==size)) throw Error("isolated_pdf_changed");
    size=next.size; revision=next.revision;
    const bytes=Buffer.from(next.data,"base64");
    if (bytes.length!==Math.min(pdfChunkSize,size-offset) || (!offset && !validHeader(bytes)))
      throw Error("invalid_isolated_pdf");
    hash.update(bytes); chunks.push(new Uint8Array(bytes)); offset+=bytes.length;
  } while (offset<size);
  return {chunks,sha256:hash.digest("hex")};
}

export async function collectIsolatedPdf(path:string,part:(offset:number)=>Promise<z.infer<typeof isolatedPdfPart>>) {
  const {chunks,sha256}=await collectIsolatedArtifact(part,bytes=>bytes.toString("ascii",0,5)==="%PDF-");
  return {name:basename(path),path,document:new Blob(chunks,{type:"application/pdf"}),sha256};
}

export async function collectIsolatedImage(path:string,part:(offset:number)=>Promise<z.infer<typeof isolatedImagePart>>) {
  const format=/\.png$/i.test(path) ? "png" : "jpeg";
  const {chunks}=await collectIsolatedArtifact(part,bytes=>imageFormat(bytes)===format);
  return {name:basename(path),photo:new Blob(chunks,{type:"image/"+format})};
}

async function uploadGroupFile(cli:string,threadId:string,file:SavedTelegramFile,signal:AbortSignal):Promise<SavedTelegramFile> {
  const id=basename(dirname(file.path));
  if (!/^\d+-[a-f0-9]{20}$/.test(id) || basename(file.path)!==file.name) throw Error("invalid_cached_attachment");
  const fd=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=await fd.stat();
    if (!st.isFile() || st.size!==file.bytes) throw Error("invalid_cached_attachment");
    const json=await new Promise<string>((resolve,reject)=>{
      const child=spawn(cli,["isolated-upload",threadId,id,file.sha256,String(file.bytes),file.name],{
        env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:[fd.fd,"pipe","ignore"],signal,timeout:30*60*1000,
      });
      let output="";const stdout=child.stdout!;stdout.setEncoding("utf8");
      stdout.on("data",(text:string)=>{if(output.length>8192)return;output+=text;if(output.length>8192){child.kill();reject(Error("invalid_upload_receipt"));}});
      child.once("error",reject);
      child.once("close",code=>code===0?resolve(output):reject(Error("isolated_upload_failed")));
    });
    const rec=z.object({path:z.string().refine(isAbsolute),name:z.literal(file.name),bytes:z.literal(file.bytes),
      sha256:z.literal(file.sha256),threadId:z.literal(threadId)}).parse(JSON.parse(json));
    return {path:rec.path,name:rec.name,sha256:rec.sha256,bytes:rec.bytes};
  } finally {await fd.close();}
}
