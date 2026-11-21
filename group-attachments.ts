import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open, readFile, realpath} from "node:fs/promises";
import {basename, dirname, isAbsolute, join} from "node:path";
import {z} from "zod";
import {maxRoutedDocumentBytes,type SavedTelegramFile} from "./telegram-files";

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
  z.object({type:z.literal("opaque"),file:cachedFile.extend({bytes:z.number().int().min(0).max(maxRoutedDocumentBytes)})}).strict(),
])).max(maxGroupAttachments).refine(items=>items.reduce((size,item)=>size+(item.type==="image" ? item.url.length : 0),0)<=maxEncodedImages);

export type IsolatedAttachment = z.infer<typeof isolatedAttachments>[number];
export type ImageAttachment = Extract<IsolatedAttachment,{type:"image"}>;

export function imageFormat(bytes:Buffer) {
  return bytes.subarray(0,3).equals(Buffer.from([255,216,255])) ? "jpeg" :
    bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" :
    bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP" ? "webp" :
    ["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6)) ? "gif" : undefined;
}
// Read dimensions from PNG IHDR or a JPEG start-of-frame segment. No decoding.
export function validTelegramPhoto(bytes:Buffer,format:"png"|"jpeg") {
  if (imageFormat(bytes)!==format) return false;
  const valid=(width:number,height:number)=>width>0 && height>0 && width+height<=10_000 &&
    Math.max(width,height)<=20*Math.min(width,height);
  if (format==="png") return bytes.length>=24 && bytes.toString("ascii",12,16)==="IHDR" &&
    valid(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
  let offset=2;
  while (offset+3<bytes.length && bytes[offset]===0xff) {
    while (bytes[offset]===0xff) offset++;
    const marker=bytes[offset++];
    if (marker===0xda || marker===0xd9 || offset+2>bytes.length) return false;
    const size=bytes.readUInt16BE(offset);
    if (size<2 || offset+size>bytes.length) return false;
    if (marker>=0xc0 && marker<=0xcf && ![0xc4,0xc8,0xcc].includes(marker))
      return size>=8 && valid(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));
    offset+=size;
  }
  return false;
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

export function isolatedFile(file:SavedTelegramFile,opaque=false): IsolatedAttachment {
  if (basename(file.path)!==file.name) throw Error("invalid_attachment_receipt");
  return {type:opaque?"opaque":"file",file:cachedFile.parse({cacheId:basename(dirname(file.path)),name:file.name,
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
  const file=await verifyIsolatedFile(item,threadId,root);
  return item.type==="opaque" ? opaqueAttachmentInput(file) : localFileInput(file);
}

export async function verifyIsolatedFile(item:Exclude<IsolatedAttachment,ImageAttachment>,threadId:string,root?:string) {
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
  return {path,name,bytes,sha256};
}

export function opaqueFileReference(file:SavedTelegramFile) {
  return "/telegram-input/"+basename(dirname(file.path))+"/"+file.name;
}

export function opaqueAttachmentInput(file:SavedTelegramFile) {
  const reference=opaqueFileReference(file).split("/").map(encodeURIComponent).join("/").replaceAll(")","%29");
  return {type:"text" as const,visibility:"agent-only" as const,mentions:[],
    text:"Входящий документ передан как байты. Имя: "+JSON.stringify(file.name)+
      ". Содержимое не загружено в модель. Чтобы вернуть этот документ, включи ссылку [Вложение]("+reference+")."};
}

export async function readOpaqueAttachment(file:SavedTelegramFile,start=0,length=maxRoutedDocumentBytes) {
  if (file.bytes>maxRoutedDocumentBytes || (start!==0 && start>=file.bytes) || await realpath(file.path)!==file.path)
    throw Error("invalid_attachment_receipt");
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await handle.stat();
    if (!info.isFile() || info.nlink!==1 || info.size!==file.bytes ||
        (process.platform==="linux" && await realpath("/proc/self/fd/"+handle.fd)!==file.path))
      throw Error("invalid_attachment_receipt");
    const bytes=Buffer.alloc(file.bytes);
    let offset=0;
    while (offset<bytes.length) {
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!bytesRead) throw Error("invalid_attachment_receipt");
      offset+=bytesRead;
    }
    if ((await handle.stat()).size!==file.bytes || createHash("sha256").update(bytes).digest("hex")!==file.sha256)
      throw Error("invalid_attachment_receipt");
    return {bytes:bytes.subarray(start,start+length),size:bytes.length,revision:file.sha256};
  } finally { await handle.close(); }
}
