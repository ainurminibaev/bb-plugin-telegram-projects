import {groupThreadMatches,isSharedOwnerPolicy,sharedOwnerForum} from "./group-binding";
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bindGroupTopic, groupTaskNote } from "./group-worker";
import type { GroupOrigin } from "./group-result";
import type { GroupTopicPolicy, Ingress } from "./ingress";
import { TelegramFailure, type Store, type Telegram } from "./model";
import { stripTelegramMarkers } from "./reply-routing";
import { sourcesVisible } from "./source-access";

export const ownerTopicInput = z.object({
  confirm: z.literal(true),
  title: z.string().trim().min(1).max(128).refine(text => !/[\x00-\x1f]/.test(text)),
  text: z.string().trim().min(1).max(4096).optional(),
}).strict();

export const ownerPrivateTopicInput=ownerTopicInput.extend({routeToken:z.string().uuid(),forum:z.string().trim().min(1).max(200).optional()});

const defaultFirstMessage = "Тема создана. Продолжим здесь.";

type Args = z.infer<typeof ownerTopicInput> & {routeToken?:string;forum?:string};
export type OwnerForumScope = {threadId:string; projectId:string; signal:AbortSignal};
type Origin = GroupOrigin;
type SubmittedJob = { state:string; ownerId:number; revision?:string; taskId?:string;
  route: Extract<Ingress,{kind:"group"}> };
type Receipt =
  | {phase:"creating"}
  | {phase:"topic" | "spawning"; topicId:number}
  | {phase:"thread" | "posting"; topicId:number; threadId:string; revision:string}
  | {phase:"work-posting"; topicId:number}
  | {phase:"done"; topicId:number; threadId?:string; revision?:string; messageId:number};
type Operation = {digest:string; projectId:string; work?:true; receipt:Receipt};
type Dependencies = {
  store:Store; sdk:BbPluginApi["sdk"];
  identity:()=>Promise<{owner:number; bot:number}>;
  transport:(chatId:number, signal:AbortSignal)=>Telegram;
  provePrivate?:(threadId:string,routeToken:string,owner:number)=>Promise<{key:string;text:string}>;
};
export type TopicSource={chatId:number;topicId:number;key:string;text?:string;shared?:true;work?:true;
  current:()=>Promise<void>;prove:()=>Promise<void>};

