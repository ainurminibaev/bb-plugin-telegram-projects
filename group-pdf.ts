import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open,realpath} from "node:fs/promises";
import {basename,join,relative,sep} from "node:path";

// Only PDFs explicitly exported into this group's environment can be shared.
export const pdfChunkSize=768*1024;
export const maxGroupPdfSize=49*1024*1024;
export async function readGroupPdfBytes(workspace:string,path:string,start=0,length=maxGroupPdfSize) {
  if (!Number.isSafeInteger(start) || start<0 || !Number.isSafeInteger(length) || length<=0 || length>maxGroupPdfSize)
    throw Error("invalid_pdf_range");
  const root=join(await realpath(workspace),"outputs");
  const resolved=await realpath(path);
  const parts=relative(root,resolved).split(sep);
  if (resolved!==path || parts.some(p=>!p || p.startsWith(".")) || !/\.pdf$/i.test(resolved)) {
    throw Error("group_export_path_required");
  }
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (process.platform==="linux" && await realpath("/proc/self/fd/"+file.fd)!==resolved)
      throw Error("group_export_changed");
    const stat=await file.stat();
    if (!stat.isFile() || stat.nlink!==1 || stat.size<5 || stat.size>maxGroupPdfSize || start>=stat.size)
      throw Error("invalid_group_pdf");
    const bytes=Buffer.alloc(Math.min(length,stat.size-start));
    let offset=0;
    while (offset<bytes.length) {
      const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,start+offset);
      if (!bytesRead) throw Error("group_pdf_changed");
      offset+=bytesRead;
    }
    const after=await file.stat();
    if (after.ctimeMs!==stat.ctimeMs || (start===0 && !bytes.subarray(0,5).equals(Buffer.from("%PDF-"))))
      throw Error("invalid_group_pdf");
    const revision=createHash("sha256").update([stat.dev,stat.ino,stat.size,stat.ctimeMs].join("/")).digest("hex");
    return {bytes,revision,size:stat.size};
  } finally {await file.close();}
}

export async function readGroupPdf(workspace:string,path:string) {
  const {bytes}=await readGroupPdfBytes(workspace,path);
  return {name:basename(path),path,sha256:createHash("sha256").update(bytes).digest("hex"),
    document:new Blob([new Uint8Array(bytes)],{type:"application/pdf"})};
}
