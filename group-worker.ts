import {curators,topicNote} from "./topic-mode";
import {markHanded} from "./turn-window";
import {albumCaption,albumChanged,albumKind,deliverAlbumWarnings,sendAlbum,type AlbumMedia} from "./media-album";
import {beginTopicSend,isTopicPaused} from "./topic-lifecycle";
import {groupThreadMatches,isSharedOwnerPolicy,sharedGroupScopeKey,sharedGroupThreadKey} from "./group-binding";
import {isolatedFile,localFileInput,maxEncodedImages,maxGroupAttachments,readSavedImage,opaqueAttachmentInput,opaqueFileReference,readOpaqueAttachment,type ImageAttachment,type IsolatedAttachment} from "./group-attachments";
import {awaitProjectProposal} from "./owner-selection";
import {NO_REPLY} from "./group-result";
import {sourcesVisible} from "./source-access";
import {randomUUID} from "node:crypto";
import {groupExecutor} from "./isolated-client";
import {historyPrefix,topicPassages} from "./topic-search";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {cleanAssistantText,localArtifacts,renderTelegramParts} from "./telegram-ux";
import {readGroupImage,readGroupPdf,readGroupDocument} from "./group-pdf";
import {outboundMessagePayload,plainFromHtml} from "./outbound-message";
import {routedArtifactKind,routedCaption} from "./routed-message";
import {ReplyRoutes, routeMarker, busyAnswerText, isBusyAnswer, stripTelegramMarkers} from "./reply-routing";
import {extractPromiseAnswer, markPromiseDelivered, normalizePromiseWords, promiseWatchKey, recordPromiseLabel, resolvePromiseLabel, type PromiseWatch} from "./promise-labels";
import {voiceTranscripts} from "./archive";
import {askNotes} from "./send-command";
import {turnMessageKey} from "./owner-ask";
import {turnAuthorKey,turnMixedKey,turnParticipantsKey} from "./delete-command";
import {canInvokeGroup, contextMediaPrefix, releaseGroupAlbums, type GroupAlbumScope, type GroupTopicPolicy, type Ingress} from "./ingress";
import type {SavedTelegramFile} from "./telegram-files";
import type {GroupExample} from "./ingress";
import {TelegramFailure,type Store,type Telegram} from "./model";
import {DISCLOSURE,accessModeKey,agentBots,hasAccess,authorStatus,activeGroupSettings,groupSettingsLog,peopleNote,permissionModeFor,rulesNote,senderRole,type PermissionMode} from "./rights";
import {voiceHeader,acknowledge,reactByMeaning,react,SERVICE_REACTIONS,stepLabel,firstLine,progressText,DEFAULT_REACTION_OPTIONS,type ReactionChooser,type ReactionOption,type Stage} from "./turn-feedback";

type GroupInput = Extract<Ingress,{kind:"group"}>;
/** A submitted message without a turn for this long, while its thread is idle, is lost. */
export const LOST_SUBMIT_MS=15*60_000;
/** The agent's own message into its conversation's chat during a turn (send): the final answer is then not repeated. */
/** С113: once a day per chat, the curator (or, unreachable, the owner) learns that the agent cannot answer in a chat and why. */
export async function tellCannotAnswer(store:Store,bot:number,owner:number,r:{chatId:number;senderName?:string},code:string,
  transport:(chat:number)=>Telegram,now=Date.now()) {
  const key=`group:cannot-answer:${bot}:${r.chatId}`;
  const last=store.get<number>(key);
  if (last!==undefined && now-last<86400_000) return;
  const title=store.get<{title?:string}>(`visibility:${bot}:group:${r.chatId}`)?.title ?? String(r.chatId);
  const text=code==="files"
    ? `В «${title}» у меня нет права отправлять файлы и фото: ответ${r.senderName ? " для "+r.senderName : ""} ушёл текстом, без вложений. Нужно право на медиа (настройки группы → Разрешения или права администратора).`
    : `Не могу ответить в «${title}»: ${code==="telegram_rights" ? "Telegram не даёт мне писать там — нужно право отправлять сообщения (настройки группы → Разрешения или права администратора)"
      : "Telegram отказал: меня там нет или мне запрещено писать"}. Сообщение${r.senderName ? " от "+r.senderName : ""} осталось без ответа.`;
  for (const to of [...curators(store).filter(id=>id!==owner),owner]) {
    // Marked only once it reached someone: a line nobody got is tried again with the next refusal.
    try { await transport(to)("sendMessage",{chat_id:to,text}); store.put(key,now); return; } catch { /* the next one */ }
  }
}

/**
 * 0.9.79: a number for a job the bridge makes itself (a further labelled answer, a watched final): negative, so it never
 * meets a Telegram update, unique, and growing in time — the queue goes by number, so later answers go later.
 */
export function nextSyntheticId(store:Store) {
  const n=(store.get<number>("group:synthetic-seq") ?? 0)+1;
  store.put("group:synthetic-seq",n);
  return -(1e15-n);
}

export const sentInTurnKey=(threadId:string)=>"group:sent-in-turn:"+threadId;
/** Text compared by its words only, so formatting and spacing do not make a repeat look new. */
export const sameWords=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
/**
 * С50: slow work (a voice transcription, a file download) started once per key and taken when ready. Returns
 * undefined while it still runs, so the worker goes on with the other chats instead of waiting.
 */
const slowWork=new Map<string,{done?:{value:unknown}|{error:unknown}}>();
export async function settled(key:string,start:()=>Promise<unknown>,keep=false):Promise<{value:unknown}|{error:unknown}|undefined> {
  let entry=slowWork.get(key);
  if (!entry) {
    const fresh:{done?:{value:unknown}|{error:unknown}}={};
    slowWork.set(key,fresh);
    entry=fresh;
    start().then(value=>{fresh.done={value};},error=>{fresh.done={error};});
    await new Promise(resolve=>setTimeout(resolve,SLOW_WORK_GRACE_MS));
  }
  if (!entry.done) return undefined;
  if (!keep) slowWork.delete(key);
  return entry.done;
}
/** Quick work finishes within this grace and is used in the same pass, as before. */
export let SLOW_WORK_GRACE_MS=1_500;
export function setSlowWorkGrace(ms:number) { SLOW_WORK_GRACE_MS=ms; }
/** С106: the bot's own message this conversation edited during the turn; the turn's answer goes as a reply to it. */
export const editedInTurnKey=(threadId:string)=>"group:edited-in-turn:"+threadId;

/**
 * 0.9.75: the messages one person sent in a row in a topic, each within the window of the previous one. The earliest
 * pending one is the anchor; the chain waits while a window is open or a voice is still being transcribed.
 */
export function collectChain(store:Store,botId:number,job:Job) {
  const r=job.route;
  const same=store.list<Job>(`group:in:${botId}:`).filter(({value:j})=>j.state==="pending" && !j.retryAfterPlugin && j.ownerId===job.ownerId &&
    j.revision===job.revision && j.route.chatId===r.chatId && j.route.topicId===r.topicId && j.route.threadId===r.threadId &&
    j.route.senderId===r.senderId && j.route.arrivedAt!==undefined && j.route.updateId>0)
    .sort((a,b)=>a.value.route.updateId-b.value.route.updateId);
  const anchor=same[0];
  const members:{key:string;job:Job}[]=[];
  let until=anchor?.value.route.collectUntil ?? 0, waiting=Date.now()<until;
  for (const s of same.slice(1)) {
    if ((s.value.route.arrivedAt ?? Infinity)>until) break;
    members.push({key:s.key,job:s.value});
    until=Math.max(until,s.value.route.collectUntil ?? 0);
    if (Date.now()<until || s.value.route.voice) waiting=true;
  }
  return {anchorKey:anchor?.key,members,waiting};
}

/** "Typing" for a submitted message stops after this long. */
export const TYPING_MAX_MS=10*60_000;

type Job = {
  route: GroupInput; ownerId:number; revision?:string;
  state:"pending"|"submitted"|"ready"|"sending"|"done"|"revoked";
  taskId?:string; progressId?:number|null;
  /** A deferred task the bridge gives itself (no person waits for this turn's answer). */
  followUp?:true;
  /** Telegram refused a file here for lack of rights: the answer goes as text only. */
  noFiles?:true;
  /** 0.9.75: this message went into the turn of an earlier one of the same person. */
  mergedInto?:number;
  /** С106: the edited message this answer replies to. */
  replyTo?:number;
  /** When the message was given to the thread; a submitted message without a turn does not live forever. */
  submittedAt?:number; resubmitted?:boolean; started?:boolean; refusedNotified?:boolean;
  executionToken?:string; executorRetryAt?:number; verifyRetryAt?:number; verifyFailures?:number; verifyFirstAt?:number;
  pdfIndex?:number; failedPdfs?:string[];
  albumSent?:number[];
  imageIndex?:number; failedImages?:string[];
  opaqueFiles?:SavedTelegramFile[]; captionSent?:true;
  cursor?:number; turnId?:string; answer?:string; part?:number;
  /** Sent into a running turn: the selector of its separate answer; busyOnce — the plain retry is under way. */
  busyLabel?:string; busyOnce?:true;
  /** A previous labelled reply is not a receipt for the final displaced by a plugin. */
  retryAfterPlugin?:true;
  /** С45/С46: the visible sign and the live status of this message. */
  /** 0.9.77: the agent worked on after its message; a later message makes that one interim, not the answer. */
  interim?:true;
  acked?:true; stage?:Stage; stageShown?:true; guest?:boolean;
  agentLine?:string; step?:string; startedAt?:number; progressAt?:number; progressText?:string;
};
/** A file with the agent's formatted caption; if Telegram rejects the formatting — the same caption as plain words. */
async function sendCaptioned(tg:Telegram,payload:(html:boolean)=>{method:string;body:Record<string,unknown>},formatted:boolean):Promise<any> {
  const first=payload(true);
  return tg(first.method,first.body).catch(error=>{
    if (formatted && error instanceof TelegramFailure && error.code==="telegram_400") {const plain=payload(false); return tg(plain.method,plain.body);}
    throw error;
  });
}
type TurnWatch={threadId:string;turn:string;afterSeq:number;route:GroupInput;ownerId:number;revision?:string;at:number;
  final?:string; labelAt?:number; taskId?:string; replyTo?:number;
  /** 0.9.79: the label of the message this watch follows and the last labelled answer already given to it. */
  label?:string; labelled?:string};
