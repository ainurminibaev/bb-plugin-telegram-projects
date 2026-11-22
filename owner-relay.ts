import {z} from "zod";
import type {Store} from "./model";
import type {Archive} from "./archive";
import type {Conversation} from "./archive-access";

// The owner's own words reach a worker thread unchanged. The assistant names an owner message the
// bridge itself received in the owner's private chat; the bridge copies its text into the target
// thread as a user message, with who wrote it, when and where, and through which thread it came.
// The assistant adds one marked line with the action and object it understood; the worker checks
// that line against the owner's words. The assistant never writes or edits the owner's text.

export const relayInput=z.object({
  threadId:z.string().regex(/^thr_[a-z0-9]{6,40}$/).describe("The worker thread that should receive the owner's message."),
  messageId:z.number().int().positive().describe("The Telegram message ID of the owner's message in your private chat with the owner."),
  action:z.string().min(3).max(200).describe("One action the owner asked for, in your words, for example «опубликовать выпуск 0.9.52»."),
  object:z.string().min(2).max(200).describe("What the action applies to, for example the repository or release."),
}).strict();
export type RelayInput=z.infer<typeof relayInput>;

const RELAY_HOURS=24;
export const relayKey=(bot:number,messageId:number,threadId:string)=>`relay:${bot}:${messageId}:${threadId}`;

/** The text the worker receives, or the reason the relay is refused. */
export function ownerRelay(store:Store,archive:Pick<Archive,"message">,bot:number,owner:number,
  caller:Conversation|undefined,args:RelayInput,via:string,now=Date.now()):{text:string}|{error:string} {
  if (caller?.kind!=="owner") return {error:"relay_only_from_owner_private_chat"};
  if (args.threadId===via) return {error:"relay_to_another_thread"};
  const m=archive.message(bot,owner,args.messageId);
  if (!m || m.chat!==owner || m.chat_type!=="private") return {error:"owner_message_not_found"};
  if (m.sender!==owner) return {error:"not_the_owners_message"};
  if (!m.text.trim()) return {error:"owner_message_has_no_text"};
  if (now/1000-m.date>RELAY_HOURS*3600) return {error:"owner_message_too_old"};
  if (store.get(relayKey(bot,args.messageId,args.threadId))) return {error:"already_relayed_to_this_thread"};
  const when=new Date(m.date*1000).toISOString().replace("T"," ").slice(0,16)+" UTC";
  return {text:[
    `Сообщение владельца (${m.sender_name||"владелец"}, Telegram ID ${owner}) из его личного чата с ботом, ${when}, сообщение № ${m.message}.`,
    `Передано мостом дословно через тред ${via}; помощник текст не писал и не менял:`,
    "«"+m.text+"»",
    "",
    `[Слова помощника, не владельца] Понял как одно действие: ${args.action}; объект: ${args.object}. Сверь со словами владельца выше: разрешено только то, что в них сказано.`,
  ].join("\n")};
}
