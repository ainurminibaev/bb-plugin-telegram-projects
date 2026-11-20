import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GroupTopicPolicy } from "./ingress";
import { privacyKey } from "./group-visibility";
import type { Store, Telegram } from "./model";
import {
  accessList, defaultGroupSettings, groupSettings, hasAccess, openGroupLock, saveGroupSettings, setAccess,
  type GroupSettings, type MembersMode,
} from "./rights";

/**
 * Setup screens in the administrator's private chat: who may give the bot tasks, the groups
 * it is in, and one screen per group. No IDs, versions or internal names. Every tap saves.
 */
type Membership = { chat: number; title: string; administrator: boolean; inviter?: number; event: number };
type Button = { text: string; callback_data?: string; url?: string };
export type SetupContext = {
  store: Store;
  sdk?: Pick<BbPluginApi["sdk"], "threads">;
  bot: number;
  botUsername: string;
  owner: number;
  tg: (chat: number) => Telegram;
  /** Topic names the employee repository lets a group hear about. */
  zones: string[];
  /** One line of the employee's role; empty for a personal assistant. */
  role: string;
};

const memberships = (store: Store, bot: number) =>
  store.list<Membership>(`visibility:${bot}:group:`).map((r) => r.value).sort((a, b) => a.title.localeCompare(b.title));
const membership = (store: Store, bot: number, chat: number) => store.get<Membership>(`visibility:${bot}:group:${chat}`);
const addToGroupUrl = (username: string) => `https://t.me/${username}?startgroup=setup`;

const WHO_LINE = { access: "только те, кто может мне поручать", all: "все участники" } as const;
const WHO_BUTTON = { access: "Обращаются: только кто может поручать", all: "Обращаются: все участники" } as const;
const REPLY_LINE = { mention: "когда меня отметили или ответили мне", auto: "сам, когда это уместно" } as const;
const REPLY_BUTTON = { mention: "Отвечаю: когда отметили", auto: "Отвечаю: сам, когда уместно" } as const;
const MEMBERS_LINE: Record<MembersMode, string> = { silent: "не отвечаю", read: "отвечаю и смотрю данные", propose: "отвечаю, смотрю данные и предлагаю действия" };
const MEMBERS_BUTTON: Record<MembersMode, string> = { silent: "Остальным: не отвечаю", read: "Остальным: отвечаю и смотрю данные", propose: "Остальным: ещё предлагаю действия" };
const MEMBERS_HINT: Record<MembersMode, string> = {
  silent: "Тем, кто не может мне поручать, я здесь не отвечаю.",
  read: "Отвечаю на вопросы и сам смотрю задачи и документы. Ничего не меняю без согласия того, кто может мне поручать.",
  propose: "Отвечаю, смотрю задачи и документы и предлагаю, что сделать. Делаю только с согласия того, кто может мне поручать.",
};
const NEXT_MEMBERS: Record<MembersMode, MembersMode> = { silent: "read", read: "propose", propose: "silent" };
export const ASSISTANT_LOCK =
  "Я личный помощник и работаю с личными файлами владельца. Пока для групп нет отдельного исполнителя под другим пользователем, обращаться ко мне здесь могут только те, кто может мне поручать.";
const lockText = (lock?: "codex" | "assistant") => lock === "codex" ? CODEX_LOCK : lock === "assistant" ? ASSISTANT_LOCK : undefined;
export const CODEX_LOCK =
  "Я работаю на Codex. Пока не проверено, что посторонний у меня ничего не изменит, обращаться ко мне здесь могут только те, кто может мне поручать.";

export function shortState(s: GroupSettings, locked = false) {
  return !locked && s.who === "all" && s.members !== "silent" ? "отвечаю всем" : "отвечаю только своим";
}

export function welcomeScreen(ctx: Pick<SetupContext, "role" | "botUsername"> & { privacy?: boolean }) {
  return {
    text: ["Готово, я подключён." + (ctx.role ? " " + ctx.role : ""),
      "Сейчас поручения мне можете давать только вы.",
      "Дальше: добавьте меня в рабочую группу — я сразу пришлю, как её настроить.",
      "",
      ctx.privacy === false
        ? "Режим приватности у меня выключен: в группах я вижу всю переписку, а что из неё обрабатывать, решают настройки группы."
        : "Режим приватности у меня включён: в группах я вижу только ответы на мои сообщения и команды. Выключите его в @BotFather → /setprivacy → Disable, затем добавьте меня в группы заново — тогда меня можно отмечать и я вижу переписку, а что обрабатывать, решают настройки группы.",
    ].join("\n"),
    reply_markup: { inline_keyboard: [
      [{ text: "➕ Добавить в группу", url: addToGroupUrl(ctx.botUsername) }],
      [{ text: "👥 Кто может мне поручать", callback_data: "rs:a" }],
      [{ text: "Мои группы", callback_data: "rs:l" }],
    ] },
  };
}

