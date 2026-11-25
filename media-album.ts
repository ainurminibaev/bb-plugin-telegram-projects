import {sameTelegramFilename} from "./send-outcome";
import {createHash} from "node:crypto";
import type {Store, Telegram} from "./model";
import {maxCaption,outboundMessagePayload} from "./outbound-message";

export const albumQuietMs = 2_500;
const albumCollectionMs = 8_000;
const retentionMs = 24 * 60 * 60 * 1000;
export const maxAlbumItems = 10;

export type AlbumItem = {messageId:number; updateId:number};
type Album<T> = {due:number; expires:number; firstAt:number; items?:T[]; positions?:number[]; updates?:number[]; anchor?:number; changed?:true};
type Scope = ReadonlyArray<number|string|null>;

export const albumChangedNotice = "Получен дополнительный элемент уже принятого альбома. Порядок мог измениться. Пришлите полный альбом новым сообщением.";
export function mediaGroupId(message:any):string|undefined {
  const id=message?.media_group_id;
  return typeof id==="string" && /^[^\p{C}\s]{1,128}$/u.test(id) ? id : undefined;
}

export function albumKey(prefix:string,scope:Scope,albumId:string) {
  return prefix+createHash("sha256").update(JSON.stringify([...scope,albumId])).digest("hex");
}

export function albumChanged(store:Store,key:string|undefined) {
  return !!key && store.get<Album<AlbumItem>>(key)?.changed===true;
}

export function albumKnown(store:Store,key:string) {
  const album=store.get<Album<AlbumItem>>(key);
  return !!album && album.expires>Date.now();
}

export function albumHasPosition(store:Store,key:string,item:AlbumItem) {
  const album=store.get<Album<AlbumItem>>(key);
  return !!(album?.positions?.includes(item.messageId) || album?.updates?.includes(item.updateId) ||
    album?.items?.some(part=>part.messageId===item.messageId || part.updateId===item.updateId));
}

export function collectAlbum<T extends AlbumItem>(store:Store,key:string,item:T,now=Date.now()) {
  let lateAnchor:number|undefined;
  store.atomic(()=>{
    const existing=store.get<Album<T>>(key);
    if (albumHasPosition(store,key,item)) return;
    if (existing && (!existing.items || existing.items.length>=maxAlbumItems)) {
      if (existing.changed) return;
      store.put(key,{...existing,changed:true});
      lateAnchor=existing.anchor;
      return;
    }
    const firstAt=existing?.firstAt??now;
    // A fragment may arrive after the quiet window while the worker is busy.
    // Until the batch is actually released it still belongs in that batch.
    store.put(key,{firstAt,due:Math.min(firstAt+albumCollectionMs,now+albumQuietMs),
      expires:firstAt+retentionMs,items:[...(existing?.items??[]),item]} satisfies Album<T>);
  });
  return lateAnchor;
}

export function releaseAlbums<T extends AlbumItem>(store:Store,prefix:string,
  enqueue:(items:T[],key:string,changed:boolean)=>number|undefined,now=Date.now()) {
  for (const {key} of store.list<Album<T>>(prefix)) store.atomic(()=>{
    const row=store.get<Album<T>>(key);
    if (!row) return;
    if (now>=row.expires) {store.del(key);return;}
    if (!row.items || now<row.due) return;
    row.items.sort((a,b)=>a.messageId-b.messageId);
    const anchor=enqueue(row.items,key,row.changed===true);
    store.put(key,{due:row.due,expires:row.expires,firstAt:row.firstAt,
      positions:row.items.map(item=>item.messageId),updates:row.items.map(item=>item.updateId),anchor,changed:row.changed});
  });
}

type AlbumKind = "photo"|"document";
export type AlbumMedia = {kind:AlbumKind; data:Blob|string; name?:string; caption?:string};
type Target = {chatId:number; topicId:number; replyTo:number};

export function albumKind<T>(items:T[],classify:(item:T)=>AlbumKind|undefined) {
  if (items.length<2 || items.length>maxAlbumItems) return;
  const kind=classify(items[0]);
  return kind && items.every(item=>classify(item)===kind) ? kind : undefined;
}

export function albumCaption(label:string,name:string) {
  const value=label.trim();
  return value && value!==name ? value.slice(0,maxCaption).replace(/[\uD800-\uDBFF]$/u,"") : undefined;
}

