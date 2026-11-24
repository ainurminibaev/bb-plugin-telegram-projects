import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import type {Archive} from "./archive";
import {groupSettings,installKind,saveGroupSettings} from "./rights";

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

/**
 * A group is the owner's own conversation when its memory is shared: only the owner and the agent are
 * there. The first other person makes it a guest conversation at once (memory becomes "separate").
 * Returns the group to tell the owner about, once.
 */
export function guardGroupMemory(store:Store,bot:number,owner:number,update:any):{chat:number;title:string}|undefined {
  const m=update?.message;
  if (!m || !["group","supergroup"].includes(m.chat?.type) || !(m.chat.id<0)) return;
  const others=(Array.isArray(m.new_chat_members) ? m.new_chat_members : [])
    .some((u:any)=>u && !u.is_bot && u.id!==owner);
  const stranger=!!m.sender_chat || (m.from && !m.from.is_bot && m.from.id!==owner);
  if (!others && !stranger) return;
  if (groupMemory(store,bot,m.chat.id)!=="shared") return;
  saveGroupSettings(store,bot,m.chat.id,{memory:"separate"});
  return {chat:m.chat.id,title:String(m.chat.title??"группа")};
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
