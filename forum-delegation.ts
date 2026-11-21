import {applyForumTopicChange,originalForumCommand} from "./forum-commands";
import {forumDefaults} from "./forum-defaults";
import {canInvokeGroup,type GroupTopicPolicy} from "./ingress";
import {checkOwnerForum,chooseOwnerForum,ownerTopicInput,type OwnerForumScope,type TopicSource} from "./owner-topic";
import {effectiveGroupPolicy} from "./rights";
import type {Store,Telegram} from "./model";

type Dependencies={store:Store;owner:number;bot:number;signal:AbortSignal;since?:number;transport:(id:number)=>Telegram;
  current:()=>boolean;create:(args:{confirm:true;title:string;text?:string},scope:OwnerForumScope,source:TopicSource)=>
    Promise<{url:string;requiresBinding?:true}>};
const link=/^https:\/\/t\.me\/c\/([1-9]\d*)\/([1-9]\d*)\/?$/;
const id=(value:unknown):value is number=>typeof value==="number" && Number.isSafeInteger(value) && value>0;

export async function handleDelegatedForumCommand(d:Dependencies,update:any) {
  const {store,owner,bot,transport}=d;
  const m=update.message;
  const command=originalForumCommand(update);
  if (!command || !d.current()) return false;
  const actor=m.from.id,fromChat=m.chat?.id,fromTopic=m.message_thread_id??0;
  const direct=m.chat?.type==="private" && fromChat===actor;
  const group=m.chat?.type==="supergroup" && m.chat.is_forum===true && m.is_topic_message===true;
  if ((!direct && !group) || (direct && actor===owner)) return false;
  const {action,botUsername}=command;
  const parts=command.args.split("|").map((part:string)=>part.trim());
  const allowed=(p:GroupTopicPolicy)=>canInvokeGroup(effectiveGroupPolicy(store,p,owner),owner,actor);
  const defaultsFor=(chat:number)=>{
    const defaults=forumDefaults(store,bot,owner,chat);
    if (!defaults || !Number.isSafeInteger(m.date) || m.date<Math.max(defaults.since,d.since??0) ||
        !allowed(defaults.source)) return;
    const permitted=action==="create"?defaults.managers:action==="delete"?defaults.deleteManagers:defaults.closeManagers;
    if (actor===owner || permitted.includes(actor)) return defaults;
  };
  const receipt=`group:delegated-forum:${bot}:${actor}:${fromChat}:${m.message_id}`;
  if (store.get(receipt)) return true;
  const forums=new Map<number,GroupTopicPolicy>();
  if (group) {
    const source=store.get<GroupTopicPolicy>(`group:policy:${fromChat}:${fromTopic}`);
    if (!source || source.botId!==bot) return false;
    const replied=m.reply_to_message;
    const addressed=botUsername ? botUsername===source.botUsername.toLowerCase() :
      replied?.from?.id===bot && replied.chat?.id===fromChat && replied.message_thread_id===fromTopic;
    if (!addressed) return false;
    const configured=defaultsFor(fromChat);
    if (!configured || !allowed(source)) {
      store.put(receipt,"denied");
      return false;
    }
    forums.set(fromChat,configured.source);
  } else {
    const prefix=`group:forum-defaults:${bot}:`;
    for (const row of store.list(prefix)) {
      const chat=Number(row.key.slice(prefix.length));
      const configured=defaultsFor(chat);
      if (configured) forums.set(chat,configured.source);
    }
    if (!forums.size) {
      if (!botUsername) store.put(receipt,"denied");
      return false;
    }
  }
  const reply=(text:string)=>transport(fromChat)("sendMessage",{chat_id:fromChat,
    message_thread_id:fromTopic||undefined,reply_parameters:{message_id:m.message_id},text});
  if (botUsername && ![...forums.values()].some(p=>p.botUsername.toLowerCase()===botUsername)) return false;
  store.put(receipt,"working");
  try {
    let chat:number,topic:number|undefined;
    if (action==="create") {
      if (parts.length>3 || !parts[0] || (group && parts[1])) throw Error("forum_command_syntax");
      if (direct && actor!==owner && !parts[1]) throw Error("explicit_private_forum_selection_required");
      chat=group?fromChat:await chooseOwnerForum(forums,parts[1]||undefined,transport);
    } else {
      const parsed=link.exec(parts[0]);
      if (parts.length!==1 || (!parsed && (!group || parts[0] || action==="delete"))) throw Error("forum_command_syntax");
      chat=parsed?Number("-100"+parsed[1]):fromChat;
      topic=parsed?Number(parsed[2]):fromTopic;
      if (group && chat!==fromChat) throw Error("forum_topic_unavailable");
      if (!id(topic) || topic<2) throw Error("forum_topic_unavailable");
    }
    const source=forums.get(chat);
    if (!source?.projectId) throw Error("forum_topic_unavailable");
    const targetPolicy=()=>topic===undefined?undefined:store.get<GroupTopicPolicy>(`group:policy:${chat}:${topic}`);
    const initial=targetPolicy();
    const shared=source.ownerSharedProject;
    const work=shared?undefined:true;
    const checkScopes=()=>{
      d.signal.throwIfAborted();
      const latest=defaultsFor(chat)?.source;
      if (!d.current() || latest?.threadId!==source.threadId || latest?.revision!==source.revision)
        throw Error("forum_topic_changed");
      const localScope=process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE;
      if (localScope!==undefined && localScope!==`${chat}:${topic??fromTopic}`) throw Error("forum_topic_unavailable");
      if (group) {
        const original=store.get<GroupTopicPolicy>(`group:policy:${fromChat}:${fromTopic}`);
        if (!original || original.botId!==bot || !allowed(original)) throw Error("forum_topic_unavailable");
      }
      if (topic!==undefined) {
        const policy=targetPolicy();
        if (policy ? policy.botId!==bot || policy.ownerId!==owner || !allowed(policy) || policy.revision!==initial?.revision :
            actor!==owner || !store.get(`group:managed-topic:${bot}:${chat}:${topic}`))
          throw Error("forum_topic_unavailable");
      }
    };
    const current=async()=>{
      checkScopes();
      await checkOwnerForum(transport(chat),chat,owner,bot,{shared,work},action==="delete");
      if (actor!==owner) {
        const member=await transport(chat)("getChatMember",{chat_id:chat,user_id:actor});
        if (member.user?.id!==actor || !["member","administrator","creator"].includes(member.status) ||
            (action==="delete" && member.status!=="creator" &&
              (member.status!=="administrator" || member.can_delete_messages!==true)))
          throw Error("forum_topic_unavailable");
      }
      checkScopes();
    };
    await current();
    let message:string;
    if (action==="create") {
      const args=ownerTopicInput.parse({confirm:true,title:parts[0],...(parts[2] && {text:parts[2]})});
      const result=await d.create(args,{projectId:source.ownerTopicManagerProjectId??source.projectId,
        threadId:source.threadId,signal:d.signal},{chatId:chat,topicId:group?fromTopic:0,
        key:receipt,text:[args.title,args.text].filter(Boolean).join("\n"),shared,work,current,prove:current});
      message="Тема создана. "+result.url+(result.requiresBinding?" Бот начнёт принимать задачи после привязки исполнителя.":"");
    } else {
      message=await applyForumTopicChange(store,bot,chat,topic!,action,transport(chat));
    }
    store.put(receipt,"done");
    await reply(message).catch(()=>{});
  } catch (error) {
    store.put(receipt,"failed");
    const code=error instanceof Error?error.message:"";
    await reply(code.includes("selection")?"Укажите точное название форума или ссылку на него.":
      code==="forum_topic_busy"?"В теме есть незавершённая работа.":
      code.includes("unconfirmed")?"Результат неизвестен. Сначала проверьте тему в Telegram.":
      "Команда недоступна. Укажите название темы или точную ссылку на тему и проверьте права.").catch(()=>{});
  }
  return true;
}
