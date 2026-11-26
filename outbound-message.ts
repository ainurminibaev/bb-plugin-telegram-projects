import {sendOutcome,sameTelegramFilename} from "./send-outcome";
import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,openSync,readSync,realpathSync} from "node:fs";
import {basename,isAbsolute,relative,sep} from "node:path";
import {z} from "zod";
import {imageFormat} from "./group-attachments";
import {TelegramFailure,type Telegram} from "./model";
import {cleanAssistantText,renderTelegramParts} from "./telegram-ux";

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

type TextMismatch = {received:number;expected:number};
type ReceiptChecks = {
  onUnverified?:()=>void;
  onTextMismatch?:(mismatch:TextMismatch)=>void;
};
type MessagePayload = {
  chatId:number;topicId:number;replyTo?:number;text?:string;
  file?:Pick<OutboundFile,"kind"|"name"|"data">;
  /** The text is Telegram HTML made by renderTelegramParts (the same formatting as a private chat). */
  html?:boolean;
  /** Buttons under a text message. */
  replyMarkup?:Record<string,unknown>;
};

/** The words of Telegram HTML without tags: sent when Telegram rejects the formatting. */
export function plainFromHtml(html:string) {
  return html.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,(_,href,label)=>label===href ? label : `${label} (${href})`)
    .replace(/<[^>]+>/g,"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,"&");
}

/** Normalize differences in the Telegram echo without changing the outgoing payload. */
function receiptText(text:string) {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(entity,digits:string)=>{
    const code=digits[0].toLowerCase()==="x" ? parseInt(digits.slice(1),16) : Number(digits);
    return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff)
      ? String.fromCodePoint(code) : entity;
  }).replace(/\r\n/g,"\n").trim();
}

export function outboundMessagePayload(args:MessagePayload):{method:string;body:Record<string,unknown>} {
  const {chatId,topicId,replyTo,text,file,html,replyMarkup}=args;
  // A formatted caption counts by its visible words, as Telegram counts it.
  if (!checkOutboundContent({text:html && text!==undefined && file ? plainFromHtml(text) : text,artifact:file})) throw Error("outbound_content_invalid");
  const target={
    chat_id:chatId,
    ...(topicId>0 && {message_thread_id:topicId}),
    ...(replyTo!==undefined && {reply_parameters:{message_id:replyTo,allow_sending_without_reply:false}}),
  };
  if (!file)
    return {method:"sendMessage",body:{...target,text,...(html && {parse_mode:"HTML"}),...(replyMarkup && {reply_markup:replyMarkup}),link_preview_options:{is_disabled:true}}};
  return {method:file.kind==="photo" ? "sendPhoto" : "sendDocument",body:{
    ...target,...(text!==undefined && {caption:text,...(html && {parse_mode:"HTML"})}),
    ...(replyMarkup && {reply_markup:replyMarkup}),
    [file.kind]:file.data,[file.kind+"_filename"]:file.name,
    ...(file.kind==="document" && {disable_content_type_detection:true}),
  }};
}

export async function sendOutboundMessage(tg:Telegram,args:Omit<MessagePayload,"file">&{file?:OutboundFile}&ReceiptChecks) {
  const {chatId,topicId,replyTo,file}=args;
  const {method,body}=outboundMessagePayload(args);
  const sent=await tg(method,body);
  if (topicId>0 && sent?.message_thread_id!==topicId ||
      replyTo!==undefined && sent?.reply_to_message && sent.reply_to_message.message_id!==replyTo)
    throw Error("outbound_receipt_missing");
  if (file?.kind==="document" && (sent?.document?.file_size!==file.bytes ||
      (sent.document.file_name!==undefined && !sameTelegramFilename(file.name,sent.document.file_name))))
    throw Error("outbound_receipt_missing");
  if (file?.kind==="photo" && (!Array.isArray(sent?.photo) || !sent.photo.some((item:any)=>typeof item?.file_id==="string")))
    throw Error("outbound_receipt_missing");
  const id=telegramMessageId(sent,chatId);
  const echo=file ? sent.caption : sent.text;
  if (args.onTextMismatch && args.text!==undefined && typeof echo==="string") {
    // Message.text contains the visible link label. The plain fallback was sent with its URL spelled out.
    const expected=receiptText(args.html ? plainFromHtml(args.text.replace(/<[^>]+>/g,"")) : args.text);
    const received=receiptText(echo);
    if (received!==expected) args.onTextMismatch({received:Array.from(received).length,expected:Array.from(expected).length});
  }
  return id;
}

/**
 * The one point an agent's text passes on its way to people (0.9.77): its Markdown as Telegram HTML, and the same words
 * without marks for when Telegram refuses the formatting. Raw Markdown never goes out.
 */
export function agentText(markdown: string) {
  const parts = renderTelegramParts(cleanAssistantText(markdown).trim());
  const html = parts.length === 1 ? parts[0] : undefined;
  return {html, plain: html !== undefined ? plainFromHtml(html) : plainFromHtml(parts.join("\n"))};
}

/** Sends (or edits) one message of an agent's text: formatted, or as plain words if Telegram refuses the formatting. */
export async function sendAgentText<T>(tg: Telegram, method: string, body: Record<string, unknown>, markdown: string): Promise<T> {
  const {html, plain} = agentText(markdown);
  if (html === undefined) return tg<T>(method, {...body, text: plain});
  return tg<T>(method, {...body, text: html, parse_mode: "HTML"}).catch(error => {
    if (error instanceof TelegramFailure && error.code === "telegram_400") return tg<T>(method, {...body, text: plain});
    throw error;
  });
}

