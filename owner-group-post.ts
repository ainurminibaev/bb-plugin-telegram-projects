import {createHash, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import {z} from "zod";
import {groupThreadMatches} from "./group-binding";
import type {GroupTopicPolicy} from "./ingress";
import {TelegramFailure, type Store, type Telegram} from "./model";
import {stripTelegramMarkers} from "./reply-routing";
import {historyPrefix} from "./topic-search";
import {beginTopicSend,isTopicPaused} from "./topic-lifecycle";
import {checkOutboundContent,outboundArtifact,outboundDirectory,outboundMaxBytes,readOutboundFile,
  sendOutboundMessage,telegramMessageId,type OutboundFile} from "./outbound-message";

const identifier = z.string().min(1).max(150);
const stamp = z.number().int().positive().safe();
const label = identifier.trim().regex(/^[^\p{C}\n]+$/u);
const grant = z.object({
  destination: label, owner: stamp, bot: stamp, privateThread: identifier,
  groupThread: identifier, groupRevision: identifier,
  directory:outboundDirectory.optional(),maxBytes:outboundMaxBytes.optional(),
}).strict().refine(row=>(row.directory===undefined)===(row.maxBytes===undefined));
type Grant = z.infer<typeof grant>;

export function ownerGroupPostGrants(path = process.env.BB_TELEGRAM_OWNER_GROUP_POSTS) {
  if (!path) return [];
  if (!isAbsolute(path)) throw Error("outbound_policy_invalid");
  try {
    return z.array(grant).max(32).parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw Error("outbound_policy_invalid");
  }
}

export const ownerGroupPostInput = z.object({
  routeToken: z.string().uuid(),
  destination: label,
  text: z.string().trim().min(1).max(3400).optional(),
  artifact:outboundArtifact.optional(),
  reply: z.object({
    messageId: stamp.optional(),
    author: z.string().trim().min(1).max(80),
    excerpt: z.string().trim().min(1).max(600),
  }).strict().optional(),
}).strict().refine(args=>checkOutboundContent(args,3400));
type Input = z.infer<typeof ownerGroupPostInput>;
type Message = {id:number; sender:number; name:string; text:string};
type Draft = {
  grant:Grant; input:Omit<Input,"routeToken">; reply?:{messageId:number;fingerprint:string};
  artifactSeal?:Pick<OutboundFile,"name"|"kind"|"sha256"|"bytes">;
  expiresAt:number; previewId?:number; messageId?:number;
  state:"previewing"|"awaiting"|"sending"|"sent"|"rejected"|"unknown"|"revoked";
};
type Dependencies = {
  store:Store;
  grants:()=>Grant[];
  transport:(chatId:number)=>Telegram;
  privateRequest:(threadId:string, routeToken:string, owner:number)=>Promise<{text:string}>;
  current:()=>Promise<{owner:number;bot:number}>;
  checkThread:(threadId:string,projectId:string)=>Promise<boolean>;
  exactReplies:(prefix:string, author:string, excerpt:string)=>Message[];
};

const prefix = "outbound:owner:";
const callbackPrefix = "outpost:";
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nameKey = (value:string) => value.normalize("NFC").trim().toLowerCase();
const stateText = {
  previewing:"Карточка ещё готовится.",
  awaiting:"Подтвердите публикацию в карточке.",
  sending:"Отправка началась. Проверьте чат перед новой попыткой.",
  sent:"Отправлено.",
  rejected:"Telegram отклонил отправку.",
  unknown:"Доставка не подтверждена. Проверьте чат перед новой попыткой.",
  revoked:"Разрешение или адрес изменились. Сообщение не отправлено.",
};

function select(d:Dependencies, destination:string, thread:string, owner:number, bot:number) {
  const matches = d.grants().filter(row => nameKey(row.destination) === nameKey(destination) &&
    row.privateThread === thread && row.owner === owner && row.bot === bot);
  if (matches.length !== 1) throw Error("outbound_destination_unavailable_or_ambiguous");
  return matches[0];
}

function binding(d:Dependencies, route:Grant) {
  const key = d.store.get<string>("group:thread:" + route.groupThread);
  const policy = key && d.store.get<GroupTopicPolicy>(key);
  if (!policy || policy.threadId !== route.groupThread || policy.revision !== route.groupRevision ||
      policy.ownerId !== route.owner || policy.botId !== route.bot || !policy.projectId ||
      policy.isolated || !groupThreadMatches(d.store, policy, policy.projectId) ||
      isTopicPaused(d.store,route.bot,policy.chatId,policy.topicId))
    throw Error("outbound_binding_revoked");
  return policy;
}

function resolveReply(d:Dependencies, policy:GroupTopicPolicy, reply:Input["reply"]) {
  if (!reply) return;
  const prefix = historyPrefix(policy.chatId,policy.topicId);
  const recent = d.store.get<Message[]>(`group:context:${policy.chatId}:${policy.topicId}`) ?? [];
  const id = reply.messageId;
  const entries = id !== undefined
    ? [policy.searchableHistory ? d.store.get<Message>(prefix + id) ?? recent.find(row=>row.id===id) : recent.find(row=>row.id===id)]
    : [...(policy.searchableHistory ? d.exactReplies(prefix,reply.author,reply.excerpt) : []),...recent];
  const matches = new Map<number,Message>();
  for (const row of entries) {
    if (row && stamp.safeParse(row.id).success && (id===undefined || row.id===id) &&
        stamp.safeParse(row.sender).success && typeof row.name==="string" && typeof row.text==="string" &&
        row.name===reply.author && row.text.includes(reply.excerpt) && !matches.has(row.id))
      matches.set(row.id,row);
  }
  if (matches.size!==1) throw Error("outbound_reply_unverified_or_ambiguous");
  const [row] = matches.values();
  return {messageId:row.id,fingerprint:digest([row.sender,row.id,row.name,row.text])};
}

function readOwnerArtifact(artifact:Input["artifact"],route:Grant) {
  if (!artifact) return;
  if (route.directory===undefined || route.maxBytes===undefined)
    throw Error("outbound_file_not_granted");
  return readOutboundFile(artifact.path,{directory:route.directory,maxBytes:route.maxBytes},artifact.kind ?? "document");
}

function fileSeal(file:OutboundFile|undefined) {
  if (!file) return;
  const {name,kind,sha256,bytes}=file;
  return {name,kind,sha256,bytes};
}

export async function previewOwnerGroupPost(d:Dependencies, threadId:string, args:Input) {
  const {owner,bot} = await d.current();
  await d.privateRequest(threadId, args.routeToken, owner);
  const route = select(d, args.destination, threadId, owner, bot);
  const policy = binding(d, route);
  if (!await d.checkThread(policy.threadId, policy.projectId!)) throw Error("outbound_binding_revoked");
  await d.privateRequest(threadId, args.routeToken, owner);
  const current = await d.current();
  if (current.owner !== owner || current.bot !== bot ||
      digest(select(d, args.destination, threadId, owner, bot)) !== digest(route))
    throw Error("outbound_binding_revoked");
  const reply = resolveReply(d, binding(d, route), args.reply);
  const {routeToken, ...input} = args;
  if (!checkOutboundContent(input,3400)) throw Error("outbound_content_invalid");
  const artifactSeal=fileSeal(readOwnerArtifact(input.artifact,route));
  const publicText=[input.text ?? "",artifactSeal?.name ?? ""].join("\n");
  if (stripTelegramMarkers(publicText) !== publicText ||
      publicText.includes(routeToken) || /bb-telegram-(?:reply-route|child-result)/i.test(publicText))
    throw Error("outbound_private_metadata");
  const requestKey = prefix + "request:" + digest([bot,owner,routeToken]);
  const old = d.store.get<string>(requestKey);
  if (old) {
    const draft = d.store.get<Draft>(prefix + old);
    if (!draft || digest(draft.input) !== digest(input) || digest(draft.grant) !== digest(route) ||
        digest(draft.artifactSeal ?? null)!==digest(artifactSeal ?? null))
      throw Error("outbound_request_conflict");
    return {state:draft.state, messageId:draft.messageId};
  }
  const id = randomUUID();
  const key = prefix + id;
  const draft:Draft = {grant:route,input,reply,artifactSeal,expiresAt:Date.now() + 10 * 60_000,state:"previewing"};
  d.store.atomic(() => {
    d.store.put(requestKey, id);
    d.store.put(key, draft);
  });
  const context = reply && input.reply
    ? `Ответ на сообщение №${reply.messageId} (${input.reply.author}).`
    : "Отдельное сообщение.";
  const note=artifactSeal
    ? `\n${artifactSeal.kind==="photo" ? "Фото" : "Документ"} «${artifactSeal.name}», ${artifactSeal.bytes} байт\nSHA-256 ${artifactSeal.sha256}`
    : "";
  try {
    const sent = await d.transport(owner)("sendMessage", {
      text:`Отправить в «${route.destination}»?\n${context}${note}${input.text ? "\n\n"+input.text : ""}`,
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:"Подтвердить публикацию",callback_data:callbackPrefix + id}]]},
    });
    d.store.put(key,{...draft,state:"awaiting",previewId:telegramMessageId(sent,owner)});
    return {state:"awaiting"};
  } catch {
    // Never send again if Telegram might already have displayed the preview.
    d.store.put(key,{...draft,state:"unknown"});
    return {state:"unknown"};
  }
}

