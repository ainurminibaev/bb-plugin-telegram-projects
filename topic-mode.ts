// Agents in shared chats (agents-in-chats.md): in a topic an agent either leads it (hears what people write there
// without a mention) or is called by a mention. One agent in a chat leads every topic, as before; once another agent
// of the organization shows up in the chat, the owner's message without a mention goes only to the topic's leader.
import type {Store} from "./model";
import {directNameAddress,type GroupTopicPolicy} from "./ingress";

export type TopicMode="lead"|"mention";
export type TopicModeRecord={mode:TopicMode;by:number;at:number};

export const topicModeKey=(bot:number,chat:number,topic:number)=>`topic:mode:${bot}:${chat}:${topic}`;
export const chatAgentsKey=(bot:number,chat:number)=>`chat:agents:${bot}:${chat}`;
/** The agent's mode for the whole chat: the chat's leader leads every topic without a leader of its own, new ones too. */
export const chatModeKey=(bot:number,chat:number)=>`chat:mode:${bot}:${chat}`;

/**
 * The chat's default leader is the agent that was in the chat before the other agents of the organization: when the
 * first colleague shows up, an agent that already talks in this chat (has a bound topic) records itself as its leader.
 * For people nothing changes; the newcomer waits for mentions. The owner may name another leader (topic-mode --chat).
 */
export const agentsSinceKey=(bot:number,chat:number)=>`chat:agents-since:${bot}:${chat}`;
export const boundSinceKey=(bot:number,chat:number)=>`chat:bound-since:${bot}:${chat}`;
export const announceKey=(bot:number,chat:number)=>`chat:announce:${bot}:${chat}`;
const SETTLED=3600_000;
const MIGRATED="topic-mode:migrated";

/**
 * Once, when this version first starts (server start, before any message — a fresh installation has no bindings yet): a chat this agent already talks in counts as bound "before" (0), and a colleague
 * the previous version already knew counts as known "before" (0). Without it an update would make every agent a
 * newcomer in its own chats.
 */
export function migrateTopicModes(store:Store,bot:number) {
  if (store.get(MIGRATED)) return;
  for (const {value:p} of store.list<GroupTopicPolicy>("group:policy:"))
    if (p?.botId===bot && p.chatId<0 && !p.privateChat && store.get(boundSinceKey(bot,p.chatId))===undefined)
      store.put(boundSinceKey(bot,p.chatId),0);
  for (const {key} of store.list<number[]>(`chat:agents:${bot}:`)) {
    const chat=Number(key.split(":").at(-1));
    if (Number.isSafeInteger(chat) && store.get(agentsSinceKey(bot,chat))===undefined) store.put(agentsSinceKey(bot,chat),0);
  }
  store.put(MIGRATED,Date.now());
}

/** Every accepted message: since when this agent talks in the chat, and — while no one leads it — a new try to lead it. */
export function noteOwnActivity(store:Store,bot:number,chat:number,organization:number[],now=Date.now()) {
  if (chat>=0) return;
  // Called for a message accepted by this agent's binding here: it talks in this chat (no scan on the message path).
  if (store.get(boundSinceKey(bot,chat))===undefined) store.put(boundSinceKey(bot,chat),now);
  claimChatLead(store,bot,chat,organization,now);
}

/**
 * The chat's default leader is the agent that talked here before the colleague came: its binding (0 — before this
 * version) is older than the colleague's arrival by a settled margin. A newcomer, even one bound a moment before it
 * learned about the colleague, never claims. A claim is announced in the chat, so a colleague that also claimed it
 * (both were here before this version) can step back by the earlier claim.
 */