const GROUP_TOOL_ITEMS=new Set(["commandExecution","mcpToolCall","toolCall","fileChange","webSearch"]);

// Keep thread ownership after disconnect: history may already contain group messages.
export const groupTaskNote = (taskId:string) =>
  "Group taskId: " + taskId + ". Include this ID in internal approval requests to the owner coordinator. " +
  "Файл для отправки в этот чат клади в outputs/" + taskId.slice(0,8) + "/ — оттуда он уходит и ссылкой в ответе, и командой send --file; " +
  "старый файл (сделанный раньше) сначала скопируй в эту папку.";

export function bindGroupTopic(store: Store, policy: GroupTopicPolicy, projectId: string) {
  const {chatId,topicId,threadId}=policy;
  const key=`group:policy:${chatId}:${topicId}`;
  store.atomic(()=>{
    const privateBindings=store.list<{projectId:string;threadId?:string}>("chat:binding:");
    // A personal assistant keeps the owner's private project out of groups. An employee is one
    // zone of trust: its private chat and groups share one folder, one memory and one set of rules.
    const employee=store.get<string>("rights:install-kind")==="employee";
    const previous=store.get<GroupTopicPolicy>(key);
    if (policy.ownerTopicManagerProjectId && (policy.ownerSharedProject || policy.topicId<2 || !policy.ownerId))
      throw Error("work_forum_binding_required");
    if (policy.ownerSharedProject || policy.ownerTopicManagerProjectId) {
      const otherTopics=store.list<GroupTopicPolicy>(`group:policy:${chatId}:`)
        .filter(({key:stored})=>stored!==key);
      if (otherTopics.some(({value})=>policy.ownerSharedProject ? !!value.ownerTopicManagerProjectId : !!value.ownerSharedProject))
        throw Error("forum_mode_conflict");
    }
    if (policy.ownerSharedProject) {
      if (!isSharedOwnerPolicy(policy) || employee || store.get("group:project:"+projectId) ||
          (previous && !previous.ownerSharedProject) ||
          (store.get("group:thread:"+threadId) && !store.get(sharedGroupThreadKey(threadId))))
        throw Error("private_owner_forum_binding_required");
    } else if (previous?.ownerSharedProject || store.get(sharedGroupThreadKey(threadId)) ||
        store.get(sharedGroupScopeKey(chatId,topicId)) || store.get("group:shared-project:"+projectId)) {
      throw Error("shared_owner_thread_cannot_change_audience");
    }
    if (privateBindings.some(({value})=>value.threadId===threadId) || store.get("chat:thread-project:"+threadId) ||
        store.list<{threadId?:string}>("reply:watch:").some(({value})=>value.threadId===threadId) ||
        (!policy.ownerSharedProject && !employee && (privateBindings.some(({value})=>value.projectId===projectId) ||
          store.list<string>("chat:thread-project:").some(row=>row.value===projectId) || store.get("private:project:"+projectId))))
      throw Error("private_thread_or_project");
    const claim=store.get<string>("group:thread:"+threadId);
    if (claim && claim!==key) throw Error("thread_belongs_to_other_topic");
    if (policy.ownerSharedProject) {
      store.put(sharedGroupThreadKey(threadId),true);
      store.put(sharedGroupScopeKey(chatId,topicId),true);
      store.put("group:shared-project:"+projectId,true);
    } else if (!policy.privateChat && !policy.inOwnerProject) store.put("group:project:"+projectId,true);
    const prev=previous;
    if (prev && prev.projectId === projectId && !!prev.isolated === !!policy.isolated && prev.acceptAfterSecond !== undefined && prev.threadId===threadId && prev.ownerOnly===policy.ownerOnly && prev.ownerTopic===policy.ownerTopic && prev.ownerSharedProject===policy.ownerSharedProject &&
        prev.ownerTopicManagerProjectId===policy.ownerTopicManagerProjectId &&
        JSON.stringify(prev.deliverySources??[])===JSON.stringify(policy.deliverySources??[]) &&
        prev.requireMention===policy.requireMention && prev.addressName===policy.addressName && prev.botId===policy.botId &&
        !!prev.retainFullHistory===!!policy.retainFullHistory && !!prev.searchableHistory===!!policy.searchableHistory && !!prev.includeTopicContext===!!policy.includeTopicContext &&
        JSON.stringify(prev.allowedSenderIds??[])===JSON.stringify(policy.allowedSenderIds??[]) &&
        prev.ownerId===policy.ownerId && prev.botUsername===policy.botUsername) return;
    if (prev) {
      for (const row of store.list(`group:recent-files:${prev.botId}:${chatId}:${topicId}:`)) store.del(row.key);
      for (const row of store.list(contextMediaPrefix(prev.botId,chatId,topicId))) store.del(row.key);
    }
    const sameAudience = prev && prev.threadId===threadId && prev.ownerId===policy.ownerId &&
      prev.botId===policy.botId && prev.ownerOnly===policy.ownerOnly &&
      JSON.stringify(prev.allowedSenderIds??[])===JSON.stringify(policy.allowedSenderIds??[]);
    for (const row of store.list<Record<string,unknown>>(historyPrefix(chatId,topicId))) {
      if (sameAudience && prev.searchableHistory && policy.searchableHistory) {
        store.put(row.key,{...row.value,permanent:policy.retainFullHistory===true});
      } else store.del(row.key);
    }
    store.del(`group:context:${chatId}:${topicId}`);
    store.put("group:thread:"+threadId,key);
    store.put(key,{...policy,projectId,acceptAfterSecond:policy.acceptAfterSecond ?? (policy.privateChat ? 0 : Math.floor(Date.now()/1000))});
  });
}

// The owner manages the bridge from the private thread or an administrator
// terminal. Group workers, including children in a group project, only need
// the search command; its handler separately checks the bound topic.
export function groupCliRestricted(store: Store, projectId?: string, threadId?: string) {
  return Boolean((projectId && store.get("group:project:" + projectId)) ||
    (threadId && store.get("group:thread:" + threadId)));
}

// Telegram clears typing on delivery or expiry. Renew it independently of long
// transcription, file downloads and BB turns. Status failures never block work.
export function groupTyping(store:Store, owner:()=>number|undefined, bot:()=>number|undefined,
  transport:(chatId:number)=>Telegram, signal:AbortSignal) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let running=false;
  async function pulse() {
    if (signal.aborted || running || timer) return;
    const ownerId=owner(), botId=bot();
    if (!ownerId || !botId) return;
    const topics=new Map<string,GroupInput>();
    for (const {value:job} of store.list<Job>(`group:in:${botId}:`)) {
      if (job.state!=="pending" && job.state!=="submitted") continue;
      // "Typing" only while the message is fresh: a lost submission never shows it for hours.
      if (job.state==="submitted" && Date.now()-(job.submittedAt ?? 0)>TYPING_MAX_MS) continue;
      const r=job.route;
      if (r.waitUntil && !r.voice && Date.now()<r.waitUntil) continue;
      const key=`group:policy:${r.chatId}:${r.topicId}`;
      const policy=store.get<GroupTopicPolicy>(key);
      if (policy?.botId===botId && job.ownerId===ownerId && (policy.ownerId===undefined || policy.ownerId===ownerId) &&
          policy.revision===job.revision && policy.threadId===r.threadId && (policy.isolated===true ? canInvokeGroup(policy,ownerId,r.senderId) : senderRole(store,botId,ownerId,r.chatId,r.senderId)!=="none"))
        topics.set(key,r);
    }
    if (!topics.size) return;
    running=true;
    const started=Date.now();
    try {
      await Promise.allSettled([...topics.values()].map(r=>transport(r.chatId)("sendChatAction",{
        chat_id:r.chatId,message_thread_id:r.topicId || undefined,action:"typing"
      })));
    } finally {
      running=false;
      if (!signal.aborted) timer=setTimeout(()=>{timer=undefined;void pulse().catch(()=>{});},
        Math.max(500,3600-(Date.now()-started)));
    }
  }
  signal.addEventListener("abort",()=>clearTimeout(timer),{once:true});
  return ()=>pulse().catch(()=>{});
}

