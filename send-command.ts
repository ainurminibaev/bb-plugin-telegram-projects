import {randomUUID} from "node:crypto";
import type {Store} from "./model";
import type {Conversation} from "./archive-access";
import {accessList,hasAccess} from "./rights";
import {forumName} from "./forum-defaults";
import {privatePolicyKey} from "./employee-private";
import {currentGroup} from "./group-migration";

// The agent's ordinary send: a topic of any group the bot is in, or the private chat of a person
// with access. No confirmation card: sending is a normal step of the agent's work.
// Who may send where follows the calling conversation:
// - the owner's conversation: any group and topic, any person with access;
// - a group: its own topics, and people with access who write in this group;
// - a person's private chat: only itself;
// - any conversation: back to the conversation whose open question it is answering.
// A question sent for another conversation is remembered, so the answer can go back there.

export type SendTarget={chat:number;topic:number};
export type Ask={id:string;target:number;origin:SendTarget;question:string;at:number;
  /** The message in the asking conversation the answer goes under (the request this question came from). */
  replyTo?:number;
  /** П28: an ordinary BB thread (not a Telegram conversation) that asked the owner; the answer comes back to it. */
  originThread?:string};
const ASK_DAYS=7;
const askPrefix=(bot:number)=>`send:ask:${bot}:`;

export function openAsks(store:Store,bot:number,target:number,now=Date.now()) {
  return store.list<Ask>(askPrefix(bot)).map(r=>r.value).filter(a=>a.target===target && now-a.at<ASK_DAYS*86400_000);
}

/** A person, by Telegram ID or part of a name, among people with access. */
export function findPerson(store:Store,bot:number,who:string) {
  if (/^\d+$/.test(who.trim())) return Number(who.trim());
  const q=norm(who);
  // Names come in any case form ("Виктору", "Алисе"): a query word matches the stem of a name word.
  const stem=(w:string)=>w.length>4 ? w.slice(0,-2) : w.length>3 ? w.slice(0,-1) : w;
  const words=q.split(" ").filter(w=>w.length>2);
  const hits=accessList(store,bot).filter(p=>norm(p.name).includes(q) ||
    norm(p.name).split(" ").some(w=>w.length>2 && words.some(x=>x.startsWith(stem(w)))));
  if (hits.length===1) return hits[0].id;
  throw Error(hits.length ? "person_ambiguous: "+hits.map(p=>p.name).join(", ") :
    "person_unknown; people with access: "+accessList(store,bot).map(p=>p.name).join(", "));
}

/** A group the bot is in, by chat ID or part of its title. */
export function findGroup(store:Store,bot:number,what:string) {
  if (/^-\d+$/.test(what.trim())) return currentGroup(store,Number(what.trim()));
  const q=norm(what);
  const groups=store.list<{chat:number;title?:string}>(`visibility:${bot}:group:`).map(r=>r.value);
  let hits=groups.filter(g=>norm(String(g.title??"")).includes(q));
  // Not found as a phrase: every word of the name is in the title (an agent may drop or reorder punctuation).
  if (!hits.length && q) hits=groups.filter(g=>{const t=norm(String(g.title??"")).split(" "); return q.split(" ").every(w=>t.includes(w));});
  // A group upgraded to a supergroup is one group under two numbers.
  hits=[...new Map(hits.map(g=>[currentGroup(store,g.chat),g])).entries()].map(([chat,g])=>({...g,chat}));
  if (hits.length===1) return hits[0].chat;
  const known=store.list<{title?:string}>(`visibility:${bot}:group:`).map(r=>r.value.title).join(", ");
  // Same titles are told apart by number: the agent repeats with --chat NUMBER.
  throw Error(hits.length ? "group_ambiguous: "+hits.map(g=>`${g.title} (--chat ${g.chat})`).join(", ") : "group_unknown; known groups: "+known);
}

