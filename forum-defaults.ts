import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import {isTopicPaused} from "./topic-lifecycle";
import {groupThreadMatches} from "./group-binding";

export type ForumDefaults={sourceTopicId:number;managers:number[];closeManagers?:number[];deleteManagers?:number[];since:number};
export const forumDefaultsKey=(bot:number,chat:number)=>`group:forum-defaults:${bot}:${chat}`;
export const forumOptOutKey=(bot:number,chat:number,topic:number)=>`group:forum-opt-out:${bot}:${chat}:${topic}`;
export const forumNameKey=(bot:number,chat:number,topic:number)=>`group:topic-name:${bot}:${chat}:${topic}`;
type TopicMetadata={name:string;updateId:number;created?:true;creationDate?:number};

export function forumDefaults(store:Store,bot:number,owner:number,chat:number) {
  const configured=store.get<ForumDefaults>(forumDefaultsKey(bot,chat));
  if (!configured) return;
  const source=store.get<GroupTopicPolicy>(`group:policy:${chat}:${configured.sourceTopicId}`);
  if (!source || source.chatId!==chat || source.topicId!==configured.sourceTopicId || source.botId!==bot || source.ownerId!==owner || !source.projectId ||
      !groupThreadMatches(store,source,source.projectId) ||
      (!source.ownerSharedProject && (!source.isolated || !source.ownerTopicManagerProjectId))) return;
  return {source,managers:configured.managers,closeManagers:configured.closeManagers??[],
    deleteManagers:configured.deleteManagers??[],since:configured.since};
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

export function forumName(store:Store,bot:number,chat:number,topic:number) {
  return store.get<TopicMetadata>(forumNameKey(bot,chat,topic))?.name;
}

export function describeForumTopic(store:Store,bot:number,owner:number,update:any) {
  const message=update.message;
  const chat=message?.chat?.id,topic=message?.message_thread_id;
  if (message?.chat?.type!=="supergroup" || message.chat.is_forum!==true ||
      message.is_topic_message!==true || !Number.isSafeInteger(chat) || chat>=0 ||
      !Number.isSafeInteger(topic) || topic<2 || !Number.isSafeInteger(update.update_id)) return;
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
  const metadata=store.get<TopicMetadata>(forumNameKey(bot,chat,topic));
  return {chat,topic,policy,metadata,service:!!(creation || edit)};
}


export function inheritableForumTopic(store:Store,bot:number,owner:number,topic:ReturnType<typeof describeForumTopic>) {
  if (!topic || topic.policy || !topic.metadata?.created ||
      isTopicPaused(store,bot,topic.chat,topic.topic) || store.get(forumOptOutKey(bot,topic.chat,topic.topic))) return;
  const defaults=forumDefaults(store,bot,owner,topic.chat);
  if (!defaults || !topic.metadata.creationDate || topic.metadata.creationDate<defaults.since) return;
  return {source:defaults.source,metadata:topic.metadata};
}


export function inheritedForumPolicy(source:GroupTopicPolicy,topicId:number,
  destination:{threadId:string;projectId:string},revision:string):GroupTopicPolicy {
  return {...source,...destination,topicId,revision,deliverySources:undefined};
}
