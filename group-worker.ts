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
import {ReplyRoutes, busyAnswerText, isBusyAnswer, stripTelegramMarkers} from "./reply-routing";
import {voiceTranscripts} from "./archive";
import {askNotes} from "./send-command";
import {turnMessageKey} from "./owner-ask";
import {canInvokeGroup, contextMediaPrefix, releaseGroupAlbums, type GroupAlbumScope, type GroupTopicPolicy, type Ingress} from "./ingress";
import type {SavedTelegramFile} from "./telegram-files";
import type {GroupExample} from "./ingress";
import {TelegramFailure,type Store,type Telegram} from "./model";
import {DISCLOSURE,accessModeKey,authorStatus,activeGroupSettings,peopleNote,permissionModeFor,rulesNote,senderRole,type PermissionMode} from "./rights";
import {voiceHeader,acknowledge,react,SERVICE_REACTIONS,stepLabel,firstLine,progressText,DEFAULT_REACTION_OPTIONS,type ReactionChooser,type ReactionOption,type Stage} from "./turn-feedback";

type GroupInput = Extract<Ingress,{kind:"group"}>;
/** A submitted message without a turn for this long, while its thread is idle, is lost. */
export const LOST_SUBMIT_MS=15*60_000;
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
/** "Typing" for a submitted message stops after this long. */
export const TYPING_MAX_MS=10*60_000;

type Job = {
  route: GroupInput; ownerId:number; revision?:string;
  state:"pending"|"submitted"|"ready"|"sending"|"done"|"revoked";
  taskId?:string; progressId?:number|null;
  /** When the message was given to the thread; a submitted message without a turn does not live forever. */
  submittedAt?:number; resubmitted?:boolean;
  executionToken?:string; executorRetryAt?:number;
  pdfIndex?:number; failedPdfs?:string[];
  albumSent?:number[];
  imageIndex?:number; failedImages?:string[];
  opaqueFiles?:SavedTelegramFile[]; captionSent?:true;
  cursor?:number; turnId?:string; answer?:string; part?:number;
  /** Sent into a running turn: the selector of its separate answer; busyOnce — the plain retry is under way. */
  busyLabel?:string; busyOnce?:true;
  /** С45/С46: the visible sign and the live status of this message. */
  acked?:true; stage?:Stage; stageShown?:true; guest?:boolean;
  agentLine?:string; step?:string; startedAt?:number; progressAt?:number; progressText?:string;
};
const GROUP_TOOL_ITEMS=new Set(["commandExecution","mcpToolCall","toolCall","fileChange","webSearch"]);

