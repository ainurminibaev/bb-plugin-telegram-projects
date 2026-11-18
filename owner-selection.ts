import {createHash,randomUUID} from "node:crypto";
import {closeSync,fsyncSync,openSync,linkSync,readFileSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute,join} from "node:path";
import {z} from "zod";
import {inspectGroupTask,type GroupOrigin} from "./group-result";
import type {Store,Telegram} from "./model";

export const proposalInput=z.object({
  threadId:z.string().min(1),routeToken:z.string().uuid(),taskId:z.string().uuid(),
  revision:z.number().int().positive().safe(),
  items:z.array(z.string().min(1).max(300).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)).min(1).max(10),
}).strict();
type Proposal=z.infer<typeof proposalInput>;
type Draft={actor:number;bot:number;project:string;directory:string;revision:number;draftHash:string;
  count:number;messageId?:number;selected?:number[]};
const key=(task:string)=>"selection:draft:"+task;

function directory(project:string) {
  const path=JSON.parse(process.env.BB_TELEGRAM_DECISION_OUTBOXES??"{}")[project];
  if(typeof path!=="string" || !isAbsolute(path)) throw Error("decision_executor_unavailable");
  return path;
}
function active(store:Store,owner:number,bot:number,task:string) {
  if(inspectGroupTask(store,owner,bot,task).binding!=="active") throw Error("group_task_unavailable");
  return store.get<GroupOrigin>("group:origin:"+task)!;
}
export async function presentProposal(store:Store,actor:number,bot:number,args:Proposal,tg:Telegram) {
  const origin=active(store,actor,bot,args.taskId);
  const dir=directory(origin.projectId);
  const draftHash=createHash("sha256").update(JSON.stringify(args.items)).digest("hex");
  const row:Draft={actor,bot,project:origin.projectId,directory:dir,revision:args.revision,draftHash,count:args.items.length};
  const old=store.get<Draft>(key(args.taskId));
  if(old && (old.actor!==actor || old.bot!==bot || old.directory!==dir || old.project!==origin.projectId ||
     old.revision>args.revision || (old.selected && old.revision!==args.revision) ||
     (old.revision===args.revision && old.draftHash!==draftHash))) throw Error("proposal_conflict");
  if(old?.revision===row.revision && old.messageId) return {messageId:old.messageId,draftHash};
  store.put(key(args.taskId),row);
  const text=["Что выполнить?",...args.items.map((s,i)=>`${i+1}. ${s}`),
    args.items.length===1 ? "Можно ответить «да, сделай» или предложить правку." : "Можно выбрать пункты по номерам или словами, одобрить всё или предложить правку."].join("\n");
  const sent=await tg("sendMessage",{chat_id:actor,text,reply_markup:{force_reply:true}});
  const current=store.get<Draft>(key(args.taskId));
  if(!Number.isSafeInteger(sent.message_id) || sent.message_id<=0 || current?.revision!==row.revision ||
     current.draftHash!==draftHash) throw Error("proposal_superseded");
  if(current.messageId) return {messageId:current.messageId,draftHash};
  store.atomic(()=>{
    store.put(key(args.taskId),{...row,messageId:sent.message_id});
    store.put(`selection:message:${bot}:${actor}:${sent.message_id}`,args.taskId);
  });
  return {messageId:sent.message_id,draftHash};
}

