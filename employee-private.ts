import {albumChanged,albumKey,collectAlbum,deliverAlbumWarnings,queueAlbumWarning,releaseAlbums,sendAlbum,albumCaption,albumKind,type AlbumMedia} from "./media-album";
import {randomUUID} from "node:crypto";
import {groupExample,type GroupExample} from "./ingress";
import {isolatedFile,maxEncodedImages,readSavedImage,type ImageAttachment,type IsolatedAttachment} from "./group-attachments";
import {privateExecutor} from "./isolated-client";
import type {Store,Telegram} from "./model";
import {splitText} from "./chat";
import {outboundMessagePayload} from "./outbound-message";
import {routedArtifactKind,routedCaption} from "./routed-message";
import {localArtifacts} from "./telegram-ux";
import {stripTelegramMarkers} from "./reply-routing";
import type {SavedTelegramFile} from "./telegram-files";

type Access={owner:number;bot:number;subject:number;nonce:string;state:"pending"|"approved"|"denied"|"revoked";
  noticeId?:number;approvalUpdate?:number;unavailableNotified?:true};
export type PrivateJob={owner:number;bot:number;subject:number;messageId:number;updateId:number;
  nonce:string;token:string;binding:string;state:"pending"|"submitted"|"ready"|"sending";
  text?:string;file?:GroupExample;files?:GroupExample[];albumKey?:string;answer?:string;part?:number;artifactIndex?:number;failedArtifacts?:string[];albumSent?:number[];captionSent?:true};
type PrivateAlbumScope={subject:number;nonce:string;binding:string};
type PrivateAlbumItem={messageId:number;updateId:number;subject:number;nonce:string;binding:string;file:GroupExample;text:string};
type Executor=typeof privateExecutor;
type Dependencies={store:Store;owner:number;bot:number;transport:(chatId:number)=>Telegram;current:()=>boolean;
  executor?:Executor};
const accessKey=(bot:number,owner:number,subject:number)=>`employee:private:access:${bot}:${owner}:${subject}`;
const nonceKey=(bot:number,owner:number,nonce:string)=>`employee:private:decision:${bot}:${owner}:${nonce}`;
const inboxPrefix=(bot:number,owner:number)=>`employee:private:in:${bot}:${owner}:`;
const positive=(id:unknown):id is number=>typeof id==="number" && Number.isSafeInteger(id) && id>0;
const cleanName=(value:unknown)=>typeof value==="string" ? value.replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,80) : "";

function withinPilot(subject:number) {
  const configured=process.env.BB_TELEGRAM_PRIVATE_PILOT_SUBJECT;
  return configured===undefined || configured===String(subject);
}

function executorFor(d:Dependencies,subject:number) {
  if (!withinPilot(subject)) return;
  try { return (d.executor??privateExecutor)(d.bot,d.owner,subject); }
  catch { return undefined; }
}