// Quotes, brackets, dashes and other punctuation do not matter in a name: «Стенд — прогоны (только боты)» = стенд прогоны только боты.
const norm=(v:string)=>v.toLowerCase().replaceAll("ё","е").replace(/[«»"'“”„()\[\]{}<>.,:;!?·•|\/\\_\-–—]+/g," ").replace(/\s+/g," ").trim();
const groupTitle=(store:Store,bot:number,chat:number)=>
  String(store.get<{title?:string}>(`visibility:${bot}:group:${chat}`)?.title ?? chat);

/** Topics the bridge knows in a group: named ones and bound ones. */
export function groupTopics(store:Store,bot:number,chat:number) {
  const ids=new Set<number>([
    ...store.list<{name?:string}>(`group:topic-name:${bot}:${chat}:`).map(r=>Number(r.key.split(":").at(-1))),
    ...store.list<{topicId:number}>(`group:policy:${chat}:`).map(r=>r.value.topicId)]);
  // General (topic 0) of a forum is a target like any topic; in a group without topics 0 is the group itself.
  const forum=[...ids].some(t=>t>1);
  return [...ids].filter(t=>Number.isSafeInteger(t) && (t>0 || (t===0 && forum)))
    .map(t=>({topic:t,name:forumName(store,bot,chat,t) ?? (t<=1 ? "General" : "")}));
}

/** A topic by ID or part of its name, in one group or, without a group, in every group the bot is in. */
export function findTopic(store:Store,bot:number,chat:number|undefined,what:string):SendTarget {
  const groups=chat!==undefined ? [chat] :
    store.list<{chat:number}>(`visibility:${bot}:group:`).map(r=>r.value.chat);
  if (/^\d+$/.test(what.trim())) {
    if (chat===undefined) throw Error("group_required_for_topic_number");
    return {chat,topic:Number(what.trim())};
  }
  const q=norm(what);
  const all=groups.flatMap(g=>groupTopics(store,bot,g).map(t=>({chat:g,...t})));
  const exact=all.filter(t=>norm(t.name)===q);
  const hits=exact.length ? exact : all.filter(t=>t.name && norm(t.name).includes(q));
  if (hits.length===1) return {chat:hits[0].chat,topic:hits[0].topic};
  const list=(hits.length ? hits : all).map(t=>`${groupTitle(store,bot,t.chat)} / ${t.name||t.topic}`).join("; ");
  throw Error((hits.length ? "topic_ambiguous: " : "topic_unknown; known topics: ")+list);
}

// С62: a person with access who started the bot (a conversation, or an approved request) can be written to first.
const reachable=(store:Store,bot:number,owner:number,person:number)=>
  hasAccess(store,bot,owner,person) && (!!store.get(privatePolicyKey(person)) ||
    store.get<{state?:string}>(`employee:private:access:${bot}:${owner}:${person}`)?.state==="approved");

/** Undefined when allowed, otherwise the reason. */
export function sendRefusal(store:Store,bot:number,owner:number,caller:Conversation|undefined,target:SendTarget,
  groupsOf:(person:number)=>number[],askId?:string,author?:number,ask?:boolean,relayTo?:number,ownMessage=true):string|undefined {
  // П28: an ordinary thread of this BB writes to the owner only (a group or a person stays a Telegram conversation's business).
  if (!caller) return target.chat===owner && !askId ? undefined : "send_only_from_a_telegram_conversation: an ordinary thread writes only to the owner (--person owner)";
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
    // С113: on the owner's own request («представься там») a group's conversation (a coordination chat) writes to any
    // group the bot is in — the first message to a new group included.
    if (caller.kind==="group" && author===owner && ownMessage) return;
    // С90: «скажи такому-то» from an approved person's private chat goes to a group where both of them are,
    // with the addressee mentioned and «по просьбе …» (--for PERSON); never to a group without the requester.
    if (caller.kind==="person" && groupsOf(caller.subject).includes(target.chat)) {
      if (relayTo!==undefined && groupsOf(relayTo).includes(target.chat)) return;
      return "relay_needs_addressee_in_this_group: передать можно только в группу, где состоите и вы, и адресат: --for ИМЯ";
    }
    return "group_not_allowed_from_this_conversation: из этого разговора писать в другую группу можно только по просьбе владельца — "+
      "попроси его здесь написать это самому или ответь людям здесь; бот в той группе есть, добавлять его не нужно";
  }
  // Any conversation may ask the owner (С43): a question whose answer comes back here. A group's conversation may also
  // send the owner a short report («отпиши мне потом»): text only, marked with the group, see OWNER_REPORT_GAP_MS.
  if (target.chat===owner) return caller.kind==="owner" || ask || caller.kind==="group" ? undefined :
    "owner_only_with_a_question: send --person owner --ask --text '<what is asked, who asks, yes or no>'; the answer comes back here";
  if (!reachable(store,bot,owner,target.chat))
    return "person_has_not_started_the_bot: mention them in a group instead and tell who asked why";
  if (caller.kind==="owner") return;
  // From a group a person's private chat is written only on the owner's own request (С44): the author decides, not the place.
  // From a group: on the owner's request («спишись с X») any approved person, even one who has not written there yet;
  // a person may ask to be written to privately themselves. Anyone else is answered in the group with a mention.
  if (caller.kind==="group" && (author===owner || author===target.chat)) return;
  if (caller.kind==="group" && groupsOf(target.chat).includes(caller.chat))
    return "person_only_on_the_owners_request_from_a_group: answer in this group and mention them";
  if (caller.kind==="person" && caller.subject===target.chat) return;
  return "person_not_allowed_from_this_conversation";
}

/** Where this conversation may send, for the agent to pick names from. */
export function sendTargets(store:Store,bot:number,owner:number,caller:Conversation|undefined,groupsOf:(person:number)=>number[],author?:number,ownMessage=true) {
  const groups=store.list<{chat:number;title?:string}>(`visibility:${bot}:group:`).map(r=>r.value)
    .filter(g=>!sendRefusal(store,bot,owner,caller,{chat:g.chat,topic:0},groupsOf,undefined,author,false,undefined,ownMessage))
    .map(g=>({chat:g.chat,title:g.title ?? String(g.chat),topics:groupTopics(store,bot,g.chat)}));
  const people=accessList(store,bot).map(p=>({...p,reachable:reachable(store,bot,owner,p.id)}))
    .filter(p=>!p.reachable || !sendRefusal(store,bot,owner,caller,{chat:p.id,topic:0},groupsOf,undefined,author))
    .map(p=>({id:p.id,name:p.name,...(!p.reachable && {note:"has not started the bot: mention them in a group"})}));
  return {groups,people};
}

export function rememberAsk(store:Store,bot:number,target:number,origin:SendTarget,question:string) {
  // The same question to the same person from the same place stays one open question: one answer comes back once.
  const same=openAsks(store,bot,target).find(a=>a.origin.chat===origin.chat && a.origin.topic===origin.topic &&
    a.question===question.slice(0,500));
  if (same) { store.put(askPrefix(bot)+same.id,{...same,at:Date.now()}); return same; }
  const ask:Ask={id:randomUUID().slice(0,8),target,origin,question:question.slice(0,500),at:Date.now()};
  store.put(askPrefix(bot)+ask.id,ask);
  return ask;
}

export function closeAsk(store:Store,bot:number,id:string) { store.del(askPrefix(bot)+id); }

/** One line per open question for this conversation's turn notes. */
/** Questions to the owner from other conversations, for the owner's own turn: the answer goes back with --answer. */
export function ownerAskNotes(store:Store,owner:number,now=Date.now(),replyTo?:number) {
  const asks=store.list<Ask>("send:ask:").map(r=>r.value).filter(a=>a.target===owner && now-a.at<ASK_DAYS*86400_000);
  if (!asks.length) return "";
  // A reply to the question message itself names the question; otherwise several open questions are never guessed.
  const replied=replyTo===undefined ? undefined : store.list<string>("send:ask-msg:").find(r=>r.key.endsWith(":"+replyTo))?.value;
  const own=replied ? asks.find(a=>a.id===replied) : undefined;
  if (own) return `Владелец ответил на вопрос из другого разговора: «${own.question.slice(0,300)}». Передай его ответ туда: `+
    `bb telegram-projects send --answer ${own.id} --text "<ответ владельца его словами>"`;
  // 0.9.77 (owner, case 35: «это же просто чат»): a text without a reply to a question's card is this chat's own
  // message — open questions of other conversations are never glued to it. They are answered by a button or a reply.
  return "";
}

export function askNotes(store:Store,bot:number,target:number) {
  return openAsks(store,bot,target).map(a=>
    `Открытый вопрос по просьбе другого разговора: «${a.question}». Когда получишь ответ, передай его туда: `+
    `bb telegram-projects send --answer ${a.id} --text "…"`).join("\n");
}

/** A group conversation's plain report to the owner: at most one per this gap per conversation. */
export const OWNER_REPORT_GAP_MS=3*60_000;

/** A group conversation's report to the owner: the text marked with the place, or why it does not go. */
export function ownerReport(store:Store,bot:number,caller:{kind:"group";chat:number;topic?:number},body:string,hasFile:boolean,now=Date.now()):
  {text:string}|{error:string} {
  if (hasFile) return {error:"owner_report_text_only: a report to the owner from a group is text only; put the file in this group or ask with --ask"};
  const text=body.trim();
  if (!text) return {error:"text_required"};
  const gapKey=`send:owner-report:${bot}:${caller.chat}:${caller.topic ?? 0}`;
  if (now-(store.get<number>(gapKey) ?? 0)<OWNER_REPORT_GAP_MS)
    return {error:"owner_report_too_soon: one report to the owner per "+OWNER_REPORT_GAP_MS/60_000+" minutes from this conversation; put everything in one message"};
  const title=store.get<{title?:string}>(`visibility:${bot}:group:${caller.chat}`)?.title ?? "группа";
  const topicName=caller.topic ? groupTopics(store,bot,caller.chat).find(t=>t.topic===caller.topic)?.name : undefined;
  store.put(gapKey,now);
  return {text:`Из группы «${title}»${caller.topic ? ", тема «"+(topicName || caller.topic)+"»" : ""}:\n${text.length>3500 ? text.slice(0,3500)+"…" : text}`};
}

/** agents-in-chats п.6: the agent's curator as the addressee of a question (consent on work); undefined target with the reason otherwise. */
export function curatorTarget(curatorIds:number[],ask:boolean):{chat:number;topic:number}|{error:string} {
  const curator=curatorIds[0];
  if (!curator) return {error:"no_curator: у этого агента куратор не назначен — спроси владельца (--person owner --ask)"};
  if (!ask) return {error:"curator_only_with_a_question: куратору — вопрос с --ask; ответ вернётся сюда"};
  return {chat:curator,topic:0};
}

/**
 * A file a group's or a person's conversation may send: received from Telegram in this very chat (its inbox and
 * memory-download folders) or made by this conversation's own tasks (outputs/<task number>/). Paths are real paths.
 */
export function conversationMayAttach(real:string,where:{inboxRoots:string[];bot:number;chat:number;taskDirs:string[]}) {
  const under=(dir:string)=>real.startsWith(dir.replace(/\/+$/,"")+"/");
  return where.inboxRoots.some(root=>under(`${root}/groups/${where.bot}/${where.chat}`) || under(`${root}/archive/${where.bot}/${where.chat}`)) ||
    where.taskDirs.some(under);
}
