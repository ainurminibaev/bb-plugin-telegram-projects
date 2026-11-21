import type {Store} from "./model";

export type TopicState="working"|"open"|"closed"|"deleted"|"uncertain";
export const topicStateKey=(bot:number,chatId:number,topicId:number)=>`group:topic-state:${bot}:${chatId}:${topicId}`;
export function isTopicPaused(store:Store,bot:number,chatId:number,topicId:number) {
  const state=store.get<TopicState>(topicStateKey(bot,chatId,topicId));
  return state!==undefined && state!=="open";
}
const activeTopicSends = new WeakMap<Store,Map<string,number>>();

export function beginTopicSend(store:Store,bot:number,chatId:number,topicId:number) {
  if (isTopicPaused(store,bot,chatId,topicId)) throw Error("forum_topic_unavailable");
  const key = topicStateKey(bot,chatId,topicId);
  let sends = activeTopicSends.get(store);
  if (!sends) {
    sends = new Map();
    activeTopicSends.set(store,sends);
  }
  sends.set(key,(sends.get(key) ?? 0)+1);
  return () => {
    const count = sends.get(key)!;
    if (count===1) sends.delete(key);
    else sends.set(key,count-1);
  };
}

export function topicHasWork(store:Store,bot:number,chatId:number,topicId:number) {
  const matches=(row?:{bot?:number;chatId:number;topicId:number})=>
    row?.chatId===chatId && row.topicId===topicId && (row.bot===undefined || row.bot===bot);
  return activeTopicSends.get(store)?.has(topicStateKey(bot,chatId,topicId)) === true ||
    store.list<{route:{chatId:number;topicId:number}}>(`group:in:${bot}:`).some(({value})=>matches(value.route)) ||
    ["group:result-queue:","group:reminder-queue:"].some(prefix=>store.list(prefix).some(({key})=>
      matches(store.get("group:origin:"+key.slice(prefix.length)))));
}


export function assertTopicQueueWritable(store:Store,{bot,chatId,topicId}:{bot:number;chatId:number;topicId:number}) {
  const state=store.get<TopicState>(topicStateKey(bot,chatId,topicId));
  if (state==="working" || state==="uncertain" || state==="deleted") throw Error("forum_topic_unavailable");
}
