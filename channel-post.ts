import {stripTelegramMarkers} from "./reply-routing";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {Store, Telegram} from "./model";

const fields={threadId:z.string().min(1),routeToken:z.string().uuid(),channelId:z.number().int().negative(),operationId:z.string().min(1).max(120)};
const messageId=z.number().int().positive(), text=z.string().trim().min(1).max(4096);
export const channelPostSchema=z.discriminatedUnion("action",[
  z.object({...fields,action:z.literal("publish"),text}).strict(),
  z.object({...fields,action:z.literal("edit"),messageId,text,manual:z.literal(true).optional()}).strict(),
  z.object({...fields,action:z.literal("delete"),messageId}).strict(),
]);

export async function inspectChannelRights(tg:Telegram,channelId:number,owner:number,bot:number) {
  const chat=await tg("getChat",{chat_id:channelId});
  if (chat.id!==channelId || chat.type!=="channel") throw Error("channel_required");
  const member=await tg("getChatMember",{chat_id:channelId,user_id:owner});
  if (!["administrator","creator"].includes(member.status)) throw Error("channel_owner_admin_required");
  const self=await tg("getChatMember",{chat_id:channelId,user_id:bot});
  const admin=self.status==="administrator";
  return {publish:admin && self.can_post_messages===true,
    editOthers:admin && self.can_edit_messages===true,deleteOthers:admin && self.can_delete_messages===true};
}

export async function channelPost(store:Store,tg:Telegram,owner:number,bot:number,allowed:string,
  args:z.infer<typeof channelPostSchema>) {
  const {channelId,operationId,action}=args;
  const scope=[bot,owner,channelId].join(":");
  if (!allowed.split(/[,\s]+/).includes(scope)) throw Error("channel_not_configured");
  const key="channel:operation:"+JSON.stringify([scope,operationId]);
  const digest=createHash("sha256").update(JSON.stringify([action,"messageId" in args?args.messageId:null,
    "text" in args?args.text:null])).digest("hex");
  const saved=store.get<{digest:string;messageId?:number}>(key);
  if (saved) {
    if (saved.digest!==digest) throw Error("channel_operation_conflict");
    if (!saved.messageId) throw Error("channel_operation_unconfirmed");
    return {messageId:saved.messageId};
  }
  const owned="channel:own:"+scope+":";
  const manual=action==="edit" && args.manual===true && !store.get(owned+args.messageId);
  if (action!=="publish" && !manual && !store.get(owned+args.messageId)) throw Error("channel_post_not_owned");
  const outgoing = "text" in args ? stripTelegramMarkers(args.text).trim() : undefined;
  if (outgoing === "") throw Error("channel_text_empty");
  const rights=await inspectChannelRights(tg,channelId,owner,bot);
  if (!(manual ? rights.editOthers : action==="delete" ? rights.publish || rights.deleteOthers : rights.publish || (action==="edit" && rights.editOthers)))
    throw Error(manual ? "channel_requires_can_edit_messages" : "channel_requires_can_post_messages");
  // Reserve synchronously before any network call. A lost acknowledgement must never duplicate a post.
  store.put(key,{digest});
  let id:number;
  if (action==="delete") {
    if (await tg("deleteMessage",{chat_id:channelId,message_id:args.messageId})!==true) throw Error("channel_delete_unconfirmed");
    id=args.messageId;
  } else {
    const result=await tg<{message_id:number;chat:{id:number;type:string}}>(
      action==="publish"?"sendMessage":"editMessageText",{chat_id:channelId,text:outgoing,
        ...(action==="edit"?{message_id:args.messageId}:{})});
    if (result?.chat?.id!==channelId || result.chat.type!=="channel" || !Number.isSafeInteger(result.message_id) ||
        result.message_id<=0 || (action==="edit" && result.message_id!==args.messageId)) throw Error("channel_post_unconfirmed");
    id=result.message_id;
  }
  store.atomic(()=>{
    if(action==="delete") store.del(owned+id);else if (!manual) store.put(owned+id,true);
    store.put(key,{digest,messageId:id});
  });
  return {messageId:id};
}
