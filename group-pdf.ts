import {maxRoutedDocumentBytes,safeTelegramFilename} from "./telegram-files";
import {imageFormat,maxImageBytes,validTelegramPhoto} from "./group-attachments";
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open,realpath} from "node:fs/promises";
import {basename,join,relative,sep} from "node:path";

// Only PDFs explicitly exported into this group's environment can be shared.
export const pdfChunkSize=768*1024;
export const maxGroupPdfSize=49*1024*1024;
export const groupImagePath=/\.(?:jpe?g|png)$/i;
type ExportFormat="pdf"|"image"|"document";
function validHeader(bytes:Buffer,path:string,format:ExportFormat) {
  if (format==="document") return true;
  if (format==="pdf") return bytes.subarray(0,5).equals(Buffer.from("%PDF-"));
  return validTelegramPhoto(bytes,/\.png$/i.test(path) ? "png" : "jpeg");
}
async function readGroupExportBytes(workspace:string,path:string,start:number,length:number,format:ExportFormat) {
  const max=format==="pdf" ? maxGroupPdfSize : format==="image" ? maxImageBytes : maxRoutedDocumentBytes;
  const extension=format==="pdf" ? /\.pdf$/i : format==="image" ? groupImagePath : undefined;
  if (!Number.isSafeInteger(start) || start<0 || !Number.isSafeInteger(length) || length<=0 || length>max)
    throw Error("invalid_pdf_range");
  const root=join(await realpath(workspace),"outputs");
  const resolved=await realpath(path);
  const parts=relative(root,resolved).split(sep);
  if (resolved!==path || parts.some(p=>!p || p.startsWith(".")) || (extension && !extension.test(resolved))) {
    throw Error("group_export_path_required");
  }
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (process.platform==="linux" && await realpath("/proc/self/fd/"+file.fd)!==resolved)
      throw Error("group_export_changed");
    const stat=await file.stat();
    if (!stat.isFile() || stat.nlink!==1 || (format!=="document" && stat.size<5) || stat.size>max || (start!==0 && start>=stat.size))
      throw Error("invalid_group_pdf");
    const bytes=Buffer.alloc(Math.min(length,stat.size-start));
    let offset=0;
    while (offset<bytes.length) {
      const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,start+offset);
      if (!bytesRead) throw Error("group_pdf_changed");
      offset+=bytesRead;
    }
    const after=await file.stat();
    if (after.ctimeMs!==stat.ctimeMs || (start===0 && !validHeader(bytes,path,format)))
      throw Error("invalid_group_pdf");
    const revision=createHash("sha256").update([stat.dev,stat.ino,stat.size,stat.ctimeMs].join("/")).digest("hex");
    return {bytes,revision,size:stat.size};
  } finally {await file.close();}
}

export function readGroupPdfBytes(workspace:string,path:string,start=0,length=maxGroupPdfSize) {
  return readGroupExportBytes(workspace,path,start,length,"pdf");
}
export function readGroupImageBytes(workspace:string,path:string,start=0,length=maxImageBytes) {
  return readGroupExportBytes(workspace,path,start,length,"image");
}
export async function readGroupImage(workspace:string,path:string) {
  const {bytes}=await readGroupImageBytes(workspace,path);
  return {name:basename(path),photo:new Blob([new Uint8Array(bytes)],{type:"image/"+imageFormat(bytes)})};
}

export async function readGroupPdf(workspace:string,path:string) {
  const {bytes}=await readGroupPdfBytes(workspace,path);
  return {name:basename(path),path,sha256:createHash("sha256").update(bytes).digest("hex"),
    document:new Blob([new Uint8Array(bytes)],{type:"application/pdf"})};
}

export function readGroupDocumentBytes(workspace:string,path:string,start=0,length=maxRoutedDocumentBytes) {
  return readGroupExportBytes(workspace,path,start,length,"document");
}

export async function readGroupDocument(workspace:string,path:string) {
  const {bytes}=await readGroupDocumentBytes(workspace,path);
  return {name:safeTelegramFilename(basename(path)),document:new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"})};
}
