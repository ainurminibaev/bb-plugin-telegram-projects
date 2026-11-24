// Agents in shared chats (agents-in-chats.md): the chat's default leader is set, not guessed. An employee whose
// passport says «leads shared chats by default» (setting leadsChatsByDefault: yes / no / auto) leads every topic that
// has no leader of its own; one that does not answers by a mention. auto (no word from the passport yet): yes while
// the organization has no other bots in this bridge's list — one agent, as before — and no once it has, so two agents
// without the passport's word never both answer the owner. A topic's own leader, or another chat
// leader, is named only by the owner or a curator (topic-mode), with a line in the chat the colleagues' bridges read.
import type {Store} from "./model";
import {directNameAddress,type GroupTopicPolicy} from "./ingress";

export type TopicMode="lead"|"mention";
export type TopicModeRecord={mode:TopicMode;by:number;at:number};

export const topicModeKey=(bot:number,chat:number,topic:number)=>`topic:mode:${bot}:${chat}:${topic}`;
export const chatAgentsKey=(bot:number,chat:number)=>`chat:agents:${bot}:${chat}`;
/** The agent's mode for the whole chat: the chat's leader leads every topic without a leader of its own, new ones too. */
export const chatModeKey=(bot:number,chat:number)=>`chat:mode:${bot}:${chat}`;

/** The installer's word from the passport: "yes", "no" or "auto" (none yet). */
export const leadsByDefaultKey="rights:leads-chats-default";
export function leadsByDefault(store:Store,bot:number) {
  const word=store.get<unknown>(leadsByDefaultKey);
  if (word==="yes" || word===true) return true;
  if (word==="no" || word===false) return false;
  const organization=store.get<number[]>("rights:agent-bots") ?? [];
  return !organization.some(id=>id!==bot);
}

/** Whether this agent leads the chat: a choice made for this chat, else the passport's default. */
export function leadsChat(store:Store,bot:number,chat:number) {
  const record=store.get<TopicModeRecord>(chatModeKey(bot,chat));
  return record ? record.mode==="lead" : leadsByDefault(store,bot);
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
  store.put(chatAgentsKey(bot,chat),[...known,sender].sort((a,b)=>a-b));
  return true;
}

export function otherAgentsInChat(store:Store,bot:number,chat:number,organization:number[]) {
  return (store.get<number[]>(chatAgentsKey(bot,chat)) ?? []).filter(id=>id!==bot && organization.includes(id));
}

/** The mode of this agent in a topic: its own leader named for the topic, else whether it leads the chat. */
export function topicMode(store:Store,bot:number,chat:number,topic:number,_organization:number[]=[]) {
  const record=store.get<TopicModeRecord>(topicModeKey(bot,chat,topic));
  if (record?.mode==="lead" || record?.mode==="mention") return {mode:record.mode,explicit:true,record};
  return {mode:(leadsChat(store,bot,chat) ? "lead" : "mention") as TopicMode,explicit:false};
}

export const curators=(store:Store)=>store.get<number[]>(curatorsKey) ?? [];
/** Who may make the agent lead a topic or let it go: the owner and the agent's curators. */
export function canAssignLead(store:Store,owner:number,sender:number) {
  return Number.isSafeInteger(sender) && sender>0 && (sender===owner || curators(store).includes(sender));
}

/** The line people see when the mode changes; colleagues' bridges read it too (noteColleagueLead). */
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
  _sentAt?:number) {
  if (sender===bot || !organization.includes(sender) || typeof text!=="string") return false;
  const body=text.trim();
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
  if (!others.length && !m.explicit && m.mode==="lead") return "";   // one agent leading as before: no new lines
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
  return true;
}

/**
 * Another leader takes over only where the former one sees the line: the organization's bots see each other (С74 — the
 * list of the organization's bots in the bridge settings). Without it naming a leader is refused in words.
 */
export function leadRefusal(organization:number[]) {
  return organization.length ? undefined
    : "Сначала включите общение агентов в этом чате (С74: боты организации в настройке моста agentBots) — иначе прежний ведущий не узнает о смене. Скажи это человеку словами.";
}

/** Told once to the owner when two agents have no word from the passport: nobody leads shared chats by default. */
export const noLeaderToldKey="rights:no-leader-told";
export const NO_LEADER_LINE="В общих чатах никто из агентов не ведёт по умолчанию: задайте в паспорте сотрудника «ведёт общие чаты» или назначьте командой («веди этот чат»). До этого на ваши сообщения без отметки агенты не отвечают — отмечайте нужного.";
/** The honest answer of naming a leader until a stand confirms that a bot sees a bot's message. */
export const LEAD_NOTE="Назначил. Прежний ведущий уступит, когда его мост увидит строку в чате; если ответят оба — скажите владельцу.";
