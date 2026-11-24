import {forumNameKey} from "./forum-defaults";
import {checkOwnerForum,chooseOwnerForum,eligibleOwnerForums,ownerTopicInput,
  type OwnerForumScope,type TopicSource} from "./owner-topic";
import {TelegramFailure,type Store,type Telegram} from "./model";
import {historyPrefix} from "./topic-search";
import {contextMediaPrefix,type GroupTopicPolicy} from "./ingress";
import {topicHasWork,topicStateKey,type TopicState} from "./topic-lifecycle";

export type ForumAction="create"|"close"|"reopen"|"delete";
type Binding={threadId:string;projectId:string};
type Dependencies={store:Store;owner:number;bot:number;signal:AbortSignal;since?:number;
  transport:(chatId:number)=>Telegram;binding:(topic:number)=>Binding|undefined;
  current:()=>boolean;create:(args:{confirm:true;title:string;text?:string},scope:OwnerForumScope,
    source:TopicSource)=>Promise<{url:string;requiresBinding?:true}>};
const methods={close:"closeForumTopic",reopen:"reopenForumTopic",delete:"deleteForumTopic"};
const help="Команды: /topic_create Название | Форум | Первое сообщение\n"+
  "Форум и первое сообщение можно опустить. Для закрытия, открытия и удаления: "+
  "/topic_close, /topic_reopen или /topic_delete и ссылка на тему вида https://t.me/c/123456/42.";
const describeError=(error:unknown)=>{
  const code=error instanceof Error?error.message:"";
  if (code==="forum_command_expired") return "Отправьте новую команду для этой операции.";
  if (code==="forum_private_binding_required") return "Откройте исходную личку владельца.";
  if (code==="forum_command_syntax") return help;
  if (code==="explicit_private_forum_selection_required" || code==="private_forum_selection_unavailable")
    return "Укажите точное название подключённого форума или ссылку. При одинаковых названиях нужна ссылка.";
  if (code==="forum_topic_busy") return "В теме есть незавершённая работа или отложенная отправка.";
  if (code==="forum_topic_unavailable") return "По ссылке не найдена доступная именованная тема.";
  if (code.includes("rights_required") || code.includes("requires_can_"))
    return "Telegram не подтверждает необходимые права владельца и бота.";
  if (code==="forum_topic_unconfirmed" || code.includes("_unconfirmed"))
    return "Результат операции неизвестен. Сначала проверьте состояние в Telegram.";
  if (code==="forum_topic_changed") return "Привязка изменилась. Начните операцию заново.";
  return "Операция недоступна.";
};
const validId=(x:unknown):x is number=>typeof x==="number" && Number.isSafeInteger(x) && x>0;
const topicRef=/^https:\/\/t\.me\/c\/([1-9]\d*)\/([1-9]\d*)\/?$/;

export function originalForumCommand(update:any) {
  const m=update.message;
  if (!validId(m?.from?.id) || !validId(m?.message_id) || m.from.is_bot || m.sender_chat ||
      m.forward_origin || m.forward_date || m.via_bot || m.is_automatic_forward || m.business_connection_id ||
      typeof m.text!=="string") return;
  const match=/^\/topic_(create|close|reopen|delete)(?:@(\w+))?(?=\s|$)/.exec(m.text);
  if (!match || !Array.isArray(m.entities) ||
      !m.entities.some((entity:any)=>entity.type==="bot_command" && entity.offset===0 && entity.length===match[0].length) ||
      m.entities.some((entity:any)=>["blockquote","expandable_blockquote","pre","code"].includes(entity.type) && entity.offset===0))
    return;
  return {action:match[1] as ForumAction,botUsername:match[2]?.toLowerCase(),args:m.text.slice(match[0].length).trim()};
}

