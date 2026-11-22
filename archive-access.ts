import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import type {Archive} from "./archive";
import {groupSettings,installKind} from "./rights";

// Who may read what in the conversation archive. The calling conversation comes from the thread
// BB reports for the tool call, never from the agent: a subthread belongs to the conversation of
// its nearest bound ancestor.
//
// - The owner's private chat reads every group and the owner's own chat; never another person's private chat.
// - A group with its own memory ("separate") reads only itself, all its topics.
// - A group with shared memory reads every shared group; a personal assistant's shared group
//   (only the owner is there) also reads the owner's private chat.
// - A person's private chat reads itself, the shared groups and the groups that person writes in.

export type Conversation={kind:"owner"}|{kind:"group";chat:number}|{kind:"person";subject:number};
export type GroupMemory="shared"|"separate";

/** The group's memory setting, or the default: a personal assistant's groups share, an employee's are separate. */
export function groupMemory(store:Store,bot:number,chat:number):GroupMemory {
  const saved=(groupSettings(store,bot,chat) as {memory?:GroupMemory}|undefined)?.memory;
  return saved ?? (installKind(store)==="assistant" ? "shared" : "separate");
}

export function conversationOfThread(store:Store,threadId:string):Conversation|undefined {
  if (store.list<{threadId?:string}>("chat:binding:").some(({value})=>value.threadId===threadId)) return {kind:"owner"};
  const scope=store.get<string>("group:thread:"+threadId);
  const policy=scope ? store.get<GroupTopicPolicy>(scope) : undefined;
  if (!policy || policy.threadId!==threadId) return;
  return policy.privateChat ? {kind:"person",subject:policy.chatId} : {kind:"group",chat:policy.chatId};
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

export function readableChats(store:Store,archive:Pick<Archive,"groupsOf">,bot:number,owner:number,c:Conversation) {
  const shared=(chat:number)=>chat<0 && groupMemory(store,bot,chat)==="shared";
  if (c.kind==="owner") return (chat:number)=>chat<0 || chat===owner;
  if (c.kind==="group") {
    if (groupMemory(store,bot,c.chat)==="separate") return (chat:number)=>chat===c.chat;
    const ownerToo=installKind(store)==="assistant";
    return (chat:number)=>chat===c.chat || shared(chat) || (ownerToo && chat===owner);
  }
  const member=new Set(archive.groupsOf(bot,c.subject));
  return (chat:number)=>chat===c.subject || shared(chat) || member.has(chat);
}
