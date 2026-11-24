import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {Store,Telegram} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import {NO_REPLY} from "./group-result";
import {ReplyRoutes,stripTelegramMarkers,isBusyAnswer} from "./reply-routing";
import {sendFormattedText} from "./outbound-message";

// A schedule set in a group or a person's chat runs as an ordinary turn of that conversation's thread; a subthread's
// outcome wakes it the same way. The result goes back to the same topic or private chat. NO_REPLY stays silent.

type Run={turnId?:string;text?:string};
type Cursor={seq:number;runs:Record<string,Run>};
const cursorKey=(threadId:string)=>"group:schedule-cursor:"+threadId;
const sentKey=(threadId:string,turnId:string)=>`group:schedule-sent:${threadId}:${turnId}`;

export async function deliverScheduledResults(store:Store,sdk:Pick<BbPluginApi["sdk"],"threads">,
  transport:(chatId:number)=>Telegram,signal:AbortSignal,allowed:()=>boolean,only?:ReadonlySet<string>) {
  const policies=store.list<GroupTopicPolicy>("group:policy:").map(r=>r.value).filter(p=>p.threadId);
  for (const policy of [...new Map(policies.map(p=>[p.threadId,p])).values()]) {
    if (!allowed()) return;
    const threadId=policy.threadId!;
    // С72: with the change feed only threads that changed are read; a safety pass reads them all.
    if (only && !only.has(threadId) && store.get(cursorKey(threadId))) continue;
    let cursor=store.get<Cursor>(cursorKey(threadId));
    // A thread deleted in BB while its topic stays bound: skip it, never stop the pass for the other threads.
    const gone=(error:unknown)=>/\b404\b|not found/i.test(String((error as Error)?.message ?? error));
    if (!cursor) {
      // Start at the present: earlier runs are not replayed.
      let latest;
      try { latest=await sdk.threads.events.list({threadId,order:"desc",limit:"1",signal}); }
      catch (error) { if (gone(error)) continue; throw error; }
      store.put(cursorKey(threadId),{seq:latest[0]?.seq ?? 0,runs:{}});
      continue;
    }
    let events;
    try {
      events=await sdk.threads.events.list({threadId,afterSeq:String(cursor.seq),limit:"100",signal,
        types:["client/turn/requested","turn/input/accepted","item/completed","turn/completed"]});
    } catch (error) { if (gone(error)) continue; throw error; }
    const runs={...cursor.runs};
    const byTurn=(turnId:string)=>Object.entries(runs).find(([,r])=>r.turnId===turnId);
    for (const e of events) {
      // Turns no Telegram message started: a schedule's run, or BB waking the thread with its subthread's outcome.
      const d=e.data as {originPluginId?:string;initiator?:string;systemMessageKind?:string;requestId:string};
      if (e.type==="client/turn/requested" && (d.originPluginId==="automations" ||
          (d.initiator==="system" && d.systemMessageKind?.startsWith("child-")))) runs[d.requestId]={};
      if (e.scope.kind==="turn") {
        const turnId=e.scope.turnId;
        if (e.type==="turn/input/accepted" && runs[e.data.clientRequestId]) runs[e.data.clientRequestId].turnId=turnId;
        const run=byTurn(turnId);
        if (run && e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId &&
            !isBusyAnswer(e.data.item.text)) run[1].text=e.data.item.text;
        if (run && e.type==="turn/completed") {
          delete runs[run[0]];
          const text=stripTelegramMarkers(run[1].text ?? "").trim();
          // A notice that joined a turn of a Telegram task (a subthread finished while the task ran): that task's own
          // delivery sends the answer; sending it here too gave the topic two identical messages.
          const telegramTask=new ReplyRoutes(store).destination(threadId,turnId)?.kind==="telegram" ||
            store.list<{state?:string;route?:{threadId?:string}}>("group:in:").some(({value:j})=>
              j.route?.threadId===threadId && (j.state==="submitted" || j.state==="ready" || j.state==="sending"));
          if (!telegramTask && e.data.status==="completed" && text && text!==NO_REPLY && !store.get(sentKey(threadId,turnId)) && allowed()) {
            store.put(sentKey(threadId,turnId),Date.now());
            const tg=transport(policy.chatId);
            try {
              await sendFormattedText(tg,{chatId:policy.chatId,topicId:policy.privateChat ? 0 : policy.topicId,markdown:text});
            } catch (error) {
              // Not delivered: the next pass reads this turn again and retries.
              store.del(sentKey(threadId,turnId));
              throw error;
            }
          }
        }
      }
      cursor={seq:e.seq,runs};
      store.put(cursorKey(threadId),cursor);
    }
  }
}
