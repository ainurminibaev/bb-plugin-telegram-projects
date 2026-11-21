import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,openSync,readSync,realpathSync} from "node:fs";
import {basename,isAbsolute,relative,sep} from "node:path";
import {z} from "zod";
import {imageFormat} from "./group-attachments";
import type {Telegram} from "./model";

export const maxOutboundDocumentBytes = 49 * 1024 * 1024;
const maxPhotoBytes = 10_000_000;
export const maxCaption = 1024;
export const maxText = 4096;
export const outboundDirectory = z.string().max(4096).refine(path=>isAbsolute(path) && path!=="/");
export const outboundMaxBytes = z.number().int().positive().max(maxOutboundDocumentBytes);
export const outboundArtifact = z.object({
  path:z.string().max(4096).refine(isAbsolute),
  kind:z.enum(["document","photo"]).optional(),
}).strict();

type Kind = "document"|"photo";
export type OutboundFile = {
  name:string; kind:Kind; data:Blob; sha256:string; bytes:number;
};
type FileRoot = {directory:string;maxBytes:number};

function jpegDimensions(bytes:Buffer) {
  if (bytes.length<12 || bytes.readUInt16BE(bytes.length-2)!==0xffd9) return;
  let offset=2;
  while (offset+3<bytes.length && bytes[offset++]===0xff) {
    while (offset<bytes.length && bytes[offset]===0xff) offset++;
    const marker=bytes[offset++];
    if (marker===0xda || marker===0xd9 || offset+2>bytes.length) return;
    const length=bytes.readUInt16BE(offset);
    if (length<2 || offset+length>bytes.length) return;
    if ([0xc0,0xc1,0xc2].includes(marker) && length>=8)
      return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
    offset+=length;
  }
}

function photoMime(bytes:Buffer) {
  const format=imageFormat(bytes);
  const size=format==="jpeg" ? jpegDimensions(bytes) :
    format==="png" && bytes.length>=45 && bytes.readUInt32BE(8)===13 &&
      bytes.toString("ascii",12,16)==="IHDR" && bytes.toString("ascii",bytes.length-8,bytes.length-4)==="IEND"
      ? [bytes.readUInt32BE(16),bytes.readUInt32BE(20)] : undefined;
  if (!size || !size[0] || !size[1] || size[0]+size[1]>10_000 ||
      Math.max(...size)>20*Math.min(...size))
    throw Error("outbound_file_invalid_photo");
  return "image/"+format;
}

export function prepareOutboundFile(bytes:Buffer,name:string,kind:Kind,maxBytes=maxOutboundDocumentBytes):OutboundFile {
  if (!name || name.startsWith(".") || /[/\\\p{C}]/u.test(name) || Buffer.byteLength(name)>180)
    throw Error("outbound_file_unsafe_name");
  if (!outboundMaxBytes.safeParse(maxBytes).success ||
      bytes.length>Math.min(maxBytes,kind==="photo" ? maxPhotoBytes : maxOutboundDocumentBytes))
    throw Error("outbound_file_size_or_type");
  const mime=kind==="photo" ? photoMime(bytes) : "application/octet-stream";
  return {name,kind,data:new Blob([new Uint8Array(bytes)],{type:mime}),
    sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
}

export function readOutboundFile(path:string,policy:FileRoot,kind:Kind,validate?:(bytes:Buffer)=>void) {
  try {
    if (!outboundDirectory.safeParse(policy.directory).success ||
        !outboundMaxBytes.safeParse(policy.maxBytes).success)
      throw Error("outbound_file_policy_invalid");
    const root=realpathSync(policy.directory);
    const resolved=realpathSync(path);
    const child=relative(root,resolved);
    if (root!==policy.directory || !child || isAbsolute(child) ||
        child.split(sep).some(part=>part.startsWith(".")) || resolved!==path)
      throw Error("outbound_file_outside_output");
    const fd=openSync(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=fstatSync(fd);
      if (!stat.isFile() || stat.nlink!==1 ||
          stat.size>Math.min(policy.maxBytes,kind==="photo" ? maxPhotoBytes : maxOutboundDocumentBytes))
        throw Error("outbound_file_size_or_type");
      if (realpathSync("/proc/self/fd/"+fd)!==resolved) throw Error("outbound_file_outside_output");
      const bytes=Buffer.alloc(stat.size);
      let offset=0;
      while (offset<bytes.length) {
        const n=readSync(fd,bytes,offset,bytes.length-offset,offset);
        if (!n) throw Error("outbound_file_changed");
        offset+=n;
      }
      const after=fstatSync(fd);
      if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs)
        throw Error("outbound_file_changed");
      validate?.(bytes);
      return prepareOutboundFile(bytes,basename(resolved),kind,policy.maxBytes);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && /^(outbound_file_|report_zip_)/.test(error.message)) throw error;
    throw Error("outbound_file_unreadable");
  }
}

export function checkOutboundContent(args:{text?:string;artifact?:unknown},textLimit=maxText) {
  const text=args.text;
  return (text!==undefined && text.trim().length>0 || args.artifact!==undefined) &&
    (text===undefined || text.length<=(args.artifact===undefined ? textLimit : maxCaption));
}

export function telegramMessageId(sent:any,chatId:number) {
  if (sent?.chat?.id!==chatId || !Number.isSafeInteger(sent?.message_id) || sent.message_id<=0)
    throw Error("outbound_receipt_missing");
  return sent.message_id as number;
}

type MessagePayload = {
  chatId:number;topicId:number;replyTo?:number;text?:string;
  file?:Pick<OutboundFile,"kind"|"name"|"data">;
};

export function outboundMessagePayload(args:MessagePayload):{method:string;body:Record<string,unknown>} {
  const {chatId,topicId,replyTo,text,file}=args;
  if (!checkOutboundContent({text,artifact:file})) throw Error("outbound_content_invalid");
  const target={
    chat_id:chatId,
    ...(topicId>0 && {message_thread_id:topicId}),
    ...(replyTo!==undefined && {reply_parameters:{message_id:replyTo,allow_sending_without_reply:false}}),
  };
  if (!file)
    return {method:"sendMessage",body:{...target,text,link_preview_options:{is_disabled:true}}};
  return {method:file.kind==="photo" ? "sendPhoto" : "sendDocument",body:{
    ...target,...(text!==undefined && {caption:text}),
    [file.kind]:file.data,[file.kind+"_filename"]:file.name,
    ...(file.kind==="document" && {disable_content_type_detection:true}),
  }};
}

export async function sendOutboundMessage(tg:Telegram,args:Omit<MessagePayload,"file">&{file?:OutboundFile}) {
  const {chatId,topicId,replyTo,file}=args;
  const {method,body}=outboundMessagePayload(args);
  const sent=await tg(method,body);
  if (topicId>0 && sent?.message_thread_id!==topicId ||
      replyTo!==undefined && sent?.reply_to_message && sent.reply_to_message.message_id!==replyTo)
    throw Error("outbound_receipt_missing");
  if (file?.kind==="document" && (sent?.document?.file_size!==file.bytes ||
      (sent.document.file_name!==undefined && sent.document.file_name!==file.name)))
    throw Error("outbound_receipt_missing");
  if (file?.kind==="photo" && (!Array.isArray(sent?.photo) || !sent.photo.some((item:any)=>typeof item?.file_id==="string")))
    throw Error("outbound_receipt_missing");
  return telegramMessageId(sent,chatId);
}
