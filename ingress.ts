import type { Store } from "./model";
import type { ChatInput } from "./chat";

export type GroupTopicPolicy = {
  chatId: number;
  topicId: number;
  threadId: string;
  ownerOnly: boolean;
  requireMention: boolean;
  botId: number;
  botUsername: string;
  ownerId?: number;
  revision?: string;
  acceptAfterSecond?: number;
};

export type Ingress =
  | {kind: "group"; chatId: number; topicId: number; senderId: number; threadId: string; messageId: number; updateId: number; text: string}
  | { kind: "chat"; input: ChatInput; callbackId?: string }
  | { kind: "tasks"; topicId: number }
  | { kind: "pair"; userId: number }
  | { kind: "ignore"; callbackId?: string };

// The plugin is the bot's only getUpdates receiver. The owner gate precedes everything:
// groups and other users are ignored. Before pairing, only "/start <code>" in a
// private chat is accepted, and only with the code shown on the plugin page.
export function routeUpdate(
  u: any,
  owner: number | undefined,
  pairCode?: string,
  group?: GroupTopicPolicy,
): Ingress {
  const cq = u?.callback_query;
  const m = cq ? cq.message : u?.message;
  const from = cq ? cq.from : u?.message?.from;
  const callbackId = cq ? String(cq.id) : undefined;
  if (group && !cq && (m?.chat?.type === "supergroup" || m?.chat?.type === "group")) {
    const topicId = m.message_thread_id ?? 0;
    if (!owner || m.chat.id !== group.chatId || topicId !== group.topicId ||
        !group.threadId || !Number.isSafeInteger(from?.id) || from.id <= 0 ||
        from.is_bot || m.sender_chat || (group.ownerOnly && from.id !== owner))
      return {kind: "ignore"};
    const text = m.text ?? m.caption;
    if (typeof text !== "string" || !text.trim()) return {kind: "ignore"};
    const entities = m.entities ?? m.caption_entities ?? [];
    const username = "@" + group.botUsername.toLowerCase();
    const addressed = m.reply_to_message?.from?.id === group.botId || entities.some((e: any) => {
      const value = text.slice(e.offset, e.offset + e.length).toLowerCase();
      return (e.type === "mention" && value === username) ||
        (e.type === "text_mention" && e.user?.id === group.botId) ||
        (e.type === "bot_command" && value.split("@")[1] === username.slice(1));
    });
    if (group.requireMention && !addressed) return {kind: "ignore"};
    return {kind: "group", chatId: group.chatId, topicId, senderId: from.id,
      threadId: group.threadId, messageId: m.message_id, updateId: u.update_id, text};
  }
  if (!m || m.chat?.type !== "private" || from?.id !== m.chat?.id)
    return { kind: "ignore", callbackId };
  if (owner === undefined) {
    const code = /^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(m.text ?? "")?.[1];
    return !cq && pairCode && code === pairCode
      ? { kind: "pair", userId: from.id }
      : { kind: "ignore", callbackId };
  }
  if (from.id !== owner) return { kind: "ignore", callbackId };
  const callback: string | undefined = cq?.data;
  if (callback && !callback.startsWith("bb:"))
    return { kind: "ignore", callbackId };
  const text: string | undefined =
    typeof m.text === "string"
      ? m.text
      : typeof m.caption === "string"
        ? m.caption
      : m.forum_topic_created
        ? "/project"
        : undefined;
  const topicId = m.message_thread_id ?? 0;
  if (!callback && text?.match(/^\/tasks(?:@\w+)?(?:\s|$)/))
    return { kind: "tasks", topicId };
  if (!callback && !text && !m.voice && !m.audio && !m.document && !m.photo && !m.video)
    return { kind: "ignore" };
  const v = m.voice && (m.voice.file_size ?? 0) <= 15_000_000 &&
    (m.voice.duration ?? 0) <= 600 ? m.voice : undefined;
  const photo = Array.isArray(m.photo) ? m.photo.at(-1) : undefined;
  const attached = m.document ?? m.video ?? m.audio ?? (v ? undefined : m.voice) ?? photo;
  const kind = m.document ? "document" : m.video ? "video" : m.audio ? "audio" :
    m.voice ? "voice" : "photo";
  return {
    kind: "chat",
    callbackId,
    input: {
      updateId: u.update_id,
      ownerId: owner,
      chatId: owner,
      topicId,
      messageId: m.message_id,
      text: callback ? undefined : text?.slice(0, 16000),
      callback,
      attachment: !callback && attached ? {
        fileId: attached.file_id,
        name: attached.file_name ?? `${kind}-${m.message_id}.${kind === "photo" ? "jpg" : kind === "voice" ? "ogg" : kind === "video" ? "mp4" : "bin"}`,
        mime: attached.mime_type ?? (kind === "photo" ? "image/jpeg" : "application/octet-stream"),
        size: attached.file_size ?? 0,
        kind,
      } : undefined,
      replyTo: m.reply_to_message?.message_id,
      voice: v
        ? {
            fileId: v.file_id,
            mime: v.mime_type ?? "audio/ogg",
            size: v.file_size ?? 0,
            duration: v.duration ?? 0,
          }
        : undefined,
    },
  };
}

/** A receipt pins the original destination even if the topic is rebound before processing. */
export function acceptGroupUpdate(store: Store, update: any, owner: number | undefined, botId: number | undefined): boolean {
  const message = update?.message;
  if (!owner || !botId || !Number.isSafeInteger(update?.update_id) || update.update_id < 0 ||
      !Number.isSafeInteger(message?.message_id) || message.message_id <= 0 ||
      !["group", "supergroup"].includes(message?.chat?.type)) return false;
  const chatId = message.chat.id;
  const topicId = message.message_thread_id ?? 0;
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId < 0) return false;
  let accepted = false;
  store.atomic(() => {
    const policy = store.get<GroupTopicPolicy>(`group:policy:${chatId}:${topicId}`);
    if (!policy || (policy.ownerId !== undefined && owner !== policy.ownerId) || policy.botId !== botId || typeof policy.ownerOnly !== "boolean" ||
        typeof policy.requireMention !== "boolean" || !policy.botUsername) return;
    // Telegram dates have second precision. The binding second is ambiguous.
    if (policy.acceptAfterSecond !== undefined && (!Number.isSafeInteger(message.date) ||
        message.date <= policy.acceptAfterSecond)) return;
    const route = routeUpdate(update, owner, undefined, policy);
    if (route.kind !== "group") return;
    const key = `group:in:${botId}:${route.updateId}`;
    if (!store.get(key) && !store.get(`group:receipt:${botId}:${route.updateId}`)) store.put(key, { route, ownerId: owner, revision: policy.revision, state: "pending" });
    const nextOffset = Math.max(store.get<number>("ingress:offset") ?? 0, route.updateId + 1);
    store.put("ingress:offset", nextOffset);
    accepted = true;
  });
  return accepted;
}
