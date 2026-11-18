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
  state:z.enum(["queued","sent","revoked","unknown","rejected"]), messageId:z.number().optional(),
});
type Status = z.infer<typeof groupResultStatus>;
type Result = Status & {text:string};
export type GroupOrigin = {
  owner:number; bot:number; sender:number; chatId:number; topicId:number; messageId:number;
  threadId:string; revision:string; projectId:string; executionToken?:string;
};

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
  return {state,messageId};
}

// This runs on the bridge's serial receiver loop. Consume the queue entry and
// record uncertainty together before the request can reach Telegram.
export async function deliverGroupResults(store:Store,sdk:BbPluginApi["sdk"],
  current:(origin:GroupOrigin)=>boolean, transport:(chatId:number)=>Telegram, signal:AbortSignal) {
  for (const row of store.list("group:result-queue:")) {
    if (signal.aborted) return;
    const taskId=row.key.slice("group:result-queue:".length);
    const key="group:result:"+taskId;
    const result=store.get<Result>(key);
    if (!result || result.state!=="queued") continue;
    const origin=store.get<GroupOrigin>("group:origin:"+taskId);
    const finish=(state:Status["state"],messageId?:number)=>store.atomic(()=>{
      store.put(key,{...result,state,messageId});
      store.del(row.key);
    });
    if (!origin) {finish("revoked");continue;}
    const {chatId,topicId,threadId,projectId,bot,owner,sender}=origin;
    const policyKey=`group:policy:${chatId}:${topicId}`;
    const allowed=()=>{
      const p=store.get<GroupTopicPolicy>(policyKey);
      return current(origin) && p?.revision===origin.revision && p.ownerId===owner && p.botId===bot &&
        p.threadId===threadId && p.projectId===projectId && (sender===owner || p.isolated===true) &&
        canInvokeGroup(p,owner,sender) && store.get("group:thread:"+threadId)===policyKey &&
        store.get("group:project:"+projectId)===true;
    };
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
