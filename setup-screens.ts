import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GroupTopicPolicy } from "./ingress";
import { groupMemory } from "./archive-access";
import { privacyKey } from "./group-visibility";
import { checkBotGroupRights } from "./bot-rights";
import type { Store, Telegram } from "./model";
import {
  accessList, activeGroupSettings, installKind, defaultGroupSettings, groupSettings, hasAccess, openGroupLock, saveGroupSettings, markOwnerMemoryChoice, setSettingsActor, setAccess,
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

/** «Ковальский подключён к организации „…“» — from the install's settings; without them a neutral line (С102). */
export function connectedLine(name?: string, organization?: string) {
  const who = name ? name + " подключён" : "Я подключён";
  return organization ? `${who} к организации «${organization}».` : (name ? who + "." : "Готово, я подключён.");
}

export function welcomeScreen(ctx: Pick<SetupContext, "role" | "botUsername"> & { privacy?: boolean; employee?: boolean;
  organization?: string; name?: string }) {
  return {
    text: [(ctx.employee ? connectedLine(ctx.name, ctx.organization) : "Готово, я подключён.") + (ctx.role ? " " + ctx.role : ""),
      "Сейчас поручения мне можете давать только вы.",
      ctx.employee ? "Напишите, чем помочь, — или добавьте меня в рабочую группу." :
        "Дальше: добавьте меня в рабочую группу — я сразу пришлю, как её настроить.",
      // An employee's privacy mode is the installer's business, not the owner's (С102).
      ...(ctx.employee ? [] : ["",
      ctx.privacy === false
        ? "Режим приватности у меня выключен: в группах я вижу всю переписку, а что из неё обрабатывать, решают настройки группы."
        : "Режим приватности у меня включён: в группах я вижу только ответы на мои сообщения и команды. Выключите его в @BotFather → /setprivacy → Disable, затем добавьте меня в группы заново — тогда меня можно отмечать и я вижу переписку, а что обрабатывать, решают настройки группы."]),
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
      text: `${g.title} — ${shortState(activeGroupSettings(store, bot, g.chat) ?? defaultGroupSettings(), openGroupLock(store) === "assistant")}`,
      callback_data: "rs:g:" + g.chat,
    }]) },
  };
}

export function groupScreen(title: string, chat: number, s: GroupSettings, lock?: "codex" | "assistant", employee = false) {
  const who = lock ? "access" : s.who;
  // An employee answers every member of an open group as someone who may give tasks.
  const membersAreAccess = employee && who === "all";
  const lines = [
    `Группа «${title}»`,
    "Ко мне обращаются: " + WHO_LINE[who],
    "Отвечаю: " + REPLY_LINE[s.reply],
    ...(s.reply === "mention" ? ["Владельцу: " + (s.ownerNoMention === false ? "тоже только по отметке" : "отвечаю и без отметки, когда реплика мне")] : []),
    membersAreAccess ? "Все участники группы могут мне поручать." : "Остальным участникам: " + (who === "access" ? "не отвечаю, пока ко мне обращаются только те, кто может поручать" : MEMBERS_LINE[s.members]),
    ...(who === "all" && !membersAreAccess ? [MEMBERS_HINT[s.members]] : []),
    "Можно рассказывать: " + (s.zones.length ? s.zones.join(", ") : "всё, что относится к работе группы"),
    "Заметка: " + (s.note || "—"),
    "Кто может мне поручать, всегда может попросить сделать что-то и ответить сюда.",
    ...(lock ? ["", lockText(lock)!] : []),
  ];
  const rows: Button[][] = [
    [{ text: lock ? WHO_BUTTON.access + " 🔒" : WHO_BUTTON[s.who], callback_data: `rs:w:${chat}` }],
    [{ text: REPLY_BUTTON[s.reply], callback_data: `rs:r:${chat}` }],
    ...(s.reply === "mention" ? [[{ text: s.ownerNoMention === false ? "Владелец: только по отметке" : "Владелец: и без отметки", callback_data: `rs:o:${chat}` }]] : []),
    ...(who === "all" && !membersAreAccess ? [[{ text: MEMBERS_BUTTON[s.members], callback_data: `rs:m:${chat}` }]] : []),
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
    const rights = await checkBotGroupRights(ctx.tg(g.chat), ctx.bot, ctx.botUsername, g.chat, { title: g.title });
    const recipient = g.inviter && hasAccess(ctx.store, ctx.bot, ctx.owner, g.inviter) ? g.inviter : ctx.owner;
    let s = activeGroupSettings(ctx.store, ctx.bot, g.chat) ?? defaultGroupSettings();
    if (!s.memory) {
      // Only the owner and the bot: one memory with everything else. Other people: this group's own memory.
      const count = await ctx.tg(g.chat)<number>("getChatMemberCount", { chat_id: g.chat }).catch(() => undefined);
      s = saveGroupSettings(ctx.store, ctx.bot, g.chat, { memory: typeof count === "number" && count <= 2 ? "shared" : "separate" }, "мост при добавлении в группу");
    }
    const lines = [`Меня добавили в «${g.title}». Если ничего не менять: ${summaryLine(ctx, s)}.`];
    if (!visible)
      lines.push("Чтобы я видел обсуждение, а не только обращения ко мне, сделайте меня администратором группы.");
    if (!rights.ok && !rights.error && rights.hint) lines.push(rights.hint);
    try {
      await ctx.tg(recipient)("sendMessage", { chat_id: recipient, text: lines.join("\n"), reply_markup: { inline_keyboard: [[
        { text: "Изменить (3 вопроса)", callback_data: "rs:s1:" + g.chat },
        { text: "Оставить так", callback_data: "rs:k" },
      ]] } });
      ctx.store.put(key, signature);
    } catch { continue; /* retried on the next pass */ }
    // Only a group the bot has just joined: an update never posts into an existing group.
    if (visible) await announceInGroup(ctx, g.chat, s);
  }
}

