import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open, readFile, realpath} from "node:fs/promises";
import {basename, dirname, isAbsolute, join} from "node:path";
import {z} from "zod";
import type {SavedTelegramFile} from "./telegram-files";

export const maxImageBytes = 5 * 1024 * 1024;
const maxEncodedImage = 4 * Math.ceil(maxImageBytes / 3);
export const maxEncodedImages = 12 * 1024 * 1024;
const imageUrl = z.string().max(maxEncodedImage + 24)
  .regex(/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/);
const cachedFile = z.object({
  cacheId:z.string().regex(/^\d+-[a-f0-9]{20}$/),
  name:z.string().min(1).refine(name=>!name.startsWith(".") && !/[/\\\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name)<=180),
  bytes:z.number().int().min(0).max(2*1024**3),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const maxGroupAttachments=24;
export const isolatedAttachments = z.array(z.union([
  z.object({type:z.literal("image"),url:imageUrl}).strict(),
  z.object({type:z.literal("file"),file:cachedFile}).strict(),
])).max(maxGroupAttachments).refine(items=>items.reduce((size,item)=>size+(item.type==="image" ? item.url.length : 0),0)<=maxEncodedImages);

export type IsolatedAttachment = z.infer<typeof isolatedAttachments>[number];
export type ImageAttachment = Extract<IsolatedAttachment,{type:"image"}>;

export function imageFormat(bytes:Buffer) {
  return bytes.subarray(0,3).equals(Buffer.from([255,216,255])) ? "jpeg" :
    bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" :
    bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP" ? "webp" :
    ["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6)) ? "gif" : undefined;
}
export function imageAttachment(bytes:Buffer): ImageAttachment {
  if (!bytes.length || bytes.length>maxImageBytes) throw Error("attachment_too_large");
  const mime=imageFormat(bytes);
  if (!mime) throw Error("attachment_invalid_image");
  return {type:"image",url:`data:image/${mime};base64,${bytes.toString("base64")}`};
}

export async function readSavedImage(file:SavedTelegramFile, signal:AbortSignal) {
  if (!Number.isSafeInteger(file.bytes) || file.bytes<1 || file.bytes>maxImageBytes) throw Error("attachment_too_large");
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await handle.stat();
    if (!info.isFile() || info.size!==file.bytes) throw Error("attachment_cached_copy_invalid");
    const buffer=Buffer.alloc(file.bytes);
    let offset=0;
    while (offset<buffer.length) {
      signal.throwIfAborted();
      const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);
      if (!bytesRead) throw Error("attachment_cached_copy_invalid");
      offset+=bytesRead;
    }
    if (createHash("sha256").update(buffer).digest("hex")!==file.sha256) throw Error("attachment_cached_copy_invalid");
    return imageAttachment(buffer);
  } finally { await handle.close(); }
}

export function isolatedFile(file:SavedTelegramFile): IsolatedAttachment {
  if (basename(file.path)!==file.name) throw Error("invalid_attachment_receipt");
  return {type:"file",file:cachedFile.parse({cacheId:basename(dirname(file.path)),name:file.name,
    bytes:file.bytes,sha256:file.sha256})};
}

export function localFileInput(file:SavedTelegramFile, hostId?:string) {
  return {type:"localFile" as const,path:file.path,name:file.name,sizeBytes:file.bytes,...(hostId && {hostId})};
}

export async function isolatedAttachmentInput(item:IsolatedAttachment,threadId:string,root?:string) {
  if (item.type==="image") {
    const image=imageAttachment(Buffer.from(item.url.slice(item.url.indexOf(",")+1),"base64"));
    if (image.url!==item.url) throw Error("invalid_attachment_image");
    return image;
  }
  if (!root || !isAbsolute(root) || root==="/")
    throw Error("isolated_inbox_unavailable");
  const {cacheId,name,bytes,sha256}=item.file;
  const directory=join(root,cacheId);
  const path=join(directory,name);
  const receiptPath=join(directory,".complete.json");
  if (await realpath(directory)!==directory || await realpath(path)!==path || await realpath(receiptPath)!==receiptPath)
    throw Error("invalid_attachment_receipt");
  const receipt=JSON.parse(await readFile(receiptPath,"utf8"));
  if (receipt.threadId!==threadId || receipt.path!==path || receipt.name!==name ||
      receipt.bytes!==bytes || receipt.sha256!==sha256) throw Error("invalid_attachment_receipt");
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await handle.stat();
    if (!info.isFile() || info.size!==bytes) throw Error("invalid_attachment_receipt");
  } finally { await handle.close(); }
  return localFileInput({path,name,bytes,sha256});
}
