import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import {isTopicPaused} from "./topic-lifecycle";
import {groupThreadMatches} from "./group-binding";

export type ForumDefaults={sourceTopicId:number;managers:number[];closeManagers?:number[];deleteManagers?:number[];since:number};
export const forumDefaultsKey=(bot:number,chat:number)=>`group:forum-defaults:${bot}:${chat}`;
export const forumOptOutKey=(bot:number,chat:number,topic:number)=>`group:forum-opt-out:${bot}:${chat}:${topic}`;
export const forumNameKey=(bot:number,chat:number,topic:number)=>`group:topic-name:${bot}:${chat}:${topic}`;
type TopicMetadata={name:string;updateId:number;created?:true;creationDate?:number};

/** С54: a group where new topics are not picked up automatically (turned off for this group only). */
export const forumAutoOffKey=(bot:number,chat:number)=>`group:forum-auto-off:${bot}:${chat}`;
/** С54: the bridge-wide switch; on by default. */
export const forumAutoKey="group:forum-auto";

/** A topic binding that can be a template for new topics: its thread is local (not a separate executor). */
function templateFor(store:Store,bot:number,owner:number,chat:number,source:GroupTopicPolicy|undefined,topicId:number) {
  if (!source || source.chatId!==chat || source.topicId!==topicId || source.botId!==bot || source.ownerId!==owner || !source.projectId ||
      source.privateChat || !groupThreadMatches(store,source,source.projectId)) return;
  if (source.isolated && !source.ownerTopicManagerProjectId) return;
  return source;
}

export function forumDefaults(store:Store,bot:number,owner:number,chat:number) {
  const configured=store.get<ForumDefaults>(forumDefaultsKey(bot,chat));
  if (configured) {
    const source=templateFor(store,bot,owner,chat,
      store.get<GroupTopicPolicy>(`group:policy:${chat}:${configured.sourceTopicId}`),configured.sourceTopicId);
    if (source) return {source,managers:configured.managers,closeManagers:configured.closeManagers??[],
      deleteManagers:configured.deleteManagers??[],since:configured.since,implicit:false};
  }
  // С54: picking up new topics is the default for every forum group and every agent. Without explicit defaults the
  // template is a topic of this group already bound (the latest one), so groups bound before the update get it too.
  if (store.get(forumAutoKey)===false || store.get(forumAutoOffKey(bot,chat))) return;
  const bound=store.list<GroupTopicPolicy>(`group:policy:${chat}:`)
    .map(({value})=>templateFor(store,bot,owner,chat,value,value.topicId))
    .filter((p):p is GroupTopicPolicy=>!!p)
    .sort((a,b)=>(b.acceptAfterSecond??0)-(a.acceptAfterSecond??0));
  const source=bound.find(p=>p.topicId>=2) ?? bound[0];
  if (source) return {source,managers:[owner],closeManagers:[],deleteManagers:[],since:0,implicit:true};
}

function normalizedTopicName(name:unknown) {
  return typeof name==="string" ? name.replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,128) : "";
}

export function rememberForumName(store:Store,bot:number,chat:number,topic:number,name:unknown,updateId:number,created?:true,creationDate?:number) {
  const clean=normalizedTopicName(name);
  if (!clean) return;
  const key=forumNameKey(bot,chat,topic);
  const prior=store.get<TopicMetadata>(key);
  if (prior && prior.updateId>updateId) return;
  store.put(key,{name:clean,updateId,created:created??prior?.created,creationDate:creationDate??prior?.creationDate} satisfies TopicMetadata);
}

/**
 * Topic names of any group the bot is in, so the agent can address a topic by name. A topic message
 * carries its topic's creation service message as reply_to_message; names come only from service fields.
 */
export function learnTopicName(store:Store,bot:number,update:any) {
  const m=update?.message ?? update?.edited_message;
  const chat=m?.chat?.id,topic=m?.message_thread_id;
  if (m?.chat?.type!=="supergroup" || m.chat.is_forum!==true || !Number.isSafeInteger(chat) ||
      !Number.isSafeInteger(topic) || topic<2 || !Number.isSafeInteger(update.update_id)) return;
  const head=m.reply_to_message?.message_id===topic ? m.reply_to_message : undefined;
  const name=m.forum_topic_edited?.name ?? m.forum_topic_created?.name ?? head?.forum_topic_edited?.name ?? head?.forum_topic_created?.name;
  // A creation message seen only through a reply is older than any rename this bridge recorded.
  const fromHead=!m.forum_topic_edited?.name && !m.forum_topic_created?.name;
  const known=store.get<TopicMetadata>(forumNameKey(bot,chat,topic));
  // A topic made by the bot itself (no update about it) or seen before its creation date was kept: the creation
  // message under every topic message gives the date, so the group's defaults pick the topic up (С54).
  if (fromHead && known && !known.creationDate && head?.forum_topic_created && Number.isSafeInteger(head.date))
    store.put(forumNameKey(bot,chat,topic),{...known,created:true,creationDate:head.date} satisfies TopicMetadata);
  if (fromHead && known) return;
  rememberForumName(store,bot,chat,topic,name,update.update_id,
    head?.forum_topic_created ? true : undefined,head?.forum_topic_created && Number.isSafeInteger(head.date) ? head.date : undefined);
}

export function forumName(store:Store,bot:number,chat:number,topic:number) {
  return store.get<TopicMetadata>(forumNameKey(bot,chat,topic))?.name;
}

