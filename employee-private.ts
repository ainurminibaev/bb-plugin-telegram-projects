import {randomUUID} from "node:crypto";
import {groupExample,type GroupExample} from "./ingress";
import {isolatedFile,maxEncodedImages,readSavedImage,type ImageAttachment,type IsolatedAttachment} from "./group-attachments";
import {privateExecutor} from "./isolated-client";
import type {Store,Telegram} from "./model";
import {splitText} from "./chat";
import {stripTelegramMarkers} from "./reply-routing";
import type {SavedTelegramFile} from "./telegram-files";

type Access={owner:number;bot:number;subject:number;nonce:string;state:"pending"|"approved"|"denied"|"revoked";
  noticeId?:number;approvalUpdate?:number;unavailableNotified?:true};
export type PrivateJob={owner:number;bot:number;subject:number;messageId:number;updateId:number;
  nonce:string;token:string;binding:string;state:"pending"|"submitted"|"ready"|"sending";
  text?:string;file?:GroupExample;answer?:string;part?:number};
type Executor=typeof privateExecutor;
type Dependencies={store:Store;owner:number;bot:number;transport:(chatId:number)=>Telegram;current:()=>boolean;
  executor?:Executor};
const accessKey=(bot:number,owner:number,subject:number)=>`employee:private:access:${bot}:${owner}:${subject}`;
const nonceKey=(bot:number,owner:number,nonce:string)=>`employee:private:decision:${bot}:${owner}:${nonce}`;
const inboxPrefix=(bot:number,owner:number)=>`employee:private:in:${bot}:${owner}:`;
const positive=(id:unknown):id is number=>typeof id==="number" && Number.isSafeInteger(id) && id>0;
const cleanName=(value:unknown)=>typeof value==="string" ? value.replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,80) : "";

function executorFor(d:Dependencies,subject:number) {
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
    if (!positive(subject)) return true;
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
  if (!positive(message.message_id) || !positive(update.update_id)) return true;
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
  const seen=new Set<number>();
  const jobs=store.list<PrivateJob>(inboxPrefix(bot,owner)).sort((a,b)=>a.value.updateId-b.value.updateId);
  for (const {key,value:job} of jobs) {
    if (signal.aborted || !d.current()) return;
    if (seen.has(job.subject)) continue;
    seen.add(job.subject);
    const finish=(state:"done"|"revoked"|"unknown")=>store.atomic(()=>{
      store.put(key.replace(":in:",":receipt:"),{state,at:Date.now()});
      store.del(key);
    });
    const worker=executorFor(d,job.subject);
    const allowed=()=>{
      const access=store.get<Access>(accessKey(bot,owner,job.subject));
      return !signal.aborted && d.current() && job.owner===owner && job.bot===bot &&
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
          if (job.file) {
            try {
              const received=await receive(job.file,job);
              if (!allowed()) {finish("revoked");continue;}
              const input="type" in received ? received : job.file.image ? await readSavedImage(received,signal) :
                isolatedFile(await worker.upload(received,signal));
              if (input.type==="image" && input.url.length>maxEncodedImages) throw Error("private_image_too_large");
              attachments.push(input);
            } catch {
              if (signal.aborted) return;
              job.answer="Не удалось получить вложение. Попробуйте приложить файл ещё раз.";
              job.state="ready";
            }
          }
          if (!allowed()) {finish("revoked");continue;}
          if (job.state==="pending") await worker.submit(job.token,job.text||"Посмотри приложенный файл.",signal,attachments);
        }
        delete job.text;
        delete job.file;
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
      const parts=splitText(job.answer?.trim()||"Не удалось получить ответ на это сообщение.");
      for (let i=job.part??0;i<parts.length;i++) {
        if (!allowed()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending"});
        const sent=await transport(job.subject)("sendMessage",{chat_id:job.subject,
          reply_parameters:{message_id:job.messageId},text:parts[i]});
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