export function accessScreen(store: Store, bot: number) {
  const people = accessList(store, bot);
  return {
    text: ["Поручать мне могут:", "• вы", ...people.map((p) => "• " + p.name),
      "Они могут давать мне поручения в группах и решают, разрешить ли действие по просьбе остальных участников. Остальным я в личке не отвечаю."].join("\n"),
    reply_markup: { inline_keyboard: [
      [{ text: "➕ Добавить человека", callback_data: "rs:aa" }],
      ...people.map((p) => [{ text: "✖ " + p.name, callback_data: "rs:ar:" + p.id }]),
      [{ text: "Готово", callback_data: "rs:ad" }],
    ] as Button[][] },
  };
}

export function groupsScreen(store: Store, bot: number, botUsername: string, visible: (m: Membership) => boolean = () => true) {
  const groups = memberships(store, bot).filter(visible);
  if (!groups.length)
    return { text: "Меня пока нет ни в одной группе.",
      reply_markup: { inline_keyboard: [[{ text: "➕ Добавить в группу", url: addToGroupUrl(botUsername) }]] } };
  return {
    text: "Группы, где я есть:",
    reply_markup: { inline_keyboard: groups.map((g) => [{
      text: `${g.title} — ${shortState(groupSettings(store, bot, g.chat) ?? defaultGroupSettings(), openGroupLock(store) === "assistant")}`,
      callback_data: "rs:g:" + g.chat,
    }]) },
  };
}

export function groupScreen(title: string, chat: number, s: GroupSettings, lock?: "codex" | "assistant") {
  const who = lock ? "access" : s.who;
  const lines = [
    `Группа «${title}»`,
    "Ко мне обращаются: " + WHO_LINE[who],
    "Отвечаю: " + REPLY_LINE[s.reply],
    "Остальным участникам: " + (who === "access" ? "не отвечаю, пока ко мне обращаются только те, кто может поручать" : MEMBERS_LINE[s.members]),
    ...(who === "all" ? [MEMBERS_HINT[s.members]] : []),
    "Можно рассказывать: " + (s.zones.length ? s.zones.join(", ") : "всё, что относится к работе группы"),
    "Заметка: " + (s.note || "—"),
    "Кто может мне поручать, всегда может попросить сделать что-то и ответить сюда.",
    ...(lock ? ["", lockText(lock)!] : []),
  ];
  const rows: Button[][] = [
    [{ text: lock ? WHO_BUTTON.access + " 🔒" : WHO_BUTTON[s.who], callback_data: `rs:w:${chat}` }],
    [{ text: REPLY_BUTTON[s.reply], callback_data: `rs:r:${chat}` }],
    ...(who === "all" ? [[{ text: MEMBERS_BUTTON[s.members], callback_data: `rs:m:${chat}` }]] : []),
    [{ text: "Что можно рассказывать ›", callback_data: `rs:z:${chat}` }],
    [{ text: "✏️ Заметка", callback_data: `rs:n:${chat}` }],
    [{ text: "Готово", callback_data: `rs:d:${chat}` }],
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function zonesScreen(title: string, chat: number, s: GroupSettings, zones: string[]) {
  if (!zones.length)
    return { text: `Для «${title}» темы не заданы: в настройках сотрудника нет списка тем. Я рассказываю всё, что относится к работе группы.`,
      reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: `rs:g:${chat}` }]] } };
  return {
    text: `Что можно рассказывать в «${title}»?\nОтметьте темы. Остальное здесь не обсуждаю.`,
    reply_markup: { inline_keyboard: [
      ...zones.map((z, i) => [{ text: (s.zones.includes(z) ? "✅ " : "▫️ ") + z, callback_data: `rs:zt:${chat}:${i}` }]),
      [{ text: "← Назад", callback_data: `rs:g:${chat}` }],
    ] },
  };
}

export function noteScreen(chat: number) {
  return {
    text: "Напишите заметку одним сообщением, например «здесь кладовщики, отвечай проще». Это пояснение для меня, а не разрешение: кто и что может, заметка не меняет.",
    reply_markup: { inline_keyboard: [[{ text: "Удалить заметку", callback_data: `rs:nd:${chat}` }, { text: "Отмена", callback_data: `rs:g:${chat}` }]] },
  };
}

