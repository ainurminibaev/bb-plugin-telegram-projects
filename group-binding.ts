import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {GroupTopicPolicy} from "./ingress";
import type {Store,Telegram} from "./model";

export const sharedGroupScopeKey=(chat:number,topic:number)=>`group:shared-scope:${chat}:${topic}`;
export const sharedGroupThreadKey=(threadId:string)=>"group:shared-thread:"+threadId;

export function groupThreadMatches(store:Store,policy:GroupTopicPolicy,projectId:string) {
  const scope=`group:policy:${policy.chatId}:${policy.topicId}`;
  if (store.get("group:thread:"+policy.threadId)!==scope) return false;
  if (policy.privateChat) return !!policy.projectId && policy.projectId===projectId;
  if (policy.ownerSharedProject)
    return policy.projectId===projectId && store.get(sharedGroupThreadKey(policy.threadId))===true;
  return store.get("group:project:"+projectId)===true &&
    (policy.projectId ? policy.projectId===projectId : store.list("group:project:").length===1);
}

export async function sharedGroupThreads(store:Store,threads:BbPluginApi["sdk"]["threads"],
  ids:string[],signal?:AbortSignal) {
  const guarded=new Set(ids.filter(id=>store.get("group:thread:"+id)));
  const remaining=ids.filter(id=>!guarded.has(id));
  if (remaining.length && store.list("group:shared-thread:").length) {
    const rows=await threads.experimental_listAncestors({threadIds:remaining,signal});
    const ancestry=new Map(rows.threads.map(row=>[row.threadId,row.ancestorIds]));
    for (const id of remaining) {
      const parents=ancestry.get(id);
      if (!parents || parents.some(parent=>store.get(sharedGroupThreadKey(parent)))) guarded.add(id);
    }
  }
  return guarded;
}

export function isSharedOwnerPolicy(policy:GroupTopicPolicy) {
  return policy.ownerSharedProject===true && policy.ownerOnly && !!policy.ownerId &&
    policy.topicId>1 && /^-100[1-9]\d*$/.test(String(policy.chatId)) &&
    !policy.isolated && !policy.allowedSenderIds?.length && !policy.deliverySources?.length &&
    (!policy.searchableHistory || policy.includeTopicContext===true) &&
    (!policy.retainFullHistory || policy.searchableHistory===true);
}

type Forum = {id:number;type:string;is_forum?:boolean;username?:string;active_usernames?:string[];linked_chat_id?:number};
type Membership = {user?:{id:number;is_bot?:boolean};status:string};

export async function sharedOwnerForum(tg:Telegram,chatId:number,owner:number,bot:number) {
  const args={chat_id:chatId};
  const chat=await tg<Forum>("getChat",args);
  if (chat.id!==chatId || chat.type!=="supergroup" || chat.is_forum!==true ||
      chat.username || chat.active_usernames?.length || chat.linked_chat_id) return false;
  const [ownerMember,botMember,count]=await Promise.all([
    tg<Membership>("getChatMember",{...args,user_id:owner}),
    tg<Membership>("getChatMember",{...args,user_id:bot}),
    tg<number>("getChatMemberCount",args),
  ]);
  return ownerMember.user?.id===owner && ownerMember.status==="creator" &&
    botMember.user?.id===bot && botMember.user.is_bot===true &&
    ["administrator","member"].includes(botMember.status) && count===2;
}
