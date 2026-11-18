import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,realpath,rm,writeFile,symlink,link} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {readGroupPdf} from "../group-pdf";

test("group exports read only a regular PDF in outputs and hash the actual payload",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"group-pdf-")));
 try {
  const out=join(root,"outputs");await mkdir(out);
  const path=join(out,"v1.pdf"), content="%PDF-1.4\nfixture";
  await writeFile(path,content);
  const pdf=await readGroupPdf(root,path);
  assert.equal(await pdf.document.text(),content);
  assert.equal(pdf.sha256,createHash("sha256").update(content).digest("hex"));
  const other=join(root,"private.pdf");await writeFile(other,content);
  await assert.rejects(readGroupPdf(root,other));
  await symlink(other,join(out,"shortcut.pdf"));await assert.rejects(readGroupPdf(root,join(out,"shortcut.pdf")));
  await link(other,join(out,"alias.pdf"));await assert.rejects(readGroupPdf(root,join(out,"alias.pdf")));
 } finally {await rm(root,{recursive:true,force:true});}
});