export function claimChatLead(store:Store,bot:number,chat:number,organization:number[]=[],now=Date.now()) {
  if (store.get(chatModeKey(bot,chat))) return false;
  const known=store.get<number[]>(chatAgentsKey(bot,chat)) ?? [];
  if (!known.some(id=>id!==bot && (!organization.length || organization.includes(id)))) return false;
  const since=store.get<number>(agentsSinceKey(bot,chat));
  const bound=store.get<number>(boundSinceKey(bot,chat));
  if (since===undefined || bound===undefined) return false;
  if (bound!==0 && !(since>0 && bound+SETTLED<=since)) return false;
  store.put(chatModeKey(bot,chat),{mode:"lead",by:0,at:now} satisfies TopicModeRecord);
  store.put(announceKey(bot,chat),now);
  return true;
}

export function leadsChat(store:Store,bot:number,chat:number) {
  return store.get<TopicModeRecord>(chatModeKey(bot,chat))?.mode==="lead";
}
/** Curators of this agent (people who may assign it to lead a topic): from the employee's passport, set by setup. */
export const curatorsKey="rights:curators";

/** Remembers an agent bot of the organization seen in a group chat (its message or its joining). */
export const agentNameKey=(id:number)=>`chat:agent-name:${id}`;
export function noteAgentInChat(store:Store,bot:number,chat:number,sender:number,organization:number[],name?:string) {
  if (!Number.isSafeInteger(sender) || sender===bot || !organization.includes(sender) || chat>=0) return false;
  const clean=String(name ?? "").replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,64);
  if (clean && store.get<string>(agentNameKey(sender))!==clean) store.put(agentNameKey(sender),clean);
  const known=store.get<number[]>(chatAgentsKey(bot,chat)) ?? [];
  if (known.includes(sender)) return false;
  if (store.get(agentsSinceKey(bot,chat))===undefined) store.put(agentsSinceKey(bot,chat),Date.now());
  store.put(chatAgentsKey(bot,chat),[...known,sender].sort((a,b)=>a-b));
  claimChatLead(store,bot,chat,organization);
  return true;
}

export function otherAgentsInChat(store:Store,bot:number,chat:number,organization:number[]) {
  return (store.get<number[]>(chatAgentsKey(bot,chat)) ?? []).filter(id=>id!==bot && organization.includes(id));
}

/** The mode of this agent in a topic: an explicit choice, or by default — leads when it is the only agent here. */
export function topicMode(store:Store,bot:number,chat:number,topic:number,organization:number[]) {
  const record=store.get<TopicModeRecord>(topicModeKey(bot,chat,topic));
  if (record?.mode==="lead" || record?.mode==="mention") return {mode:record.mode,explicit:true,record};
  // No leader of its own: the chat's leader leads the topic (owner without a mention, new topics), others by mention.
  const chatRecord=store.get<TopicModeRecord>(chatModeKey(bot,chat));
  if (chatRecord?.mode==="lead" || chatRecord?.mode==="mention") return {mode:chatRecord.mode,explicit:false,chat:true};
  const alone=otherAgentsInChat(store,bot,chat,organization).length===0;
  return {mode:(alone ? "lead" : "mention") as TopicMode,explicit:false};
}

export const curators=(store:Store)=>store.get<number[]>(curatorsKey) ?? [];
/** Who may make the agent lead a topic or let it go: the owner and the agent's curators. */
export function canAssignLead(store:Store,owner:number,sender:number) {
  return Number.isSafeInteger(sender) && sender>0 && (sender===owner || curators(store).includes(sender));
}

/** The line people see when the mode changes; colleagues' bridges read it too (noteColleagueLead). */
export const DEFAULT_LEAD_LINE="Веду этот чат как агент, который был здесь первым: владельцу отвечаю без отметки. Позвать коллегу — отметьте его.";
export function modeLine(mode:TopicMode,chat=false) {
  if (chat) return mode==="lead" ? "Веду этот чат: отвечаю здесь без отметки. Позвать коллегу — отметьте его."
    : "Больше не веду этот чат, зовите отметкой.";
  return mode==="lead" ? "Веду эту тему. Позвать коллегу — отметьте его."
    : "Вышел из темы, зовите отметкой.";
}