async function publish(d:Dependencies, key:string, draft:Draft) {
  if (draft.state !== "awaiting") return draft;
  let policy:GroupTopicPolicy;
  let file:OutboundFile|undefined;
  try {
    const {owner,bot} = await d.current();
    const {grant:route,input} = draft;
    if (draft.expiresAt <= Date.now() ||
        digest(select(d, input.destination, route.privateThread, owner, bot)) !== digest(route))
      throw Error("outbound_binding_revoked");
    policy = binding(d, route);
    if (!await d.checkThread(policy.threadId, policy.projectId!)) throw Error("outbound_binding_revoked");
    const live = await d.current();
    if (live.owner !== owner || live.bot !== bot || draft.expiresAt <= Date.now() ||
        digest(select(d, input.destination, route.privateThread, owner, bot)) !== digest(route))
      throw Error("outbound_binding_revoked");
    policy = binding(d, route);
    if (input.reply && (!draft.reply ||
        resolveReply(d,policy,{...input.reply,messageId:draft.reply.messageId})?.fingerprint!==draft.reply.fingerprint))
      throw Error("outbound_reply_unverified");
    file=readOwnerArtifact(input.artifact,route);
    if (digest(fileSeal(file) ?? null)!==digest(draft.artifactSeal ?? null))
      throw Error("outbound_file_changed");
  } catch {
    const current = d.store.get<Draft>(key) ?? draft;
    if (current.state !== "awaiting") return current;
    const receipt:Draft = {...draft,state:"revoked"};
    d.store.put(key,receipt);
    return receipt;
  }
  const current = d.store.get<Draft>(key) ?? draft;
  if (current.state !== "awaiting") return current;
  const finish = beginTopicSend(d.store,draft.grant.bot,policy.chatId,policy.topicId);
  try {
    d.store.put(key,{...draft,state:"sending"});
    let receipt:Draft;
    try {
      const messageId=await sendOutboundMessage(d.transport(policy.chatId),{
        chatId:policy.chatId,topicId:policy.topicId,replyTo:draft.reply?.messageId,text:draft.input.text,file,
      });
      receipt = {...draft,state:"sent",messageId};
    } catch (err) {
      receipt = {...draft,state:err instanceof TelegramFailure && !err.ambiguous ? "rejected" : "unknown"};
    }
    d.store.put(key,receipt);
    return receipt;
  } finally {
    finish();
  }
}

export async function handleOwnerGroupPost(d:Dependencies, update:any, owner:number, bot:number) {
  const query = update?.callback_query;
  if (typeof query?.data !== "string" || !query.data.startsWith(callbackPrefix)) return false;
  if (query.from?.id !== owner || query.from.is_bot || query.message?.chat?.id !== owner ||
      query.message.chat.type !== "private" || query.message.from?.id !== bot) return true;
  const id = query.data.slice(callbackPrefix.length);
  if (!z.uuid().safeParse(id).success) return true;
  const key = prefix + id;
  const draft = d.store.get<Draft>(key);
  if (!draft || draft.grant.bot !== bot || draft.grant.owner !== owner ||
      draft.previewId !== query.message.message_id) return true;
  const receipt = await publish(d,key,draft);
  await d.transport(owner)("answerCallbackQuery",{
    callback_query_id:query.id,show_alert:true,
    text:receipt.state === "sent" ? `Отправлено. Сообщение №${receipt.messageId}.` : stateText[receipt.state],
  }).catch(() => {});
  return true;
}
