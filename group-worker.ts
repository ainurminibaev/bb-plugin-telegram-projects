import {isTopicPaused} from "./topic-lifecycle";
import {groupThreadMatches,isSharedOwnerPolicy,sharedGroupScopeKey,sharedGroupThreadKey} from "./group-binding";
import {isolatedFile,localFileInput,maxEncodedImages,maxGroupAttachments,readSavedImage,type ImageAttachment,type IsolatedAttachment} from "./group-attachments";
import {awaitProjectProposal} from "./owner-selection";
import {NO_REPLY} from "./group-result";
import {sourcesVisible} from "./source-access";
import {randomUUID} from "node:crypto";
import {groupExecutor} from "./isolated-client";
import {historyPrefix,topicPassages} from "./topic-search";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {localArtifacts} from "./telegram-ux";
import {groupImagePath,readGroupImage,readGroupPdf} from "./group-pdf";
import {splitText} from "./chat";
import {ReplyRoutes, stripTelegramMarkers} from "./reply-routing";
import {refersToExamples, promisesExamples, canInvokeGroup, contextMediaPrefix, type GroupTopicPolicy, type Ingress} from "./ingress";
import type {SavedTelegramFile} from "./telegram-files";
import type {GroupExample} from "./ingress";
import {TelegramFailure,type Store,type Telegram} from "./model";
import {accessModeKey,groupSettings,permissionModeFor,rulesNote,senderRole,type PermissionMode} from "./rights";

