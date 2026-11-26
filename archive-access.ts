import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import type {Archive} from "./archive";
import {accessList,groupSettings,hasAccess,installKind,ownerMemoryChoiceKey,saveGroupSettings,setAccess} from "./rights";

// Who may read what in the conversation archive. The calling conversation comes from the thread
// BB reports for the tool call, never from the agent: a subthread belongs to the conversation of
// its nearest bound ancestor.
//
// - The owner's private chat reads every group and the owner's own chat; never another person's private chat.
// - A group with its own memory ("separate") reads only itself, all its topics.
// - A group with shared memory has only the owner in it: it reads like the owner's private chat.
// - A person's private chat reads itself, the shared groups and the groups that person writes in.

export type Conversation={kind:"owner"}|{kind:"group";chat:number;topic?:number}|{kind:"person";subject:number};
export type GroupMemory="shared"|"separate";

/** The group's memory setting, or the default: a personal assistant's groups share, an employee's are separate. */
export function groupMemory(store:Store,bot:number,chat:number):GroupMemory {
  const saved=(groupSettings(store,bot,chat) as {memory?:GroupMemory}|undefined)?.memory;
  return saved ?? (installKind(store)==="assistant" ? "shared" : "separate");
}

type Stranger={id:number;name:string;channel?:true};
type GroupGuard={chat:number;title:string;unknown:Stranger[]};
/** Everyone not approved who joined or wrote in a group since it turned guest: approving one does not clear the rest. */
const unknownKey=(bot:number,chat:number)=>`gm:unknown:${bot}:${chat}`;
/** A group whose «separate» memory predates the reason being kept: the owner is asked once, never switched silently. */
const askedRestoreKey=(bot:number,chat:number)=>`gm:asked-restore:${bot}:${chat}`;
const personName=(u:any)=>[u.first_name,u.last_name].filter(Boolean).join(" ").slice(0,64) || (u.username ? "@"+u.username : "новый участник");

/**
 * A group is the owner's own conversation when its memory is shared: only the owner, people he approved and the agent
 * are there. A person nobody approved (who joined or wrote, or wrote on behalf of his own channel) makes it a guest
 * conversation at once (memory becomes "separate"); every such person is kept until approved. An anonymous admin
 * (on behalf of the group itself) and the linked channel's automatic forward are not a person.
 * Returns what to tell the owner: a guest group (once, with everyone unknown), or — for a group made separate before
 * reasons were kept — a one-time question whether to return the shared memory now that the writer is approved.
 */
export function guardGroupMemory(store:Store,bot:number,owner:number,update:any):
  ({kind:"guest"}&GroupGuard)|{kind:"restore?";chat:number;title:string}|undefined {
  const m=update?.message;
  if (!m || !["group","supergroup"].includes(m.chat?.type) || !(m.chat.id<0)) return;
  const chat=m.chat.id, title=String(m.chat.title??"группа");
  const strange=(u:any)=>u && Number.isSafeInteger(u.id) && !u.is_bot && !hasAccess(store,bot,owner,u.id);
  const found:Stranger[]=(Array.isArray(m.new_chat_members) ? m.new_chat_members : []).filter(strange).map((u:any)=>({id:u.id,name:personName(u)}));
  if (m.sender_chat) {
    if (m.sender_chat.id!==chat && !m.is_automatic_forward) found.push({id:m.sender_chat.id,name:String(m.sender_chat.title ?? "канал").slice(0,64),channel:true});
  } else if (strange(m.from)) found.push({id:m.from.id,name:personName(m.from)});
  const key=unknownKey(bot,chat);
  // Someone who left is no longer there: off the list (the memory stays as it is until the owner decides).
  const before=store.get<Stranger[]>(key) ?? [];
  if (m.left_chat_member && before.some(k=>k.id===m.left_chat_member.id)) store.put(key,before.filter(k=>k.id!==m.left_chat_member.id));
  const known=store.get<Stranger[]>(key) ?? [];
  if (found.length) {
    const all=[...known,...found.filter(f=>!known.some(k=>k.id===f.id))];
    store.put(key,all);
    if (groupMemory(store,bot,chat)!=="shared") return;
    saveGroupSettings(store,bot,chat,{memory:"separate"},"мост: в группе незнакомый человек");
    return {kind:"guest",chat,title,unknown:all};
  }
  // An approved person wrote in a group made separate before reasons were kept (no list): ask the owner once.
  const settings=groupSettings(store,bot,chat) as {memory?:GroupMemory;version?:number}|undefined;
  if (!m.from || m.from.is_bot || !hasAccess(store,bot,owner,m.from.id) || store.get(key)!==undefined) return;
  if (settings?.memory!=="separate" || (settings.version ?? 1)<2 || store.get(askedRestoreKey(bot,chat)) ||
      store.get(ownerMemoryChoiceKey(bot,chat))==="separate") return;
  store.put(askedRestoreKey(bot,chat),Date.now());
  return {kind:"restore?",chat,title};
}

