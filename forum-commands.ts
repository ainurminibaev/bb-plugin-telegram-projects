import {randomUUID} from "node:crypto";
import {checkOwnerForum,chooseOwnerForum,eligibleOwnerForums,ownerTopicInput,
  type OwnerForumScope,type TopicSource} from "./owner-topic";
import {TelegramFailure,type Store,type Telegram} from "./model";
import {historyPrefix} from "./topic-search";
import {contextMediaPrefix,type GroupTopicPolicy} from "./ingress";
import {topicHasWork,topicStateKey,type TopicState} from "./topic-lifecycle";

type Action="create"|"close"|"reopen"|"delete";
type Binding={threadId:string;projectId:string};
type Command={action:Action;chatId:number;topicId?:number;title?:string;text?:string;
  privateTopic:number;binding:Binding;targetRevision?:string;shared?:true;work?:true;
  nonce:string;expires:number;noticeId?:number;state:"preview"|"running"|"done"|"failed"|"cancelled"};
type Dependencies={store:Store;owner:number;bot:number;signal:AbortSignal;
  transport:(chatId:number)=>Telegram;binding:(topic:number)=>Binding|undefined;
  current:()=>boolean;create:(args:{confirm:true;title:string;text?:string},scope:OwnerForumScope,
    source:TopicSource)=>Promise<{url:string;requiresBinding?:true}>};
const names={create:"Создать",close:"Закрыть",reopen:"Открыть снова",delete:"Удалить"};
const methods={close:"closeForumTopic",reopen:"reopenForumTopic",delete:"deleteForumTopic"};
const help="Команды: /topic_create Название | Форум | Первое сообщение\n"+
  "Форум и первое сообщение можно опустить. Для закрытия, открытия и удаления: "+
  "/topic_close, /topic_reopen или /topic_delete и ссылка на тему вида https://t.me/c/123456/42.";