export async function sendAlbum(tg:Telegram,target:Target,files:AlbumMedia[]) {
  const {chatId,topicId,replyTo}=target;
  const kind=files[0]?.kind;
  if (files.length<2 || files.length>maxAlbumItems || files.some(f=>f.kind!==kind ||
      (f.caption?.length??0)>maxCaption || typeof f.data==="string" && !f.data))
    throw Error("invalid_album");
  const body:Record<string,unknown>={chat_id:chatId,
    ...(topicId>0 && {message_thread_id:topicId}),
    ...(replyTo>0 && {reply_parameters:{message_id:replyTo,allow_sending_without_reply:false}})};
  body.media=files.map((file,index)=>{
    const field="media"+index;
    const upload=typeof file.data!=="string";
    if (upload) {
      body[field]=file.data;
      body[field+"_filename"]=file.name;
    }
    return {type:kind,media:upload?"attach://"+field:file.data,
      ...(file.caption && {caption:file.caption}),
      ...(kind==="document" && {disable_content_type_detection:true})};
  });
  const result=await tg<any[]>("sendMediaGroup",body);
  if (!Array.isArray(result) || result.length!==files.length) throw Error("unconfirmed_album");
  const mediaGroupId=result[0]?.media_group_id;
  const ids=result.map(row=>row?.message_id);
  if (typeof mediaGroupId!=="string" || !mediaGroupId ||
      (replyTo>0 && !result.some(row=>row?.reply_to_message?.message_id===replyTo)))
    throw Error("unconfirmed_album");
  for (const [index,row] of result.entries()) {
    const id=ids[index];
    if (!Number.isSafeInteger(id) || id<=0 || (index>0 && id<=ids[index-1]) ||
        row.media_group_id!==mediaGroupId || row.chat?.id!==chatId ||
        (topicId>0 && row.message_thread_id!==topicId) ||
        // In a forum topic Telegram marks every message as a reply to the topic's root: that is not a reply.
        (row.reply_to_message && row.reply_to_message.message_id!==replyTo && !(topicId>0 && row.reply_to_message.message_id===topicId)))
      throw Error("unconfirmed_album");
    if (kind==="photo") {
      if (!row.photo?.length) throw Error("unconfirmed_album");
    } else {
      const file=files[index];
      const document=row.document;
      if (!document?.file_id || (typeof file.data!=="string" &&
          ((document.file_name!==undefined && !sameTelegramFilename(file.name ?? "",document.file_name)) ||
           (document.file_size!==undefined && document.file_size!==file.data.size))))
        throw Error("unconfirmed_album");
    }
  }
  return {mediaGroupId,messageIds:ids as number[]};
}

/** Copy only already-authorized IDs from one scope; partial results cannot be retried as a batch. */
export async function copyAlbum(tg:Telegram,target:Omit<Target,"replyTo">,
  source:{chatId:number;messageIds:number[]}) {
  const messageIds=[...new Set(source.messageIds)].sort((a,b)=>a-b);
  if (messageIds.length!==source.messageIds.length || messageIds.length<2 ||
      messageIds.length>maxAlbumItems || messageIds.some(id=>!Number.isSafeInteger(id)||id<=0))
    throw Error("invalid_album_copy");
  const sent=await tg<{message_id:number}[]>("copyMessages",{chat_id:target.chatId,
    ...(target.topicId>0 && {message_thread_id:target.topicId}),
    from_chat_id:source.chatId,message_ids:messageIds});
  if (!Array.isArray(sent) || sent.length>messageIds.length ||
      sent.some((item,index)=>!Number.isSafeInteger(item?.message_id) || item.message_id<=0 ||
        index>0 && item.message_id<=sent[index-1].message_id))
    throw Error("unconfirmed_album_copy");
  return {messageIds:sent.map(item=>item.message_id),complete:sent.length===messageIds.length};
}

type Warning<T> = Target & {scope:T;expires:number;sent?:true};

export function queueAlbumWarning<T>(store:Store,key:string,target:Target,scope:T) {
  if (!store.get(key)) store.put(key,{...target,scope,expires:Date.now()+retentionMs} satisfies Warning<T>);
}

export async function deliverAlbumWarnings<T>(store:Store,prefix:string,transport:(chatId:number)=>Telegram,
  allowed:(scope:T,target:Target)=>boolean|Promise<boolean>,signal:AbortSignal) {
  for (const {key,value} of store.list<Warning<T>>(prefix)) {
    if (signal.aborted) return;
    if (value.expires<=Date.now()) {store.del(key);continue;}
    if (value.sent || !await allowed(value.scope,value)) continue;
    if (signal.aborted) return;
    store.put(key,{...value,sent:true});
    const {method,body}=outboundMessagePayload({...value,text:albumChangedNotice});
    await transport(value.chatId)(method,body).catch(()=>{});
  }
}