type GroupInput = Extract<Ingress,{kind:"group"}>;
type Job = {
  route: GroupInput; ownerId:number; revision?:string;
  state:"pending"|"submitted"|"ready"|"sending"|"done"|"revoked";
  taskId?:string; progressId?:number|null;
  executionToken?:string; executorRetryAt?:number;
  pdfIndex?:number; failedPdfs?:string[];
  imageIndex?:number; failedImages?:string[];
  cursor?:number; turnId?:string; answer?:string; part?:number;
};

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
    } else store.put("group:project:"+projectId,true);
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
    store.put(key,{...policy,projectId,acceptAfterSecond:Math.floor(Date.now()/1000)});
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
  verifyOwnerForum?:(policy:GroupTopicPolicy)=>Promise<boolean>) {
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
          messageId:r.messageId,threadId:r.threadId,turnId:job.turnId,sentId});
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
      return !sourceDenied && p?.botId===botId && p.revision===job.revision && (p.ownerId===undefined || p.ownerId===owner) && p.chatId===r.chatId && p.topicId===r.topicId && p.threadId===r.threadId &&
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
    const dest={kind:"telegram" as const,chatId:r.chatId,topicId:r.topicId,updateId:r.updateId};
    if (job.state==="pending" && r.voice) {
      try {
        const transcript = (await transcribe?.(r.voice))?.trim();
        if (!transcript) throw Error("voice_unavailable");
        if (!allowed()) {finish("revoked");continue;}
        if (r.searchBefore!==undefined) {
          const matches=store.findTopicHistory?.(historyPrefix(r.chatId,r.topicId),transcript,r.searchBefore)??[];
          r.text=topicPassages(matches,r.chatId)+r.text;
        }
        r.text += "\nГолосовое обращение: " + transcript;
        const mentionsFiles=refersToExamples(transcript);
        if (!mentionsFiles) delete r.precedingExamples;
        if (!promisesExamples(transcript)) {
          if (mentionsFiles && !r.precedingExamples?.length && !r.examples?.length) {
            r.waitUntil=Date.now()+4_000;
          } else {
            delete r.waitUntil;
          }
        }
        delete r.voice;
      } catch {
        if (signal.aborted) return;
        job.answer = "Голосовое не удалось распознать. Пришлите правки текстом в ответ на исходное сообщение.";
        job.state = "ready";
      }
      store.put(key,job);
      if (!allowed()) {finish("revoked");continue;}
    }
    if (job.state==="pending" && r.ambiguousMedia) {
      job.answer="В этой теме несколько подходящих сообщений с вложениями. Ответьте на нужное фото или файл и отметьте бота.";
      job.state="ready";
    }
    if (job.state==="pending") {
      if (r.precedingExamples && r.waitUntil===undefined) {
        const sets=new Set(r.precedingExamples.map(f=>f.album ? "album:"+f.album : "file:"+f.messageId));
        if (sets.size===1) r.examples=r.precedingExamples;
        else {
          job.answer="Вижу несколько наборов примеров. Ответьте на нужный файл или фотоальбом и отметьте бота.";
          job.state="ready";
        }
      }
      delete r.precedingExamples;
      const bag=store.get<{files:GroupExample[];last:number;closed?:boolean}>(`group:examples:${botId}:${r.updateId}`);
      if (r.waitUntil!==undefined && Date.now()<r.waitUntil && !bag?.closed &&
          (!bag || Date.now()<bag.last+4_000)) continue;
      if (bag?.files.length && r.waitUntil!==undefined) {
        r.examples=[...(r.examples??[]),...bag.files];
      } else if (r.waitUntil!==undefined && !r.examples?.length) {
        job.answer="Пока не вижу примеров для этой правки. Ответьте на это сообщение с материалами и правками.";
        job.state="ready";
      }
      if (r.waitUntil!==undefined) {delete r.waitUntil;store.put(key,job);}
    }
    if (visibleProgress && !policy.ownerSharedProject && r.updateId>0 && job.state==="pending" && job.progressId===undefined) {
      // A lost Telegram acknowledgement must not create a second status on restart.
      job.progressId=null;
      store.put(key,job);
      try {
        const sent=await transport(r.chatId)("sendMessage",{chat_id:r.chatId,message_thread_id:r.topicId||undefined,
          reply_parameters:{message_id:r.messageId},text:"⏳ Готовлю ответ…",disable_notification:true});
        if (Number.isSafeInteger(sent?.message_id)) job.progressId=sent.message_id;
        store.put(key,job);
      } catch { /* A status failure must not stop the actual reply. */ }
      if (!allowed()) {finish("revoked");continue;}
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
            job.state="submitted";
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
    const localInputs:(ImageAttachment|ReturnType<typeof localFileInput>)[]=[];
    const remoteInputs:IsolatedAttachment[]=[];
    if (job.state==="pending" && r.examples?.length) {
      try {
        if (!receiveExample) throw Error("missing_receiver");
        if (r.examples.length>maxGroupAttachments) throw Error("attachment_too_large");
        let imageSize=0;
        for (const example of r.examples) {
          if (!allowed()) break;
          const received=await receiveExample(example,r);
          if (!allowed()) break;
          if ("type" in received || example.image) {
            const image="type" in received ? received : await readSavedImage(received,signal);
            imageSize+=image.url.length;
            if (imageSize>maxEncodedImages) throw Error("attachment_too_large");
            if (executor) remoteInputs.push(image);
            else localInputs.push(image);
          } else if (executor) {
            remoteInputs.push(isolatedFile(await executor.upload(received,signal)));
          } else {
            localInputs.push(localFileInput(received,fileHostId));
          }
        }
        if (!allowed()) {finish("revoked");continue;}
      } catch {
        if (signal.aborted) return;
        if (!allowed()) {finish("revoked");continue;}
        job.answer="Не удалось получить все файлы. Ответьте на исходное сообщение и приложите материалы ещё раз.";
        job.state="ready";
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
          job.state="submitted";
          store.put(key,job);
        }
        if (!job.executionToken) {finish("revoked");continue;}
        const result=isolatedResult ?? await executor.read(job.executionToken,signal);
        if (result.state==="waiting") continue;
        job.answer=result.state==="finished" ? result.text : "Исполнитель потерял квитанцию. Проверьте задачу перед повтором.";
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
      const settings=groupSettings(store,botId,r.chatId);
      const title=store.get<{title?:string}>(`visibility:${botId}:group:${r.chatId}`)?.title ?? "эта группа";
      const senderName=r.senderName ?? "участник";
      const rules=rulesNote({title,settings,role,senderName});
      const permissionMode=permissionModeFor(role,provider,store.get<PermissionMode>(accessModeKey));
      const latest=await sdk.threads.events.list({threadId:r.threadId,order:"desc",limit:"1",signal});
      if (!allowed() || !await safeToSend()) {finish("revoked");continue;}
      const marker=routes.ingress(r.threadId,dest);
      job.cursor=latest[0]?.seq ?? 0;
      delete r.examples;
      job.state="submitted";
      store.put(key,job);
      // The mode persists for later messages of the thread, so every group message sets it.
      await sdk.threads.send({threadId:r.threadId,mode:"queue-if-active",permissionMode,
        input:[{type:"text",text:r.text,mentions:[]},...localInputs,marker,{type:"text" as const,visibility:"agent-only" as const,text:rules,mentions:[]},
          ...(taskNote ? [{type:"text" as const,visibility:"agent-only" as const,text:taskNote,mentions:[]}] : [])]});
    }
    if (job.state==="submitted") {
      const events=await sdk.threads.events.list({threadId:r.threadId,afterSeq:String(job.cursor??0),limit:"100",signal,
        types:["client/turn/requested","turn/input/accepted","item/completed","turn/completed"]});
      for (const e of events) {
        if (e.type==="client/turn/requested") routes.requested(r.threadId,e.data);
        if (e.scope.kind==="turn") {
          const turn=e.scope.turnId;
          if (e.type==="turn/input/accepted") routes.accept(r.threadId,turn,e.data.clientRequestId);
          if (routes.sameTask(routes.destination(r.threadId,turn),dest)) {
            if (e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId) {
              job.turnId=turn; job.answer=e.data.item.text;
            }
            if (e.type==="turn/completed") {
              if (e.data.status!=="completed") job.answer="Помощнику не удалось завершить это поручение.";
              else if (job.turnId!==turn || !job.answer?.trim()) job.answer="Помощник завершил ход без текстового ответа.";
              job.state="ready";
            }
          }
        }
        job.cursor=e.seq;
        if (job.state==="ready") break;
      }
      store.put(key,job);
    }
    // NO_REPLY means "say nothing" in any group turn, not only in a scheduled check.
    if (job.state==="ready" && stripTelegramMarkers(job.answer ?? "").trim()===NO_REPLY) {finish("done");continue;}
    if (job.state==="ready") {
      // Ready jobs may be resumed long after submission, including between reply parts.
      if (!allowed()) {finish("revoked");continue;}
      if (!executor && !belongsToGroup(await sdk.threads.get({threadId:r.threadId,signal}))) {finish("revoked");continue;}
      const outputRoot=async()=>{
        const thread=await sdk.threads.get({threadId:r.threadId,signal});
        if (!belongsToGroup(thread) || !fileHostId || !thread.environmentId) throw Error("missing_environment");
        const env=await sdk.environments.get({environmentId:thread.environmentId,signal});
        if (!env.path || env.hostId!==fileHostId) throw Error("group_export_host_mismatch");
        return env.path;
      };
      let text=stripTelegramMarkers(job.answer!);
      const artifacts=localArtifacts(text);
      const links=artifacts.filter(link=>/\.pdf$/i.test(link.path));
      const paths=[...new Set(links.map(link=>link.path))];
      for (let i=job.pdfIndex??0;i<paths.length;i++) {
        let pdf;
        try {
          if (executor) {
            if (!job.executionToken) throw Error("missing_isolated_receipt");
            pdf=await executor.pdf(job.executionToken,paths[i],signal);
          } else {
            pdf=await readGroupPdf(await outputRoot(),paths[i]);
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
        const sent=await transport(r.chatId)("sendDocument",{chat_id:r.chatId,message_thread_id:r.topicId||undefined,
          reply_parameters:{message_id:r.messageId},document:pdf.document,document_filename:pdf.name,caption:pdf.name.slice(0,900)});
        if (!Number.isSafeInteger(sent?.message_id) || !sent.document?.file_id) throw Error("missing_document_receipt");
        job.pdfIndex=i+1;
        store.atomic(()=>{
          if (job.taskId) store.put("group:completed-pdf:"+job.taskId,sent.message_id);
          store.put(`group:pdf:${botId}:${r.chatId}:${r.topicId}:${sent.message_id}`,{
            owner,threadId:r.threadId,path:pdf.path,sha256:pdf.sha256,fileId:sent.document.file_id});
          store.put(key,job);
        });
      }
      if (!store.get(key)) continue;
      if (!allowed()) {finish("revoked");continue;}
      for (const link of links) text=text.replace(link.markdown,
        job.failedPdfs?.includes(link.path) ? "PDF недоступен для отправки." : "");
      const imageLinks=artifacts.filter(link=>groupImagePath.test(link.path));
      const images=[...new Set(imageLinks.map(link=>link.path))];
      for (let i=job.imageIndex??0;i<images.length;i++) {
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
        const sent=await transport(r.chatId)("sendPhoto",{chat_id:r.chatId,message_thread_id:r.topicId||undefined,
          reply_parameters:{message_id:r.messageId},photo:image.photo,photo_filename:image.name});
        if (!Number.isSafeInteger(sent?.message_id) || !sent.photo?.length) throw Error("missing_photo_receipt");
        job.imageIndex=i+1;
        store.put(key,job);
      }
      if (!store.get(key)) continue;
      if (!allowed()) {finish("revoked");continue;}
      for (const link of imageLinks) text=text.replace(link.markdown,
        job.failedImages?.includes(link.path) ? "Изображение недоступно для отправки." : "");
      if (!text.trim()) {finish("done");continue;}
      const parts=splitText(text.trim());
      for (let i=job.part??0;i<parts.length;i++) {
        if (!allowed() || !await safeToSend()) {finish("revoked");break;}
        store.put(key,{...job,state:"sending",part:i});
        const sent=await transport(r.chatId)("sendMessage",{chat_id:r.chatId,message_thread_id:r.topicId||undefined,
          reply_parameters:{message_id:r.messageId},text:parts[i]});
        if (job.taskId && Number.isSafeInteger(sent?.message_id))
          store.put(`group:task-message:${botId}:${r.chatId}:${r.topicId}:${sent.message_id}`,job.taskId);
        if (i+1===parts.length) finish("done",sent?.message_id);
        else store.put(key,{...job,state:"ready",part:i+1});
      }
    }
  }
}
