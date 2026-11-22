import type {Store} from "./model";
import type {ReplyRoute} from "./reply-routing";

type Address = Extract<ReplyRoute,{kind:"telegram"}> & {messageId:number};
export type BusyExactEvidence = {
  requestId:string; acceptedSeq:number; itemSeq?:number; completedSeq?:number;
  disposition:"saved-result"|"status-only";
};
export type BusyExactDelivery = {
  ownerId:number; topicId:number; revision:string; threadId:string; taskRoute:Address;
  text:string; at:number; retryAt:number; evidence:BusyExactEvidence;
  busyExact:"queued"|"sending"|"sent"|"unknown"|"cancelled";
  sentId?:number;
};
export const exactOutboxPrefix = "chat:out:busy-exact:";
export const claimAuditPrefix = "chat:busy-exact-claim:";

function current(store:Store, row:BusyExactDelivery) {
  const route=row.taskRoute;
  const binding=store.get<{threadId:string;revision:string}>("chat:binding:"+route.topicId);
  return Number.isSafeInteger(route.messageId) && route.messageId>0 &&
    route.topicId===row.topicId && store.get<number>("owner:id")===route.chatId && route.chatId===row.ownerId &&
    binding?.threadId===row.threadId && binding.revision===row.revision &&
    !store.get("reply:cancelled:"+JSON.stringify([route.chatId,route.topicId,route.updateId]));
}

export function claimBusyExact(store:Store, row:BusyExactDelivery, producer:"observer"|"recovery") {
  const r=row.taskRoute;
  const key=exactOutboxPrefix+JSON.stringify([r.chatId,r.topicId,r.updateId,r.messageId,row.threadId,row.revision]);
  let result:"won"|"exists"|"stale"|"legacy"="stale";
  (store.atomicBusyExact ?? store.atomic)(() => {
    if (!current(store,row)) return;
    const previous=store.get<BusyExactDelivery>(key);
    if (previous) result="exists";
    else if (store.list<{taskRoute?:ReplyRoute}>("chat:out:event:"+row.revision+":").some(({key,value}) =>
      !key.includes(":queued:") && value.taskRoute?.kind==="telegram" && value.taskRoute.chatId===r.chatId && value.taskRoute.topicId===r.topicId &&
      value.taskRoute.updateId===r.updateId && value.taskRoute.messageId===r.messageId)) result="legacy";
    else {
      store.put(key,row);
      result="won";
    }
    const auditKey=claimAuditPrefix+key+":"+producer;
    const audit=store.get<{attempts:number;wins:number}>(auditKey) ?? {attempts:0,wins:0};
    store.put(auditKey,{attempts:audit.attempts+1,wins:audit.wins+Number(result==="won"),last:result,
      observedState:previous?.busyExact ?? null,evidence:row.evidence});
  });
  return {key,result};
}

export function startBusyExact(store:Store, key:string, allowed:(row:BusyExactDelivery)=>boolean) {
  let selected:BusyExactDelivery|undefined;
  (store.atomicBusyExact ?? store.atomic)(() => {
    const row=store.get<BusyExactDelivery>(key);
    if (!row || row.busyExact!=="queued") return;
    if (!current(store,row) || !allowed(row)) {
      store.put(key,{...row,busyExact:"cancelled",text:"",sentId:-1});
      return;
    }
    selected=row;
    // In-flight is terminal for recovery purposes until a receipt arrives.
    store.put(key,{...row,busyExact:"sending",text:"",sentId:-1});
  });
  return selected;
}

export function finishBusyExact(store:Store, key:string, sentId?:number) {
  (store.atomicBusyExact ?? store.atomic)(() => {
    const row=store.get<BusyExactDelivery>(key);
    if (row?.busyExact==="sending") store.put(key,{...row,busyExact:sentId?"sent":"unknown",sentId:sentId??-1});
  });
}