const describeError=(error:unknown)=>{
  const code=error instanceof Error?error.message:"";
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

export async function handleOwnerForumCommand(d:Dependencies,update:any) {
  const {owner,bot,store,transport}=d;
  const cq=update.callback_query;
  const m=cq?.message ?? update.message;
  const command=typeof m?.text==="string" ? /^\/topic_(create|close|reopen|delete)(?=\s|$)/.exec(m.text) : null;
  const choice=typeof cq?.data==="string" ? /^ft:(confirm|cancel):([a-f0-9]{32})$/.exec(cq.data) : null;
  if (cq ? !choice : !command) return false;
  if (!d.current() || m?.chat?.type!=="private" || m.chat.id!==owner || (cq?.from??m.from)?.id!==owner ||
      !validId(m.message_id)) return true;
  if (!cq && (m.forward_origin || m.forward_date || m.via_bot || m.is_automatic_forward || m.sender_chat || m.business_connection_id)) return true;
  const privateTopic=m.message_thread_id??0;
  const ownerTg=transport(owner);
  const reply=(text:string,extra:object={})=>ownerTg("sendMessage",{chat_id:owner,
    message_thread_id:privateTopic||undefined,text,...extra});
  const prefix=`group:topic-command:${bot}:${owner}:`;
  const binding=d.binding(privateTopic);
  if (!binding) {
    if (!cq) await reply("Откройте исходную личку, связанную с BB.");
    return true;
  }
  const maybePolicy=(chat:number)=>eligibleOwnerForums(store,owner,bot,binding.projectId).get(chat);
  const managed=(chat:number,topic:number)=>store.get<GroupTopicPolicy>(`group:policy:${chat}:${topic}`);
  const known=(chat:number,topic:number)=>store.get<{title:string}>(`group:managed-topic:${bot}:${chat}:${topic}`);
  if (!cq) {
    const id=prefix+"message:"+m.message_id;
    if (store.get(id)) return true;
    try {
      const action=command![1] as Action;
      const args=m.text.slice(command![0].length).trim();
      if (!args) {await reply(help);return true;}
      let title:string|undefined,text:string|undefined,chatId:number,topicId:number|undefined;
      if (action==="create") {
        const parts=args.split("|").map((part:string)=>part.trim());
        if (parts.length>3) {await reply(help);return true;}
        const create=ownerTopicInput.parse({confirm:true,title:parts[0],...(parts[2] && {text:parts[2]})});
        ({title,text}=create);
        chatId=await chooseOwnerForum(eligibleOwnerForums(store,owner,bot,binding.projectId),parts[1]||undefined,transport);
      } else {
        const link=topicRef.exec(args);
        if (!link) {await reply(help);return true;}
        chatId=Number("-100"+link[1]);topicId=Number(link[2]);
        const existing=managed(chatId,topicId);
        if (!validId(topicId) || topicId<2 ||
            (existing ? existing.ownerId!==owner || existing.botId!==bot : !known(chatId,topicId)))
          throw Error("forum_topic_unavailable");
        title=known(chatId,topicId)?.title;
      }
      const policy=maybePolicy(chatId);
      if (!policy) throw Error("forum_topic_unavailable");
      const shared=policy.ownerSharedProject;
      const work=shared?undefined:true;
      const {title:forumTitle}=await checkOwnerForum(transport(chatId),chatId,owner,bot,{shared,work},action==="delete");
      if (!d.current() || d.binding(privateTopic)?.threadId!==binding.threadId || !maybePolicy(chatId)) return true;
      const saved:Command={action,chatId,topicId,title,text,privateTopic,binding,shared,work,
        targetRevision:topicId===undefined?undefined:managed(chatId,topicId)?.revision,
        nonce:randomUUID().replaceAll("-",""),expires:Date.now()+15*60_000,state:"preview"};
      store.atomic(()=>{store.put(id,saved);store.put(prefix+"nonce:"+saved.nonce,{id,expires:saved.expires});});
      const link=topicId ? "https://t.me/c/"+String(chatId).slice(4)+"/"+topicId : undefined;
      const warning=action==="delete" ? "\nБудут безвозвратно удалены тема и все её сообщения в Telegram. "+
        "Мост очистит свой поисковый архив этой темы. История отдельного BB-треда сохранится." :
        action==="close" ? "\nИстория темы сохранится." : "";
      const message=await reply(`${names[action]} тему ${title?"«"+title+"»":""}\nГруппа: ${forumTitle} (${chatId})`+
        (link?"\nТема: "+link:"")+
        (text?"\nПервое сообщение: "+text.slice(0,3200)+(text.length>3200?"… (полный текст в команде)":""):"")+warning,
        {reply_markup:{inline_keyboard:[[{text:action==="delete"?"Удалить навсегда":"Подтвердить",callback_data:"ft:confirm:"+saved.nonce},
          {text:"Отмена",callback_data:"ft:cancel:"+saved.nonce}]]}});
      if (validId(message?.message_id)) store.put(id,{...saved,noticeId:message.message_id});
    } catch (e) { await reply(describeError(e)); }
    return true;
  }
  const id=store.get<{id:string}>(prefix+"nonce:"+choice![2])?.id;
  const saved=id && store.get<Command>(id);
  if (!id || !saved || saved.state!=="preview" || saved.noticeId!==m.message_id ||
      saved.privateTopic!==privateTopic || saved.expires<Date.now()) return true;
  const current=()=>{
    const b=d.binding(privateTopic);
    const target=maybePolicy(saved.chatId);
    const bound=saved.topicId===undefined?undefined:managed(saved.chatId,saved.topicId);
    if (!d.current() || !b || b.threadId!==saved.binding.threadId || b.projectId!==saved.binding.projectId ||
        !target || target.ownerSharedProject!==saved.shared ||
        (saved.topicId!==undefined && (bound?.revision!==saved.targetRevision ||
          (bound ? bound.ownerId!==owner || bound.botId!==bot : !known(saved.chatId,saved.topicId)))))
      throw Error("forum_topic_changed");
    d.signal.throwIfAborted();
  };
  store.put(id,{...saved,state:choice![1]==="cancel"?"cancelled":"running"});
  await ownerTg("answerCallbackQuery",{callback_query_id:cq.id}).catch(()=>{});
  if (choice![1]==="cancel") return true;
  try {
    current();
    await checkOwnerForum(transport(saved.chatId),saved.chatId,owner,bot,saved,saved.action==="delete");
    current();
    if (saved.action==="create") {
      const prove=async()=>{current();};
      const result=await d.create({confirm:true,title:saved.title!,text:saved.text},{...binding,signal:d.signal},
        {chatId:saved.chatId,topicId:0,key:"command:"+saved.nonce,text:[saved.title,saved.text].filter(Boolean).join("\n"),
          shared:saved.shared,work:saved.work,current:prove,prove});
      store.put(id,{...saved,text:undefined,state:"done"});
      await reply("Тема создана. "+result.url+(result.requiresBinding?" Для ответов бота нужна привязка исполнителя.":""));
      return true;
    }
    const topic=saved.topicId!;
    const key=topicStateKey(bot,saved.chatId,topic);
    const old=store.get<TopicState>(key);
    if (old==="working" || old==="uncertain") throw Error("forum_topic_unconfirmed");
    if (old==="deleted" || (old==="closed" && saved.action==="close") || (old==="open" && saved.action==="reopen")) {
      store.put(id,{...saved,text:undefined,state:"done"});
      await reply("Операция уже выполнена.");return true;
    }
    if (saved.action!=="reopen" && topicHasWork(store,bot,saved.chatId,topic)) throw Error("forum_topic_busy");
    store.put(key,"working");
    try {
      if (await transport(saved.chatId)(methods[saved.action],{chat_id:saved.chatId,message_thread_id:topic})!==true)
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
      if (saved.action==="reopen") store.put(key,"open");
      else if (saved.action==="close") store.put(key,"closed");
      else {
        store.put(key,"deleted");
        store.del(`group:policy:${saved.chatId}:${topic}`);
        store.del(`group:context:${saved.chatId}:${topic}`);
        for (const scope of [historyPrefix(saved.chatId,topic),contextMediaPrefix(bot,saved.chatId,topic),
          `group:recent-files:${bot}:${saved.chatId}:${topic}:`,`group:pdf:${bot}:${saved.chatId}:${topic}:`]) {
          for (const {key:entry} of store.list(scope)) store.del(entry);
        }
      }
      store.put(id,{...saved,text:undefined,state:"done"});
    });
    await reply(saved.action==="close"?"Тема закрыта.":saved.action==="reopen"?"Тема открыта.":"Тема и её сообщения удалены в Telegram.");
  } catch (e) {
    if (store.get<Command>(id)?.state==="running") store.put(id,{...saved,text:undefined,state:"failed"});
    await reply(describeError(e));
  }
  return true;
}
