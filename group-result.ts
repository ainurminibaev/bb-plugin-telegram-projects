import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {z} from "zod";
import {canInvokeGroup, type GroupTopicPolicy} from "./ingress";
import {groupExecutor} from "./isolated-client";
import {TelegramFailure, type Store, type Telegram} from "./model";

export const groupResultInput = z.object({
  threadId:z.string().min(1), routeToken:z.string().uuid(), taskId:z.string().uuid(),
  text:z.string().trim().min(1).max(4096),
}).strict();
export const groupResultStatus = z.object({
  state:z.enum(["queued","sent","revoked","unknown","rejected","cancelled"]), messageId:z.number().optional(),
});
type Status = z.infer<typeof groupResultStatus>;
type Result = Status & {text:string};
export type GroupOrigin = {
  owner:number; bot:number; sender:number; chatId:number; topicId:number; messageId:number;
  threadId:string; revision:string; projectId:string; executionToken?:string;
};

function groupBindingActive(store:Store,origin:GroupOrigin) {
  const {chatId,topicId,threadId,projectId,owner,bot,sender}=origin;
  const key=`group:policy:${chatId}:${topicId}`;
  const policy=store.get<GroupTopicPolicy>(key);
  return !!policy && policy.revision===origin.revision && policy.ownerId===owner && policy.botId===bot &&
    policy.threadId===threadId && policy.projectId===projectId && (sender===owner || policy.isolated===true) &&
    canInvokeGroup(policy,owner,sender) && store.get("group:thread:"+threadId)===key &&
    store.get("group:project:"+projectId)===true;
}

// A binding confirms the return address only. Delivery additionally checks the live worker.
export function inspectGroupTask(store:Store,owner:number,bot:number,taskId:string) {
  const origin=store.get<GroupOrigin>("group:origin:"+taskId);
  if (!origin || origin.owner!==owner || origin.bot!==bot) throw Error("group_task_unavailable");
  if (!groupBindingActive(store,origin)) return {binding:"revoked" as const};
  const receipt=store.get<Result>("group:result:"+taskId);
  return {binding:"active" as const,delivery:receipt?.state ?? "unsubmitted",
    ...(receipt?.messageId && {messageId:receipt.messageId})} as const;
}

export function queueGroupResult(store:Store, owner:number, bot:number, taskId:string, text:string):Status {
  const origin=store.get<GroupOrigin>("group:origin:"+taskId);
  if (!origin || origin.owner!==owner || origin.bot!==bot) throw Error("group_task_unavailable");
  const key="group:result:"+taskId;
  store.atomic(()=>{
    const old=store.get<Result>(key);
    if (old) {
      if (old.text!==text) throw Error("group_result_conflict");
      return;
    }
    store.put(key,{state:"queued",text});
    store.put("group:result-queue:"+taskId,true);
  });
  const {state,messageId}=store.get<Result>(key)!;
  return messageId===undefined ? {state} : {state,messageId};
}

export const groupReminderInput=groupResultInput.extend({
  dueAt:z.number().int().positive().safe(),
  waitingFor:z.enum(["pdf","decision"]),
});
type Reminder = Result & Pick<z.infer<typeof groupReminderInput>,"dueAt"|"waitingFor">;

export const bbReminderInput=groupReminderInput.omit({threadId:true,routeToken:true});

export function isDirectOwnerRequest(request:{
  initiator:string; senderThreadId:string|null; originPluginId?:string; systemMessageKind?:string;
  retryOfRequestId?:string; target:{kind:string};
}) {
  return request.initiator==="user" && request.senderThreadId===null && !request.originPluginId &&
    (!request.systemMessageKind || request.systemMessageKind==="unlabeled") && !request.retryOfRequestId && request.target.kind==="new-turn";
}