/**
 * One leader per topic and per chat: when a colleague of the organization announces that it now leads this topic
 * or chat (its bridge posts modeLine), this agent steps back to mentions there.
 */
export function noteColleagueLead(store:Store,bot:number,chat:number,topic:number,sender:number,text:string,organization:number[],
  sentAt?:number) {
  if (sender===bot || !organization.includes(sender) || typeof text!=="string") return false;
  const body=text.trim();
  if (body.startsWith(DEFAULT_LEAD_LINE.slice(0,40))) {
    // Both claimed by default (both were here before this version): the earlier claim leads; a tie — the smaller id.
    const mine=store.get<TopicModeRecord>(chatModeKey(bot,chat));
    if (mine?.mode!=="lead") return true;
    if (mine.by!==0) return true;   // named by the owner or a curator: it stays
    const theirs=(sentAt ?? Date.now()/1000)*1000;
    if (theirs<mine.at-1000 || (Math.abs(theirs-mine.at)<=1000 && sender<bot))
      store.put(chatModeKey(bot,chat),{mode:"mention",by:sender,at:Date.now()} satisfies TopicModeRecord);
    return true;
  }
  if (body.startsWith(modeLine("lead",true))) {
    if (store.get<TopicModeRecord>(chatModeKey(bot,chat))?.mode!=="mention")
      store.put(chatModeKey(bot,chat),{mode:"mention",by:sender,at:Date.now()} satisfies TopicModeRecord);
    return true;
  }
  if (body.startsWith(modeLine("lead"))) {
    if (store.get<TopicModeRecord>(topicModeKey(bot,chat,topic))?.mode!=="mention")
      store.put(topicModeKey(bot,chat,topic),{mode:"mention",by:sender,at:Date.now()} satisfies TopicModeRecord);
    return true;
  }
  return false;
}

/** The chat-level choice (topic-mode --chat): returns false when nothing changed. */
export function setChatMode(store:Store,bot:number,chat:number,mode:TopicMode,by:number) {
  if (store.get<TopicModeRecord>(chatModeKey(bot,chat))?.mode===mode) return false;
  store.put(chatModeKey(bot,chat),{mode,by,at:Date.now()} satisfies TopicModeRecord);
  return true;
}

/** Sets the mode; the record keeps who asked and when. Returns false when nothing changed. */
export function setTopicMode(store:Store,bot:number,chat:number,topic:number,mode:TopicMode,by:number,organization:number[]) {
  const now=topicMode(store,bot,chat,topic,organization);
  if (now.explicit && now.mode===mode) return false;
  store.put(topicModeKey(bot,chat,topic),{mode,by,at:Date.now()} satisfies TopicModeRecord);
  return true;
}

/** The policy of one message with the agent's mode in this topic (used by routeUpdate). */
export function withTopicMode(store:Store,policy:GroupTopicPolicy,organization:number[]):GroupTopicPolicy {
  if (policy.privateChat || policy.ownerTopic || policy.ownerSharedProject || policy.isolated) return policy;
  const m=topicMode(store,policy.botId,policy.chatId,policy.topicId,organization);
  return {...policy,leadMode:m.mode,leadExplicit:m.explicit};
}