// A private staging file and an exclusive hard link publish complete bytes exactly once.
// The executor keeps the receipt in place and reconciles external writes by item.
function publish(path:string, body:string) {
  const temp=path+"."+randomUUID()+".tmp";
  writeFileSync(temp,body,{flag:"wx",mode:0o640,flush:true});
  try {
    try {linkSync(temp,path);}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST" || readFileSync(path,"utf8")!==body) throw error;
    }
    const parent=openSync(dirname(path),"r");
    try {fsyncSync(parent);} finally {closeSync(parent);}
  } finally {unlinkSync(temp);}
}
function selectedItems(text:string,count:number):number[] | undefined {
  const reply=text.trim().toLowerCase().replace(/ё/g,"е").replace(/[.!]+$/,"").trim();
  if (/^(?:да,? )?(?:давай|сделай|делай|выполни|одобряю) все(?: пункты)?$/.test(reply))
    return Array.from({length:count},(_,i)=>i+1);
  if (count===1 && /^(?:да|да,? сделай|сделай|делай|подтверждаю)$/.test(reply)) return [1];
  const words=["первый","второй","третий","четвертый","пятый","шестой","седьмой","восьмой","девятый","десятый"];
  const list=reply.replace(/^(?:\/approve |(?:да,? )?(?:давай|сделай|делай|выполни|одобряю|подтверждаю) )/,"")
    .replace(/^(?:только )?(?:пункты? )?/,"");
  const selected=list.split(/\s*,\s*|\s+и\s+/).map(item=>
    /^(?:[1-9]|10)$/.test(item) ? Number(item) : words.indexOf(item)+1);
  if (selected.some(n=>!n || n>count) || new Set(selected).size!==selected.length) return;
  return selected.sort((a,b)=>a-b);
}
export function acceptOwnerSelection(store:Store,update:any,actor:number|undefined,bot:number|undefined,
  clarify?:(task:string,proposal:number)=>void) {
  const m=update?.message;
  if(!actor || !bot || m?.chat?.type!=="private" || m.chat.id!==actor || m.from?.id!==actor ||
    m.from.is_bot || m.sender_chat || m.forward_origin || m.via_bot || m.is_automatic_forward ||
    m.reply_to_message?.from?.id!==bot || m.reply_to_message?.chat?.id!==actor ||
    typeof m.text!=="string") return false;
  const id=m.reply_to_message.message_id;
  const address=store.get<string|{task:string;proposal:number}>(`selection:message:${bot}:${actor}:${id}`);
  const task=typeof address==="string" ? address : address?.task;
  const proposal=typeof address==="object" ? address.proposal : id;
  if(!task) return /^\/approve(?:\s|$)/.test(m.text);
  const row=store.get<Draft>(key(task));
  if(!row || row.messageId!==proposal || row.bot!==bot || row.actor!==actor) return true;
  const selected=selectedItems(m.text,row.count);
  // Free-form questions, changes and conditional answers belong in the owner's conversation.
  if(!selected && !row.selected && clarify && /^(?:да|ок|хорошо|согласен|согласна|давай|подтверждаю)[.!]*$/iu.test(m.text.trim())) {
    clarify(task,proposal);
    return true;
  }
  if(!selected) return /^\/approve(?:\s|$)/.test(m.text);
  if(row.selected && JSON.stringify(row.selected)!==JSON.stringify(selected)) return true;
  let origin:GroupOrigin;
  try {origin=active(store,actor,bot,task);} catch {return true;}
  if(origin.projectId!==row.project || directory(origin.projectId)!==row.directory) return true;
  const body=JSON.stringify({actor,taskId:task,revision:row.revision,draftHash:row.draftHash,selected});
  store.put(key(task),{...row,selected});
  publish(join(row.directory,task+".json"),body);
  return true;
}

export async function handleOwnerSelection(store:Store,update:any,actor:number|undefined,bot:number|undefined,tg:Telegram) {
  let question:{task:string;proposal:number}|undefined;
  const handled=acceptOwnerSelection(store,update,actor,bot,(task,proposal)=>{question={task,proposal};});
  if(question && actor && bot) {
    const seen=`selection:clarified:${bot}:${actor}:${update.update_id}`;
    if(store.get(seen)) return handled;
    const sent=await tg("sendMessage",{chat_id:actor,reply_parameters:{message_id:question.proposal},
      text:"Какие пункты выполнить? Можно ответить номерами или словами.",reply_markup:{force_reply:true}});
    if(!Number.isSafeInteger(sent.message_id) || sent.message_id<=0) throw Error("clarification_unconfirmed");
    store.atomic(()=>{
      store.put(`selection:message:${bot}:${actor}:${sent.message_id}`,question);
      store.put(seen,true);
    });
  }
  return handled;
}