/** Screen 3: to whoever added the bot if they can give it tasks, otherwise to the owner. */
export async function notifyGroupsAdded(ctx: SetupContext) {
  const privacy = ctx.store.get<boolean>(privacyKey(ctx.bot));
  for (const g of memberships(ctx.store, ctx.bot)) {
    const key = `rights:${ctx.bot}:added:${g.chat}`;
    const visible = g.administrator || privacy === false;
    const signature = JSON.stringify([g.event, visible]);
    if (ctx.store.get(key) === signature) continue;
    const recipient = g.inviter && hasAccess(ctx.store, ctx.bot, ctx.owner, g.inviter) ? g.inviter : ctx.owner;
    const s = groupSettings(ctx.store, ctx.bot, g.chat) ?? defaultGroupSettings();
    const lines = [s.version === 0
      ? `Меня добавили в «${g.title}». Пока я отвечаю здесь только тем, кто может мне поручать, и только когда обращаются ко мне.`
      : `Я в «${g.title}». Сейчас ${shortState(s, openGroupLock(ctx.store) === "assistant")}.`];
    if (privacy === false && !g.administrator)
      lines.push(`Режим приватности у меня выключен: я вижу всю переписку «${g.title}». Обрабатываю только то, что разрешают настройки группы.`);
    if (!visible)
      lines.push(`Пока я обычный участник, Telegram показывает мне в «${g.title}» только ответы на мои сообщения и команды для меня. Обычные сообщения и отметки через @ до меня не доходят: чтобы обратиться, ответьте на любое моё сообщение. Если сделать меня администратором группы (права можно не давать), я увижу обсуждение и меня можно будет просто отметить.`);
    try {
      await ctx.tg(recipient)("sendMessage", { chat_id: recipient, text: lines.join("\n"), reply_markup: { inline_keyboard: [[
        { text: `Настроить «${g.title}»`, callback_data: "rs:g:" + g.chat },
        { text: "Оставить так", callback_data: "rs:k" },
      ]] } });
      ctx.store.put(key, signature);
    } catch { /* retried on the next pass */ }
  }
}

async function providerOf(ctx: SetupContext, chat: number) {
  const binding = ctx.store.list<GroupTopicPolicy>(`group:policy:${chat}:`).map((r) => r.value).find((p) => p.botId === ctx.bot);
  if (!binding?.threadId || !ctx.sdk) return undefined;
  try {
    return ((await ctx.sdk.threads.get({ threadId: binding.memberThreadId ?? binding.threadId })) as { providerId?: string }).providerId;
  } catch { return undefined; }
}

async function canManageGroup(ctx: SetupContext, user: number, chat: number) {
  if (user === ctx.owner) return true;
  if (!hasAccess(ctx.store, ctx.bot, ctx.owner, user)) return false;
  try {
    const m = await ctx.tg(chat)<{ status: string }>("getChatMember", { chat_id: chat, user_id: user });
    return ["creator", "administrator"].includes(m.status);
  } catch { return false; }
}

const MENU = new Set(["/groups", "Мои группы", "/access", "Кто может мне поручать"]);