export function describeForumTopic(store:Store,bot:number,owner:number,update:any) {
  const message=update.message;
  // General is topic 0: its messages carry no topic (a reply there may carry a thread id that is no topic).
  const chat=message?.chat?.id,topic=message?.is_topic_message===true ? message?.message_thread_id : 0;
  if (message?.chat?.type!=="supergroup" || message.chat.is_forum!==true ||
      !Number.isSafeInteger(chat) || chat>=0 ||
      !Number.isSafeInteger(topic) || (topic<2 && topic!==0) || !Number.isSafeInteger(update.update_id)) return;
  const key=`group:policy:${chat}:${topic}`;
  const policy=store.get<GroupTopicPolicy>(key);
  if ((policy && (policy.botId!==bot || (policy.ownerId!==undefined && policy.ownerId!==owner))) ||
      (!policy && !forumDefaults(store,bot,owner,chat))) return;
  // Telegram service fields are metadata. A caption or participant name never sets the name.
  const creation=message.forum_topic_created;
  const edit=message.forum_topic_edited;
  if (creation || edit)
    rememberForumName(store,bot,chat,topic,edit?.name??creation?.name,update.update_id,
      creation && message.message_id===topic ? true : undefined,
      creation && message.message_id===topic ? message.date : undefined);
  const metadata=store.get<TopicMetadata>(forumNameKey(bot,chat,topic)) ?? (topic===0 ? {name:"General",updateId:0} : undefined);
  return {chat,topic,policy,metadata,service:!!(creation || edit)};
}


export function inheritableForumTopic(store:Store,bot:number,owner:number,topic:ReturnType<typeof describeForumTopic>) {
  if (!topic || topic.policy || (topic.topic<2 && topic.topic!==0) ||
      isTopicPaused(store,bot,topic.chat,topic.topic) || store.get(forumOptOutKey(bot,topic.chat,topic.topic))) return;
  const defaults=forumDefaults(store,bot,owner,topic.chat);
  if (!defaults) return;
  // Explicit defaults keep their boundary (topics created after they were set); the default pickup takes any topic
  // the bridge sees that has no binding and was not unbound on purpose, including one created before the update.
  // General exists from the start: the pickup always covers it.
  if (!defaults.implicit && topic.topic!==0 && (!topic.metadata?.created || !topic.metadata.creationDate || topic.metadata.creationDate<defaults.since)) return;
  return {source:defaults.source,metadata:topic.metadata ?? {name:"Тема",updateId:0}};
}


export function inheritedForumPolicy(source:GroupTopicPolicy,topicId:number,
  destination:{threadId:string;projectId:string},revision:string):GroupTopicPolicy {
  return {...source,...destination,topicId,revision,deliverySources:undefined};
}


type ForumDeps={owner:number;bot:number;check:(chatId:number)=>Promise<void>;current:()=>boolean};

type ThreadRow={id:string;projectId?:string|null;environmentId?:string|null;providerId?:string|null;title?:string|null;
  archivedAt?:unknown;deletedAt?:unknown;parentThreadId?:string|null};

/**
 * П29: a topic of the assistant's group whose thread was archived does not fall silent: it gets a new thread in the
 * same project and environment with the same settings and acceptance boundary, so the arriving message goes to it.
 */
export async function reviveArchivedForumTopic(store:Store,d:ForumDeps&{signal:AbortSignal;
  threads:{get:(a:{threadId:string;signal?:AbortSignal})=>Promise<ThreadRow>;spawn:(a:any)=>Promise<ThreadRow>};
  bind:(policy:GroupTopicPolicy,projectId:string)=>void},
  topic:{chat:number;topic:number;policy?:GroupTopicPolicy;metadata?:{name:string}}) {
  const policy=topic.policy;
  if (!policy?.ownerSharedProject || policy.ownerId!==d.owner || policy.botId!==d.bot || !policy.projectId ||
      isTopicPaused(store,d.bot,topic.chat,topic.topic)) return false;
  const old=await d.threads.get({threadId:policy.threadId,signal:d.signal}).catch(()=>undefined);
  if (!old || !old.archivedAt || old.deletedAt || !old.environmentId || old.projectId!==policy.projectId || old.parentThreadId)
    return false;
  const journal=`group:forum-revive:${d.bot}:${topic.chat}:${topic.topic}`;
  if (store.get(journal)) return false;
  await d.check(topic.chat);
  store.put(journal,"spawning");
  try {
    const child=await d.threads.spawn({projectId:old.projectId,visibility:"visible",
      title:topic.metadata?.name ?? old.title ?? "Тема",permissionMode:"accept-edits",
      environment:{type:"reuse",environmentId:old.environmentId},
      ...(old.providerId && {providerId:old.providerId}),
      input:[{type:"text",visibility:"agent-only",mentions:[],
        text:"Initialize an empty Telegram topic conversation. Wait for a Telegram request and reply NO_REPLY."}]});
    if (child.projectId!==policy.projectId || child.id===policy.threadId) throw Error("forum_topic_thread_unconfirmed");
    const live=store.get<GroupTopicPolicy>(`group:policy:${topic.chat}:${topic.topic}`);
    if (live?.revision!==policy.revision || !d.current()) return false;
    d.bind({...policy,threadId:child.id,revision:crypto.randomUUID()},policy.projectId);
    return true;
  } finally { store.del(journal); }
}