function memoryOf(ctx: Pick<SetupContext, "store" | "bot">, chat: number, s: GroupSettings) {
  return s.memory ?? groupMemory(ctx.store, ctx.bot, chat);
}

/** One line: who may talk to me here, when I answer, and the group memory. */
export function summaryLine(ctx: Pick<SetupContext, "store" | "bot">, s: GroupSettings, chat?: number) {
  const locked = openGroupLock(ctx.store) === "assistant";
  const who = s.who === "all" && !locked ? "отвечаю всем участникам" : "отвечаю только вам" + (accessList(ctx.store, ctx.bot).length ? " и людям с доступом" : "");
  const when = s.reply === "mention" ? "когда меня отметят или ответят мне" : "на всё, что ко мне по делу";
  const memory = (chat === undefined ? s.memory : memoryOf(ctx, chat, s)) === "shared" ? "память общая с другими разговорами" : "память только этой группы";
  return `${who}, ${when}; ${memory}`;
}

/** The three-step setup: who may talk to me, when I answer, the group memory. */
export function setupStep(ctx: Pick<SetupContext, "store" | "bot" | "botUsername">, step: 1 | 2 | 3, title: string, chat: number) {
  const assistant = installKind(ctx.store) === "assistant";
  const others = accessList(ctx.store, ctx.bot).length ? " и люди с доступом" : "";
  if (step === 1) return {
    text: [`Шаг 1 из 3. Кто может обращаться ко мне в «${title}»?`,
      "• Все участники — например, любой попросит сводку или поручит задачу.",
      `• Только вы${others} — остальным я не отвечаю.`,
      ...(openGroupLock(ctx.store) === "assistant" ? ["Личный помощник работает с вашими файлами, поэтому в группах отвечает только вам."] : [])].join("\n"),
    reply_markup: { inline_keyboard: [[
      ...(openGroupLock(ctx.store) === "assistant" ? [] : [{ text: "Все участники", callback_data: `rs:a1:${chat}:all` }]),
      { text: `Только вы${others}`, callback_data: `rs:a1:${chat}:access` }]] },
  };
  if (step === 2) return {
    text: [`Шаг 2 из 3. Когда мне отвечать в «${title}»?`,
      `• Когда отметили или ответили мне — например: «@${ctx.botUsername || "бот"}, какой срок у задачи?»`,
      "• На всё по делу — сам вступаю, когда вопрос ко мне."].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "Когда отметили", callback_data: `rs:a2:${chat}:mention` },
      { text: "На всё по делу", callback_data: `rs:a2:${chat}:auto` }]] },
  };
  return {
    text: [`Шаг 3 из 3. Память в «${title}».`,
      `• Общая — здесь я помню и то, что знаю из других групп${assistant ? " и вашей лички" : ""}. Подходит, если в группе только вы.`,
      "• Только этой группы — здесь я знаю только её переписку. Подходит, если в группе есть другие люди."].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "Общая", callback_data: `rs:a3:${chat}:shared` },
      { text: "Только этой группы", callback_data: `rs:a3:${chat}:separate` }]] },
  };
}

