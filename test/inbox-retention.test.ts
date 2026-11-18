import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat,realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {cleanInbox} from "../inbox-retention";
test("quota removes only idle completed downloads; unknown, active and unrelated files survive",async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),"bb-inbox-")),day=86400000;
 try{
  for(const [i,threadId] of ["idle","busy",undefined].entries()){
    const dir=join(root,i+"-"+"f".repeat(20));await mkdir(dir);
    const path=join(dir,"file");await writeFile(path,"data");await writeFile(join(dir,".complete.json"),
      JSON.stringify({name:"file",path,bytes:4,sha256:"a".repeat(64),threadId}));
  }
  await writeFile(join(root,"notes"),"keep");
  assert.equal((await cleanInbox(root,async id=>id==="idle",Date.now()+2*day,0)).removed,1);
  assert.ok(await stat(join(root,"notes")));
  assert.equal((await cleanInbox(root,async()=>false,Date.now()+35*day)).removed,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