async function groupSource(d:Dependencies,scope:OwnerForumScope,owner:number,bot:number):Promise<TopicSource> {
  const {store,sdk}=d;
  const {threadId,projectId,signal}=scope;
  const candidates = store.list<SubmittedJob>(`group:in:${bot}:`).map(row=>row.value)
    .filter(job => job.state==="submitted" && job.ownerId===owner &&
      job.route.senderId===owner && job.route.threadId===threadId && job.route.updateId>0 && job.taskId);
  if (candidates.length !== 1) throw Error("current_owner_group_request_required");
  const [job] = candidates;
  const {route} = job;
  const origin = store.get<Origin>("group:origin:"+job.taskId);
  if (!origin || origin.owner!==owner || origin.sender!==owner || origin.bot!==bot || origin.threadId!==threadId ||
      origin.projectId!==projectId || origin.chatId!==route.chatId || origin.topicId!==route.topicId ||
      origin.messageId!==route.messageId || origin.revision!==job.revision || origin.executionToken)
    throw Error("current_owner_group_request_required");
  const {chatId} = origin;
  const sourceKey = `group:policy:${chatId}:${origin.topicId}`;
  const initial=store.get<GroupTopicPolicy>(sourceKey);
  const sourceIsShared=initial?.ownerSharedProject;
  const work=initial?.ownerTopicManagerProjectId ? true : undefined;
  const currentSource = async () => {
    signal.throwIfAborted();
    const live = await d.identity();
    if (live.owner !== owner || live.bot !== bot) throw Error("bot_changed");
    const persisted = store.get<SubmittedJob>(`group:in:${bot}:${route.updateId}`);
    const source = store.get<GroupTopicPolicy>(sourceKey);
    if (persisted?.state!=="submitted" || persisted.taskId!==job.taskId ||
        source?.revision!==origin.revision || source?.ownerId!==owner || source.botId!==bot ||
        source.threadId!==threadId || source.projectId!==projectId || source.isolated ||
        source.ownerSharedProject!==sourceIsShared ||
        source.ownerTopicManagerProjectId!==initial?.ownerTopicManagerProjectId || !groupThreadMatches(store,source,projectId) ||
        !sourcesVisible(source.deliverySources,bot,chatId,origin.topicId))
      throw Error("current_owner_group_request_required");
    signal.throwIfAborted();
  };
  const proveTurn = async () => {
    // The native tool context has a thread ID. The native input log proves
    // that the submitted job is the accepted input still running there.
    const events = await sdk.threads.events.list({threadId,signal,order:"desc",limit:"30",
      types:["client/turn/requested","turn/input/accepted","turn/completed"]});
    const accepted = events.find(e=>e.type==="turn/input/accepted");
    if (accepted?.scope.kind!=="turn") throw Error("current_owner_group_request_required");
    const request = events.find(e => e.type==="client/turn/requested" && e.data.requestId===accepted.data.clientRequestId);
    if (request?.type!=="client/turn/requested" || request.data.originPluginId!=="telegram-projects" ||
        !request.data.input?.some(item=>item.type==="text" && item.visibility==="agent-only" &&
          item.text===groupTaskNote(job.taskId!)))
      throw Error("current_owner_group_request_required");
    const turnId = accepted.scope.turnId;
    if (events.some(e=>e.type==="turn/completed" && e.scope.kind==="turn" && e.scope.turnId===turnId && e.seq>accepted.seq))
      throw Error("current_owner_group_request_required");
  };
  return {chatId,topicId:origin.topicId,key:job.taskId!,text:route.ownerTopicText,
    shared:sourceIsShared,work,current:currentSource,prove:proveTurn};
}

export function eligibleOwnerForums(store:Store,owner:number,bot:number,projectId:string) {
  const forums=new Map<number,GroupTopicPolicy>();
  for (const {value:policy} of store.list<GroupTopicPolicy>("group:policy:")) {
    if (policy.ownerId!==owner || policy.botId!==bot || !policy.projectId || !groupThreadMatches(store,policy,policy.projectId)) continue;
    if ((isSharedOwnerPolicy(policy) && policy.projectId===projectId) || policy.ownerTopicManagerProjectId===projectId)
      forums.set(policy.chatId,policy);
  }
  return forums;
}

const normalizeForum=(text:string)=>text.normalize("NFC").toLowerCase();

export async function chooseOwnerForum(forums:Map<number,GroupTopicPolicy>,forum:string|undefined,
  transport:(id:number)=>Telegram,originalText?:string) {
  if (!forum) {
    if (forums.size!==1) throw Error("explicit_private_forum_selection_required");
    return [...forums.keys()][0];
  }
  const supplied=normalizeForum(forum);
  const ref=/^https:\/\/t\.me\/c\/([1-9]\d*)(?:\/[1-9]\d*){0,2}\/?$/.exec(forum);
  if (ref) {
    const selected=Number("-100"+ref[1]);
    if (forums.has(selected)) return selected;
    throw Error("private_forum_selection_unavailable");
  }
  const chats=await Promise.all([...forums.keys()].map(async id=>{
    const chat=await transport(id)<{id:number;title?:string}>("getChat",{chat_id:id});
    return chat.id===id && chat.title ? {id,title:normalizeForum(chat.title)} : undefined;
  }));
  const matches=chats.filter(chat=>chat?.title===supplied);
  const cited=originalText===undefined ? "" : normalizeForum(originalText);
  const quoted=cited.includes("«"+supplied+"»") || cited.includes('"'+supplied+'"');
  if (matches.length!==1 || (!quoted && chats.some(chat=>chat && chat.title!==supplied &&
      chat.title.includes(supplied) && cited.includes(chat.title))))
    throw Error("private_forum_selection_unavailable");
  return matches[0]!.id;
}

