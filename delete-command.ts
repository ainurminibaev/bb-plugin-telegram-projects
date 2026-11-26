import type {Store} from "./model";
import type {Conversation} from "./archive-access";
import {ReplyRoutes} from "./reply-routing";

/**
 * С80: deleting a message in the conversation's own chat. The bot's own message — always (within Telegram's term);
 * anyone else's — only in a turn the owner started (his message, or his answer «да» to a question), with the admin
 * right «Удаление сообщений». From another conversation — never.
 */
export function deleteRefusal(args:{caller:Conversation|undefined;owner:number;bot:number;chat:number;
  sender:number|undefined;author:number|undefined}):string|undefined {
  const {caller,owner,bot,chat,sender,author}=args;
  if (!caller) return "delete_only_from_a_telegram_conversation: удалять можно только в чате своего разговора";
  const own=caller.kind==="group" ? caller.chat : caller.kind==="person" ? caller.subject : owner;
  // С105: the owner's conversation (and its subthreads) removes the bot's own message in any chat of this install.
  if (chat!==own && !(caller.kind==="owner" && sender===bot))
    return "delete_only_in_own_chat: удалять можно только в чате этого разговора; там, где сообщение, удаляет тамошний разговор";
  if (sender===bot) return;
  if (author!==owner)
    return "delete_others_only_by_owner: чужое сообщение удаляется только по слову владельца — спроси его: "+
      "bb telegram-projects send --person owner --ask --text 'Удалить сообщение … в этом чате? Причина: …'; ответ придёт сюда";
  return;
}

export function deleteLog(store:Store,bot:number,entry:{thread:string;chat:number;message:number;own:boolean;author?:number}) {
  store.put(`delete:log:${bot}:${Date.now()}:${entry.chat}:${entry.message}`,{...entry,at:Date.now()});
}

/**
 * Whose word the current turn carries: only a turn a Telegram message started (the owner's message or his «да»
 * answer) has an author; a turn begun from BB (a task, a schedule, another thread) has none.
 */
export function authorOfTurn(store:Store,threadId:string,turnId:string|undefined,ownerChatOwner?:number) {
  const route=turnId ? new ReplyRoutes(store).destination(threadId,turnId) : undefined;
  if (route?.kind!=="telegram") return undefined;
  // The author of the very message that started this turn — a later message joining it (the owner writing while a
  // guest's turn runs) never lends its author to the turn (0.9.77 review).
  const updateId=(route as {updateId?:number}).updateId;
  const author=(updateId!==undefined ? store.get<number>(turnAuthorKey(threadId,updateId)) : undefined) ?? ownerChatOwner;
  // Someone else's message joined this turn: the turn's rights are the least trusted of those in it (С112).
  const joined=store.get<number>(turnMixedKey(threadId,turnId!));
  return joined!==undefined && joined!==author ? joined : author;
}
export const turnMixedKey=(threadId:string,turnId:string)=>`group:turn-mixed:${threadId}:${turnId}`;
export const turnAuthorKey=(threadId:string,updateId:number)=>`group:turn-author:${threadId}:${updateId}`;

/**
 * С105: the chat a bot's own message is edited or removed in. The owner's conversation may name any chat (--chat);
 * a group's or a person's conversation acts only in its own chat, as before.
 */
export function ownMessageChat(caller:Conversation|undefined,owner:number,named:number|undefined):number|undefined {
  if (!caller) return undefined;
  if (caller.kind==="owner") return named ?? owner;
  const own=caller.kind==="group" ? caller.chat : caller.subject;
  return named===undefined || named===own ? own : undefined;
}

/**
 * Whether the current turn was started by a person's own Telegram message (not the bridge's turn: the owner's answer
 * to a question, a deferred task, the bot added). Valis 25.11: writing to another group needs the owner's own message
 * in this place; his answer to a narrow question stays an answer to it.
 */
export function turnStartedByMessage(store:Store,threadId:string,turnId:string|undefined) {
  const route=turnId ? new ReplyRoutes(store).destination(threadId,turnId) : undefined;
  return route?.kind==="telegram" && Number((route as {updateId?:number}).updateId)>0;
}
