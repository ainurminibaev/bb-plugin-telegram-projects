import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";

// A basic Telegram group becomes a supergroup with a new chat ID, for example when topics are
// turned on. The bridge moves the group to the new ID: bindings and their threads, group settings
// and the saved conversation. Messages of the former group arrive in the General topic (0).
// Turning topics off and on again keeps a supergroup's ID; nothing moves then.

/** The old and new chat IDs from a Telegram migration service message, if this update is one. */
export function groupMigration(update:any):{from:number;to:number}|undefined {
  const m=update?.message;
  if (Number.isSafeInteger(m?.migrate_to_chat_id) && Number.isSafeInteger(m?.chat?.id))
    return {from:m.chat.id,to:m.migrate_to_chat_id};
  if (Number.isSafeInteger(m?.migrate_from_chat_id) && Number.isSafeInteger(m?.chat?.id))
    return {from:m.migrate_from_chat_id,to:m.chat.id};
}

/** Chat IDs of bound basic groups: candidates for an upgrade check. */
export function basicGroupChats(store:Store) {
  return [...new Set(store.list<GroupTopicPolicy>("group:policy:").map(r=>r.value.chatId)
    .filter(chat=>Number.isSafeInteger(chat) && chat<0 && chat>-1_000_000_000_000))];
}

export function migrateGroupChat(store:Store,bot:number,from:number,to:number) {
  if (from===to || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from>=0 || to>=0) return false;
  let moved=false;
  store.atomic(()=>{
    const rekey=(prefix:string,next:string)=>{
      for (const {key,value} of store.list(prefix)) {
        const target=next+key.slice(prefix.length);
        if (store.get(target)===undefined) store.put(target,value);
        store.del(key);
      }
    };
    for (const {key,value} of store.list<GroupTopicPolicy>(`group:policy:${from}:`)) {
      const target=`group:policy:${to}:${value.topicId}`;
      if (!store.get(target)) {
        store.put(target,{...value,chatId:to});
        if (store.get("group:thread:"+value.threadId)===key) store.put("group:thread:"+value.threadId,target);
        moved=true;
      }
      store.del(key);
    }
    rekey(`group:history:${from}:`,`group:history:${to}:`);
    const context=store.get(`group:context:${from}:0`);
    if (context!==undefined && store.get(`group:context:${to}:0`)===undefined) store.put(`group:context:${to}:0`,context);
    store.del(`group:context:${from}:0`);
    const settings=store.get(`rights:${bot}:group:${from}`);
    if (settings!==undefined && store.get(`rights:${bot}:group:${to}`)===undefined) store.put(`rights:${bot}:group:${to}`,settings);
    // The same people, the same group: never an automatic announcement after a move.
    if (store.get(`rights:${bot}:announced:${to}`)===undefined) store.put(`rights:${bot}:announced:${to}`,"migrated");
    store.put(`group:migrated:${from}`,to);
  });
  return moved;
}