export async function checkOwnerForum(tg:Telegram,chatId:number,owner:number,bot:number,
  mode:{shared?:true;work?:true},deleting=false) {
  if (mode.shared && !await sharedOwnerForum(tg,chatId,owner,bot))
    throw Error("private_owner_forum_required");
  const chat=await tg("getChat",{chat_id:chatId});
  if (chat.id!==chatId || chat.type!=="supergroup" || chat.is_forum!==true ||
      (!mode.work && (chat.username || chat.active_usernames?.length)))
    throw Error("closed_forum_supergroup_required");
  const self=await tg("getMe",{});
  if (self.id!==bot || !self.is_bot || !self.username) throw Error("bot_changed");
  const ownerMember=await tg("getChatMember",{chat_id:chatId,user_id:owner});
  if (ownerMember.user?.id!==owner || !(ownerMember.status==="creator" ||
      (ownerMember.status==="administrator" && ownerMember.can_manage_topics===true &&
        (!deleting || ownerMember.can_delete_messages===true))))
    throw Error("forum_owner_rights_required");
  const botMember=await tg("getChatMember",{chat_id:chatId,user_id:bot});
  if (botMember.user?.id!==bot || botMember.status!=="administrator" || botMember.can_manage_topics!==true)
    throw Error("bot_requires_can_manage_topics");
  if (deleting && botMember.can_delete_messages!==true) throw Error("bot_requires_can_delete_messages");
  return {username:self.username as string,title:String(chat.title??chatId).slice(0,128)};
}

async function privateSource(d:Dependencies,scope:OwnerForumScope,owner:number,bot:number,token:string,forum?:string):Promise<TopicSource> {
  if (!d.provePrivate) throw Error("current_owner_request_required");
  const {threadId,projectId,signal}=scope;
  const proof=()=>d.provePrivate!(threadId,token,owner);
  const originals=()=>eligibleOwnerForums(d.store,owner,bot,projectId);
  const original=await proof();
  if (forum && !normalizeForum(original.text).includes(normalizeForum(forum)))
    throw Error("explicit_private_forum_selection_required");
  const choose=()=>chooseOwnerForum(originals(),forum,id=>d.transport(id,signal),original.text);
  const chatId=await choose();
  const selected=originals().get(chatId);
  if (!selected) throw Error("private_owner_forum_changed");
  const shared=selected.ownerSharedProject;
  const work=shared ? undefined : true;
  return {chatId,topicId:0,key:original.key,text:original.text,shared,work,
    current:async()=>{
      signal.throwIfAborted();
      const identity=await d.identity();
      if (identity.owner!==owner || identity.bot!==bot || await choose()!==chatId)
        throw Error("private_owner_forum_changed");
      const current=originals().get(chatId);
      if (!current || current.ownerSharedProject!==shared) throw Error("private_owner_forum_changed");
    },
    prove:async()=>{
      const live=await proof();
      if (live.key!==original.key || live.text!==original.text) throw Error("current_owner_request_required");
    },
  };
}