// Keep thread ownership after disconnect: history may already contain group messages.
export const groupTaskNote = (taskId:string) =>
  "Group taskId: " + taskId + ". Include this ID in internal approval requests to the owner coordinator.";

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
  verifyOwnerForum?:(policy:GroupTopicPolicy)=>Promise<boolean>,
  reactions?:()=>{chooser?:ReactionChooser;options:ReactionOption[]},
  /** The rules in force for a project and their fingerprint, from the platform plugin (0.4.4); null outside an organization. */
  turnRules?:(projectId:string)=>Promise<{version:string;text:string}|null>) {
  const routes=new ReplyRoutes(store);
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
      (!policy.ownerSharedProject || !!await verifyOwnerForum?.(policy));
  },signal);
  const pending=store.list<Job>(`group:in:${botId}:`);
  pending.sort((a,b)=>a.value.route.updateId-b.value.route.updateId);
  for (const {key,value:job} of pending) {
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
    const allowed=()=>{
      const p=store.get<GroupTopicPolicy>(`group:policy:${r.chatId}:${r.topicId}`);
      sourceDenied=!sourcesVisible(p?.deliverySources,botId,r.chatId,r.topicId);
      return !isTopicPaused(store,botId,r.chatId,r.topicId) && !albumChanged(store,r.albumKey) && !sourceDenied && p?.botId===botId && p.revision===job.revision && (p.ownerId===undefined || p.ownerId===owner) && p.chatId===r.chatId && p.topicId===r.topicId && p.threadId===r.threadId &&
        owner===job.ownerId && (p.isolated===true || p.ownerTopic || p.ownerSharedProject ? canInvokeGroup(p,owner,r.senderId) : senderRole(store,botId,owner,r.chatId,r.senderId)!=="none");
    };
    if (!allowed()) {finish("revoked");continue;}
    const topicKey = `group:policy:${r.chatId}:${r.topicId}`;
    const policy=store.get<GroupTopicPolicy>(topicKey)!;
    const safeToSend=async()=>!policy.ownerSharedProject || !!await verifyOwnerForum?.(policy) && allowed();
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
    const dest={kind:"telegram" as const,chatId:r.chatId,topicId:r.topicId,updateId:r.updateId,messageId:r.messageId};
    const reactionKey=`group:reaction:${botId}:${r.updateId}`;
    // Lazy: a transport that cannot be built must not break the job (the reaction is best effort).
    const reactTg:Telegram=(method,body)=>transport(r.chatId)(method,body);
    // С45: every message that reached this agent gets a visible sign at once: 👀, then the chosen reaction.
    // A message of the owner without a mention may not be for the agent (С55): no sign until it answers.
    if (r.updateId>0 && !job.acked && !r.ownerUnaddressed) {
      job.acked=true; job.startedAt??=Date.now(); store.put(key,job);
      const set=reactions?.();
      void acknowledge(reactTg,r.chatId,r.messageId,r.ownText ?? r.text,set?.chooser,set?.options ?? DEFAULT_REACTION_OPTIONS,
        ()=>!!store.get(reactionKey),[],signal).catch(()=>{});
    }
    // С46: one live status message: the agent's first line and the current step; guests see the step only.
    const updateProgress=async()=>{
      if (!visibleProgress || policy.ownerSharedProject || r.ownerUnaddressed || r.updateId<=0 || job.progressId===null) return;
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
        voiceTranscripts.observe?.(r.chatId, r.messageId, transcript);
        delete r.voice;
      } catch {
        if (signal.aborted) return;
        job.answer = "Голосовое не удалось распознать. Пришлите правки текстом в ответ на исходное сообщение.";
        job.state = "ready"; job.stage = "failed";
      }
      store.put(key,job);
      if (!allowed()) {finish("revoked");continue;}
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
          delete r.examples;
          job.state="submitted"; job.submittedAt=Date.now();
          store.put(key,job);
        }
        if (!job.executionToken) {finish("revoked");continue;}
        const result=isolatedResult ?? await executor.read(job.executionToken,signal);
        if (result.state==="waiting") continue;
        job.answer=result.state==="finished" ? result.text : "Исполнитель потерял квитанцию. Проверьте задачу перед повтором.";
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
    if (job.state==="pending") {
      const thread = await sdk.threads.get({threadId:r.threadId,signal});
      if (!belongsToGroup(thread)) {finish("revoked");continue;}
      const provider=(thread as {providerId?:string}).providerId;
      const role=senderRole(store,botId,owner,r.chatId,r.senderId,provider);
      if (role==="none") {finish("revoked");continue;}
      store.put("group:turn-author:"+r.threadId,r.senderId);
      // С67: the message this turn answers, for a question to the owner (a link to it, or the message itself forwarded).
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
      const rules=[rulesBase,people,asks,unaddressed].filter(Boolean).join("\n");
      // A running session keeps the rules it started with: the rules in force come with the turn — in full once per edit,
      // otherwise one line (0.9.59).
      const rulesVersionKey="group:rules-version:"+r.threadId;
      const inForce=policy.projectId && turnRules ? await turnRules(policy.projectId).catch(()=>null) : null;
      const rulesInForce=!inForce ? "" : store.get<string>(rulesVersionKey)===inForce.version
        ? `Правила организации без изменений (версия ${inForce.version}).`
        : `Правила обновлены (версия ${inForce.version}) и действуют с этого хода. Прежние формулировки правил в этом разговоре отменены — следуй этим:\n\n${inForce.text}`;
      const permissionMode=permissionModeFor(role,provider,store.get<PermissionMode>(accessModeKey));
      const latest=await sdk.threads.events.list({threadId:r.threadId,order:"desc",limit:"1",signal});
      if (!allowed() || !await safeToSend()) {finish("revoked");continue;}
      // A message that arrives while the thread works goes into the running turn and gets its own answer
      // there, as in the owner's chat. If that turn ends without it, the message is sent again in turn order.
      const busy=(thread as {status?:string}).status==="active" && !job.busyOnce;
      const metadata=busy ? routes.busyIngress(r.threadId,dest,undefined,senderName) : [routes.ingress(r.threadId,dest)];
      if (busy) job.busyLabel=/\[telegram-answer:([a-f0-9-]+)\]/.exec(metadata[1]?.text ?? "")?.[1];
      else delete job.busyLabel;
      job.cursor=latest[0]?.seq ?? 0;
      delete r.examples;
      job.state="submitted"; job.submittedAt=Date.now();
      store.put(key,job);
      // The mode persists for later messages of the thread, so every group message sets it.
      await sdk.threads.send({threadId:r.threadId,mode:busy ? "steer-if-active" : "queue-if-active",permissionMode,
        input:[{type:"text",text:r.text,mentions:[]},...localInputs,...metadata,{type:"text" as const,visibility:"agent-only" as const,text:rules,mentions:[]},
          ...(rulesInForce ? [{type:"text" as const,visibility:"agent-only" as const,text:rulesInForce,mentions:[]}] : []),
          ...(taskNote ? [{type:"text" as const,visibility:"agent-only" as const,text:taskNote,mentions:[]}] : [])]});
      if (inForce) store.put(rulesVersionKey,inForce.version);
    }
    if (job.state==="submitted") {
      const events=await sdk.threads.events.list({threadId:r.threadId,afterSeq:String(job.cursor??0),limit:"100",signal,
        types:["client/turn/requested","turn/input/accepted","item/started","item/completed","turn/completed"]});
      for (const e of events) {
        if (e.type==="client/turn/requested") routes.requested(r.threadId,e.data);
        if (e.scope.kind==="turn") {
          const turn=e.scope.turnId;
          if (e.type==="turn/input/accepted") routes.accept(r.threadId,turn,e.data.clientRequestId);
          const label=job.busyLabel;
          if (label && routes.busyAnswer(r.threadId,turn,label)) {
            // This message joined a running turn: its answer is the enclosed one.
            const enclosed=e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId ?
              busyAnswerText(e.data.item.text,label) : undefined;
            if (enclosed) {job.turnId=turn; job.answer=enclosed; job.state="ready";}
            else if (e.type==="turn/completed" && !routes.sameTask(routes.destination(r.threadId,turn),dest)) {
              // The turn ended without that answer: send the message again, in turn order.
              job.busyOnce=true; delete job.busyLabel; job.state="pending";
            }
          }
          if (job.state==="submitted" && routes.sameTask(routes.destination(r.threadId,turn),dest)) {
            if (e.type==="item/started" && GROUP_TOOL_ITEMS.has(e.data.item.type)) job.step=stepLabel(e.data.item as never);
            if (e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId) {
              const text=e.data.item.text;
              job.agentLine??=firstLine(stripTelegramMarkers(text).replace(/\[\/?telegram-answer(?::[a-f0-9-]+)?\]/g,"").trim()) || undefined;
              // Answers to other messages that joined this turn are not this message's answer.
              const own=label ? busyAnswerText(text,label) : undefined;
              if (own || !isBusyAnswer(text)) {job.turnId=turn; job.answer=own ?? text;}
            }
            if (e.type==="turn/completed") {
              if (e.data.status!=="completed") {job.answer="Помощнику не удалось завершить это поручение."; job.stage="failed";}
              else if (job.turnId!==turn || !job.answer?.trim()) job.answer="Помощник завершил ход без текстового ответа.";
              job.state="ready";
            }
          }
        }
        job.cursor=e.seq;
        if (job.state!=="submitted") break;
      }
      // A message the thread never took up (no turn, the thread idle) is given once more, then closed honestly.
      if (job.state==="submitted" && !job.turnId && Date.now()-(job.submittedAt ?? 0)>LOST_SUBMIT_MS) {
        const t=await sdk.threads.get({threadId:r.threadId,signal}).catch(()=>undefined);
        if (t && (t as {status?:string}).status!=="active") {
          if (!job.resubmitted) {job.resubmitted=true; job.busyOnce=true; delete job.busyLabel; delete job.submittedAt; job.state="pending";}
          else {job.answer="Это сообщение у меня потерялось и осталось без ответа — повторите его, пожалуйста."; job.stage="failed"; job.state="ready";}
        }
      }
      store.put(key,job);
      if (job.state==="submitted") await updateProgress();
    }
    // С45: the bridge's service reaction over the chosen one: a question, a refusal or a failure.
    if (job.state==="ready" && job.stage && !job.stageShown && r.updateId>0) {
      store.put(reactionKey,job.stage); job.stageShown=true; store.put(key,job);
      await react(reactTg,r.chatId,r.messageId,SERVICE_REACTIONS[job.stage]);
    }
    // NO_REPLY means "say nothing" in any group turn, not only in a scheduled check: the reaction stays as the sign.
    if (job.state==="ready" && stripTelegramMarkers(job.answer ?? "").trim()===NO_REPLY) {finish("done");continue;}
    if (job.state==="ready") {
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
      const artifacts=localArtifacts(text);
      const caption=routedCaption(text,artifacts);
      const reply={chatId:r.chatId,topicId:r.topicId,replyTo:r.messageId};
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
          if (!allowed() || !await safeToSend()) {finish("revoked");continue;}
          if (files.length!==unique.length) {
            job.answer="Не удалось подготовить все вложения альбома.";
            store.put(key,job);
            continue;
          }
          const end=beginTopicSend(store,botId,r.chatId,r.topicId);
          try {
            store.put(key,{...job,state:"sending"});
            const sent=await sendAlbum(transport(r.chatId),reply,files);
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
        if (!allowed() || !await safeToSend()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending"});
        const {method,body}=outboundMessagePayload({...reply,text:caption ??
          (kind==="pdf" && artifacts.length>1 ? document.name.slice(0,900) : undefined),
          file:{kind:"document",name:document.name,data:document.document}});
        const sent=await transport(r.chatId)(method,body);
        if (!Number.isSafeInteger(sent?.message_id) || !sent.document?.file_id) throw Error("missing_document_receipt");
        job.pdfIndex=i+1;
        if (caption) job.captionSent=true;
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
        if (!allowed() || !await safeToSend()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending"});
        const {method,body}=outboundMessagePayload({...reply,text:caption,file:{kind:"photo",name:image.name,data:image.photo}});
        const sent=await transport(r.chatId)(method,body);
        if (!Number.isSafeInteger(sent?.message_id) || !sent.photo?.length) throw Error("missing_photo_receipt");
        job.imageIndex=i+1;
        if (caption) job.captionSent=true;
        store.put(key,job);
      }
      if (!store.get(key)) continue;
      if (!allowed()) {finish("revoked");continue;}
      for (const link of imageLinks) text=text.replace(link.markdown,
        job.failedImages?.includes(link.path) ? "Изображение недоступно для отправки." : "");
      if (job.captionSent || !text.trim()) {finish("done");continue;}
      // The same formatting as a private chat: bold, italic, lists, code and links; plain words if Telegram rejects it.
      const parts=renderTelegramParts(cleanAssistantText(text).trim());
      for (let i=job.part??0;i<parts.length;i++) {
        if (!allowed() || !await safeToSend()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending",part:i});
        const send=(html:boolean)=>{
          const {method,body}=outboundMessagePayload({...reply,text:html ? parts[i] : plainFromHtml(parts[i]),html});
          return transport(r.chatId)(method,body);
        };
        const sent=await send(true).catch(error=>{
          if (error instanceof TelegramFailure && error.code==="telegram_400") return send(false);
          throw error;
        });
        if (job.taskId && Number.isSafeInteger(sent?.message_id))
          store.put(`group:task-message:${botId}:${r.chatId}:${r.topicId}:${sent.message_id}`,job.taskId);
        if (i+1===parts.length) finish("done",sent?.message_id);
        else store.put(key,{...job,state:"ready",part:i+1});
      }
    }
  }
}
