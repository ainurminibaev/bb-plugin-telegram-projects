import type {Store} from "./model";
import {canInvokeGroup, type GroupTopicPolicy, type Ingress} from "./ingress";
import {syntheticUpdateId} from "./group-result";
import {historyCutoff, historyPrefix, type TopicRecord} from "./topic-search";
import {sourcesVisible} from "./source-access";

type Route = Extract<Ingress,{kind:"group"}>;
type Source = Pick<Route,"chatId"|"topicId"|"messageId">;
type Record = TopicRecord & {permanent?:boolean;directMention?:boolean};
type Selection = {owner:number; row:Record; expires:number; username:string};
const matches = (a:Source,b:Source) => a.chatId===b.chatId && a.topicId===b.topicId && a.messageId===b.messageId;

// Administrative terminal only. The caller supplies a source address, never an author,
// destination thread or prompt. Selection survives the audience change during migration.
export function recoverMention(store:Store, action:"select"|"queue"|"discard", owner:number, bot:number,
  source:Source, executor?:{threadId:string;projectId:string}) {
  const {chatId,topicId,messageId}=source;
  if (![owner,bot,chatId,topicId,messageId].every(Number.isSafeInteger) ||
      owner<=0 || bot<=0 || chatId>=0 || topicId<0 || messageId<=0) throw Error("invalid_source");
  const key=`group:mention-recovery:${bot}:${chatId}:${topicId}:${messageId}`;
  let result="already_handled";
  store.atomic(()=>{
    const selected=store.get<Selection>(key);
    if (action==="discard") {store.del(key); result="discarded";return;}
    const bindingKey=`group:policy:${chatId}:${topicId}`;
    const p=store.get<GroupTopicPolicy>(bindingKey);
    if (!p || p.ownerId!==owner || p.botId!==bot || p.chatId!==chatId || p.topicId!==topicId ||
        !p.revision || !p.projectId || store.get("group:thread:"+p.threadId)!==bindingKey)
      throw Error("current_binding_required");
    const id=`${bot}:${chatId}:${topicId}:${messageId}`;
    if (store.get("group:task-message:"+id) || store.get("group:accepted-message:"+id) ||
        store.get("group:mention-queued:"+id) ||
        store.list<{route:Route}>(`group:in:${bot}:`).some(j=>matches(j.value.route,source)) ||
        store.list<Source & {route?:Route}>(`group:receipt:${bot}:`).some(j=>matches(j.value.route??j.value,source))) return;
    const current=store.get<Record>(historyPrefix(chatId,topicId)+messageId);
    if (action==="select") {
      const trimmed=current?.text.trim()??"";
      const handle="@"+p.botUsername.toLowerCase();
      const legacyAddress=trimmed.toLowerCase().startsWith(handle) &&
        /^\s+\S/u.test(trimmed.slice(handle.length));
      // Older archives contain plain text, not Telegram entity offsets. Only accept
      // an explicit leading address and a body, after an operator reviewed the original.
      if (!p.searchableHistory || !current || current.id!==messageId ||
          !Number.isSafeInteger(current.sender) || current.sender<=0 || current.sender===owner ||
          !Number.isSafeInteger(current.date) || (!current.permanent && current.date<historyCutoff()) ||
          !(current.directMention??legacyAddress)) throw Error("reviewed_direct_mention_required");
      store.put(key,{owner,row:current,username:p.botUsername,expires:Date.now()+86400000});
      result="selected";return;
    }
    if (!selected || selected.owner!==owner || selected.expires<=Date.now() || selected.username!==p.botUsername)
      throw Error("selection_expired_or_missing");
    const row=selected.row;
    if (current && (current.sender!==row.sender || current.text!==row.text || current.date!==row.date || current.directMention===false))
      throw Error("source_changed");
    if (!p.isolated || !executor || executor.threadId!==p.threadId || executor.projectId!==p.projectId ||
        !canInvokeGroup(p,owner,row.sender) || !sourcesVisible(p.deliverySources,bot,chatId,topicId))
      throw Error("permitted_isolated_executor_required");
    const updateId=syntheticUpdateId(store);
    const route:Route={kind:"group",...source,threadId:p.threadId,senderId:row.sender,
      senderName:row.name,text:row.text,updateId};
    store.put(`group:in:${bot}:${updateId}`,{route,revision:p.revision,ownerId:owner,state:"pending"});
    store.put("group:mention-queued:"+id,true);
    store.del(key);
    result="queued";
  });
  return result;
}