export function ownerTopicTool(d: Dependencies) {
  const inFlight = new Set<string>();
  return async (args: Args, scope: OwnerForumScope, confirmedCommand?:TopicSource) => {
    const {store, sdk} = d;
    const {owner,bot} = await d.identity();
    const {threadId, projectId, signal} = scope;
    const source=confirmedCommand ?? (args.routeToken ? await privateSource(d,scope,owner,bot,args.routeToken,args.forum) : await groupSource(d,scope,owner,bot));
    const {chatId,shared:sourceIsShared,work,current:currentSource,prove:proveTurn,text:ownerMessage}=source;
    const privateChat = /^-100([1-9]\d*)$/.exec(String(chatId))?.[1];
    if (!privateChat || !ownerMessage?.includes(args.title) || stripTelegramMarkers(args.title)!==args.title)
      throw Error("explicit_owner_title_required");
    if (args.text!==undefined && (!ownerMessage.includes(args.text) || stripTelegramMarkers(args.text)!==args.text))
      throw Error("explicit_owner_message_required");
    const text = args.text ?? defaultFirstMessage;
    const key = "group:owner-topic:"+JSON.stringify([bot,chatId,args.title.normalize("NFC").toLowerCase()]);
    const digest = createHash("sha256").update(JSON.stringify([args.title,text])).digest("hex");
    if (inFlight.has(key)) throw Error("owner_topic_in_progress");
    inFlight.add(key);
    try {
      await currentSource();
      await proveTurn();
      const thread = await sdk.threads.get({threadId,signal});
      if (thread.id!==threadId || thread.projectId!==projectId || !thread.environmentId ||
          thread.archivedAt || thread.deletedAt || thread.visibility!=="visible" ||
          (sourceIsShared && thread.parentThreadId))
        throw Error("group_source_thread_unavailable");
      const tg = d.transport(chatId,signal);
      const checkForum=()=>checkOwnerForum(tg,chatId,owner,bot,{shared:sourceIsShared,work});
      const {username}=await checkForum();
      async function post(topicId:number) {
        const message=await tg("sendMessage",{chat_id:chatId,message_thread_id:topicId,text,
          link_preview_options:{is_disabled:true}});
        if (message?.chat?.id!==chatId || message.message_thread_id!==topicId ||
            !Number.isSafeInteger(message.message_id) || message.message_id<1)
          throw Error("owner_topic_post_unconfirmed");
        return message.message_id as number;
      }

      const taskKey = "group:owner-topic-task:"+source.key;
      const claimTask = () => {
        const existing = store.get<string>(taskKey);
        if (existing && existing!==key) throw Error("owner_topic_request_conflict");
        if (!existing) store.put(taskKey,key);
      };
      const saved = store.get<Operation>(key);
      if (saved && (saved.digest!==digest || saved.projectId!==projectId || saved.work!==work))
        throw Error("owner_topic_request_conflict");
      let receipt: Receipt | undefined = saved?.receipt;
      const save = (next: Receipt) => {
        store.put(key,{digest,projectId,...(work && {work}),receipt:next} satisfies Operation);
        receipt = next;
      };
      if (receipt) claimTask();
      if (!receipt) {
        await currentSource();
        await proveTurn();
        signal.throwIfAborted();
        store.atomic(() => {
          claimTask();
          save({phase:"creating"});
        });
        let result;
        try {
          result = await tg("createForumTopic",{chat_id:chatId,name:args.title});
        } catch (error) {
          if (error instanceof TelegramFailure && !error.ambiguous) store.del(key);
          throw error;
        }
        if (!Number.isSafeInteger(result?.message_thread_id) || result.message_thread_id<2 ||
            result.message_thread_id===source.topicId)
          throw Error("owner_topic_creation_unconfirmed");
        save({phase:"topic",topicId:result.message_thread_id});
      }
      // Re-read the durable receipt after each save. Unknown mutations are
      // deliberately held for manual reconciliation instead of replayed.
      let stage = store.get<Operation>(key)!.receipt;
      if (stage.phase==="creating") throw Error("owner_topic_creation_unconfirmed");
      if (stage.phase==="work-posting") throw Error("owner_topic_post_unconfirmed");
      if (stage.phase==="topic" && work) {
        await checkForum();
        await currentSource();
        await proveTurn();
        signal.throwIfAborted();
        save({...stage,phase:"work-posting"});
        try {
          stage={...stage,phase:"done",messageId:await post(stage.topicId)};
        } catch (error) {
          if (error instanceof TelegramFailure && !error.ambiguous) save(stage);
          throw error;
        }
        save(stage);
      }
      if (stage.phase==="topic") {
        await currentSource();
        await proveTurn();
        signal.throwIfAborted();
        if (store.get(`group:policy:${chatId}:${stage.topicId}`))
          throw Error("owner_topic_binding_conflict");
        save({...stage,phase:"spawning"});
        const newThread = await sdk.threads.spawn({
          projectId, title:args.title, visibility:"visible", permissionMode:"accept-edits",
          // BB 0.50.1 requires input to spawn a standalone thread. This
          // initialization has no Telegram route and contains no user content.
          input:[{type:"text",visibility:"agent-only",mentions:[],
            text:"This is a new Telegram topic thread. Wait for a group request. Reply with NO_REPLY, without using tools."}],
          environment:{type:"reuse",environmentId:thread.environmentId},
          ...(thread.providerId && {providerId:thread.providerId}),
        });
        if (!newThread.id || newThread.id===threadId || newThread.projectId!==projectId)
          throw Error("owner_topic_thread_unconfirmed");
        save({phase:"thread",topicId:stage.topicId,threadId:newThread.id,revision:randomUUID()});
        stage = store.get<Operation>(key)!.receipt;
      }
      if (stage.phase==="spawning") throw Error("owner_topic_thread_unconfirmed");
      if (stage.phase==="posting") throw Error("owner_topic_post_unconfirmed");
      if (stage.phase==="thread") {
        await currentSource();
        await proveTurn();
        const newThread = await sdk.threads.get({threadId:stage.threadId,signal});
        if (newThread.id!==stage.threadId || newThread.projectId!==projectId ||
            newThread.environmentId!==thread.environmentId || newThread.archivedAt || newThread.deletedAt ||
            newThread.visibility!=="visible")
          throw Error("owner_topic_thread_unavailable");
        const targetKey = `group:policy:${chatId}:${stage.topicId}`;
        const target = store.get<GroupTopicPolicy>(targetKey);
        if (target && (target.threadId!==stage.threadId || target.revision!==stage.revision))
          throw Error("owner_topic_binding_conflict");
        signal.throwIfAborted();
        if (!target) bindGroupTopic(store,{
          chatId, topicId:stage.topicId, threadId:stage.threadId, projectId,
          revision:stage.revision, botId:bot, botUsername:username,
          ownerId:owner, ownerOnly:true, ownerTopic:true, requireMention:false,
          ...(sourceIsShared && {ownerSharedProject:true}),
        },projectId);
        await checkForum();
        await currentSource();
        await proveTurn();
        signal.throwIfAborted();
        const bound = store.get<GroupTopicPolicy>(targetKey);
        if (bound?.revision!==stage.revision || bound.threadId!==stage.threadId ||
            bound.ownerId!==owner || bound.botId!==bot || bound.ownerTopic!==true ||
            bound.ownerSharedProject!==sourceIsShared || !bound.ownerOnly || bound.requireMention || bound.allowedSenderIds?.length || bound.projectId!==projectId ||
            bound.chatId!==chatId || bound.topicId!==stage.topicId || store.get("group:thread:"+stage.threadId)!==targetKey)
          throw Error("owner_topic_binding_conflict");
        save({...stage,phase:"posting"});
        try {
          stage={...stage,phase:"done",messageId:await post(stage.topicId)};
        } catch (error) {
          if (error instanceof TelegramFailure && !error.ambiguous) save(stage);
          throw error;
        }
        save(stage);
      }
      if (stage.phase!=="done") throw Error("owner_topic_operation_unconfirmed");
      store.put(`group:managed-topic:${bot}:${chatId}:${stage.topicId}`,{title:args.title,messageId:stage.messageId});
      return {topicId:stage.topicId,...(stage.threadId ? {threadId:stage.threadId} : {requiresBinding:true as const}),
        messageId:stage.messageId,
        url:`https://t.me/c/${privateChat}/${stage.topicId}/${stage.messageId}`};
    } finally {
      inFlight.delete(key);
    }
  };
}
