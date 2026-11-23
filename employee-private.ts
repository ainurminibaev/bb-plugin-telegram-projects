import {randomUUID} from "node:crypto";
import type {Store,Telegram} from "./model";
import {accessList,hasAccess,setAccess} from "./rights";
import type {GroupTopicPolicy} from "./ingress";

// A person writes to an employee bot in private. Without access the person gets one notice and
// the owner gets one card with buttons. Access is the same list the group settings use: a person
// either has access to the employee or not. A person with access talks to an ordinary thread of the
// employee, with the same instructions and tools; the group pipeline carries the messages.
type Access={owner:number;bot:number;subject:number;nonce:string;state:"pending"|"approved"|"denied"|"revoked";
  noticeId?:number;approvalUpdate?:number};
type Dependencies={store:Store;owner:number;bot:number;transport:(chatId:number)=>Telegram;current:()=>boolean;
  /** Binds the person's private chat to an ordinary employee thread. Returns false while that is not possible. */
  bindPerson:(subject:number,name:string)=>Promise<boolean>;
  /** С62: asks the person's conversation to write first — a short greeting and what the agent can do. */
  greetPerson?:(subject:number,name:string,talkedBefore:boolean)=>Promise<boolean>};
const greetedKey=(bot:number,subject:number)=>`employee:private:greeted:${bot}:${subject}`;

/**
 * С62: right after approval the person gets a conversation and the agent writes first. The mark is put before the turn
 * is sent, so a greeting is never asked twice; a failed bind leaves no mark and the next pass retries.
 */
export async function greetApproved(d:Dependencies,subject:number,name:string) {
  if (!d.greetPerson || d.store.get(greetedKey(d.bot,subject)) || !hasAccess(d.store,d.bot,d.owner,subject)) return false;
  const talkedBefore=!!d.store.get(privatePolicyKey(subject));
  if (!talkedBefore && !await d.bindPerson(subject,name).catch(()=>false)) return false;
  d.store.put(greetedKey(d.bot,subject),Date.now());
  return d.greetPerson(subject,name,talkedBefore).catch(()=>false);
}

/** Approved people the agent has not been asked to greet yet (approved before С62, or a bind that failed). */
export async function greetPendingApproved(d:Dependencies) {
  for (const {value} of d.store.list<Access & {name?:string}>(`employee:private:access:${d.bot}:${d.owner}:`))
    if (value.state==="approved" && positive(value.subject)) await greetApproved(d,value.subject,value.name ?? "");
}
const accessKey=(bot:number,owner:number,subject:number)=>`employee:private:access:${bot}:${owner}:${subject}`;
const nonceKey=(bot:number,owner:number,nonce:string)=>`employee:private:decision:${bot}:${owner}:${nonce}`;
export const privatePolicyKey=(subject:number)=>`group:policy:${subject}:0`;
const positive=(id:unknown):id is number=>typeof id==="number" && Number.isSafeInteger(id) && id>0;
const cleanName=(value:unknown)=>typeof value==="string" ? value.replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,80) : "";
const personName=(from:any)=>[cleanName(from?.first_name),cleanName(from?.last_name)].filter(Boolean).join(" ");

/** Removes the person's private binding. The BB thread and its history stay. */
export function unbindPerson(store:Store,subject:number) {
  store.atomic(()=>{
    const policy=store.get<GroupTopicPolicy>(privatePolicyKey(subject));
    if (!policy?.privateChat) return;
    store.del(privatePolicyKey(subject));
    // Schedules of this conversation must not outlive the access: the dispatch check reads this mark.
    store.put("conversation:closed:"+policy.threadId,Date.now());
    if (store.get("group:thread:"+policy.threadId)===privatePolicyKey(subject)) store.del("group:thread:"+policy.threadId);
  });
}

