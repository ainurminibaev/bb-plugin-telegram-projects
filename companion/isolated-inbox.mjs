// Invoked by the administrator's isolated BB launcher, with the file on stdin.
// The configured cache directory belongs only to this isolated worker.
import {createHash} from "node:crypto";
import {createWriteStream,createReadStream} from "node:fs";
import {mkdir,mkdtemp,realpath,statfs,writeFile,rename,rm,readFile,lstat} from "node:fs/promises";
import {basename,isAbsolute,join} from "node:path";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";

async function receive() {
  const [threadId,id,sha,sizeText,name]=process.argv.slice(2);
  const root=process.env.BB_TELEGRAM_ISOLATED_INBOX;
  const bytes=Number(sizeText);
  if (!root || !isAbsolute(root) || root==="/" || threadId!==process.env.BB_TELEGRAM_ISOLATED_THREAD ||
      !threadId || !/^\d+-[a-f0-9]{20}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha) ||
      !Number.isSafeInteger(bytes) || bytes<0 || bytes>2*1024**3 || !name || name!==basename(name) ||
      name.startsWith(".") || /[\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name)>180)
    throw Error("invalid_upload");
  await mkdir(root,{recursive:true,mode:0o700});
  if (await realpath(root)!==root) throw Error("invalid_upload_root");
  const dest=join(root,id),path=join(dest,name);
  const receipt={name,path,bytes,sha256:sha,threadId};
  const disk=await statfs(root);
  if (disk.bavail*disk.bsize<bytes+256*1024**2) throw Error("insufficient_disk_space");
  const staging=await mkdtemp(join(root,".receiving-"));
  try {
    const hash=createHash("sha256");let received=0;
    const meter=new Transform({transform(chunk,_,done) {
      received+=chunk.length;
      if(received>bytes) return done(Error("size_mismatch"));
      hash.update(chunk);done(null,chunk);
    }});
    await pipeline(process.stdin,meter,createWriteStream(join(staging,name),{flags:"wx",mode:0o600}));
    if(received!==bytes || hash.digest("hex")!==sha) throw Error("digest_mismatch");
    await writeFile(join(staging,".complete.json"),JSON.stringify(receipt),{flag:"wx",mode:0o600});
    try {await rename(staging,dest);}
    catch(error) {
      if (!["EEXIST","ENOTEMPTY"].includes(error.code)) throw error;
      if (await realpath(dest)!==dest || !(await lstat(path)).isFile()) throw Error("cache_conflict");
      const existing=JSON.parse(await readFile(join(dest,".complete.json"),"utf8"));
      if (Object.entries(receipt).some(([k,v])=>existing[k]!==v)) throw Error("cache_conflict");
      const actual=createHash("sha256");for await(const chunk of createReadStream(path)) actual.update(chunk);
      if(actual.digest("hex")!==sha) throw Error("cache_conflict");
    }
    console.log(JSON.stringify(receipt));
  } finally {await rm(staging,{recursive:true,force:true});}
}
receive().catch(()=>{console.error("isolated_attachment_failed");process.exitCode=1;});
