// С117: check the bot's real Telegram rights in a group at connection/setup time and during acceptance (С114),
// returning missing rights as one clear line with the exact Telegram path (С77).
import type { Telegram } from "./model";

export type BotRightKey = "administrator" | "can_delete_messages" | "can_pin_messages" | "can_manage_topics";

export type BotMemberInfo = {
  status?: string;
  can_delete_messages?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
};

export type BotGroupRightsCheck = {
  chatId: number;
  title: string;
  isForum: boolean;
  status: string;
  ok: boolean;
  required: BotRightKey[];
  present: BotRightKey[];
  missing: BotRightKey[];
  /** One clear Russian line with the exact Telegram path to grant missing rights (С77); empty when ok=true. */
  hint: string;
  error?: string;
};

const RIGHT_LABELS: Record<Exclude<BotRightKey, "administrator">, string> = {
  can_delete_messages: "Удаление сообщений",
  can_pin_messages: "Закрепление сообщений",
  can_manage_topics: "Управление темами",
};

export function formatMissingBotRights(title: string, botUsername: string, missing: BotRightKey[]): string {
  if (!missing.length) return "";
  const cleanTitle = title.replace(/\s+/g, " ").trim() || "группа";
  const handle = botUsername.trim() ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`) : "бота";
  const specific = missing
    .filter((r): r is Exclude<BotRightKey, "administrator"> => r !== "administrator")
    .map((r) => RIGHT_LABELS[r]);
  const list = specific.length ? specific.join(", ") : "права администратора";
  if (missing.includes("administrator")) {
    return (
      `В группе «${cleanTitle}» не хватает прав: ${list}. ` +
      `Откройте группу → название группы сверху → «Изменить» → «Администраторы» → «Добавить администратора» → выберите ${handle} и включите: ${list}.`
    );
  }
  return (
    `В группе «${cleanTitle}» не хватает прав: ${list}. ` +
    `Откройте группу → название группы сверху → «Изменить» → «Администраторы» → ${handle} → включите: ${list}.`
  );
}

export function evaluateBotGroupRights(args: {
  chatId: number;
  title: string;
  botUsername: string;
  isForum: boolean;
  member: BotMemberInfo;
}): BotGroupRightsCheck {
  const status = String(args.member.status ?? "unknown");
  const isCreator = status === "creator";
  const isAdmin = isCreator || status === "administrator";
  const required: BotRightKey[] = [
    "administrator",
    "can_delete_messages",
    "can_pin_messages",
    ...(args.isForum ? (["can_manage_topics"] as const) : []),
  ];
  const has = (r: BotRightKey): boolean => {
    if (r === "administrator") return isAdmin;
    if (isCreator) return true;
    if (!isAdmin) return false;
    return args.member[r] === true;
  };
  const present = required.filter(has);
  const missing = required.filter((r) => !has(r));
  const displayTitle = args.title.replace(/\s+/g, " ").trim();
  return {
    chatId: args.chatId,
    title: displayTitle || "группа",
    isForum: args.isForum,
    status,
    ok: missing.length === 0,
    required,
    present,
    missing,
    hint: formatMissingBotRights(displayTitle, args.botUsername, missing),
  };
}

export async function checkBotGroupRights(
  tg: Telegram,
  botId: number,
  botUsername: string,
  chatId: number,
  opts: { title?: string; isForum?: boolean } = {},
): Promise<BotGroupRightsCheck> {
  let title = opts.title ?? "";
  let isForum = opts.isForum === true;
  if (opts.isForum === undefined || !title) {
    try {
      const chat = await tg<{ title?: string; is_forum?: boolean }>("getChat", { chat_id: chatId });
      if (!title && typeof chat?.title === "string" && chat.title.trim()) title = chat.title.trim();
      if (opts.isForum === undefined && typeof chat?.is_forum === "boolean") isForum = chat.is_forum;
    } catch {
      /* fallback to caller-provided title/isForum */
    }
  }
  try {
    const member = await tg<BotMemberInfo>("getChatMember", { chat_id: chatId, user_id: botId });
    return evaluateBotGroupRights({
      chatId,
      title,
      botUsername,
      isForum,
      member: member ?? {},
    });
  } catch (error) {
    const cleanTitle = title.replace(/\s+/g, " ").trim() || "группа";
    return {
      chatId,
      title: cleanTitle,
      isForum,
      status: "unknown",
      ok: false,
      required: ["administrator", "can_delete_messages", "can_pin_messages", ...(isForum ? (["can_manage_topics"] as const) : [])],
      present: [],
      missing: ["administrator"],
      hint: `Не удалось проверить права бота в группе «${cleanTitle}»: проверьте, что бот добавлен в группу и сделан администратором.`,
      error: String((error as Error)?.message ?? error).slice(0, 120),
    };
  }
}

export function formatBotRightsReport(checks: BotGroupRightsCheck[]): string {
  if (!checks.length) return "Подключённых групп не найдено.";
  return checks
    .map((c) => (c.ok ? `✅ «${c.title}»: прошло` : `❌ «${c.title}»: не прошло — ${c.hint}`))
    .join("\n");
}
