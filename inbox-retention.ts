// Only completed cache entries written by telegram-files qualify. Leave unknown
// files and project outputs intact, including legacy entries without an owner.
import {lstat,readFile,readdir,realpath,unlink,rmdir} from "node:fs/promises";
import {basename,join,resolve} from "node:path";

type Entry={dir:string;path:string;bytes:number;at:number;threadId?:string};
const day=86400000;
export async function cleanInbox(root:string,idle:(id:string)=>Promise<boolean>,now=Date.now(),
  maxBytes=8*1024**3,maxAge=30*day) {
  if (!root || resolve(root)!==root || root==="/" || await realpath(root)!==root) throw Error("invalid_inbox_root");
  const entries:Entry[]=[];
  async function scan(parent:string,depth:number) {
    for(const entry of await readdir(parent,{withFileTypes:true})) {
      if(!entry.isDirectory()) continue;
      const dir=join(parent,entry.name);
      if(!/^\d+-[a-f0-9]{20}$/.test(entry.name)) {
        if((depth===0 && entry.name==="groups") || (depth>=1 && depth<=4 && /^-?\d+$/.test(entry.name))) await scan(dir,depth+1);
        continue;
      }
      try {
        const rp=join(dir,".complete.json");
        const stat=await lstat(rp);
        if(!stat.isFile() || stat.size>10000)continue;
        const rec=JSON.parse(await readFile(rp,"utf8"));
        if(typeof rec.name!=="string" || rec.name!==basename(rec.name) || rec.name.startsWith(".") ||
           rec.path!==join(dir,rec.name) || !/^[a-f0-9]{64}$/.test(rec.sha256))continue;
        const data=await lstat(rec.path);
        if(!data.isFile() || data.size!==rec.bytes || (await readdir(dir)).length!==2)continue;
        entries.push({dir,path:rec.path,bytes:data.size,at:Math.max(stat.mtimeMs,data.atimeMs,data.mtimeMs),threadId:rec.threadId});
      } catch(error:any) {if(error.code!=="ENOENT" && !(error instanceof SyntaxError))throw error;}
    }
  }
  await scan(root,0);
  let total=entries.reduce((n,e)=>n+e.bytes,0),removed=0;
  for(const e of entries.sort((a,b)=>a.at-b.at)) {
    if(now-e.at<day || (now-e.at<maxAge && total<=maxBytes))continue;
    const transientVoice=basename(e.dir).startsWith("0-") && basename(e.path)==="voice.ogg";
    if(!transientVoice && (!e.threadId || !await idle(e.threadId)))continue;
    if(await realpath(e.dir)!==e.dir || (await readdir(e.dir)).length!==2)continue;
    const data=await lstat(e.path);
    if(!data.isFile() || data.size!==e.bytes || Math.max(data.atimeMs,data.mtimeMs)>e.at)continue;
    await unlink(e.path);await unlink(join(e.dir,".complete.json"));await rmdir(e.dir);
    total-=e.bytes;removed++;
  }
  return {removed,remainingBytes:total};
}