const approveButton=(chat:number,p:Stranger)=>({text:`Одобрить ${p.name} (доступ к боту)`.slice(0,60),callback_data:`gm:ok:${chat}:${p.id}`});
const pending=(unknown:Stranger[])=>unknown.map(p=>p.name).join(", ");

/** The owner's message: who came, what changed, and what he can do. */
export function groupMemoryNotice(event:NonNullable<ReturnType<typeof guardGroupMemory>>) {
  if (event.kind==="restore?") return {text:`В «${event.title}» все, кто сейчас пишет, одобрены. Вернуть группе общую память?`,
    reply_markup:{inline_keyboard:[[{text:"Вернуть",callback_data:`gm:back:${event.chat}`},{text:"Оставить отдельной",callback_data:`gm:keep:${event.chat}`}]]}};
  const people=event.unknown.filter(p=>!p.channel);
  const one=event.unknown.length===1;
  return {text:`В «${event.title}» ${one ? "появился" : "есть люди, которых я не знаю:"} ${pending(event.unknown)}${one ? " — я его не знаю" : ""}. `+
      `Пока ${one ? "он" : "они"} в группе, я использую там только переписку этой группы, без общей памяти.`+
      (people.length ? " «Одобрить» даёт человеку доступ к боту, как в списке допуска." : ""),
    reply_markup:{inline_keyboard:[...people.slice(0,5).map(p=>[approveButton(event.chat,p)]),[{text:"Оставить так",callback_data:`gm:keep:${event.chat}`}]]}};
}

/**
 * The owner's buttons. «Одобрить X» adds X to access and takes him off the group's unknown list; the shared memory
 * comes back only when nobody unknown is left. «Вернуть» (an old separate group) returns it; «Оставить» keeps it.
 */
export function groupMemoryAnswer(store:Store,bot:number,owner:number,update:any):
  {callbackId:string;text:string;chat:number;message:number;reply_markup?:{inline_keyboard:unknown[][]}}|undefined {
  const q=update?.callback_query;
  const m=/^gm:(ok|keep|back):(-\d+)(?::(\d+))?$/.exec(String(q?.data ?? ""));
  if (!m || q.from?.id!==owner || !q.message) return;
  const chat=Number(m[2]);
  const reply={callbackId:String(q.id),chat:q.message.chat.id,message:q.message.message_id};
  if (m[1]==="keep") return {...reply,text:"Оставил так: в этой группе — только её переписка."};
  const ownChoice=store.get(ownerMemoryChoiceKey(bot,chat))==="separate";
  if (m[1]==="back") {
    if (ownChoice) return {...reply,text:"Не вернул: память этой группы вы сами сделали отдельной в настройках."};
    const now=(store.get<Stranger[]>(unknownKey(bot,chat)) ?? []).filter(p=>!hasAccess(store,bot,owner,p.id));
    if (now.length) return {...reply,text:`Не вернул: в группе появились не одобренные — ${pending(now)}.`};
    saveGroupSettings(store,bot,chat,{memory:"shared"},"владелец (кнопка «Вернуть»)");
    return {...reply,text:"Готово: в группе снова общая память."};
  }
  const key=unknownKey(bot,chat);
  const unknown=store.get<Stranger[]>(key) ?? [];
  const id=Number(m[3]);
  const person=unknown.find(p=>p.id===id);
  const name=person?.name ?? String(id);
  if (!accessList(store,bot).some(p=>p.id===id)) setAccess(store,bot,[...accessList(store,bot),{id,name}]);
  const left=unknown.filter(p=>p.id!==id && !hasAccess(store,bot,owner,p.id));
  store.put(key,left);
  if (left.length) return {...reply,text:`${name} одобрен. В группе ещё не одобрены: ${pending(left)} — общая память пока выключена.`,
    reply_markup:{inline_keyboard:[...left.filter(p=>!p.channel).slice(0,5).map(p=>[approveButton(chat,p)]),[{text:"Оставить так",callback_data:`gm:keep:${chat}`}]]}};
  if (ownChoice) return {...reply,text:`Готово: ${name} одобрен. Память группы остаётся отдельной — так вы выбрали в настройках.`};
  saveGroupSettings(store,bot,chat,{memory:"shared"},`владелец (кнопка «Одобрить ${name}»)`);
  return {...reply,text:`Готово: ${name} одобрен, в группе снова общая память.`};
}

