import {createHash} from "node:crypto";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {z} from "zod";
import {localArtifacts} from "./telegram-ux";
import {pdfChunkSize,maxGroupPdfSize,readGroupPdfBytes} from "./group-pdf";
import {routeMarker} from "./reply-routing";
import type {Store} from "./model";

export const isolatedGroupInput = z.object({
  projectId: z.string().min(1).max(160),
  threadId: z.string().min(1).max(160),
  routeToken: z.string().uuid(),
  text: z.string().min(1).max(256 * 1024),
}).strict();
export const isolatedGroupResult = z.object({
  state: z.enum(["accepted", "unconfirmed"]),
});

export const isolatedLookup = isolatedGroupInput.pick({projectId:true,threadId:true,routeToken:true});
export const isolatedAnswer = z.discriminatedUnion("state",[
  z.object({state:z.literal("waiting")}), z.object({state:z.literal("missing")}),
  z.object({state:z.literal("finished"),text:z.string().max(256*1024)}),
]);
type Receipt = {hash:string; threadId:string; projectId:string; cursor:number; state:"accepted"|"unconfirmed";
  requestId?:string; turnId?:string; answer?:string; finished?:boolean};


// Runs in the group's BB instance. The personal bridge retains the Telegram
// destination and supplies only the opaque route token for matching BB events.
export async function submitIsolatedGroup(
  sdk: BbPluginApi["sdk"], store: Store, configuredProject: string | undefined,
  args: z.infer<typeof isolatedGroupInput>,
): Promise<z.infer<typeof isolatedGroupResult>> {
  if (!configuredProject || configuredProject !== args.projectId) throw Error("isolated_project_required");
  const thread = await sdk.threads.get({threadId:args.threadId});
  if (thread.projectId !== configuredProject || thread.id !== args.threadId ||
      thread.visibility !== "visible" || thread.archivedAt || thread.deletedAt) throw Error("isolated_thread_required");
  const key = "group:submission:" + args.routeToken;
  const hash = createHash("sha256").update(JSON.stringify([args.projectId,args.threadId,args.text])).digest("hex");
  const latest = await sdk.threads.events.list({threadId:args.threadId,order:"desc",limit:"1"});
  const fresh:Receipt = {hash,state:"unconfirmed",projectId:args.projectId,threadId:args.threadId,cursor:latest[0]?.seq??0};
  let previous:Receipt|undefined;
  store.atomic(()=>{
    previous = store.get<Receipt>(key);
    if (previous && previous.hash !== hash) throw Error("group_submission_conflict");
    if (!previous) store.put(key,fresh);
  });
  if (previous) return {state:previous.state};
  await sdk.threads.send({threadId:thread.id,mode:"queue-if-active",input:[
    {type:"text",text:args.text,mentions:[]},
    routeMarker(args.routeToken),
  ]});
  store.put(key,{...store.get<Receipt>(key),state:"accepted"});
  return {state:"accepted"};
}

export async function readIsolatedGroup(sdk:BbPluginApi["sdk"],store:Store,project:string,
  args:z.infer<typeof isolatedLookup>):Promise<z.infer<typeof isolatedAnswer>> {
  if (project !== args.projectId) throw Error("isolated_project_required");
  const key="group:submission:"+args.routeToken;
  const saved=store.get<Receipt>(key);
  if (!saved) return {state:"missing"};
  if (saved.projectId!==project || saved.threadId!==args.threadId) throw Error("group_submission_conflict");
  const thread=await sdk.threads.get({threadId:args.threadId});
  if (thread.projectId!==project || thread.archivedAt || thread.deletedAt || thread.visibility!=="visible")
    throw Error("isolated_thread_required");
  if (saved.finished) return {state:"finished",text:saved.answer!};
  const events=await sdk.threads.events.list({threadId:args.threadId,afterSeq:String(saved.cursor),limit:"100",
    types:["client/turn/requested","turn/input/accepted","item/completed","turn/completed"]});
  const row={...saved};
  for (const e of events) {
    if (e.threadId!==args.threadId || e.seq<=row.cursor) continue;
    row.cursor=e.seq;
    if (e.type==="client/turn/requested" && e.data.originPluginId==="telegram-projects" &&
        e.data.input?.some(x=>x.type==="text" && x.visibility==="agent-only" && x.text===routeMarker(args.routeToken).text))
      row.requestId=e.data.requestId;
    if (e.scope.kind!=="turn") continue;
    if (e.type==="turn/input/accepted" && row.requestId && row.requestId===e.data.clientRequestId) row.turnId=e.scope.turnId;
    if (!row.turnId || row.turnId!==e.scope.turnId) continue;
    if (e.type==="item/completed" && e.data.item.type==="agentMessage" && !e.data.item.parentToolCallId)
      row.answer=e.data.item.text.slice(0,256*1024);
    if (e.type==="turn/completed") {
      if (e.data.status!=="completed" || !row.answer?.trim()) row.answer="Исполнитель завершил задачу без результата.";
      row.finished=true; break;
    }
  }
  store.atomic(()=>{
    const current=store.get<Receipt>(key);
    if (current && current.cursor<row.cursor) store.put(key,{...row,state:current.state});
  });
  return row.finished ? {state:"finished",text:row.answer!} : {state:"waiting"};
}

export const isolatedPdfInput=isolatedLookup.extend({path:z.string().min(1).max(4096),
  offset:z.number().int().min(0).max(maxGroupPdfSize-1)}).strict();
export const isolatedPdfPart=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),
  size:z.number().int().min(5).max(maxGroupPdfSize),data:z.string().min(4).max(4*Math.ceil(pdfChunkSize/3))});

export async function readIsolatedPdf(sdk:BbPluginApi["sdk"],store:Store,project:string,
  hostId:string|undefined,args:z.infer<typeof isolatedPdfInput>) {
  if (!hostId || args.projectId!==project) throw Error("isolated_export_unavailable");
  const row=store.get<Receipt>("group:submission:"+args.routeToken);
  if (!row?.finished || row.projectId!==project || row.threadId!==args.threadId ||
      !localArtifacts(row.answer??"").some(link=>link.path===args.path)) throw Error("isolated_export_unavailable");
  const thread=await sdk.threads.get({threadId:args.threadId});
  if (!thread.environmentId || thread.projectId!==project || thread.visibility!=="visible" ||
      thread.archivedAt || thread.deletedAt) throw Error("isolated_thread_required");
  const env=await sdk.environments.get({environmentId:thread.environmentId});
  if (env.projectId!==project || env.hostId!==hostId || !env.path) throw Error("isolated_export_unavailable");
  const {size,revision,bytes}=await readGroupPdfBytes(env.path,args.path,args.offset,pdfChunkSize);
  return {size,revision,data:bytes.toString("base64")};
}