export function queueGroupReminder(store:Store,owner:number,bot:number,args:z.infer<typeof bbReminderInput>):Status {
  const origin=store.get<GroupOrigin>("group:origin:"+args.taskId);
  if (!origin || origin.owner!==owner || origin.bot!==bot) throw Error("group_task_unavailable");
  const key="group:reminder:"+args.taskId;
  store.atomic(()=>{
    const old=store.get<Reminder>(key);
    if (old) {
      if (old.text!==args.text || old.dueAt!==args.dueAt || old.waitingFor!==args.waitingFor)
        throw Error("group_reminder_conflict");
      return;
    }
    store.put(key,{state:"queued",text:args.text,dueAt:args.dueAt,waitingFor:args.waitingFor});
    store.put("group:reminder-queue:"+args.taskId,true);
  });
  const {state,messageId}=store.get<Reminder>(key)!;
  return messageId===undefined ? {state} : {state,messageId};
}

// This runs on the bridge's serial receiver loop. Consume the queue entry and
// record uncertainty together before the request can reach Telegram.
export async function deliverGroupResults(store:Store,sdk:BbPluginApi["sdk"],
  current:(origin:GroupOrigin)=>boolean, transport:(chatId:number)=>Telegram, signal:AbortSignal) {
  for (const row of [...store.list("group:result-queue:"), ...store.list("group:reminder-queue:")]) {
    if (signal.aborted) return;
    const reminder=row.key.startsWith("group:reminder-queue:");
    const taskId=row.key.split(":")[2];
    const key=(reminder?"group:reminder:":"group:result:")+taskId;
    const result=store.get<Result>(key);
    if (!result || result.state!=="queued") continue;
    const scheduled=reminder ? store.get<Reminder>(key) : undefined;
    if (scheduled && scheduled.dueAt>Date.now()) continue;
    const satisfied=()=>scheduled && (scheduled.waitingFor==="pdf"
      ? !!store.get("group:completed-pdf:"+taskId) : !!store.get("group:result:"+taskId));
    const origin=store.get<GroupOrigin>("group:origin:"+taskId);
    const finish=(state:Status["state"],messageId?:number)=>store.atomic(()=>{
      store.put(key,messageId===undefined ? {...result,state} : {...result,state,messageId});
      store.del(row.key);
    });
    if (!origin) {finish("revoked");continue;}
    const {chatId,topicId,threadId,projectId,bot,owner,sender}=origin;
    const policyKey=`group:policy:${chatId}:${topicId}`;
    const allowed=()=>current(origin) && groupBindingActive(store,origin);
    if (!allowed()) {finish("revoked");continue;}
    const isolated=store.get<GroupTopicPolicy>(policyKey)!.isolated;
    if (isolated) {
      const worker=groupExecutor(chatId,topicId);
      if (worker?.threadId!==threadId || worker.projectId!==projectId || !origin.executionToken) {finish("revoked");continue;}
      // The isolated service checks the thread's current project and visibility.
      try {
        const receipt=await worker.read(origin.executionToken,signal);
        if (receipt.state==="missing") {finish("revoked");continue;}
      } catch { continue; }
    } else {
      // A temporary SDK failure must not block other groups or ordinary replies.
      let thread;
      try { thread=await sdk.threads.get({threadId,signal}); }
      catch { continue; }
      if (thread.id!==threadId || thread.projectId!==projectId || thread.visibility!=="visible" ||
          thread.archivedAt || thread.deletedAt) {finish("revoked");continue;}
    }
    if (signal.aborted) return;
    if (!allowed()) {finish("revoked");continue;}
    if (satisfied()) {finish("cancelled");continue;}
    finish("unknown");
    try {
      const sent=await transport(chatId)("sendMessage",{chat_id:chatId,message_thread_id:topicId||undefined,
        reply_parameters:{message_id:origin.messageId,allow_sending_without_reply:false},text:result.text});
      if (Number.isSafeInteger(sent?.message_id) && sent.message_id>0) finish("sent",sent.message_id);
    } catch (error) {
      if (error instanceof TelegramFailure && !error.ambiguous) finish("rejected");
    }
  }
}