export async function acceptPrivateEmployeeUpdate(d:Dependencies,update:any) {
  const {bot,owner,store,transport}=d;
  const callback=update.callback_query;
  if (callback) {
    const action=/^ep:(allow|deny|revoke):([a-f0-9]{32})$/.exec(callback.data??"");
    if (!action) return false;
    if (!positive(update.update_id) || !d.current() || callback.from?.id!==owner || callback.message?.chat?.type!=="private" ||
        callback.message.chat.id!==owner) return true;
    const [,decision,nonce]=action;
    const subject=store.get<number>(nonceKey(bot,owner,nonce));
    if (!positive(subject) || !withinPilot(subject)) return true;
    const key=accessKey(bot,owner,subject);
    const row=store.get<Access>(key);
    if (!row || row.nonce!==nonce || row.noticeId!==callback.message.message_id ||
        row.state!==(decision==="revoke"?"approved":"pending")) return true;
    const next:Access["state"]=decision==="allow"?"approved":decision==="deny"?"denied":"revoked";
    store.put(key,{...row,state:next,...(next==="approved" && {approvalUpdate:update.update_id})} satisfies Access);
    const tg=transport(owner);
    await tg("editMessageReplyMarkup",{chat_id:owner,message_id:row.noticeId,
      reply_markup:{inline_keyboard:next==="approved"?[[{text:"Отозвать доступ",callback_data:"ep:revoke:"+nonce}]]:[]}}).catch(()=>{});
    const status=next==="approved"?"Доступ разрешён.":next==="denied"?"В доступе отказано.":"Доступ отозван.";
    await tg("answerCallbackQuery",{callback_query_id:callback.id,text:status}).catch(()=>{});
    if (d.current()) await transport(subject)("sendMessage",{chat_id:subject,text:status}).catch(()=>{});
    return true;
  }
  const message=update.message;
  const subject=message?.from?.id;
  if (!positive(subject) || subject===owner || message.chat?.type!=="private" || message.chat.id!==subject ||
      !d.current() || message.from.is_bot || message.sender_chat || message.business_connection_id) return false;
  if (!withinPilot(subject) || !positive(message.message_id) || !positive(update.update_id)) return true;
  const file=groupExample(message);
  const text=(typeof message.text==="string" ? message.text :
    typeof message.caption==="string" ? message.caption : "").trim().slice(0,16000);
  if (!text && !file) return true;
  const key=accessKey(bot,owner,subject);
  const existing=store.get<Access>(key);
  if (!existing) {
    const nonce=randomUUID().replaceAll("-","");
    const row:Access={owner,bot,subject,nonce,state:"pending"};
    store.atomic(()=>{
      store.put(key,row);
      store.put(nonceKey(bot,owner,nonce),subject);
    });
    const name=[cleanName(message.from.first_name),cleanName(message.from.last_name)].filter(Boolean).join(" ");
    const username=/^[A-Za-z0-9_]{1,32}$/.test(message.from.username??"") ? " @"+message.from.username : "";
    await transport(subject)("sendMessage",{chat_id:subject,
      text:"Доступ к сотруднику ещё не выдан. Обратитесь к администратору."}).catch(()=>{});
    if (!d.current()) return true;
    // The reservation precedes the send. An unknown Telegram outcome never creates a duplicate card.
    const sent=await transport(owner)("sendMessage",{chat_id:owner,text:`Запрос личного доступа: ${name||"пользователь"}${username}\nTelegram ID: ${subject}`,
      reply_markup:{inline_keyboard:[[{text:"Разрешить",callback_data:"ep:allow:"+nonce},{text:"Отказать",callback_data:"ep:deny:"+nonce}]]}}).catch(()=>undefined);
    if (positive(sent?.message_id) && d.current()) store.put(key,{...row,noticeId:sent.message_id});
    return true;
  }
  if (existing.state!=="approved" || !existing.approvalUpdate || update.update_id<=existing.approvalUpdate || /^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return true;
  const worker=executorFor(d,subject);
  if (!worker) {
    if (!existing.unavailableNotified) {
      store.put(key,{...existing,unavailableNotified:true});
      await transport(subject)("sendMessage",{chat_id:subject,
        text:"Доступ разрешён, но отдельный исполнитель пока не готов. Сообщение не принято."}).catch(()=>{});
    }
    return true;
  }
  if (file?.album) {
    const key=albumKey(`private:album:${bot}:${owner}:`,[subject],file.album);
    const scope={subject,nonce:existing.nonce,binding:worker.binding};
    store.atomic(()=>{
      const late=collectAlbum(store,key,{
        ...scope,messageId:message.message_id,updateId:update.update_id,text,file:{...file,sourceUpdateId:update.update_id},
      } satisfies PrivateAlbumItem);
      if (late) queueAlbumWarning(store,`private:album-warning:${bot}:${owner}:`+key,
        {chatId:subject,topicId:0,replyTo:late},scope);
    });
    return true;
  }
  const jobKey=inboxPrefix(bot,owner)+subject+":"+message.message_id;
  const receipt=jobKey.replace(":in:",":receipt:");
  if (!store.get(jobKey) && !store.get(receipt))
    store.put(jobKey,{owner,bot,subject,messageId:message.message_id,updateId:update.update_id,
      nonce:existing.nonce,token:randomUUID(),binding:worker.binding,state:"pending",text,file} satisfies PrivateJob);
  return true;
}

export async function processPrivateEmployeeInputs(d:Dependencies,signal:AbortSignal,
  receive:(file:GroupExample,job:PrivateJob)=>Promise<SavedTelegramFile|ImageAttachment>) {
  const {store,bot,owner,transport}=d;
  releaseAlbums<PrivateAlbumItem>(store,`private:album:${bot}:${owner}:`,(parts,albumKey,changed)=>{
    const first=parts[0];
    const access=store.get<Access>(accessKey(bot,owner,first.subject));
    const worker=executorFor(d,first.subject);
    if (!d.current() || access?.state!=="approved" || access.nonce!==first.nonce ||
        worker?.binding!==first.binding || parts.some(part=>part.nonce!==first.nonce || part.binding!==first.binding)) return;
    if (changed || parts.some(part=>part.file.document!==first.file.document)) {
      queueAlbumWarning(store,`private:album-warning:${bot}:${owner}:`+albumKey,
        {chatId:first.subject,topicId:0,replyTo:first.messageId},
        {subject:first.subject,nonce:first.nonce,binding:first.binding} satisfies PrivateAlbumScope);
      return first.messageId;
    }
    const jobKey=inboxPrefix(bot,owner)+first.subject+":"+first.messageId;
    if (!store.get(jobKey) && !store.get(jobKey.replace(":in:",":receipt:")))
      store.put(jobKey,{owner,bot,subject:first.subject,messageId:first.messageId,updateId:first.updateId,
        nonce:first.nonce,binding:first.binding,token:randomUUID(),state:"pending",albumKey,
        text:parts.map(part=>part.text).filter(Boolean).join("\n"),files:parts.map(part=>part.file)} satisfies PrivateJob);
    return first.messageId;
  });
  await deliverAlbumWarnings<PrivateAlbumScope>(store,`private:album-warning:${bot}:${owner}:`,transport,scope=>{
    const access=store.get<Access>(accessKey(bot,owner,scope.subject));
    return d.current() && access?.state==="approved" && access.nonce===scope.nonce &&
      executorFor(d,scope.subject)?.binding===scope.binding;
  },signal);
  const seen=new Set<number>();
  const jobs=store.list<PrivateJob>(inboxPrefix(bot,owner)).sort((a,b)=>a.value.updateId-b.value.updateId);
  for (const {key,value:job} of jobs) {
    if (signal.aborted || !d.current()) return;
    if (seen.has(job.subject)) continue;
    seen.add(job.subject);
    const finish=(state:"done"|"revoked"|"unknown")=>store.atomic(()=>{
      store.put(key.replace(":in:",":receipt:"),{state,at:Date.now(),...(job.albumSent && {albumMessageIds:job.albumSent})});
      store.del(key);
    });
    const worker=executorFor(d,job.subject);
    const allowed=()=>{
      const access=store.get<Access>(accessKey(bot,owner,job.subject));
      return !albumChanged(store,job.albumKey) && !signal.aborted && d.current() && job.owner===owner && job.bot===bot &&
        !!worker && access?.state==="approved" && access.nonce===job.nonce &&
        executorFor(d,job.subject)?.binding===job.binding;
    };
    if (!worker || !allowed()) {finish("revoked");continue;}
    if (job.state==="sending") {finish("unknown");continue;}
    try {
      if (job.state==="pending") {
        const prior=await worker.read(job.token,signal);
        if (!allowed()) {finish("revoked");continue;}
        if (prior.state==="missing") {
          const attachments:IsolatedAttachment[]=[];
          try {
            let imageSize=0;
            for (const file of job.files ?? (job.file ? [job.file] : [])) {
              const received=await receive(file,job);
              if (!allowed()) break;
              const image="type" in received ? received : file.image
                ? await readSavedImage(received,signal).catch(err=>{if (!file.document) throw err;})
                : undefined;
              if (image) {
                imageSize+=image.url.length;
                if (imageSize>maxEncodedImages) throw Error("private_image_too_large");
                attachments.push(image);
              }
              if (!("type" in received) && (!image || file.document)) {
                attachments.push(isolatedFile(await worker.upload(received,signal),!file.pdf));
              }
            }
          } catch {
            if (signal.aborted) return;
            job.answer="Не удалось получить вложение. Попробуйте приложить файл ещё раз.";
            job.state="ready";
          }
          if (!allowed()) {finish("revoked");continue;}
          if (job.state==="pending") await worker.submit(job.token,job.text||"Посмотри приложенный файл.",signal,attachments);
        }
        delete job.text;
        delete job.file;
        delete job.files;
        if (job.state==="pending") job.state="submitted";
        store.put(key,job);
      }
      if (job.state==="submitted") {
        const result=await worker.read(job.token,signal);
        if (result.state==="waiting") continue;
        job.answer=result.state==="finished" ? stripTelegramMarkers(result.text) : "Поручение не удалось подтвердить.";
        job.state="ready";
        store.put(key,job);
      }
      let text=job.answer?.trim()||"Не удалось получить ответ на это сообщение.";
      const links=localArtifacts(text);
      const artifacts=[...new Map(links.map(link=>[link.path,link])).values()].slice(0,3);
      const caption=routedCaption(text,links);
      const reply={chatId:job.subject,topicId:0,replyTo:job.messageId};
      const albumType=albumKind(artifacts,link=>routedArtifactKind(link)==="image"?"photo":"document");
      if (albumType && (job.albumSent || !job.artifactIndex)) {
        if (!job.albumSent) {
          const files:AlbumMedia[]=[];
          for (const link of artifacts) {
            if (!allowed()) break;
            const file=await worker[routedArtifactKind(link)](job.token,link.path,signal).catch(()=>undefined);
            if (!file) break;
            files.push({kind:albumType,name:file.name,data:"document" in file ? file.document : file.photo,
              caption:albumCaption(link.label,file.name)});
          }
          if (!allowed()) {if (!signal.aborted) finish("revoked");continue;}
          if (files.length!==artifacts.length) {
            job.answer="Не удалось подготовить все вложения альбома.";
            store.put(key,job);
            continue;
          }
          store.put(key,{...job,state:"sending"});
          const sent=await sendAlbum(transport(job.subject),reply,files);
          job.albumSent=sent.messageIds;
          store.put(key,job);
        }
        text=links.reduce((body,link)=>body.replace(link.markdown,""),text).trim();
      }
      for (let i=job.albumSent ? artifacts.length : job.artifactIndex??0;i<artifacts.length;i++) {
        if (!allowed()) break;
        const link=artifacts[i];
        const {path}=link;
        const kind=routedArtifactKind(link);
        const file=await worker[kind](job.token,path,signal).catch(()=>undefined);
        if (!allowed()) break;
        if (!file) {
          job.failedArtifacts=[...(job.failedArtifacts??[]),path];
        } else {
          store.put(key,{...job,state:"sending"});
          const {method,body}=outboundMessagePayload({...reply,text:caption,
            file:{name:file.name,...("document" in file ? {kind:"document",data:file.document} : {kind:"photo",data:file.photo})}});
          const sent=await transport(job.subject)(method,body);
          if (!positive(sent?.message_id) || ("document" in file ? !sent.document?.file_id : !sent.photo?.length))
            throw Error("unconfirmed_private_file_delivery");
          if (caption) job.captionSent=true;
        }
        job.artifactIndex=i+1;
        store.put(key,job);
      }
      if (!allowed()) {
        if (!signal.aborted) finish("revoked");
        continue;
      }
      for (const link of links) text=text.replace(link.markdown,
        !artifacts.some(artifact=>artifact.path===link.path) || job.failedArtifacts?.includes(link.path) ? "Вложение недоступно для отправки." : "");
      if (job.captionSent || !text.trim()) {finish("done");continue;}
      const parts=splitText(text.trim());
      for (let i=job.part??0;i<parts.length;i++) {
        if (!allowed()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending"});
        const {method,body}=outboundMessagePayload({...reply,text:parts[i]});
        const sent=await transport(job.subject)(method,body);
        if (!positive(sent?.message_id)) {finish("unknown");break;}
        if (i+1===parts.length) finish("done");
        else store.put(key,{...job,part:i+1});
      }
    } catch {
      // Before submit, the scoped receipt is safe to read and retry. After a Telegram
      // send attempt the saved sending state prevents automatic delivery replay.
      if (signal.aborted) return;
    }
  }
}