/**
 * Returns true when the update is handled here, false when it should continue to the group
 * acceptor (a message from a person with access whose private chat is bound).
 */
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
    const row=store.get<Access & {name?:string}>(key);
    if (!row || row.nonce!==nonce || row.noticeId!==callback.message.message_id ||
        row.state!==(decision==="revoke"?"approved":"pending")) return true;
    const next:Access["state"]=decision==="allow"?"approved":decision==="deny"?"denied":"revoked";
    store.atomic(()=>{
      store.put(key,{...row,state:next,...(next==="approved" && {approvalUpdate:update.update_id})});
      const people=accessList(store,bot).filter(p=>p.id!==subject);
      setAccess(store,bot,next==="approved" ? [...people,{id:subject,name:row.name||String(subject)}] : people);
    });
    if (next==="revoked") unbindPerson(store,subject);
    const tg=transport(owner);
    await tg("editMessageReplyMarkup",{chat_id:owner,message_id:row.noticeId,
      reply_markup:{inline_keyboard:next==="approved"?[[{text:"Отозвать доступ",callback_data:"ep:revoke:"+nonce}]]:[]}}).catch(()=>{});
    const status=next==="approved"?"Доступ разрешён.":next==="denied"?"В доступе отказано.":"Доступ отозван.";
    await tg("answerCallbackQuery",{callback_query_id:callback.id,text:status}).catch(()=>{});
    if (d.current() && next!=="approved") await transport(subject)("sendMessage",{chat_id:subject,text:status}).catch(()=>{});
    // С62: approved — the agent greets the person itself; the plain notice only when the greeting cannot be asked.
    if (d.current() && next==="approved" && !await greetApproved(d,subject,row.name ?? ""))
      await transport(subject)("sendMessage",{chat_id:subject,text:status}).catch(()=>{});
    if (next==="revoked") d.store.del(greetedKey(bot,subject));
    return true;
  }
  const message=update.message??update.edited_message;
  const subject=message?.from?.id;
  if (!positive(subject) || subject===owner || message.chat?.type!=="private" || message.chat.id!==subject ||
      !d.current() || message.from.is_bot || message.sender_chat || message.business_connection_id) return false;
  if (!positive(message.message_id) || !positive(update.update_id)) return true;
  if (hasAccess(store,bot,owner,subject)) {
    // /start only opens the chat; it is not a request.
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text??"")) {
      if (!store.get(privatePolicyKey(subject))) await d.bindPerson(subject,personName(message.from)).catch(()=>false);
      return true;
    }
    if (store.get<GroupTopicPolicy>(privatePolicyKey(subject))?.privateChat) return false;
    if (await d.bindPerson(subject,personName(message.from)).catch(()=>false)) return false;
    // Never hold the whole ingress on one chat: tell the person and let the next message retry.
    await transport(subject)("sendMessage",{chat_id:subject,reply_to_message_id:message.message_id,
      text:"Сейчас не получается принять сообщение. Повторите его чуть позже."}).catch(()=>{});
    return true;
  }
  const key=accessKey(bot,owner,subject);
  const existing=store.get<Access & {at?:number;waitNotified?:true}>(key);
  if (existing?.state==="pending") {
    // A request left without a decision: tell the person once, and give the owner a fresh card after an hour.
    if ((existing.at ?? 0) > Date.now()-3600_000) {
      if (!existing.waitNotified) {
        store.put(key,{...existing,waitNotified:true});
        await transport(subject)("sendMessage",{chat_id:subject,text:"Запрос уже у владельца. Как только он решит, я отвечу."}).catch(()=>{});
      }
      return true;
    }
  }
  // Denied or revoked people may ask again; the owner sees one new card per request.
  const nonce=randomUUID().replaceAll("-","");
  const name=personName(message.from);
  const row={owner,bot,subject,nonce,state:"pending" as const,name,at:Date.now()};
  store.atomic(()=>{
    store.put(key,row);
    store.put(nonceKey(bot,owner,nonce),subject);
  });
  const username=/^[A-Za-z0-9_]{1,32}$/.test(message.from.username??"") ? " @"+message.from.username : "";
  await transport(subject)("sendMessage",{chat_id:subject,
    text:"Запрос отправлен владельцу. Отвечу, как только он подтвердит."}).catch(()=>{});
  if (!d.current()) return true;
  // The reservation precedes the send. An unknown Telegram outcome never creates a duplicate card.
  const sent=await transport(owner)("sendMessage",{chat_id:owner,text:`Запрос личного доступа: ${name||"пользователь"}${username}\nTelegram ID: ${subject}`,
    reply_markup:{inline_keyboard:[[{text:"Разрешить",callback_data:"ep:allow:"+nonce},{text:"Отказать",callback_data:"ep:deny:"+nonce}]]}}).catch(()=>undefined);
  if (positive(sent?.message_id) && d.current()) store.put(key,{...row,noticeId:sent.message_id});
  return true;
}