/** Returns true when the update belonged to the setup screens. */
export async function handleSetupUpdate(ctx: SetupContext, u: any): Promise<boolean> {
  const cb = u?.callback_query;
  const m = cb ? cb.message : u?.message;
  const user: number | undefined = cb ? cb.from?.id : m?.from?.id;
  if (!user || m?.chat?.type !== "private" || m.chat.id !== user) return false;
  const allowed = hasAccess(ctx.store, ctx.bot, ctx.owner, user);
  const tg = ctx.tg(user);
  const send = (screen: object) => tg("sendMessage", { chat_id: user, ...screen });
  const show = (screen: object) => cb
    ? tg("editMessageText", { chat_id: user, message_id: m.message_id, ...screen }).catch(() => send(screen))
    : send(screen);
  const answer = (text?: string, alert = false) => cb
    ? tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text && { text, show_alert: alert }) }).catch(() => {})
    : Promise.resolve();
  const awaitKey = `rights:${ctx.bot}:await:${user}`;

  if (!cb) {
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const waiting = ctx.store.get<{ kind: "note"; chat: number } | { kind: "people" }>(awaitKey);
    if (m.users_shared && user === ctx.owner) {
      const people = [...accessList(ctx.store, ctx.bot), ...(m.users_shared.users ?? []).map((p: any) => ({
        id: p.user_id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.username ? "@" + p.username : String(p.user_id)),
      }))].filter((p) => p.id !== ctx.owner);
      setAccess(ctx.store, ctx.bot, people);
      ctx.store.del(awaitKey);
      await send({ text: "Добавил.", reply_markup: { remove_keyboard: true } });
      await send(accessScreen(ctx.store, ctx.bot));
      return true;
    }
    if (waiting?.kind === "people" && text === "Отмена") {
      ctx.store.del(awaitKey);
      await send({ text: "Хорошо, никого не добавляю.", reply_markup: { remove_keyboard: true } });
      return true;
    }
    if (waiting?.kind === "note" && text && !text.startsWith("/") && !MENU.has(text)) {
      if (!(await canManageGroup(ctx, user, waiting.chat))) return false;
      const s = saveGroupSettings(ctx.store, ctx.bot, waiting.chat, { note: text });
      ctx.store.del(awaitKey);
      await send(groupScreen(membership(ctx.store, ctx.bot, waiting.chat)?.title ?? "группа", waiting.chat, s,
        openGroupLock(ctx.store, await providerOf(ctx, waiting.chat))));
      return true;
    }
    if (!allowed || !MENU.has(text)) return false;
    if (text === "/access" || text === "Кто может мне поручать") {
      if (user !== ctx.owner) await send({ text: "Список тех, кто может мне поручать, ведёт владелец." });
      else await send(accessScreen(ctx.store, ctx.bot));
      return true;
    }
    await send(groupsScreen(ctx.store, ctx.bot, ctx.botUsername));
    return true;
  }

  const data: string = cb.data ?? "";
  if (!data.startsWith("rs:")) return false;
  if (!allowed) {
    await answer("Эти настройки доступны тем, кто может мне поручать.");
    return true;
  }
  const [, action, arg, extra] = data.split(":");
  if (action === "a" || action === "aa" || action === "ar" || action === "ad") {
    if (user !== ctx.owner) {
      await answer("Список ведёт владелец.");
      return true;
    }
    if (action === "aa") {
      ctx.store.put(awaitKey, { kind: "people" });
      await answer();
      await send({ text: "Выберите человека кнопкой ниже.", reply_markup: { resize_keyboard: true, one_time_keyboard: true, keyboard: [
        [{ text: "Выбрать человека", request_users: { request_id: 1, user_is_bot: false, max_quantity: 10, request_name: true, request_username: true } }],
        [{ text: "Отмена" }],
      ] } });
      return true;
    }
    if (action === "ar") setAccess(ctx.store, ctx.bot, accessList(ctx.store, ctx.bot).filter((p) => p.id !== Number(arg)));
    if (action === "ad") {
      const n = accessList(ctx.store, ctx.bot).length;
      await show({ text: n ? `Поручать мне могут вы и ещё ${n}.` : "Поручать мне можете только вы." });
    } else await show(accessScreen(ctx.store, ctx.bot));
    await answer();
    return true;
  }
  if (action === "l") {
    await show(groupsScreen(ctx.store, ctx.bot, ctx.botUsername));
    await answer();
    return true;
  }
  if (action === "k") {
    await show({ text: "Хорошо. Настроить можно позже: «Мои группы»." });
    await answer();
    return true;
  }
  const chat = Number(arg);
  if (!Number.isSafeInteger(chat) || !(await canManageGroup(ctx, user, chat))) {
    await answer("Эту группу настраивают её администраторы из тех, кто может мне поручать.", true);
    return true;
  }
  const title = membership(ctx.store, ctx.bot, chat)?.title ?? "группа";
  const lock = openGroupLock(ctx.store, await providerOf(ctx, chat));
  let s = groupSettings(ctx.store, ctx.bot, chat) ?? defaultGroupSettings();
  if (action === "w") {
    if (lock) {
      await answer(lockText(lock), true);
      return true;
    }
    s = saveGroupSettings(ctx.store, ctx.bot, chat, { who: s.who === "access" ? "all" : "access" });
  } else if (action === "r") s = saveGroupSettings(ctx.store, ctx.bot, chat, { reply: s.reply === "mention" ? "auto" : "mention" });
  else if (action === "m") s = saveGroupSettings(ctx.store, ctx.bot, chat, { members: NEXT_MEMBERS[s.members] });
  else if (action === "zt") {
    const zone = ctx.zones[Number(extra)];
    if (zone) s = saveGroupSettings(ctx.store, ctx.bot, chat, { zones: s.zones.includes(zone) ? s.zones.filter((z) => z !== zone) : [...s.zones, zone] });
    await show(zonesScreen(title, chat, s, ctx.zones));
    await answer();
    return true;
  } else if (action === "z") {
    await show(zonesScreen(title, chat, s, ctx.zones));
    await answer();
    return true;
  } else if (action === "n") {
    ctx.store.put(awaitKey, { kind: "note", chat });
    await show(noteScreen(chat));
    await answer();
    return true;
  } else if (action === "nd") {
    ctx.store.del(awaitKey);
    s = saveGroupSettings(ctx.store, ctx.bot, chat, { note: "" });
  } else if (action === "d") {
    ctx.store.del(awaitKey);
    await show({ text: `«${title}»: ${shortState(s)}. Изменить можно в «Мои группы».` });
    await answer();
    return true;
  } else if (action === "g") ctx.store.del(awaitKey);
  await show(groupScreen(title, chat, s, lock));
  await answer();
  return true;
}