export function conversationOfThread(store:Store,threadId:string):Conversation|undefined {
  if (store.list<{threadId?:string}>("chat:binding:").some(({value})=>value.threadId===threadId)) return {kind:"owner"};
  const scope=store.get<string>("group:thread:"+threadId);
  const policy=scope ? store.get<GroupTopicPolicy>(scope) : undefined;
  if (!policy || policy.threadId!==threadId) return;
  return policy.privateChat ? {kind:"person",subject:policy.chatId} : {kind:"group",chat:policy.chatId,topic:policy.topicId};
}

export async function conversationOf(store:Store,threads:Pick<BbPluginApi["sdk"]["threads"],"get">,threadId:string,signal?:AbortSignal) {
  let current:string|undefined=threadId;
  for (let depth=0;current && depth<8;depth++) {
    const found=conversationOfThread(store,current);
    if (found) return found;
    const thread=await threads.get({threadId:current,signal}) as {parentThreadId?:string|null};
    current=thread.parentThreadId ?? undefined;
  }
  return undefined;
}

/**
 * A thread that was the conversation of a group or a person until the binding moved to another thread: it keeps its
 * claim but no longer acts for that place. Says where the conversation went, so the refusal can name it.
 */
export function movedConversationOfThread(store:Store,threadId:string):{chatId:number;topicId:number;threadId:string;privateChat:boolean}|undefined {
  const scope=store.get<string>("group:thread:"+threadId);
  const policy=scope ? store.get<GroupTopicPolicy>(scope) : undefined;
  if (!policy || !policy.threadId || policy.threadId===threadId) return;
  return {chatId:policy.chatId,topicId:policy.topicId,threadId:policy.threadId,privateChat:!!policy.privateChat};
}

export async function movedConversationOf(store:Store,threads:Pick<BbPluginApi["sdk"]["threads"],"get">,threadId:string,signal?:AbortSignal) {
  let current:string|undefined=threadId;
  for (let depth=0;current && depth<8;depth++) {
    if (conversationOfThread(store,current)) return;
    const moved=movedConversationOfThread(store,current);
    if (moved) return moved;
    const thread=await threads.get({threadId:current,signal}) as {parentThreadId?:string|null};
    current=thread.parentThreadId ?? undefined;
  }
  return undefined;
}

/** The refusal for a thread whose conversation moved: in words, with where to pass the work. */
export function movedConversationRefusal(moved:{chatId:number;topicId:number;threadId:string;privateChat:boolean},title?:string) {
  const place=moved.privateChat ? "лички" : "группы «"+(title ?? "группа")+"»"+(moved.topicId ? ", тема "+moved.topicId : "");
  return "conversation_moved: этот тред больше не ведёт разговор "+place+" — его ведёт тред "+moved.threadId+
    ". Отправка туда и список адресатов отсюда недоступны. Передай дело тому треду: bb thread tell "+moved.threadId+" '…' (что сделать и где лежит результат).";
}

export function readableChats(store:Store,archive:Pick<Archive,"groupsOf">,bot:number,owner:number,c:Conversation) {
  const shared=(chat:number)=>chat<0 && groupMemory(store,bot,chat)==="shared";
  if (c.kind==="owner") return (chat:number)=>chat<0 || chat===owner;
  if (c.kind==="group") {
    if (groupMemory(store,bot,c.chat)==="separate") return (chat:number)=>chat===c.chat;
    // Shared memory: only the owner is there, so it reads like the owner's private chat.
    return (chat:number)=>chat<0 || chat===owner;
  }
  const member=new Set(archive.groupsOf(bot,c.subject));
  return (chat:number)=>chat===c.subject || shared(chat) || member.has(chat);
}
