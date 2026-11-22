import {randomUUID} from "node:crypto";
import type {Store} from "./model";
import type {Conversation} from "./archive-access";
import {accessList,hasAccess} from "./rights";
import {forumName} from "./forum-defaults";
import {privatePolicyKey} from "./employee-private";

// The agent's ordinary send: a topic of any group the bot is in, or the private chat of a person
// with access. No confirmation card: sending is a normal step of the agent's work.
// Who may send where follows the calling conversation:
// - the owner's conversation: any group and topic, any person with access;
// - a group: its own topics, and people with access who write in this group;
// - a person's private chat: only itself;
// - any conversation: back to the conversation whose open question it is answering.
// A question sent for another conversation is remembered, so the answer can go back there.

export type SendTarget={chat:number;topic:number};
export type Ask={id:string;target:number;origin:SendTarget;question:string;at:number};
const ASK_DAYS=7;
const askPrefix=(bot:number)=>`send:ask:${bot}:`;

export function openAsks(store:Store,bot:number,target:number,now=Date.now()) {
  return store.list<Ask>(askPrefix(bot)).map(r=>r.value).filter(a=>a.target===target && now-a.at<ASK_DAYS*86400_000);
}

/** A person, by Telegram ID or part of a name, among people with access. */
export function findPerson(store:Store,bot:number,who:string) {
  if (/^\d+$/.test(who.trim())) return Number(who.trim());
  const q=who.trim().toLowerCase();
  const hits=accessList(store,bot).filter(p=>p.name.toLowerCase().includes(q));
  if (hits.length===1) return hits[0].id;
  throw Error(hits.length ? "person_ambiguous: "+hits.map(p=>p.name).join(", ") : "person_unknown");
}

/** A group the bot is in, by chat ID or part of its title. */
export function findGroup(store:Store,bot:number,what:string) {
  if (/^-\d+$/.test(what.trim())) return Number(what.trim());
  const q=what.trim().toLowerCase();
  const hits=store.list<{chat:number;title?:string}>(`visibility:${bot}:group:`).map(r=>r.value)
    .filter(g=>String(g.title??"").toLowerCase().includes(q));
  if (hits.length===1) return hits[0].chat;
  throw Error(hits.length ? "group_ambiguous: "+hits.map(g=>g.title).join(", ") : "group_unknown");
}

/** A topic by ID or part of its name, among the topics the bridge knows in that group. */
export function findTopic(store:Store,bot:number,chat:number,what:string) {
  if (/^\d+$/.test(what.trim())) return Number(what.trim());
  const q=what.trim().toLowerCase();
  const topics=new Set(store.list<{chatId:number;topicId:number}>(`group:policy:${chat}:`).map(r=>r.value.topicId));
  const hits=[...topics].filter(t=>String(forumName(store,bot,chat,t)??"").toLowerCase().includes(q));
  if (hits.length===1) return hits[0];
  throw Error(hits.length ? "topic_ambiguous" : "topic_unknown");
}

const reachable=(store:Store,bot:number,owner:number,person:number)=>
  hasAccess(store,bot,owner,person) && !!store.get(privatePolicyKey(person));

/** Undefined when allowed, otherwise the reason. */
export function sendRefusal(store:Store,bot:number,owner:number,caller:Conversation|undefined,target:SendTarget,
  groupsOf:(person:number)=>number[],askId?:string):string|undefined {
  if (!caller) return "send_only_from_a_telegram_conversation";
  if (askId) {
    const ask=store.get<Ask>(askPrefix(bot)+askId);
    const own=caller.kind==="person" ? caller.subject : caller.kind==="group" ? caller.chat : owner;
    if (!ask || ask.target!==own || ask.origin.chat!==target.chat || ask.origin.topic!==target.topic) return "no_open_question_for_this_answer";
    return;
  }
  if (target.chat<0) {
    if (!store.get(`visibility:${bot}:group:${target.chat}`)) return "bot_is_not_in_this_group";
    if (caller.kind==="owner") return;
    if (caller.kind==="group" && caller.chat===target.chat) return;
    return "group_not_allowed_from_this_conversation";
  }
  if (target.chat===owner) return caller.kind==="owner" ? undefined : "owner_only_through_an_open_question";
  if (!reachable(store,bot,owner,target.chat))
    return "person_has_not_started_the_bot: mention them in a group instead and tell who asked why";
  if (caller.kind==="owner") return;
  if (caller.kind==="group" && groupsOf(target.chat).includes(caller.chat)) return;
  if (caller.kind==="person" && caller.subject===target.chat) return;
  return "person_not_allowed_from_this_conversation";
}

export function rememberAsk(store:Store,bot:number,target:number,origin:SendTarget,question:string) {
  const ask:Ask={id:randomUUID().slice(0,8),target,origin,question:question.slice(0,500),at:Date.now()};
  store.put(askPrefix(bot)+ask.id,ask);
  return ask;
}

export function closeAsk(store:Store,bot:number,id:string) { store.del(askPrefix(bot)+id); }

/** One line per open question for this conversation's turn notes. */
export function askNotes(store:Store,bot:number,target:number) {
  return openAsks(store,bot,target).map(a=>
    `Открытый вопрос по просьбе другого разговора: «${a.question}». Когда получишь ответ, передай его туда: `+
    `bb telegram-projects send --answer ${a.id} --text "…"`).join("\n");
}
