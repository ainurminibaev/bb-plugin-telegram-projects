import { TelegramFailure, type Store, type Telegram } from "./model";

type Membership = {
  chat: number;
  title: string;
  administrator: boolean;
  inviter?: number;
  event: number;
};
type Delivery = {
  signature: string;
  recipient: number;
  status: "sending" | "delivered" | "unavailable" | "unknown";
};
type Send = (chat: number) => Telegram;
const groups = (bot: number) => `visibility:${bot}:group:`;
const notice = (bot: number, chat: number) =>
  `visibility:${bot}:notice:${chat}`;
export const privacyKey = (bot: number) => `visibility:${bot}:privacy`;

export function rememberMembership(store: Store, bot: number, update: any) {
  const change = update.my_chat_member;
  if (
    !change ||
    !["group", "supergroup"].includes(change.chat?.type) ||
    change.new_chat_member?.user?.id !== bot ||
    !Number.isSafeInteger(update.update_id)
  )
    return;
  const chat = change.chat.id,
    key = groups(bot) + chat;
  const previous = store.get<Membership>(key);
  if (previous && previous.event >= update.update_id) return;
  const role = change.new_chat_member.status;
  if (
    !["member", "creator", "administrator"].includes(role) &&
    !(role === "restricted" && change.new_chat_member.is_member)
  ) {
    store.del(key);
    store.del(notice(bot, chat));
    return;
  }
  store.put(key, {
    chat,
    title: String(change.chat.title ?? chat),
    administrator: role === "administrator" || role === "creator",
    inviter: change.from?.id,
    event: update.update_id,
  } satisfies Membership);
}

export async function sendVisibilityUpdates(
  store: Store,
  bot: number,
  send: Send,
  managers: readonly number[] = [],
) {
  const privacy = store.get<boolean>(privacyKey(bot));
  if (privacy === undefined) return;
  for (const { value: g } of store.list<Membership>(groups(bot))) {
    const key = notice(bot, g.chat),
      signature = JSON.stringify([privacy, g.administrator]);
    if (store.get<Delivery>(key)?.signature === signature) continue;
    let admins;
    try {
      admins = await send(g.chat)<
        { status: string; user: { id: number; is_bot: boolean } }[]
      >("getChatAdministrators", {});
    } catch {
      continue;
    }
    if (!Array.isArray(admins)) continue;
    const people = admins.filter(
      (a) => !a.user.is_bot && ["administrator", "creator"].includes(a.status),
    );
    const recipient = (
      people.find((a) => a.user.id === g.inviter) ??
      people.find((a) => a.status === "creator")
    )?.user.id;
    if (!recipient) continue;
    const visible = g.administrator || !privacy;
    const rules = store.get<{
      rules: { topics: string[]; triggers: string[] };
    }>(`employee:${bot}:group:${g.chat}`)?.rules;
    const legacy = store
      .list<{ botId: number; topicId: number; requireMention: boolean }>(
        `group:policy:${g.chat}:`,
      )
      .filter((r) => r.value.botId === bot);
    const triggers = rules?.triggers.map((t) =>
      t === "mention" ? "упоминание" : t === "reply" ? "ответ боту" : t,
    );
    const handling = rules?.topics.length
      ? "Включённые темы: " +
        rules.topics.join(", ") +
        ". Обращение: " +
        (triggers?.join(", ") || "не настроено") +
        "."
      : legacy.length
        ? "Подключённые темы: " +
          legacy.map((r) => r.value.topicId).join(", ") +
          ". Действуют правила каждой привязки."
        : "Обработка поручений в этой группе пока не настроена.";
    const text = [
      g.title,
      privacy ? "Privacy Mode включён." : "Privacy Mode выключен.",
      g.administrator
        ? "Бот — администратор группы."
        : "Бот участвует в группе без прав администратора.",
      visible
        ? "Telegram доставляет все обычные сообщения участников. Для обращения используйте @упоминание или ответ на сообщение бота."
        : "Telegram ограничивает доставку. Используйте прямой ответ на сообщение бота. Адресованные боту команды также доставляются.",
      handling,
    ].join("\n");
    const mark = (status: Delivery["status"]) =>
      store.put(key, { signature, recipient, status } satisfies Delivery);
    mark("sending");
    try {
      await send(recipient)("sendMessage", {
        text,
        ...(managers.includes(recipient)
          ? {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Мои группы", callback_data: "emp:list" }],
                ],
              },
            }
          : {}),
      });
      mark("delivered");
    } catch (e) {
      if (
        e instanceof TelegramFailure &&
        ["telegram_403", "telegram_400"].includes(e.code)
      )
        mark("unavailable");
      else if (e instanceof TelegramFailure && !e.ambiguous) {
        store.del(key);
        throw e;
      } else mark("unknown");
    }
  }
}
export function noticeRecipient(store: Store, bot: number, chat: number) {
  return store.get<Delivery>(notice(bot, chat))?.recipient;
}
export function privacySummary(store: Store, bot: number) {
  const mode = store.get<boolean>(privacyKey(bot));
  return mode === undefined
    ? "Privacy Mode: ожидается ответ Telegram."
    : `Privacy Mode ${mode ? "включён" : "выключен"}. В группе, где бот администратор, Telegram доставляет все обычные сообщения участников.`;
}