/**
 * The agent's text as a file's caption, formatted as any message (bold, lists, links); undefined when it does not fit
 * one caption — then it goes as its own message. Never raw Markdown: «**» in a caption is what people saw.
 */
export function formattedCaption(markdown:string) {
  const parts=renderTelegramParts(cleanAssistantText(markdown).trim());
  const visible=parts.length===1 ? plainFromHtml(parts[0]) : "";
  return visible.trim() && visible.length<=maxCaption ? parts[0] : undefined;
}

/** A file with the agent's text: a formatted caption, or the formatted text and then the file when it is too long.
 * If Telegram rejects the formatting, the caption goes as plain words — the marks taken off, links as «name (address)». */
export async function sendFormattedFile(tg:Telegram,args:{chatId:number;topicId:number;replyTo?:number;markdown?:string;file:OutboundFile;replyMarkup?:Record<string,unknown>}, messageIds:number[] = [], checks:ReceiptChecks={}) {
  const record=(id:number)=>{ messageIds.push(id); return id; };
  const {markdown,...destination}=args;
  const target={...destination,...checks};
  if (!markdown?.trim()) return sendOutboundMessage(tg,target).then(record);
  const caption=formattedCaption(markdown);
  if (caption===undefined) {
    messageIds.push(...await sendFormattedText(tg,{chatId:target.chatId,topicId:target.topicId,replyTo:target.replyTo,markdown,...checks}));
    // The text went: whatever becomes of the file, a repeat must not carry the text again.
    return sendOutboundMessage(tg,{...target,replyTo:undefined}).catch(error=>{
      if (error && typeof error==="object") Object.assign(error,{textSent:true});
      throw error;
    }).then(record);
  }
  return sendOutboundMessage(tg,{...target,text:caption,html:true}).catch(error=>{
    if (error instanceof TelegramFailure && error.code==="telegram_400") return sendOutboundMessage(tg,{...target,text:plainFromHtml(caption)});
    throw error;
  }).then(record);
}

/**
 * С82: an edit of the bot's own message with the same formatting as a new one: a text message by editMessageText,
 * a file's caption by editMessageCaption (caption — from the archive; unknown — the text first, then the caption).
 * A refused formatting is edited as plain words without marks. Returns what was edited.
 */
export async function editFormatted(tg:Telegram,args:{chatId:number;messageId:number;markdown:string;caption?:boolean}) {
  const text=cleanAssistantText(args.markdown).trim();
  const target={chat_id:args.chatId,message_id:args.messageId};
  const plainOn400=(send:(html:boolean)=>Promise<unknown>)=>send(true).catch(error=>{
    if (error instanceof TelegramFailure && error.code==="telegram_400") return send(false);
    throw error;
  });
  const edit=async(caption:boolean)=>{
    if (caption) {
      const formatted=formattedCaption(text);
      if (formatted===undefined) throw Error("edit_caption_too_long");
      await plainOn400(html=>tg("editMessageCaption",{...target,caption:html ? formatted : plainFromHtml(formatted),...(html && {parse_mode:"HTML"})}));
      return "caption" as const;
    }
    const parts=renderTelegramParts(text);
    if (parts.length!==1) throw Error("edit_text_too_long");
    await plainOn400(html=>tg("editMessageText",{...target,text:html ? parts[0] : plainFromHtml(parts[0]),...(html && {parse_mode:"HTML"}),
      link_preview_options:{is_disabled:true}}));
    return "text" as const;
  };
  if (args.caption!==undefined) return edit(args.caption);
  return edit(false).catch(error=>{
    if (error instanceof TelegramFailure && error.code==="telegram_400") return edit(true);
    throw error;
  });
}

export class TextPartFailure extends Error {
  constructor(readonly outcome:"unknown"|"rejected", index:number, ids:number[], cause:unknown) {
    const accepted=index ? `Ушли части 1–${index} (подтверждённые номера: ${ids.join(", ") || "нет"}). ` : "";
    const next=outcome==="unknown"
      ? `Не повторяй: часть ${index+1} могла дойти. Проверь сообщения в чате.`
      : `Повтори только оставшееся, начиная с части ${index+1}.`;
    super(`partial_send: messageIds=[${ids.join(",")}], part=${index+1}, ${String(cause)}. ${accepted}${next}`,{cause});
  }
}

/**
 * Agent text to a group or a person: the same formatting as the owner's private chat (bold, italic, lists, code, links).
 * A part Telegram rejects as formatting goes as plain words. Returns the sent message IDs in order.
 */
export async function sendFormattedText(tg:Telegram,args:{chatId:number;topicId:number;replyTo?:number;markdown:string;replyMarkup?:Record<string,unknown>}&ReceiptChecks) {
  const ids:number[]=[];
  const parts=renderTelegramParts(cleanAssistantText(args.markdown).trim());
  for (const [index,part] of parts.entries()) {
    // Buttons go under the last part only.
    const target={chatId:args.chatId,topicId:args.topicId,onTextMismatch:args.onTextMismatch,replyTo:index===0 ? args.replyTo : undefined,...(index===parts.length-1 && args.replyMarkup && {replyMarkup:args.replyMarkup})};
    try {
      ids.push(await sendOutboundMessage(tg,{...target,text:part,html:true}).catch(error=>{
        if (error instanceof TelegramFailure && error.code==="telegram_400") return sendOutboundMessage(tg,{...target,text:plainFromHtml(part)});
        throw error;
      }));
    } catch (error) {
      const outcome=sendOutcome(error);
      if (outcome==="delivered") {
        args.onUnverified?.();
        continue;
      }
      throw new TextPartFailure(outcome,index,ids,error);
    }
  }
  return ids;
}