// Called serially by the chat service. Never retry a send with an unknown outcome.
export async function processGroupInputs(store:Store, sdk:BbPluginApi["sdk"],
  owner:number, botId:number, transport:(chatId:number)=>Telegram, signal:AbortSignal,
  transcribe?:(voice:NonNullable<GroupInput["voice"]>)=>Promise<string>, fileHostId?:string,
  receiveExample?:(example:GroupExample,route:GroupInput)=>Promise<SavedTelegramFile|ImageAttachment>, visibleProgress=false,
  verifyOwnerForum?:(policy:GroupTopicPolicy)=>Promise<boolean|"retry">,
  reactions?:()=>{chooser?:ReactionChooser;options:ReactionOption[]},
  /** The rules in force for a project and their fingerprint, from the platform plugin (0.4.4); null outside an organization. */
  turnRules?:(projectId:string)=>Promise<{version:string;text:string}|null>,
  /** The employee is paused (platform 0.4.7 pauseStatus); no call means not paused. */
  paused?:()=>Promise<boolean>,
  /** A group's or a person's conversation attaches only its own files (see server insideConversationFolder). */
  mayAttach?:(threadId:string,route:{chatId:number;topicId:number;privateChat:boolean},path:string)=>Promise<boolean>,
  /** С103: one line — whether the agent has written in this chat and topic today, and the local time. */
  todayOf?:(chatId:number,topicId:number)=>string,
  /** С105: the bot's own messages in this chat and topic after this message (number and what it replies to). */
  botMessagesAfter?:(chatId:number,topicId:number,messageId:number)=>{message:number;replyTo?:number}[]) {
  // С105 (narrow, until the incoming ledger): answered — the bot replied to this very message. Any other later message
  // of the bot proves nothing: several messages may wait, and an answer to one is not an answer to another.
  const answered=(r:{chatId:number;topicId:number;messageId:number;updateId:number})=>{
    try {
      // Only a real Telegram message can be answered already: what the bridge itself gives (a deferred task, a
      // subthread's result — a synthetic update) carries the original message's number and must still run.
      if (!(r.updateId>0) || !(r.messageId>0) || !botMessagesAfter) return false;
      return botMessagesAfter(r.chatId,r.topicId,r.messageId).some(m=>m.replyTo===r.messageId);
    } catch {return false;}
  };
  const routes=new ReplyRoutes(store);
  let pausedNow:boolean|undefined;
  const isPaused=async()=>pausedNow??=(paused ? await paused().catch(()=>false) : false);
  type Cleanup={chatId:number;messageId:number;retryAt?:number};
  for (const {key,value} of store.list<Cleanup>(`group:cleanup:${botId}:`)) {
    if (signal.aborted) return;
    if ((value.retryAt??0)>Date.now()) continue;
    try {
      await transport(value.chatId)("deleteMessage",{chat_id:value.chatId,message_id:value.messageId});
      store.del(key);
    } catch (error) {
      if (error instanceof TelegramFailure && ["telegram_400","telegram_403"].includes(error.code)) store.del(key);
      else store.put(key,{...value,retryAt:Date.now()+1000*(error instanceof TelegramFailure ? error.retryAfter : 30)});
    }
  }
  releaseGroupAlbums(store,owner,botId);
  await deliverAlbumWarnings<GroupAlbumScope>(store,`group:album-warning:${botId}:${owner}:`,
    chatId=>async (method,body)=>{
      const end=beginTopicSend(store,botId,chatId,Number(body.message_thread_id??0));
      try {return await transport(chatId)(method,body);} finally {end();}
    },async (scope,target)=>{
    const policy=store.get<GroupTopicPolicy>(`group:policy:${target.chatId}:${target.topicId}`);
    return !!policy && policy.botId===botId && policy.revision===scope.revision &&
      (policy.ownerId===undefined || policy.ownerId===owner) &&
      !isTopicPaused(store,botId,target.chatId,target.topicId) &&
      canInvokeGroup(policy,owner,scope.senderId) &&
      (!policy.ownerSharedProject || (await verifyOwnerForum?.(policy).catch(()=>"retry"))===true);
  },signal);
  // A busy job starts observing at submission, possibly midway through a BB turn.
  // Its first locally observed acceptance is insufficient proof of who started that turn.
  async function* earlierEvents(threadId:string,before:number,types:Parameters<typeof sdk.threads.events.list>[0]["types"]) {
    while (true) {
      const page=await sdk.threads.events.list({threadId,beforeSeq:String(before),order:"desc",limit:"100",types,signal});
      const events=page.filter(e=>e.seq<before).sort((a,b)=>b.seq-a.seq);
      yield* events;
      if (events.length<100) return;
      before=events[events.length-1].seq;
    }
  }
  async function acceptRequest(threadId:string,turn:string,id:string,seq:number) {
    // A queued tell can be requested before our submission cursor, then accepted into our turn.
    if (!routes.routeOf(threadId,id)) {
      for await (const e of earlierEvents(threadId,seq,["client/turn/requested"])) {
        if (e.type==="client/turn/requested" && e.data.requestId===id) {
          routes.requested(threadId,e.data);
          break;
        }
      }
    }
    routes.accept(threadId,turn,id);
  }
  // A plugin can request work before our cursor and join it later. Only requests
  // actually accepted by this turn can claim its unlabelled reply.
  async function pluginJoined(threadId:string,turn:string,through:number) {
    const joined=new Set(routes.requestIds(threadId,turn).slice(1));
    if (!joined.size) return false;
    for await (const e of earlierEvents(threadId,through+1,["client/turn/requested"])) {
      if (e.type!=="client/turn/requested" || !joined.delete(e.data.requestId)) continue;
      const req=e.data;
      if (req.originPluginId && req.originPluginId!=="telegram-projects" &&
          !(req.initiator==="system" && req.systemMessageKind?.startsWith("child-"))) return true;
      if (!joined.size) break;
    }
    return false;
  }
  function requestFinal(source:Pick<Job,"route"|"ownerId"|"revision"|"taskId"|"replyTo">):Job {
    return {route:source.route,ownerId:source.ownerId,revision:source.revision,taskId:source.taskId,
      replyTo:source.replyTo,state:"pending",acked:true,retryAfterPlugin:true};
  }
  const starters=new Map<string,string|undefined>();
  async function starterRequest(threadId:string,turn:string,through:number) {
    const key=JSON.stringify([threadId,turn]);
    if (starters.has(key)) return starters.get(key);
    let first:string|undefined;
    for await (const e of earlierEvents(threadId,through+1,["turn/input/accepted","turn/completed"])) {
      if (e.scope.kind!=="turn") continue;
      if (e.type==="turn/completed" && e.scope.turnId!==turn) break;
      if (e.type==="turn/input/accepted" && e.scope.turnId===turn) first=e.data.clientRequestId;
    }
    starters.set(key,first);
    return first;
  }
  const destinationOf=(r:GroupInput)=>({kind:"telegram" as const,chatId:r.chatId,topicId:r.topicId,
    updateId:r.updateId,messageId:r.messageId,...(r.forwarded && !r.typedComment && {forwardedOnly:true as const})});
  // Separate messages from one verified group author can share one final. This
  // is a delivery decision only; it confers no permissions or delegated claims.
  async function finalFor(r:GroupInput,turn:string,through:number) {
    const dest=destinationOf(r);
    const first=await starterRequest(r.threadId,turn,through);
    const owners=routes.taskRequestIds(r.threadId,turn);
    if (!first || first!==owners[0]) return;
    const exact=routes.destination(r.threadId,turn);
    if (exact) return routes.sameTask(exact,dest) ? "deliver" : undefined;
    if (owners.length<2 || r.updateId<=0) return;
    let latest=0, included=false;
    for (const id of owners) {
      const route=routes.routeOf(r.threadId,id);
      if (route?.kind!=="telegram" || route.chatId!==r.chatId || route.topicId!==r.topicId ||
          !route.messageId || route.updateId<=0 || routes.cancelled(route) ||
          store.get<number>(turnAuthorKey(r.threadId,route.updateId))!==r.senderId) return;
      latest=Math.max(latest,route.messageId);
      if (routes.sameTask(route,dest)) included=true;
    }
    if (included) return r.messageId===latest ? "deliver" : "covered";
  }
  for (const {key,value:w} of store.list<TurnWatch>(`group:turn-watch:${botId}:`)) {
    if (signal.aborted) return;
    if (Date.now()-w.at>6*3600_000) {store.del(key);continue;}
    let events;
    try {
      events=await sdk.threads.events.list({threadId:w.threadId,afterSeq:String(w.afterSeq),order:"asc",limit:"100",signal,
        types:["client/turn/requested","turn/input/accepted","item/completed","turn/completed"]});
    } catch {continue;}
    let done=false;
    for (const e of events as any[]) {
      const previous=w.afterSeq;
      w.afterSeq=Math.max(w.afterSeq,e.seq);
      if (e.type==="client/turn/requested") routes.requested(w.threadId,e.data);
      if (e.scope?.kind!=="turn" || e.scope.turnId!==w.turn) continue;
      if (e.type==="turn/input/accepted") await acceptRequest(w.threadId,w.turn,e.data.clientRequestId,e.seq);
      if (e.type==="item/completed" && e.data.item?.type==="agentMessage" && !e.data.item.parentToolCallId &&
          !isBusyAnswer(e.data.item.text)) w.final=e.data.item.text;
      // 0.9.79: another answer with the same label in this turn («прочитаю и пришлю», then the result) goes too, as a
      // reply to the same message; only a word-for-word repeat of the last one is dropped.
      const again=w.label && e.type==="item/completed" && e.data.item?.type==="agentMessage" && !e.data.item.parentToolCallId ?
        busyAnswerText(e.data.item.text,w.label) : undefined;
      if (again && sameWords(again)!==sameWords(w.labelled ?? "")) {
        w.labelled=again;
        if (w.label) markPromiseDelivered(store,w.threadId,w.label,again);
        const updateId=nextSyntheticId(store);
        store.put(`group:in:${botId}:${updateId}`,{ownerId:w.ownerId,revision:w.revision,state:"ready",turnId:w.turn,
          answer:again,...(w.replyTo && {replyTo:w.replyTo}),route:{...w.route,updateId}} satisfies Job);
      }
      if (e.type==="turn/completed") {
        const said=stripTelegramMarkers(w.final ?? "").replace(/<!--[\s\S]*?-->/g,"").trim();
        const ownsFinal=await finalFor(w.route,w.turn,e.seq)==="deliver";
        // Already sent into this place by command during the turn: no second copy.
        const wrote=store.get<{chat:number;topic:number;sent?:{at:number}[]}>(sentInTurnKey(w.threadId));
        const sentHere=!!wrote && wrote.chat===w.route.chatId && wrote.topic===(w.route.topicId ?? 0) &&
          (wrote.sent ?? []).some(x=>x.at>=(w.labelAt ?? w.at) && (e.createdAt===undefined || x.at<=e.createdAt));
        store.waiting?.completed(w.threadId,w.turn,ownsFinal && sentHere && e.data.status==="completed");
        if (ownsFinal && !sentHere && e.data.status==="completed" && said && said!==NO_REPLY) {
          if (await pluginJoined(w.threadId,w.turn,e.seq)) {
            const retryKey=`group:in:${botId}:${w.route.updateId}`;
            // Finish sending the labelled reply before reusing its job key.
            if (store.get(retryKey)) {w.afterSeq=previous;break;}
            store.atomic(()=>{store.put(retryKey,requestFinal(w));store.del(key);});
          } else {
            const updateId=nextSyntheticId(store);
            store.put(`group:in:${botId}:${updateId}`,{ownerId:w.ownerId,revision:w.revision,state:"ready",turnId:w.turn,
              answer:w.final,route:{...w.route,updateId}} satisfies Job);
          }
        }
        done=true; break;
      }
    }
    // A turn that never ends (cut off, the thread idle for long): stop watching.
    if (!done && !events.length && Date.now()-w.at>30*60_000) {
      const status=await sdk.threads.get({threadId:w.threadId,signal}).then((t:any)=>t.status).catch(()=>undefined);
      if (status && status!=="active") done=true;
    }
    if (done) store.del(key); else store.put(key,w);
  }
  const pending=store.list<Job>(`group:in:${botId}:`);
  pending.sort((a,b)=>a.value.route.updateId-b.value.route.updateId);
  // 0.9.81: watch non-Telegram turns on group/topic threads for explicit [telegram-answer:<label>] replies (24h TTL).
  // Unlabelled finals of such turns never leave for Telegram.
  for (const {key,value:w} of store.list<PromiseWatch>(`promise:watch:${botId}:`)) {
    if (signal.aborted) return;
    if (Date.now()-w.at>6*3600_000) {store.del(key);continue;}
    const policyKey=store.get<string>("group:thread:"+w.threadId);
    const policy=policyKey ? store.get<GroupTopicPolicy>(policyKey) : undefined;
    if (!policy || policy.botId!==botId || (policy.ownerId!==undefined && policy.ownerId!==owner) ||
        policy.chatId!==w.chatId || policy.topicId!==w.topicId || isTopicPaused(store,botId,w.chatId,w.topicId)) {
      store.del(key); continue;
    }
    let events;
    try {
      events=await sdk.threads.events.list({threadId:w.threadId,afterSeq:String(w.cursor),order:"asc",limit:"100",signal,
        types:["item/completed","turn/completed"]});
    } catch {continue;}
    let completed=false;
    for (const e of events as any[]) {
      w.cursor=Math.max(w.cursor,e.seq);
      const prevSeq=store.get<number>("group:last-seq:"+w.threadId) ?? 0;
      if (e.seq>prevSeq) store.put("group:last-seq:"+w.threadId,e.seq);
      if (e.type==="item/completed" && e.data.item?.type==="agentMessage" && !e.data.item.parentToolCallId) {
        const ans=extractPromiseAnswer(String(e.data.item.text ?? ""));
        if (ans) {
          const entry=resolvePromiseLabel(store,w.threadId,ans.label,{
            chatId:policy.chatId,topicId:policy.topicId,botId,ownerId:owner,kind:"group",
          });
          if (entry && e.seq>(entry.afterSeq ?? 0) &&
              !routes.cancelled({kind:"telegram",chatId:entry.chatId,topicId:entry.topicId,updateId:entry.updateId,messageId:entry.messageId}) &&
              normalizePromiseWords(ans.body)!==entry.lastDeliveredWords) {
            markPromiseDelivered(store,w.threadId,ans.label,ans.body);
            const updateId=nextSyntheticId(store);
            store.put(`group:in:${botId}:${updateId}`,{
              ownerId:owner,revision:policy.revision,state:"ready",turnId:e.scope?.turnId,
              answer:ans.body,replyTo:entry.messageId,
              route:{kind:"group",chatId:entry.chatId,topicId:entry.topicId,senderId:owner,
                threadId:w.threadId,messageId:entry.messageId,updateId,text:""},
            } satisfies Job);
          }
        }
      }
      if (e.type==="turn/completed") completed=true;
    }
    if (completed) {
      let stillActive=false;
      try { stillActive=(await sdk.threads.get({threadId:w.threadId,signal}) as {status?:string}).status==="active"; } catch {}
      if (!stillActive) {store.del(key); continue;}
    }
    store.put(key,w);
  }
  jobs: for (const {key} of pending) {
    const job=store.get<Job>(key);
    if (!job) continue;
    if (signal.aborted) return;
    const r=job.route;
    if (isTopicPaused(store,botId,r.chatId,r.topicId)) continue;
    let sourceDenied=false;
    const finish=(state:"done"|"revoked"|"sending", sentId?:number)=>{
      store.atomic(()=>{
        const receiptKey=`group:receipt:${botId}:${r.updateId}`;
        // An interrupted Telegram send requires the original payload for reconciliation.
        store.put(receiptKey,state==="sending"?job:{state,...(sourceDenied && {reason:"source_unavailable"}),chatId:r.chatId,topicId:r.topicId,
          messageId:r.messageId,threadId:r.threadId,turnId:job.turnId,sentId,...(job.albumSent && {albumMessageIds:job.albumSent})});
        if (job.progressId) store.put(`group:cleanup:${botId}:${r.updateId}`,{chatId:r.chatId,messageId:job.progressId});
        store.del(`group:examples:${botId}:${r.updateId}`);
        store.del(key);
      });
    };
    if (job.state==="done" || job.state==="revoked" || job.state==="sending") {
      finish(job.state);
      continue;
    }
    if (job.verifyRetryAt!==undefined && job.verifyRetryAt>Date.now()) continue;
    const allowed=()=>{
      const p=store.get<GroupTopicPolicy>(`group:policy:${r.chatId}:${r.topicId}`);
      sourceDenied=!sourcesVisible(p?.deliverySources,botId,r.chatId,r.topicId);
      return !isTopicPaused(store,botId,r.chatId,r.topicId) && !albumChanged(store,r.albumKey) && !sourceDenied && p?.botId===botId && p.revision===job.revision && (p.ownerId===undefined || p.ownerId===owner) && p.chatId===r.chatId && p.topicId===r.topicId && p.threadId===r.threadId &&
        owner===job.ownerId && (p.isolated===true || p.ownerTopic || p.ownerSharedProject ? canInvokeGroup(p,owner,r.senderId) : senderRole(store,botId,owner,r.chatId,r.senderId)!=="none");
    };
    if (!allowed()) {finish("revoked");continue;}
    const topicKey = `group:policy:${r.chatId}:${r.topicId}`;
    const policy=store.get<GroupTopicPolicy>(topicKey)!;
    const checkSafeToSend=async():Promise<"ok"|"revoked"|"retry">=>{
      if (!allowed()) return "revoked";
      if (!policy.ownerSharedProject) return "ok";
      let verdict:boolean|"retry";
      try { verdict=verifyOwnerForum ? await verifyOwnerForum(policy) : false; }
      catch { verdict="retry"; }
      if (verdict==="retry") return "retry";
      return verdict && allowed() ? "ok" : "revoked";
    };
    const VERIFY_RETRY_MAX_MS=24*3600_000;
    const deferVerify=()=>{
      const now=Date.now();
      const first=job.verifyFirstAt ?? now;
      if (now-first>=VERIFY_RETRY_MAX_MS) {
        console.warn(`verifyOwnerForum: retry limit (24h) reached for chat=${r.chatId} topic=${r.topicId} msg=${r.messageId}; closing as revoked`);
        finish("revoked");
        return;
      }
      const failures=(job.verifyFailures ?? 0)+1;
      job.verifyFirstAt=first;
      job.verifyFailures=failures;
      job.verifyRetryAt=now+Math.min(300_000,5_000*2**(failures-1));
      store.put(key,job);
    };
    const clearVerify=()=>{
      if (job.verifyFailures!==undefined || job.verifyRetryAt!==undefined || job.verifyFirstAt!==undefined) {
        delete job.verifyFailures; delete job.verifyRetryAt; delete job.verifyFirstAt;
        store.put(key,job);
      }
    };
    const executor=policy.isolated ? groupExecutor(r.chatId,r.topicId) : undefined;
    if (policy.isolated && (!executor || executor.projectId!==policy.projectId || executor.threadId!==r.threadId)) {
      finish("revoked");continue;
    }
    const belongsToGroup = (thread: Awaited<ReturnType<typeof sdk.threads.get>>) => {
      const binding = store.get<GroupTopicPolicy>(topicKey);
      return allowed() && thread.id === r.threadId && !thread.archivedAt && !thread.deletedAt &&
        thread.visibility === "visible" && !!thread.projectId &&
        !!binding && (!binding.ownerSharedProject || !thread.parentThreadId) &&
        groupThreadMatches(store,binding,thread.projectId);
    };
    const dest=destinationOf(r);
    const reactionKey=`group:reaction:${botId}:${r.updateId}`;
    // Lazy: a transport that cannot be built must not break the job (the reaction is best effort).
    const reactTg:Telegram=(method,body)=>transport(r.chatId)(method,body);
    // С45: every message that reached this agent gets a visible sign at once: 👀, then the chosen reaction.
    // A message of the owner without a mention may not be for the agent (С55): no sign until it answers.
    // С74: no reaction is chosen for an agent bot's message.
    if (r.updateId>0 && !job.acked && !r.ownerUnaddressed && !r.leaderUnaddressed && !r.quietAck && !agentBots(store).includes(r.senderId)) {
      job.acked=true; job.startedAt??=Date.now(); store.put(key,job);
      const set=reactions?.();
      // A voice has no words yet: 👀 now, the reaction by meaning after its transcript (below).
      void acknowledge(reactTg,r.chatId,r.messageId,r.voice ? "" : r.ownText ?? r.text,set?.chooser,set?.options ?? DEFAULT_REACTION_OPTIONS,
        ()=>!!store.get(reactionKey),[],signal).catch(()=>{});
    }
    // С46: one live status message: the agent's first line and the current step; guests see the step only.
    const updateProgress=async()=>{
      // A message nobody addressed to the agent shows nothing while it works: its answer (if any) is the only sign.
      if (!visibleProgress || policy.ownerSharedProject || r.ownerUnaddressed || r.leaderUnaddressed || r.quietAck || r.updateId<=0 || job.progressId===null) return;
      const text=progressText({agentLine:job.agentLine,step:job.step,guest:job.guest,startedAt:job.startedAt ?? Date.now()});
      if (!text || text===job.progressText || Date.now()-(job.progressAt ?? 0)<5000) return;
      try {
        const tg=transport(r.chatId);
        if (job.progressId) await tg("editMessageText",{chat_id:r.chatId,message_id:job.progressId,text});
        else {
          // A lost Telegram acknowledgement must not create a second status on restart.
          job.progressId=null; store.put(key,job);
          const sent=await tg("sendMessage",{chat_id:r.chatId,message_thread_id:r.topicId||undefined,
            reply_parameters:{message_id:r.messageId},text,disable_notification:true});
          if (Number.isSafeInteger(sent?.message_id)) job.progressId=sent.message_id;
        }
        job.progressText=text; job.progressAt=Date.now(); store.put(key,job);
      } catch { /* A status failure must not stop the actual reply. */ }
    };
    const finalUnavailable="Не удалось получить итог по вашему сообщению.";
    if (job.retryAfterPlugin && job.state==="pending") {
      const thread=await sdk.threads.get({threadId:r.threadId,signal});
      const provider=thread.providerId;
      const role=senderRole(store,botId,owner,r.chatId,r.senderId,provider);
      if (executor || role==="none" || !belongsToGroup(thread)) {finish("revoked");continue;}
      const latest=await sdk.threads.events.list({threadId:r.threadId,order:"desc",limit:"1",signal});
      {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");continue;} if (safe==="retry") {deferVerify();continue;} clearVerify();}
      const {token,label}=routes.labelledIngress(r.threadId,dest);
      job.busyLabel=label; job.cursor=latest[0]?.seq ?? 0;
      job.state="submitted"; job.submittedAt=Date.now();
      // Persist before send: even an uncertain SDK receipt must never trigger another request.
      store.put(key,job);
      await sdk.threads.send({threadId:r.threadId,mode:"queue-if-active",
        permissionMode:permissionModeFor(role,provider,store.get<PermissionMode>(accessModeKey)),
        input:[{type:"text",mentions:[],text:`Итог по сообщению №${r.messageId} не доставлен человеку. Дай готовый итог одним сообщением: начни отдельной строкой [telegram-answer:${label}] и закончи строкой [/telegram-answer]. Работу не повторяй.`},routeMarker(token)]});
    }
    if (job.state==="pending" && r.voice) {
      // С50: a long transcription in one chat never holds the others — it runs in the background and is taken
      // on a later pass.
      const voice=r.voice;
      const ready=await settled(key+":voice",()=>Promise.resolve().then(()=>transcribe?.(voice)));
      if (!ready) continue;
      try {
        if ("error" in ready) throw ready.error;
        const transcript = (ready.value as string|undefined)?.trim();
        if (!transcript) throw Error("voice_unavailable");
        if (!allowed()) {finish("revoked");continue;}
        if (r.searchBefore!==undefined) {
          const matches=store.findTopicHistory?.(historyPrefix(r.chatId,r.topicId),transcript,r.searchBefore)??[];
          r.text=topicPassages(matches,r.chatId)+r.text;
        }
        r.text += "\n" + voiceHeader(r.voice.duration,"Голосовое обращение") + transcript;
        r.voiceText = voiceHeader(r.voice.duration,"Голосовое обращение") + transcript;
        voiceTranscripts.observe?.(r.chatId, r.messageId, transcript);
        if (job.acked && r.updateId>0) {
          const set=reactions?.();
          void reactByMeaning(reactTg,r.chatId,r.messageId,transcript,set?.chooser,set?.options ?? DEFAULT_REACTION_OPTIONS,
            ()=>!!store.get(reactionKey),[],signal).catch(()=>{});
        }
        delete r.voice;
      } catch {
        if (signal.aborted) return;
        job.answer = "Голосовое не удалось распознать. Пришлите правки текстом в ответ на исходное сообщение.";
        job.state = "ready"; job.stage = "failed";
      }
      store.put(key,job);
      if (!allowed()) {finish("revoked");continue;}
    }
    // 0.9.75: several messages of one person in a row (forwards and a comment) where the agent answers without a
    // mention are one turn. The earliest waits for its window; a later one waits for the earliest to take it.
    if (job.state==="pending" && r.arrivedAt!==undefined) {
      const chain=collectChain(store,botId,job);
      if (chain.anchorKey!==key) continue;                 // an earlier message of the same person takes this one
      if (chain.waiting) continue;                         // a window is still open or a voice is not yet transcribed
      for (const m of chain.members) {
        const mr=m.job.route;
        if (mr.forwarded) r.forwarded=true;
        if (mr.typedComment) r.typedComment=true;
        r.text += "\n\n"+(r.forwarded && mr.typedComment ? "[Собственный комментарий отправителя]\n" : "")+(mr.ownText ?? mr.text)+(mr.ownText!==undefined && mr.voiceText ? "\n"+mr.voiceText : "");
        if (mr.examples?.length) r.examples=[...(r.examples ?? []),...mr.examples];
        // Topic window: the merged messages are in this turn — the next turn does not bring them again as new.
        if (r.windowUpTo!==undefined) r.windowUpTo=Math.max(r.windowUpTo,mr.messageId);
        store.put(m.key,{...m.job,state:"ready",answer:NO_REPLY,mergedInto:r.updateId});
      }
      if (chain.members.length || r.collectUntil!==undefined) {delete r.collectUntil; delete r.arrivedAt; store.put(key,job);}
    }
    if (job.state==="pending" && r.ambiguousMedia) {
      job.answer="В этой теме несколько подходящих сообщений с вложениями. Ответьте на нужное фото или файл и отметьте бота.";
      job.state="ready"; job.stage="question";
    }
    if (job.state==="pending") {
      delete r.precedingExamples;
      if (r.waitUntil!==undefined) {delete r.waitUntil;store.put(key,job);}
    }
    let isolatedResult:Awaited<ReturnType<NonNullable<typeof executor>["read"]>>|undefined;
    if (executor && (job.state==="pending" || job.state==="submitted") && job.executorRetryAt!==undefined) {
      if (job.executorRetryAt>Date.now()) continue;
      if (job.state==="pending" && job.executionToken) {
        try {
          isolatedResult=await executor.read(job.executionToken,signal);
          if (isolatedResult.state!=="missing") {
            if (!allowed()) {finish("revoked");continue;}
            delete r.examples;
            job.state="submitted"; job.submittedAt=Date.now();
            store.put(key,job);
          } else isolatedResult=undefined;
        } catch {
          if (signal.aborted) return;
          job.executorRetryAt=Date.now()+15000;
          store.put(key,job);
          continue;
        }
      }
    }
    const localInputs:(ImageAttachment|ReturnType<typeof localFileInput>|ReturnType<typeof opaqueAttachmentInput>)[]=[];
    const remoteInputs:IsolatedAttachment[]=[];
    let waiting=false;
    if (job.state==="pending" && r.examples?.length) {
      try {
        if (!receiveExample) throw Error("missing_receiver");
        if (r.examples.length>maxGroupAttachments) throw Error("attachment_too_large");
        let imageSize=0;
        for (const example of r.examples) {
          if (!allowed()) break;
          const got=await settled(key+":file:"+example.messageId,()=>receiveExample(example,r),true);
          if (!got) {waiting=true; break;}
          if ("error" in got) throw got.error;
          const received=got.value as Awaited<ReturnType<typeof receiveExample>>;
          if (!allowed()) break;
          const image="type" in received ? received : example.image
            ? await readSavedImage(received,signal).catch(err=>{if (!example.document) throw err;})
            : undefined;
          if (image) {
            imageSize+=image.url.length;
            if (imageSize>maxEncodedImages) throw Error("attachment_too_large");
            if (executor) remoteInputs.push(image);
            else localInputs.push(image);
          }
          if (!("type" in received) && (!image || example.document)) {
            if (executor) remoteInputs.push(isolatedFile(await executor.upload(received,signal),!example.pdf));
            // Any file, any format: the agent gets the saved file and reads it with its own tools.
            else localInputs.push(localFileInput(received,fileHostId));
          }
        }
        if (!allowed()) {finish("revoked");continue;}
        // С50: a file of this message is still downloading — other chats go on; this one resumes on a later pass.
        if (waiting) continue;
        for (const k of [...slowWork.keys()]) if (k.startsWith(key+":file:")) slowWork.delete(k);
      } catch {
        if (signal.aborted) return;
        if (!allowed()) {finish("revoked");continue;}
        delete job.opaqueFiles;
        job.answer="Не удалось получить все файлы. Ответьте на исходное сообщение и приложите материалы ещё раз.";
        job.state="ready"; job.stage="failed";
        store.put(key,job);
      }
    }
    if (job.state==="pending" && !job.taskId && !job.executionToken && policy.revision && policy.projectId) {
      job.taskId=randomUUID();
      if (executor) job.executionToken=randomUUID();
      store.atomic(()=>{
        store.put(`group:task-message:${botId}:${r.chatId}:${r.topicId}:${r.messageId}`,job.taskId);
        store.put("group:origin:"+job.taskId,{owner,bot:botId,sender:r.senderId,chatId:r.chatId,
          topicId:r.topicId,messageId:r.messageId,threadId:r.threadId,revision:policy.revision,projectId:policy.projectId,
          executionToken:job.executionToken});
        awaitProjectProposal(store,job.taskId!,r.chatId,r.topicId,policy.projectId!);
        store.put(key,job);
      });
    }
    const taskNote=job.taskId ? groupTaskNote(job.taskId) : "";
    if (executor && (job.state==="pending" || job.state==="submitted")) {
      try {
        if (job.state==="pending") {
          job.executionToken ??= randomUUID();
          store.put(key,job);
          await executor.submit(job.executionToken,[r.text,taskNote].filter(Boolean).join("\n"),signal,remoteInputs);
          markHanded(store,r.threadId,r.windowUpTo);
          delete r.examples;
          job.state="submitted"; job.submittedAt=Date.now();
          store.put(key,job);
        }
        if (!job.executionToken) {finish("revoked");continue;}
        const result=isolatedResult ?? await executor.read(job.executionToken,signal);
        if (result.state==="waiting") continue;
        job.answer=result.state==="finished" ? result.text : "Не уверен, что это сделано, — проверьте, пожалуйста, или повторите просьбу.";
        if (result.state!=="finished") job.stage="failed";
        job.state="ready";
        store.put(key,job);
      } catch {
        if (signal.aborted) return;
        job.executorRetryAt=Date.now()+15000;
        store.put(key,job);
        continue;
      }
    }
    // С105: a message the bot has already replied to — after a pause, a restart or a late delivery — is not given again.
    if (job.state==="pending" && answered(r)) {job.answer=NO_REPLY; job.state="ready";}
    if (job.state==="pending") {
      const thread = await sdk.threads.get({threadId:r.threadId,signal});
      if (!belongsToGroup(thread)) {finish("revoked");continue;}
      const provider=(thread as {providerId?:string}).providerId;
      const role=senderRole(store,botId,owner,r.chatId,r.senderId,provider);
      if (role==="none") {finish("revoked");continue;}
      // Whose word this message's turn carries; a turn the bridge gives without a message (the bot added) has none.
      if (r.messageId>0) store.put(turnAuthorKey(r.threadId,r.updateId),r.senderId);
      // С67: the message this turn answers, for a question to the owner (a link to it, or the message itself forwarded).
      // A turn the bridge gives itself (the owner's answer, a deferred task) keeps the person's original request: the
      // next question names that person, not «Владелец».
      if (r.messageId>0 && (r.updateId>0 || !store.get(turnMessageKey(r.threadId))))
        store.put(turnMessageKey(r.threadId),{chat:r.chatId,topic:r.topicId,message:r.messageId,sender:r.senderId,
          ...(r.senderName && {senderName:r.senderName}),text:String(r.ownText ?? r.text ?? "").slice(0,1500)});
      job.guest=role==="member" || !!policy.isolated;
      const settings=activeGroupSettings(store,botId,r.chatId);
      const title=store.get<{title?:string}>(`visibility:${botId}:group:${r.chatId}`)?.title ?? "эта группа";
      const senderName=r.senderName ?? "участник";
      const asks=askNotes(store,botId,r.chatId);
      const rulesBase=policy.privateChat
        ? `Личный чат в Telegram: пишет ${senderName}, у него есть доступ к тебе и он может тебе поручать. Отвечай ему здесь.\n${DISCLOSURE}`
        : rulesNote({title,settings,role,senderName,status:authorStatus(store,botId,owner,r.senderId)});
      const people=policy.privateChat ? "" : peopleNote(store,botId,owner,r.senderId);
      // С55: the owner wrote without a mention; the agent decides whether the message is meant for it.
      const unaddressed=r.ownerUnaddressed ? "Владелец написал в группе без отметки. Если реплика обращена не к тебе (он говорит с другими людьми), ничего не делай и ответь ровно "+NO_REPLY+"." : "";
      const leader=r.leaderUnaddressed ? "Сообщение в теме без отметки; ты ведёшь эту тему. Если оно обращено не к тебе или ответ не нужен, ничего не делай и ответь ровно "+NO_REPLY+"." : "";
      // Agents in chats (items 5 and 7): who leads the topic, which colleagues are here, a colleague called once.
      const topic=topicNote(store,policy,agentBots(store),id=>store.get<string>(`chat:agent-name:${id}`),
        agentBots(store).includes(r.senderId));
      const day=todayOf ? (()=>{try {return todayOf(r.chatId,r.topicId);} catch {return "";}})() : "";
      // 0.9.77: a person changed how the agent answers here since its last turn — one line, so it is not surprised.
      const seenKey="group:settings-seen:"+r.threadId;
      const replyChanges=groupSettingsLog(store,botId,r.chatId).filter(c=>c.at>Math.max(store.get<number>(seenKey) ?? 0,Date.now()-86400_000) && c.changes.reply && !c.by.startsWith("мост"));
      const lastReply=replyChanges.at(-1);
      const modeChanged=lastReply ? `Режим ответа в этом чате сменил ${lastReply.by}: теперь ${lastReply.changes.reply[1]==="mention" ? "только по отметке или ответу на твоё сообщение" : "отвечаешь сам, когда к тебе по делу"}.` : "";
      store.put(seenKey,Date.now());
      const rules=[rulesBase,people,asks,unaddressed,leader,topic,day,modeChanged].filter(Boolean).join("\n");
      // A running session keeps the rules it started with: the rules in force come with the turn — in full once per edit,
      // otherwise one line (0.9.59).
      const rulesVersionKey="group:rules-version:"+r.threadId;
      const inForce=policy.projectId && turnRules ? await turnRules(policy.projectId).catch(()=>null) : null;
      const placeRule="Итог хода в этом разговоре уходит человеку, чьё сообщение начало ход; ответ другому треду отправляй командой bb thread tell, не итогом.";
      const rulesVersion=JSON.stringify([inForce?.version,placeRule]);
      const changedRules=store.get<string>(rulesVersionKey)!==rulesVersion;
      const rulesInForce=changedRules ? [inForce && `Правила обновлены (версия ${inForce.version}). Прежние формулировки правил в этом разговоре отменены — следуй этим:\n\n${inForce.text}`,placeRule].filter(Boolean).join("\n") :
        inForce ? `Правила организации без изменений (версия ${inForce.version}).` : "";
      const permissionMode=permissionModeFor(role,provider,store.get<PermissionMode>(accessModeKey));
      const latest=await sdk.threads.events.list({threadId:r.threadId,order:"desc",limit:"1",signal});
      {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");continue;} if (safe==="retry") {deferVerify();continue;} clearVerify();}
      // A message that arrives while the thread works goes into the running turn and gets its own answer
      // there, as in the owner's chat. If that turn ends without it, the message is sent again in turn order.
      const busy=(thread as {status?:string}).status==="active" && !job.busyOnce;
      const submission=destinationOf(r);
      const metadata=busy ? routes.busyIngress(r.threadId,submission,undefined,senderName) : [routes.ingress(r.threadId,submission)];
      if (busy) job.busyLabel=/\[telegram-answer:([a-f0-9-]+)\]/.exec(metadata[1]?.text ?? "")?.[1];
      else delete job.busyLabel;
      // A message joining a running turn lowers that turn's rights to its author's before the agent sees it (review 0.9.77).
      if (busy && (r.senderId!==owner || submission.forwardedOnly)) {
        const running=(await sdk.threads.events.list({threadId:r.threadId,order:"desc",limit:"1",types:["turn/started"],signal}))[0];
        // The least trusted of those who joined stays: the owner, then people with access, then anyone else.
        const trust=(id:number)=>id===owner ? 2 : hasAccess(store,botId,owner,id) ? 1 : 0;
        const key=running?.scope.kind==="turn" ? turnMixedKey(r.threadId,running.scope.turnId) : undefined;
        if (running?.scope.kind==="turn") {
          if (submission.forwardedOnly) routes.markForwardedTurn(r.threadId,running.scope.turnId);
          const participants=turnParticipantsKey(r.threadId,running.scope.turnId);
          const ids=store.get<number[]>(participants) ?? [];
          if (!ids.includes(r.senderId)) store.put(participants,[...ids,r.senderId]);
        }
        const before=key ? store.get<number>(key) : undefined;
        if (key && (before===undefined || trust(r.senderId)<trust(before))) store.put(key,r.senderId);
      }
      job.cursor=latest[0]?.seq ?? 0;
      if (job.cursor>(store.get<number>("group:last-seq:"+r.threadId) ?? 0)) store.put("group:last-seq:"+r.threadId,job.cursor);
      if (r.updateId>0 && r.messageId>0) {
        recordPromiseLabel(store,{
          label:job.busyLabel,threadId:r.threadId,chatId:r.chatId,topicId:r.topicId,
          messageId:r.messageId,updateId:r.updateId,botId,ownerId:owner,revision:job.revision,
          senderName,excerpt:String(r.ownText ?? r.text ?? ""),afterSeq:job.cursor,kind:"group",
        });
      }
      delete r.examples;
      job.state="submitted"; job.submittedAt=Date.now();
      store.put(key,job);
      // The mode persists for later messages of the thread, so every group message sets it.
      await sdk.threads.send({threadId:r.threadId,mode:busy ? "steer-if-active" : "queue-if-active",permissionMode,
        input:[{type:"text",text:r.text,mentions:[]},...localInputs,...metadata,{type:"text" as const,visibility:"agent-only" as const,text:rules,mentions:[]},
          ...(rulesInForce ? [{type:"text" as const,visibility:"agent-only" as const,text:rulesInForce,mentions:[]}] : []),
          ...(taskNote ? [{type:"text" as const,visibility:"agent-only" as const,text:taskNote,mentions:[]}] : [])]});
      if (changedRules) store.put(rulesVersionKey,rulesVersion);
      markHanded(store,r.threadId,r.windowUpTo);
    }
    if (job.state==="submitted") {
      const events=await sdk.threads.events.list({threadId:r.threadId,afterSeq:String(job.cursor??0),limit:"100",signal,
        types:["client/turn/requested","turn/input/accepted","item/started","item/completed","turn/completed"]});
      for (const e of events) {
        if (e.type==="client/turn/requested") routes.requested(r.threadId,e.data);
        if (e.scope.kind==="turn") {
          const turn=e.scope.turnId;
          if (e.type==="turn/input/accepted") await acceptRequest(r.threadId,turn,e.data.clientRequestId,e.seq);
          const label=job.busyLabel;
          if (job.retryAfterPlugin) {
            if (label && routes.sameTask(routes.busyAnswer(r.threadId,turn,label),dest)) {
              const item=e.type==="item/completed" ? e.data.item : undefined;
              const body=item?.type==="agentMessage" && !item.parentToolCallId ? busyAnswerText(item.text,label) : undefined;
              const result=body && stripTelegramMarkers(body).trim();
              if (result && result!==NO_REPLY) {
                job.answer=body; job.turnId=turn; job.state="ready";
              } else if (e.type==="turn/completed") {
                job.answer=finalUnavailable; job.stage="failed"; job.state="ready";
              }
            }
            job.cursor=e.seq; if (e.seq>(store.get<number>("group:last-seq:"+r.threadId) ?? 0)) store.put("group:last-seq:"+r.threadId,e.seq);
            if (job.state==="ready") break;
            continue;
          }
          const exact=routes.destination(r.threadId,turn);
          let ownsFinal=routes.sameTask(exact,dest);
          if (r.updateId>0 && (label || !exact) && (e.type==="turn/completed" || e.type==="item/completed")) {
            const disposition=await finalFor(r,turn,e.seq);
            ownsFinal=disposition==="deliver";
            if (disposition==="covered" && e.type==="turn/completed") {
              job.turnId=turn; job.answer=NO_REPLY; job.state="ready";
            }
          }
          if (label && routes.busyAnswer(r.threadId,turn,label)) {
            // This message joined a running turn: its answer is the enclosed one.
            const enclosed=e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId ?
              busyAnswerText(e.data.item.text,label) : undefined;
            if (enclosed) {
              markPromiseDelivered(store,r.threadId,label,enclosed);
              job.turnId=turn; job.answer=enclosed; job.state="ready";
              // The turn goes on after this answer: if a subthread's completion joins it, its final is that result.
              // The watch follows the rest of the turn: further answers with this label always; the unlabelled final
              // only when the turn is this message's (checked again when the turn ends).
              store.put(`group:turn-watch:${botId}:${r.threadId}:${turn}`,{threadId:r.threadId,turn,afterSeq:e.seq,
                route:r,ownerId:job.ownerId,revision:job.revision,at:Date.now(),labelAt:e.createdAt,taskId:job.taskId,replyTo:job.replyTo,
                label,labelled:enclosed} satisfies TurnWatch);
            }
            else if (e.type==="turn/completed" && !ownsFinal) {
              // The turn ended without that answer: send the message again, in turn order — unless the bot has already
              // replied to it (С105): then it is answered and not given twice.
              if (answered(r)) {job.turnId=turn; job.answer=NO_REPLY; job.state="ready";}
              else {job.busyOnce=true; delete job.busyLabel; job.state="pending";}
            }
          }
          if (job.state==="submitted" && ownsFinal) {
            job.started=true;
            if (e.type==="item/started" && GROUP_TOOL_ITEMS.has(e.data.item.type)) {
              job.step=stepLabel(e.data.item as never);
              // 0.9.77: work went on after the agent's message — if it writes again, that message was interim.
              if (job.turnId===turn && job.answer!==undefined) job.interim=true;
            }
            if (e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId) {
              const text=e.data.item.text;
              if (!job.agentLine && (r.updateId<=0 || isBusyAnswer(text) || !await pluginJoined(r.threadId,turn,e.seq)))
                job.agentLine=firstLine(stripTelegramMarkers(text).replace(/\[\/?telegram-answer(?::[a-f0-9-]+)?\]/g,"").trim()) || undefined;
              // Answers to other messages that joined this turn are not this message's answer.
              const own=label ? busyAnswerText(text,label) : undefined;
              if (job.interim) {delete job.answer; delete job.interim;}
              if (own || !isBusyAnswer(text)) {job.turnId=turn; job.answer=own ?? text;}
            }
            if (e.type==="turn/completed") {
              const wrote=store.get<{chat:number;topic:number;at:number;sent?:{t:string;at:number}[]}>(sentInTurnKey(r.threadId));
              const here=!!wrote && wrote.chat===r.chatId && wrote.topic===(r.topicId ?? 0);
              const final=job.turnId===turn ? sameWords(stripTelegramMarkers(job.answer ?? "").replace(/\[\/?telegram-answer(?::[a-f0-9-]+)?\]/g,"")) : "";
              // The final answer repeats what the agent already sent here in this turn: no second copy. An interim
              // message («взял, будет готово через 10 минут») never hides the real result («Готово.»): a part only
              // counts as a repeat for a long answer, and only texts sent during this task count.
              // Only an exact repeat (words, without spacing and formatting) of what the agent sent here during this
              // very turn is skipped; a lost answer is worse than a double one, so any doubt publishes.
              const sentNow=(wrote?.sent ?? []).filter(x=>x.at>=(job.submittedAt ?? 0));
              // A deferred task the bridge started itself (no person waiting): any send here in it is the answer.
              // The owner's answer to a group's question is a person's turn: only an exact repeat is skipped.
              const repeated=here && (job.followUp ? sentNow.length>0 : !!final && sentNow.some(x=>x.t===final));
              if (e.data.status!=="completed") {job.answer="Не получилось сделать — повторите или уточните, пожалуйста."; job.stage="failed";}
              else if (repeated) job.answer=NO_REPLY;
              else if (job.turnId!==turn || !job.answer?.trim()) job.answer=NO_REPLY;   // С79: no service line; the reaction stays
              else if (r.updateId>0 && job.answer.trim()!==NO_REPLY && await pluginJoined(r.threadId,turn,e.seq)) {
                store.put(key,{...requestFinal(job),progressId:job.progressId});
                continue jobs;
              }
              store.waiting?.completed(r.threadId,turn,e.data.status==="completed" && here && job.answer===NO_REPLY);
              job.state="ready";
            }
          }
        }
        job.cursor=e.seq; if (e.seq>(store.get<number>("group:last-seq:"+r.threadId) ?? 0)) store.put("group:last-seq:"+r.threadId,e.seq);
        if (job.state!=="submitted") break;
      }
      // A message the thread never took up (no turn, the thread idle) is given once more, then closed honestly.
      if (job.retryAfterPlugin && job.state==="submitted" && events.length<100 && Date.now()-(job.submittedAt ?? 0)>LOST_SUBMIT_MS) {
        job.answer=finalUnavailable; job.stage="failed"; job.state="ready";
      }
      if (!job.retryAfterPlugin && job.state==="submitted" && !job.turnId && Date.now()-(job.submittedAt ?? 0)>LOST_SUBMIT_MS) {
        const t=await sdk.threads.get({threadId:r.threadId,signal}).catch(()=>undefined);
        if (t && (t as {status?:string}).status!=="active") {
          if (answered(r)) {job.answer=NO_REPLY; job.state="ready";}
          else if (!job.resubmitted) {job.resubmitted=true; job.busyOnce=true; delete job.busyLabel; delete job.submittedAt; job.state="pending";}
          else {job.answer="Это сообщение у меня потерялось и осталось без ответа — повторите его, пожалуйста."; job.stage="failed"; job.state="ready";}
        }
      }
      store.put(key,job);
      // On the employee's pause a message waiting for its end shows only the «seen» sign; the live line comes when
      // its turn really starts.
      if (job.state==="submitted" && !job.retryAfterPlugin && (job.started || !await isPaused())) await updateProgress();
    }
    // С45: the bridge's service reaction over the chosen one: a question, a refusal or a failure.
    if (job.state==="ready" && job.stage && !job.stageShown && r.updateId>0) {
      store.put(reactionKey,job.stage); job.stageShown=true; store.put(key,job);
      await react(reactTg,r.chatId,r.messageId,SERVICE_REACTIONS[job.stage]);
    }
    // NO_REPLY means "say nothing" in any group turn, not only in a scheduled check: the reaction stays as the sign.
    if (job.state==="ready" && stripTelegramMarkers(job.answer ?? "").trim()===NO_REPLY) {finish("done");continue;}
    let sendingFiles=true;   // the answer's files go first; a refusal there may be about media only
    if (job.state==="ready") try {
      // Ready jobs may be resumed long after submission, including between reply parts.
      if (!allowed()) {finish("revoked");continue;}
      if (!executor && !belongsToGroup(await sdk.threads.get({threadId:r.threadId,signal}))) {finish("revoked");continue;}
      const outputRoot=async()=>{
        const thread=await sdk.threads.get({threadId:r.threadId,signal});
        if (!belongsToGroup(thread) || !thread.environmentId) throw Error("missing_environment");
        const env=await sdk.environments.get({environmentId:thread.environmentId,signal});
        // Without a configured file host the thread's own environment is used: the bridge reads it locally.
        if (!env.path || (fileHostId && env.hostId!==fileHostId)) throw Error("group_export_host_mismatch");
        return env.path;
      };
      let text=stripTelegramMarkers(job.answer!);
      // Files are forbidden here but text is not: the answer goes as text, its attachments named as not sent.
      if (job.noFiles) for (const link of localArtifacts(text)) text=text.replace(link.markdown,(link.label ? link.label+" " : "")+"(вложение не отправлено: нет права на файлы)");
      // A link to a file not of this conversation is not attached: the agent is told where to copy it and sends it
      // itself (the owner's own forum is not limited).
      const refused:string[]=[];
      if (mayAttach && !executor && !policy.ownerSharedProject)
        for (const link of localArtifacts(text))
          if (!await mayAttach(r.threadId,{chatId:r.chatId,topicId:r.topicId,privateChat:!!policy.privateChat},link.path)) {
            refused.push(link.path); text=text.replace(link.markdown,link.label || "");
          }
      if (refused.length && !job.refusedNotified) {
        job.refusedNotified=true; store.put(key,job);
        const dir=job.taskId ? "outputs/"+job.taskId.slice(0,8)+"/" : "outputs/ (новым файлом в этом ходе)";
        const target=policy.privateChat ? "--person "+r.chatId : "--chat "+r.chatId+(r.topicId ? " --topic "+r.topicId : "");
        await sdk.threads.send({threadId:r.threadId,mode:"queue-if-active",input:[{type:"text",mentions:[],text:
          "[Мост Telegram] Файл(ы) из ответа не ушли в чат: они не из этого разговора — "+refused.join(", ")+
          ". Скопируй их в "+dir+" и пришли командой bb telegram-projects send "+target+" --file <путь>. Ответ человеку не повторяй."}]}).catch(()=>undefined);
      }
      const artifacts=localArtifacts(text);
      const caption=routedCaption(text,artifacts);
      // С106: after an edit in this turn, in this chat and topic, the answer is a reply to the edited message.
      const edited=store.get<{chat:number;topic:number;message:number;at:number}>(editedInTurnKey(r.threadId));
      const afterEdit=edited && edited.chat===r.chatId && edited.topic===r.topicId && edited.at>=(job.submittedAt ?? 0) ? edited.message : undefined;
      // Kept on the job, so the rest of a delivery resumed on the next pass also replies to the edited message.
      if (afterEdit) {job.replyTo??=afterEdit; store.put(key,job); store.del(editedInTurnKey(r.threadId));}
      // A turn the bridge gave without a message (the bot was just added) is a plain message, not a reply.
      const reply={chatId:r.chatId,topicId:r.topicId,replyTo:job.replyTo ?? (r.messageId>0 ? r.messageId : undefined)};
      const byPath=new Map(artifacts.map(link=>[link.path,link]));
      const unique=[...byPath.values()];
      const links=artifacts.filter(link=>routedArtifactKind(byPath.get(link.path)!)!=="image");
      const paths=[...unique.filter(link=>routedArtifactKind(link)==="pdf"),
        ...unique.filter(link=>routedArtifactKind(link)==="document").slice(0,3)].map(link=>link.path);
      const albumType=albumKind(unique,link=>routedArtifactKind(link)==="image"?"photo":"document");
      if (albumType && (job.albumSent || (!job.pdfIndex && !job.imageIndex))) {
        if (!job.albumSent) {
          const files:AlbumMedia[]=[];
          try {
            const workspace=executor ? undefined : await outputRoot();
            for (const link of unique) {
              if (!allowed()) break;
              const kind=routedArtifactKind(link);
              const path=link.path;
              const source=kind==="document" ? job.opaqueFiles?.find(file=>opaqueFileReference(file)===path) : undefined;
              const result=executor ? await executor[kind](job.executionToken!,path,signal) :
                kind==="image" ? await readGroupImage(workspace!,path) :
                kind==="pdf" ? await readGroupPdf(workspace!,path) :
                source ? {name:source.name,document:new Blob([new Uint8Array((await readOpaqueAttachment(source)).bytes)],
                  {type:"application/octet-stream"})} : await readGroupDocument(workspace!,path);
              files.push({kind:albumType,name:result.name,data:"photo" in result ? result.photo : result.document,
                caption:albumCaption(link.label,result.name)});
            }
          } catch {
            if (signal.aborted) return;
          }
          {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");continue;} if (safe==="retry") {deferVerify();continue;} clearVerify();}
          if (files.length!==unique.length) {
            job.answer="Не удалось подготовить все вложения альбома.";
            store.put(key,job);
            continue;
          }
          const end=beginTopicSend(store,botId,r.chatId,r.topicId);
          try {
            store.put(key,{...job,state:"sending"});
            const sent=await sendAlbum(transport(r.chatId),{...reply,replyTo:reply.replyTo ?? 0},files);
            job.albumSent=sent.messageIds;
            store.put(key,job);
          } finally {end();}
        }
        text=artifacts.reduce((body,link)=>body.replace(link.markdown,""),text).trim();
        if (!text) {finish("done",job.albumSent.at(-1));continue;}
      }
      for (let i=job.albumSent ? paths.length : job.pdfIndex??0;i<paths.length;i++) {
        let document;
        const path=paths[i];
        const kind=routedArtifactKind(byPath.get(path)!);
        try {
          if (executor) {
            if (!job.executionToken) throw Error("missing_isolated_receipt");
            document=await executor[kind==="pdf"?"pdf":"document"](job.executionToken,path,signal);
          } else if (kind==="pdf") document=await readGroupPdf(await outputRoot(),path);
          else {
            const source=job.opaqueFiles?.find(file=>opaqueFileReference(file)===path);
            if (source) {
              const {bytes}=await readOpaqueAttachment(source);
              document={name:source.name,document:new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"})};
            } else document=await readGroupDocument(await outputRoot(),path);
          }
        } catch {
          if (signal.aborted) return;
          job.failedPdfs=[...(job.failedPdfs??[]),paths[i]];
          job.pdfIndex=i+1;
          store.put(key,job);
          continue;
        }
        {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");break;} if (safe==="retry") {deferVerify();continue jobs;} clearVerify();}
        store.put(key,{...job,state:"sending"});
        const docPayload=(html:boolean)=>outboundMessagePayload({...reply,text:caption!==undefined ? (html ? caption : plainFromHtml(caption)) :
          (kind==="pdf" && artifacts.length>1 ? document.name.slice(0,900) : undefined),html:html && caption!==undefined,
          file:{kind:"document",name:document.name,data:document.document}});
        const sent=await sendCaptioned(transport(r.chatId),docPayload,caption!==undefined);
        if (!Number.isSafeInteger(sent?.message_id) || !sent.document?.file_id) throw Error("missing_document_receipt");
        job.pdfIndex=i+1;
        if (caption) {job.captionSent=true;store.waiting?.delivered(r.chatId,r.topicId,sent.message_id,plainFromHtml(caption));}
        store.atomic(()=>{
          if (kind==="pdf" && job.taskId) store.put("group:completed-pdf:"+job.taskId,sent.message_id);
          if (kind==="pdf" && "sha256" in document && "path" in document) store.put(`group:pdf:${botId}:${r.chatId}:${r.topicId}:${sent.message_id}`,{
            owner,threadId:r.threadId,path:document.path,sha256:document.sha256,fileId:sent.document.file_id});
          store.put(key,job);
        });
      }
      if (!store.get(key)) continue;
      if (!allowed()) {finish("revoked");continue;}
      for (const link of links) text=text.replace(link.markdown,
        !paths.includes(link.path) || job.failedPdfs?.includes(link.path) ? "Вложение недоступно для отправки." : "");
      const imageLinks=artifacts.filter(link=>routedArtifactKind(byPath.get(link.path)!)==="image");
      const images=[...new Set(imageLinks.map(link=>link.path))];
      for (let i=job.albumSent ? images.length : job.imageIndex??0;i<images.length;i++) {
        let image;
        try {
          if (executor) {
            if (!job.executionToken) throw Error("missing_isolated_receipt");
            image=await executor.image(job.executionToken,images[i],signal);
          } else {
            image=await readGroupImage(await outputRoot(),images[i]);
          }
        } catch {
          if (signal.aborted) return;
          job.failedImages=[...(job.failedImages??[]),images[i]];
          job.imageIndex=i+1;
          store.put(key,job);
          continue;
        }
        {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");break;} if (safe==="retry") {deferVerify();continue jobs;} clearVerify();}
        store.put(key,{...job,state:"sending"});
        const photoPayload=(html:boolean)=>outboundMessagePayload({...reply,text:caption!==undefined && !html ? plainFromHtml(caption) : caption,
          html:html && caption!==undefined,file:{kind:"photo",name:image.name,data:image.photo}});
        const sent=await sendCaptioned(transport(r.chatId),photoPayload,caption!==undefined);
        if (!Number.isSafeInteger(sent?.message_id) || !sent.photo?.length) throw Error("missing_photo_receipt");
        job.imageIndex=i+1;
        if (caption) {job.captionSent=true;store.waiting?.delivered(r.chatId,r.topicId,sent.message_id,plainFromHtml(caption));}
        store.put(key,job);
      }
      if (!store.get(key)) continue;
      if (!allowed()) {finish("revoked");continue;}
      for (const link of imageLinks) text=text.replace(link.markdown,
        job.failedImages?.includes(link.path) ? "Изображение недоступно для отправки." : "");
      if (job.captionSent || !text.trim()) {finish("done");continue;}
      sendingFiles=false;
      // The same formatting as a private chat: bold, italic, lists, code and links; plain words if Telegram rejects it.
      const parts=renderTelegramParts(cleanAssistantText(text).trim());
      for (let i=job.part??0;i<parts.length;i++) {
        {const safe=await checkSafeToSend(); if (safe==="revoked") {finish("revoked");break;} if (safe==="retry") {deferVerify();continue jobs;} clearVerify();}
        store.put(key,{...job,state:"sending",part:i});
        const send=(html:boolean)=>{
          const {method,body}=outboundMessagePayload({...reply,replyTo:i===0 ? reply.replyTo : undefined,text:html ? parts[i] : plainFromHtml(parts[i]),html});
          return transport(r.chatId)(method,body);
        };
        const sent=await send(true).catch(error=>{
          if (error instanceof TelegramFailure && error.code==="telegram_400") return send(false);
          throw error;
        });
        if (job.taskId && Number.isSafeInteger(sent?.message_id))
          store.put(`group:task-message:${botId}:${r.chatId}:${r.topicId}:${sent.message_id}`,job.taskId);
        if (i+1===parts.length) {finish("done",sent?.message_id);store.waiting?.delivered(r.chatId,r.topicId,sent?.message_id,text);}
        else {job.part=i+1; store.put(key,{...job,state:"ready",part:i+1});}
      }
    } catch (error) {
      // С113: Telegram does not let the bot write here (no right to post, removed from the chat) — the answer cannot be
      // delivered, and retrying forever helps nobody: one line to the curator (or the owner) says what is missing.
      if (!(error instanceof TelegramFailure) || error.ambiguous || !["telegram_rights","telegram_403"].includes(error.code)) throw error;
      // Only media may be forbidden (photos or documents) while text is allowed: once more as text, without files.
      if (error.code==="telegram_rights" && sendingFiles && !job.noFiles) {
        job.noFiles=true; store.put(key,job);
        if (r.chatId<0) await tellCannotAnswer(store,botId,owner,r,"files",transport);
        continue;
      }
      if (r.chatId<0) await tellCannotAnswer(store,botId,owner,r,error.code,transport);   // a private chat: the person blocked the bot
      finish("done");
    }
  }
}
