import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {z} from "zod";
import {groupThreadMatches} from "./group-binding";
import type {GroupTopicPolicy} from "./ingress";
import {TelegramFailure, type Store, type Telegram} from "./model";
import {stripTelegramMarkers} from "./reply-routing";
import {beginTopicSend,isTopicPaused} from "./topic-lifecycle";
import {checkOutboundContent,maxText,outboundArtifact,outboundDirectory,outboundMaxBytes,
  readOutboundFile,sendOutboundMessage} from "./outbound-message";

const id = z.string().min(1).max(150);
const timestamp = z.number().int().positive().safe();
export const schedulePermit = z.object({
  automationId:id, runId:id, projectId:id, threadId:id,
  scheduledFor:timestamp, trigger:z.literal("schedule"), nonce:z.string().uuid(),
  inputSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Permit = z.infer<typeof schedulePermit>;

const grant = z.object({
  automationId:id, projectId:id, threadId:id, groupThread:id, groupRevision:id,
  owner:timestamp, bot:timestamp, directory:outboundDirectory,
  maxBytes:outboundMaxBytes,
}).strict();
type Grant = z.infer<typeof grant>;

export function scheduledReportGrants(path = process.env.BB_TELEGRAM_SCHEDULED_GROUP_REPORTS) {
  if (!path) return [];
  if (!isAbsolute(path)) throw Error("report_policy_invalid");
  try {
    return z.array(grant).max(32).parse(JSON.parse(readFileSync(path,"utf8")));
  } catch {
    throw Error("report_policy_invalid");
  }
}

export const scheduledReportInput = z.object({
  summary:z.string().trim().min(1).max(1000).optional(),
  zip:z.string().max(4096).refine(isAbsolute).optional(),
  text:z.string().trim().min(1).max(maxText).optional(),
  artifact:outboundArtifact.optional(),
}).strict().refine(args=>args.zip!==undefined || args.summary!==undefined
  ? !!args.zip && !!args.summary && args.text===undefined && args.artifact===undefined
  : checkOutboundContent(args));
type Input = z.infer<typeof scheduledReportInput>;
type Receipt = {
  state:"sending"|"sent"|"unknown"|"rejected";
  messageId?:number; runId:string; sha256?:string; bytes?:number;
};

type Dependencies = {
  store:Store;
  grants:()=>Grant[];
  current:()=>Promise<{owner:number;bot:number}>;
  transport:(chatId:number)=>Telegram;
  threads:BbPluginApi["sdk"]["threads"];
};

const permitPrefix = "outbound:schedule:permit:";
const markerPrefix = "[bb-scheduled-group-report:";
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventScope = ["client/turn/requested","turn/input/accepted","turn/completed"] as const;

function matchingGrant(d:Dependencies, permit:Permit, owner:number, bot:number) {
  const matches = d.grants().filter(g => g.automationId === permit.automationId &&
    g.projectId === permit.projectId && g.threadId === permit.threadId && g.owner === owner && g.bot === bot);
  if (matches.length !== 1) throw Error("report_destination_unavailable_or_ambiguous");
  return matches[0];
}

function binding(d:Dependencies, route:Grant) {
  const key = d.store.get<string>("group:thread:" + route.groupThread);
  const row = key && d.store.get<GroupTopicPolicy>(key);
  if (!row || row.threadId !== route.groupThread || row.revision !== route.groupRevision ||
      row.ownerId !== route.owner || row.botId !== route.bot || !row.projectId ||
      row.isolated || !groupThreadMatches(d.store,row,row.projectId) ||
      isTopicPaused(d.store,route.bot,row.chatId,row.topicId))
    throw Error("report_binding_revoked");
  return row;
}

type RegisteredPermit = {permit:Permit; grantDigest:string};

export async function registerSchedulePermit(d:Dependencies, permit:Permit, caller:{kind:string;pluginId?:string}) {
  if (caller.kind !== "plugin" || caller.pluginId !== "automations")
    throw Error("report_scheduler_required");
  const {owner,bot} = await d.current();
  const route = matchingGrant(d,permit,owner,bot);
  binding(d,route);
  const key = permitPrefix + permit.nonce;
  const value:RegisteredPermit = {permit,grantDigest:digest(route)};
  const old = d.store.get<RegisteredPermit>(key);
  if (old && digest(old) !== digest(value)) throw Error("report_permit_conflict");
  if (!old) d.store.put(key,value);
  return {registered:true as const};
}

async function acceptedPermit(d:Dependencies, threadId:string, projectId:string, signal:AbortSignal) {
  const events = await d.threads.events.list({
    threadId,signal,order:"desc",limit:"40",types:[...eventScope],
  });
  const accepted = events.find(e => e.type === "turn/input/accepted");
  if (!accepted || accepted.scope.kind !== "turn") throw Error("report_schedule_unverified");
  const {turnId} = accepted.scope;
  const request = events.find(e => e.type === "client/turn/requested");
  if (!request || request.type !== "client/turn/requested" || request.data.originPluginId !== "automations" ||
      request.data.target.kind !== "new-turn" || request.data.retryOfRequestId || request.data.requestId !== accepted.data.clientRequestId ||
      events.some(e => e.scope.kind === "turn" && e.scope.turnId === turnId &&
        (e.type === "turn/completed" || (e.type === "turn/input/accepted" && e.seq !== accepted.seq))))
    throw Error("report_schedule_unverified");
  const [plain, marker, extra] = request.data.input ?? [];
  if (plain?.type !== "text" || plain.visibility === "agent-only" ||
      marker?.type !== "text" || marker.visibility !== "agent-only" || extra ||
      !marker.text.startsWith(markerPrefix) || !marker.text.endsWith("]"))
    throw Error("report_schedule_unverified");
  const nonce = marker.text.slice(markerPrefix.length,-1);
  if (!z.uuid().safeParse(nonce).success) throw Error("report_schedule_unverified");
  const registered = d.store.get<RegisteredPermit>(permitPrefix + nonce);
  if (!registered || registered.permit.threadId !== threadId || registered.permit.projectId !== projectId ||
      createHash("sha256").update(plain.text).digest("hex") !== registered.permit.inputSha256)
    throw Error("report_schedule_unverified");
  return {...registered, requestId:request.data.requestId};
}

// Read only the ZIP directory. The audit verifies the individual PDFs and CRCs.
function checkZipDirectory(bytes:Buffer) {
  const invalid = () => Error("report_zip_must_contain_pdf_reports");
  if (bytes.length < 22 || bytes.readUInt32LE(0)!==0x04034b50) throw invalid();
  let end = bytes.length-22;
  const earliest = Math.max(0,end-65535);
  for (; end>=earliest; end--)
    if (bytes.readUInt32LE(end)===0x06054b50 && end+22+bytes.readUInt16LE(end+20)===bytes.length) break;
  if (end<earliest || bytes.readUInt32LE(end+4)!==0) throw invalid();
  const count = bytes.readUInt16LE(end+10);
  let entry = bytes.readUInt32LE(end+16);
  if (!count || count===65535 || bytes.readUInt16LE(end+8)!==count ||
      entry+bytes.readUInt32LE(end+12)!==end) throw invalid();
  const names = new Set<string>();
  for (let i=0; i<count; i++) {
    if (entry+46>end || bytes.readUInt32LE(entry)!==0x02014b50) throw invalid();
    const nameEnd = entry+46+bytes.readUInt16LE(entry+28);
    const next = nameEnd+bytes.readUInt16LE(entry+30)+bytes.readUInt16LE(entry+32);
    if (next>end || (bytes.readUInt16LE(entry+8)&1)!==0 || bytes.readUInt16LE(entry+34)!==0)
      throw invalid();
    const name = bytes.toString("utf8",entry+46,nameEnd);
    if (name.startsWith(".") || !/^[^/\\\p{C}]+\.pdf$/iu.test(name) || names.has(name.toLowerCase())) throw invalid();
    names.add(name.toLowerCase());
    entry = next;
  }
  if (entry!==end) throw invalid();
}

function reportFile(input:Input,route:Grant) {
  if (!input.zip)
    return input.artifact && readOutboundFile(input.artifact.path,route,input.artifact.kind ?? "document");
  if (!/\.zip$/i.test(input.zip)) throw Error("report_zip_outside_output");
  try {
    return readOutboundFile(input.zip,route,"document",checkZipDirectory);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("outbound_file_"))
      throw Error(error.message.replace("outbound_file_","report_zip_"));
    throw error;
  }
}

export async function publishScheduledReport(d:Dependencies, scope:{threadId:string;projectId:string;signal:AbortSignal}, input:Input) {
  const {threadId,projectId,signal} = scope;
  const proof = await acceptedPermit(d,threadId,projectId,signal);
  const {permit} = proof;
  const {owner,bot} = await d.current();
  const route = matchingGrant(d,permit,owner,bot);
  if (digest(route) !== proof.grantDigest) throw Error("report_binding_revoked");
  const group = binding(d,route);
  const target = await d.threads.get({threadId:group.threadId,signal});
  if (target.projectId !== group.projectId || target.archivedAt !== null || target.deletedAt !== null)
    throw Error("report_binding_revoked");
  const key = "outbound:schedule:release:" + digest([bot,owner,permit.automationId,permit.scheduledFor]);
  const old = d.store.get<Receipt>(key);
  if (old) return old;
  const text=input.zip ? input.summary : input.text;
  const file=reportFile(input,route);
  const publicText=[text ?? "",file?.name ?? ""].join("\n");
  if (stripTelegramMarkers(publicText) !== publicText ||
      /bb-(?:telegram-(?:reply-route|child-result)|scheduled-group-report)/i.test(publicText))
    throw Error("report_private_metadata");
  if (!checkOutboundContent({text,artifact:file})) throw Error("outbound_content_invalid");
  const live = await d.current();
  const latest = await acceptedPermit(d,threadId,projectId,signal);
  if (latest.requestId !== proof.requestId || latest.permit.nonce !== permit.nonce ||
      live.owner !== owner || live.bot !== bot ||
      digest(matchingGrant(d,permit,owner,bot)) !== proof.grantDigest)
    throw Error("report_schedule_revoked");
  signal.throwIfAborted();
  const policy = binding(d,route);
  const existing = d.store.get<Receipt>(key);
  if (existing) return existing;
  const started:Receipt = {state:"sending",runId:permit.runId,...(file && {sha256:file.sha256,bytes:file.bytes})};
  const finish = beginTopicSend(d.store,bot,policy.chatId,policy.topicId);
  try {
    d.store.put(key,started);
    let receipt:Receipt;
    try {
      const messageId=await sendOutboundMessage(d.transport(policy.chatId),{
        chatId:policy.chatId,topicId:policy.topicId,text,file,
      });
      receipt = {...started,state:"sent",messageId};
    } catch (err) {
      receipt = {...started,state:err instanceof TelegramFailure && !err.ambiguous ? "rejected" : "unknown"};
    }
    d.store.put(key,receipt);
    return receipt;
  } finally {
    finish();
  }
}