export async function handleOwnerForumCommand(d:Dependencies,update:any) {
  const {owner,bot,store,transport}=d;
  const cq=update.callback_query;
  if (cq) {
    // Retire any preview made by an older build. It cannot authorize a new operation.
    if (typeof cq.data!=="string" || !/^ft:(confirm|cancel):[a-f0-9]{32}$/.test(cq.data)) return false;
    if (cq.from?.id===owner && !cq.from.is_bot && cq.message?.chat?.type==="private" &&
        cq.message.chat.id===owner && cq.message.from?.id===bot)
      await transport(owner)("answerCallbackQuery",{callback_query_id:cq.id,
        text:"Эта карточка устарела. Отправьте новую явную команду.",show_alert:true}).catch(()=>{});
    return true;
  }
  const m=update.message;
  const command=originalForumCommand(update);
  if (!command || command.botUsername || m.chat?.type!=="private" || m.chat.id!==owner || m.from.id!==owner)
    return false;
  if (!d.current()) return true;
  const privateTopic=m.message_thread_id??0;
  const reply=(text:string)=>transport(owner)("sendMessage",{chat_id:owner,message_thread_id:privateTopic||undefined,
    reply_parameters:{message_id:m.message_id},text});
  const id=`group:topic-command:${bot}:${owner}:message:${m.message_id}`;
  if (store.get(id)) return true;
  store.put(id,"running");
  let result:string;
  try {
    if (d.since!==undefined && (!Number.isSafeInteger(m.date) || m.date<d.since))
      throw Error("forum_command_expired");
    const binding=d.binding(privateTopic);
    if (!binding) throw Error("forum_private_binding_required");
    const forums=()=>eligibleOwnerForums(store,owner,bot,binding.projectId);
    const {action,args}=command;
    let title:string|undefined,text:string|undefined,chatId:number,topicId:number|undefined;
    if (action==="create") {
      const parts=args.split("|").map((part:string)=>part.trim());
      if (parts.length>3 || !parts[0]) throw Error("forum_command_syntax");
      ({title,text}=ownerTopicInput.parse({confirm:true,title:parts[0],...(parts[2] && {text:parts[2]})}));
      chatId=await chooseOwnerForum(forums(),parts[1]||undefined,transport);
    } else {
      const link=topicRef.exec(args);
      if (!link) throw Error("forum_command_syntax");
      chatId=Number("-100"+link[1]);topicId=Number(link[2]);
      if (!validId(topicId) || topicId<2) throw Error("forum_topic_unavailable");
    }
    const policy=forums().get(chatId);
    if (!policy) throw Error("forum_topic_unavailable");

    const shared=policy.ownerSharedProject,work=shared?undefined:true;
    const target=()=>topicId===undefined?undefined:store.get<GroupTopicPolicy>(`group:policy:${chatId}:${topicId}`);
    const initial=target();
    const known=()=>store.get(`group:managed-topic:${bot}:${chatId}:${topicId}`);
    const current=()=>{
      d.signal.throwIfAborted();
      const b=d.binding(privateTopic);
      const live=forums().get(chatId);
      const bound=target();
      const localScope=process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE;
      if (!d.current() || !b || b.threadId!==binding.threadId || b.projectId!==binding.projectId ||
          live?.threadId!==policy.threadId || live?.revision!==policy.revision ||
          live?.ownerSharedProject!==shared ||
          (localScope!==undefined && localScope!==`${chatId}:${topicId}`) ||
          (topicId!==undefined && (bound?.threadId!==initial?.threadId || bound?.revision!==initial?.revision ||
            (bound ? bound.ownerId!==owner || bound.botId!==bot : !known()))))
        throw Error("forum_topic_changed");
    };
    current();
    await checkOwnerForum(transport(chatId),chatId,owner,bot,{shared,work},action==="delete");
    current();
    if (action==="create") {
      const prove=async()=>{current();};
      const created=await d.create({confirm:true,title:title!,text},{...binding,signal:d.signal},
        {chatId,topicId:0,key:id,text:[title,text].filter(Boolean).join("\n"),
          shared,work,current:prove,prove});
      result="Тема создана. "+created.url+(created.requiresBinding?" Для ответов бота нужна привязка исполнителя.":"");
    } else {
      result=await applyForumTopicChange(store,bot,chatId,topicId!,action,transport(chatId));
    }
    store.put(id,"done");
  } catch (error) {
    store.put(id,"failed");
    result=describeError(error);
  }
  await reply(result).catch(()=>{});
  return true;
}


export async function applyForumTopicChange(store:Store,bot:number,chatId:number,topic:number,
  action:Exclude<ForumAction,"create">,tg:Telegram) {
  const key=topicStateKey(bot,chatId,topic);
  const old=store.get<TopicState>(key);
  if (old==="working" || old==="uncertain") throw Error("forum_topic_unconfirmed");
  if (old==="deleted" || (old==="closed" && action==="close") || (old==="open" && action==="reopen"))
    return "Операция уже выполнена.";
  if (action!=="reopen" && topicHasWork(store,bot,chatId,topic)) throw Error("forum_topic_busy");
  store.put(key,"working");
  try {
    if (await tg(methods[action],{chat_id:chatId,message_thread_id:topic})!==true)
      throw Error("forum_topic_unconfirmed");
  } catch (error) {
    if (error instanceof TelegramFailure && !error.ambiguous) {
      if (old) store.put(key,old);else store.del(key);
      throw error;
    }
    store.put(key,"uncertain");
    throw Error("forum_topic_unconfirmed");
  }
  store.atomic(()=>{
    if (action==="reopen") store.put(key,"open");
    else if (action==="close") store.put(key,"closed");
    else {
      store.put(key,"deleted");
      store.del(`group:policy:${chatId}:${topic}`);
      store.del(`group:context:${chatId}:${topic}`);
      store.del(forumNameKey(bot,chatId,topic));
      for (const scope of [historyPrefix(chatId,topic),contextMediaPrefix(bot,chatId,topic),
        `group:recent-files:${bot}:${chatId}:${topic}:`,`group:pdf:${bot}:${chatId}:${topic}:`]) {
        for (const {key:entry} of store.list(scope)) store.del(entry);
      }
    }
  });
  return action==="close"?"Тема закрыта.":action==="reopen"?"Тема открыта.":"Тема и её сообщения удалены в Telegram.";
}

const RIGHTS:Record<string,string>={
  create:"«Управление темами»", rename:"«Управление темами»", close:"«Управление темами»", reopen:"«Управление темами»",
  delete:"«Удаление сообщений» и «Управление темами»", pin:"«Закрепление сообщений»", deleteMessage:"«Удаление сообщений»"};

/** С77: Telegram refused for want of an admin right — the reason in words and how to ask the owner for it. */
export function missingRightRefusal(action:string,chatTitle:string) {
  const right=RIGHTS[action] ?? "нужного права администратора";
  return `bot_lacks_right: у бота нет права ${right} в группе «${chatTitle}», поэтому Telegram отклонил действие. `+
    `Попроси владельца сам: bb telegram-projects send --person owner --ask --text 'Включить боту право ${right} в группе «${chatTitle}»? `+
    `Путь: группа → Настройки (Управление группой) → Администраторы → бот → ${right}. Нужно, чтобы …' — ответ придёт сюда; людям в чате скажи, что ждёшь права.`;
}