/** The turn's note on the topic (item 7) and, for a colleague called once, on leaving after the answer (item 5). */
export function topicNote(store:Store,policy:GroupTopicPolicy,organization:number[],names:(id:number)=>string|undefined,
  calledByColleague:boolean) {
  if (policy.privateChat) return "";
  const m=topicMode(store,policy.botId,policy.chatId,policy.topicId,organization);
  const others=otherAgentsInChat(store,policy.botId,policy.chatId,organization);
  if (!others.length && !m.explicit) return "";
  const who=others.map(id=>names(id) ?? "агент "+id).join(", ");
  const lines=[m.mode==="lead"
    ? (m.explicit
      ? "Ты ведёшь эту тему: неадресованные сообщения людей здесь — тебе; если вопрос не твой, позови коллегу отметкой."
      : "Ты ведёшь этот чат: сообщение владельца без отметки — тебе, люди зовут отметкой; если вопрос не твой, позови коллегу отметкой.")
    : "Ты в этой теме по отметке: отвечаешь, только когда к тебе обратились; тему ведёт не ты."];
  if (others.length) lines.push("Другие агенты организации в этом чате: "+who+". Обращённое к ним — не тебе.");
  if (calledByColleague || m.mode==="mention")
    lines.push("Тебя позвали разово: ответь по делу один раз и не продолжай без новой отметки.");
  return lines.join(" ");
}

/** A message plainly addressed to this agent: its @name, a mention of it, a reply to it, or its name at the start. */
export function addressedToAgent(message:any,bot:number,username:string|undefined,addressName?:string) {
  if (!message) return false;
  const text=String(message.text ?? message.caption ?? "");
  const entities:any[]=message.entities ?? message.caption_entities ?? [];
  const handle=username ? "@"+username.toLowerCase() : "";
  const reply=message.reply_to_message;
  // In a forum every message of a topic replies to its creation message: a topic this bot made is not a call to it.
  const toRoot=!!reply && (reply.forum_topic_created || reply.message_id===message.message_thread_id);
  return (reply?.from?.id===bot && !toRoot) ||
    entities.some(e=>(e.type==="mention" && !!handle && text.slice(e.offset,e.offset+e.length).toLowerCase()===handle) ||
      (e.type==="text_mention" && e.user?.id===bot)) ||
    (!!addressName && !!directNameAddress(text,addressName));
}

export const chatAgentsCheckedKey=(bot:number,chat:number)=>`chat:agents-checked:${bot}:${chat}`;
const DAY=24*3600_000;
const PRESENT=new Set(["creator","administrator","member"]);

/** A bot of the organization joined or left this chat (service message): the list follows at once. */
export function noteAgentsLeaving(store:Store,bot:number,chat:number,message:any,organization:number[]) {
  const left=message?.left_chat_member;
  if (!left?.is_bot || !organization.includes(left.id) || chat>=0) return false;
  const known=store.get<number[]>(chatAgentsKey(bot,chat)) ?? [];
  if (!known.includes(left.id)) return false;
  store.put(chatAgentsKey(bot,chat),known.filter(id=>id!==left.id));
  return true;
}

/**
 * Which bots of the organization are in this chat, asked of Telegram once a day per chat: a colleague that never
 * wrote still counts as present. One getChatMember per bot of the organization; a failed answer keeps what was known.
 */
export async function refreshChatAgents(store:Store,bot:number,chat:number,organization:number[],
  ask:(user:number)=>Promise<{status?:string;is_member?:boolean}|undefined>,now=Date.now()) {
  const others=organization.filter(id=>id!==bot);
  if (chat>=0 || !others.length) return false;
  const checked=store.get<number>(chatAgentsCheckedKey(bot,chat));
  if (checked!==undefined && now-checked<DAY) return false;
  store.put(chatAgentsCheckedKey(bot,chat),now);
  const known=new Set(store.get<number[]>(chatAgentsKey(bot,chat)) ?? []);
  for (const id of others) {
    const member=await ask(id).catch(()=>undefined);
    if (!member?.status) continue;
    if (PRESENT.has(member.status) || (member.status==="restricted" && member.is_member===true)) known.add(id);
    else known.delete(id);
  }
  store.put(chatAgentsKey(bot,chat),[...known].sort((a,b)=>a-b));
  if ([...known].some(id=>id!==bot && organization.includes(id))) {
    if (store.get(agentsSinceKey(bot,chat))===undefined) store.put(agentsSinceKey(bot,chat),now);
    claimChatLead(store,bot,chat,organization,now);
  }
  return true;
}
