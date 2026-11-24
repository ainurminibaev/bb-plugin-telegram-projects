import type {Store} from "./model";
import type {Conversation} from "./archive-access";

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
  if (chat!==own) return "delete_only_in_own_chat: удалять можно только в чате этого разговора; там, где сообщение, удаляет тамошний разговор";
  if (sender===bot) return;
  if (author!==owner)
    return "delete_others_only_by_owner: чужое сообщение удаляется только по слову владельца — спроси его: "+
      "bb telegram-projects send --person owner --ask --text 'Удалить сообщение … в этом чате? Причина: …'; ответ придёт сюда";
  return;
}

export function deleteLog(store:Store,bot:number,entry:{thread:string;chat:number;message:number;own:boolean;author?:number}) {
  store.put(`delete:log:${bot}:${Date.now()}:${entry.chat}:${entry.message}`,{...entry,at:Date.now()});
}