/** An employee open to all members says once in the group how to reach it. */
export async function announceInGroup(ctx: SetupContext, chat: number, s: GroupSettings) {
  const key = `rights:${ctx.bot}:announced:${chat}`;
  if (ctx.store.get(key) || installKind(ctx.store) !== "employee" || s.who !== "all" || openGroupLock(ctx.store)) return;
  const name = ctx.botUsername ? "@" + ctx.botUsername : "мне";
  // With Telegram's privacy mode on and no admin rights the bot sees only replies to its messages and commands to it —
  // a mention in plain text never reaches it (С113): then the greeting says so instead of «отметьте».
  const admin = ctx.store.get<{administrator?: boolean}>(`visibility:${ctx.bot}:group:${chat}`)?.administrator === true;
  const seesAll = admin || ctx.store.get<boolean>(privacyKey(ctx.bot)) !== true;   // privacy unknown — as before
  const how = !seesAll ? `ответьте на это моё сообщение или напишите /ask@${ctx.botUsername ?? "бот"} и вопрос — простую отметку я здесь не вижу`
    : s.reply === "mention" ? `отметьте ${name} или ответьте на моё сообщение` : "напишите в группу";
  try {
    await ctx.tg(chat)("sendMessage", { chat_id: chat,
      text: `Здравствуйте! Я отвечаю здесь всем участникам: ${how}. Можно просить и поручать. Написать мне лично: откройте чат со мной и нажмите «Старт» — доступ одобрит владелец.` });
    ctx.store.put(key, Date.now());
  } catch { /* retried on the next pass */ }
}

async function providerOf(ctx: SetupContext, chat: number) {
  const binding = ctx.store.list<GroupTopicPolicy>(`group:policy:${chat}:`).map((r) => r.value).find((p) => p.botId === ctx.bot);
  if (!binding?.threadId || !ctx.sdk) return undefined;
  try {
    return ((await ctx.sdk.threads.get({ threadId: binding.threadId })) as { providerId?: string }).providerId;
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
  const from = cb ? cb.from : m?.from;
  setSettingsActor(`${[from?.first_name, from?.last_name].filter(Boolean).join(" ") || user} (меню)`);
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
        openGroupLock(ctx.store, await providerOf(ctx, waiting.chat)), installKind(ctx.store) === "employee"));
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
  let s = activeGroupSettings(ctx.store, ctx.bot, chat) ?? defaultGroupSettings();
  if (action === "s1") {
    ctx.store.del(awaitKey);
    await show(setupStep(ctx, 1, title, chat));
    await answer();
    return true;
  }
  if (action === "a1" || action === "a2" || action === "a3") {
    if (action === "a1" && (extra === "all" || extra === "access")) {
      if (extra === "all" && lock) { await answer(lockText(lock), true); return true; }
      saveGroupSettings(ctx.store, ctx.bot, chat, { who: extra });
    } else if (action === "a2" && (extra === "mention" || extra === "auto")) saveGroupSettings(ctx.store, ctx.bot, chat, { reply: extra });
    else if (action === "a3" && (extra === "shared" || extra === "separate")) {
      if (extra === "shared") {
        // Shared memory makes the group the owner's own conversation: only when nobody else is there.
        const count = await ctx.tg(chat)<number>("getChatMemberCount", { chat_id: chat }).catch(() => undefined);
        if (typeof count !== "number" || count > 2) {
          await answer("В группе есть другие люди: общая память недоступна.", true);
          return true;
        }
      }
      saveGroupSettings(ctx.store, ctx.bot, chat, { memory: extra });
      markOwnerMemoryChoice(ctx.store, ctx.bot, chat, extra);
    }
    else { await answer(); return true; }
    const saved = activeGroupSettings(ctx.store, ctx.bot, chat) ?? defaultGroupSettings();
    if (action === "a3") await show({ text: `Готово. «${title}»: ${summaryLine(ctx, saved, chat)}.`,
      reply_markup: { inline_keyboard: [[{ text: "Изменить", callback_data: `rs:s1:${chat}` }]] } });
    else await show(setupStep(ctx, action === "a1" ? 2 : 3, title, chat));
    await answer();
    return true;
  }
  if (action === "w") {
    if (lock) {
      await answer(lockText(lock), true);
      return true;
    }
    s = saveGroupSettings(ctx.store, ctx.bot, chat, { who: s.who === "access" ? "all" : "access" });
  } else if (action === "r") s = saveGroupSettings(ctx.store, ctx.bot, chat, { reply: s.reply === "mention" ? "auto" : "mention" });
  else if (action === "o") s = saveGroupSettings(ctx.store, ctx.bot, chat, { ownerNoMention: s.ownerNoMention === false });
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
  await show(groupScreen(title, chat, s, lock, installKind(ctx.store) === "employee"));
  await answer();
  return true;
}
