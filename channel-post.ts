import {createHash} from "node:crypto";
import {z} from "zod";
import type {Store, Telegram} from "./model";

const fields={threadId:z.string().min(1),routeToken:z.string().uuid(),channelId:z.number().int().negative(),operationId:z.string().min(1).max(120)};
const messageId=z.number().int().positive(), text=z.string().trim().min(1).max(4096);
export const channelPostSchema=z.discriminatedUnion("action",[
  z.object({...fields,action:z.literal("publish"),text}).strict(),
  z.object({...fields,action:z.literal("edit"),messageId,text}).strict(),
  z.object({...fields,action:z.literal("delete"),messageId}).strict(),
]);

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
  if (action!=="publish" && !store.get(owned+args.messageId)) throw Error("channel_post_not_owned");
  // Reserve synchronously before any network call. A lost acknowledgement must never duplicate a post.
  store.put(key,{digest});
  let id:number;
  if (action==="delete") {
    if (await tg("deleteMessage",{chat_id:channelId,message_id:args.messageId})!==true) throw Error("channel_delete_unconfirmed");
    id=args.messageId;
  } else {
    const result=await tg<{message_id:number;chat:{id:number;type:string}}>(
      action==="publish"?"sendMessage":"editMessageText",{chat_id:channelId,text:args.text,
        ...(action==="edit"?{message_id:args.messageId}:{})});
    if (result?.chat?.id!==channelId || result.chat.type!=="channel" || !Number.isSafeInteger(result.message_id) ||
        result.message_id<=0 || (action==="edit" && result.message_id!==args.messageId)) throw Error("channel_post_unconfirmed");
    id=result.message_id;
  }
  store.atomic(()=>{
    if(action==="delete") store.del(owned+id);else store.put(owned+id,true);
    store.put(key,{digest,messageId:id});
  });
  return {messageId:id};
}
