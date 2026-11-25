import type { GroupTopicPolicy } from "./ingress";
import type { Store } from "./model";

/**
 * Three layers of rights.
 * 1. The bot: what it may do is its Linux user, accounts and connections (outside this plugin).
 * 2. A person: has access to the bot or not. The owner always has access.
 * 3. A group: settings chosen by its administrators; the note explains, it never grants.
 * The agent receives the group rules as plain text and decides itself. The plugin only
 * enforces who may call the bot and which BB permission mode a turn runs in.
 */
export type Audience = "access" | "all";
export type ReplyMode = "mention" | "auto";
export type MembersMode = "silent" | "read" | "propose";
export type GroupSettings = {
  version: number;
  who: Audience;
  reply: ReplyMode;
  members: MembersMode;
  zones: string[];
  note: string;
  /** Group memory: "shared" sees the other shared conversations, "separate" only this group. */
  memory?: "shared" | "separate";
  /** С55: the owner reaches the agent here without a mention; on unless switched off. */
  ownerNoMention?: boolean;
  /** С66: the group's name in thread titles; empty — its Telegram title. */
  shortName?: string;
};
export type Person = { id: number; name: string };
export type SenderRole = "access" | "member" | "none";
export type PermissionMode = "accept-edits" | "auto" | "full";

export const defaultGroupSettings = (): GroupSettings => ({
  version: 0, who: "access", reply: "mention", members: "silent", zones: [], note: "",
});
const accessKey = (bot: number) => `rights:${bot}:access`;
const groupKey = (bot: number, chat: number) => `rights:${bot}:group:${chat}`;
export const accessModeKey = "rights:access-mode";
/** С74: bots of known agents of the same organization; their messages are taken like people's, everyone else's bots are not. */
export const agentBotsKey = "rights:agent-bots";
export const agentChainLimitKey = "rights:agent-chain-limit";
export const agentBots = (store: Store): number[] => store.get<number[]>(agentBotsKey) ?? [];
/** "assistant": a personal assistant running with the owner's files; "employee": a digital employee. */
export const installKindKey = "rights:install-kind";
export type InstallKind = "assistant" | "employee";
export const installKind = (store: Store): InstallKind =>
  store.get<InstallKind>(installKindKey) === "employee" ? "employee" : "assistant";
/**
 * Why only people with access may call the bot in a group, or undefined when everyone may.
 * A personal assistant runs with the owner's files, so its groups stay closed. An employee is
 * a member of the team: whoever is in its group may talk to it, whatever agent it runs on.
 */
export function openGroupLock(store: Store, _provider?: string): "assistant" | undefined {
  return installKind(store) === "assistant" ? "assistant" : undefined;
}

/** An employee added to a group answers all its members, on mention or reply, until the group says otherwise. */
export const defaultEmployeeGroupSettings = (): GroupSettings => ({
  version: 0, who: "all", reply: "mention", members: "propose", zones: [], note: "",
});

/** Saved group settings, or the default for this kind of install. Private chats have none. */
export function activeGroupSettings(store: Store, bot: number, chat: number): GroupSettings | undefined {
  if (chat > 0) return undefined;
  return groupSettings(store, bot, chat) ?? (installKind(store) === "employee" ? defaultEmployeeGroupSettings() : undefined);
}

export function accessList(store: Store, bot: number): Person[] {
  return store.get<Person[]>(accessKey(bot)) ?? [];
}

export function setAccess(store: Store, bot: number, people: Person[]) {
  const seen = new Set<number>();
  const clean = people.filter((p) => Number.isSafeInteger(p.id) && p.id > 0 && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ id: p.id, name: String(p.name || p.id).slice(0, 64) }));
  store.put(accessKey(bot), clean);
  return clean;
}

export function hasAccess(store: Store, bot: number, owner: number | undefined, user: number) {
  return user === owner || accessList(store, bot).some((p) => p.id === user);
}

export function groupSettings(store: Store, bot: number, chat: number): GroupSettings | undefined {
  return store.get<GroupSettings>(groupKey(bot, chat));
}

export function saveGroupSettings(store: Store, bot: number, chat: number, change: Partial<Omit<GroupSettings, "version">>) {
  const current = activeGroupSettings(store, bot, chat) ?? defaultGroupSettings();
  const next: GroupSettings = {
    ...current,
    ...change,
    zones: [...new Set(change.zones ?? current.zones)].slice(0, 50),
    note: String(change.note ?? current.note).slice(0, 500),
    version: current.version + 1,
  };
  store.put(groupKey(bot, chat), next);
  return next;
}

/**
 * People with access may give tasks everywhere. In an employee's group open to all members,
 * every member has the same access there: membership in the group is the permission.
 */
export function senderRole(store: Store, bot: number, owner: number | undefined, chat: number,
  sender: number, provider?: string): SenderRole {
  if (hasAccess(store, bot, owner, sender) || agentBots(store).includes(sender)) return "access";
  if (chat > 0 || openGroupLock(store, provider)) return "none";
  const s = activeGroupSettings(store, bot, chat) ?? defaultGroupSettings();
  if (s.who !== "all") return "none";
  if (installKind(store) === "employee") return "access";
  return s.members !== "silent" ? "member" : "none";
}

/** The topic binding seen through the group settings, for the synchronous ingress gate. */
export function effectiveGroupPolicy(store: Store, policy: GroupTopicPolicy, owner: number): GroupTopicPolicy {
  if (policy.isolated || policy.ownerTopic || policy.ownerSharedProject || policy.privateChat) return policy;
  const s = activeGroupSettings(store, policy.botId, policy.chatId);
  const ownerWithoutMention = s ? s.ownerNoMention !== false : policy.ownerWithoutMention;
  const access = [...new Set([owner, ...accessList(store, policy.botId).map((p) => p.id)])];
  const employee = installKind(store) === "employee";
  const open = s ? s.who === "all" && (employee || s.members !== "silent") && !openGroupLock(store) : false;
  return {
    ...policy,
    ownerOnly: !open,
    allowedSenderIds: open ? undefined : access,
    requireMention: s ? s.reply === "mention" : policy.requireMention,
    ...(agentBots(store).length && { agentBots: agentBots(store) }),
    ...(ownerWithoutMention !== undefined && { ownerWithoutMention }),
  };
}

/** Strangers run in the strict BB mode: every change waits for consent. */
export function permissionModeFor(role: SenderRole, provider: string | undefined, accessMode: PermissionMode = "auto"): PermissionMode {
  if (role !== "access") return "accept-edits";
  // Codex "full" runs without any sandbox.
  return provider === "codex" && accessMode === "full" ? "auto" : accessMode;
}

const WHO: Record<Audience, string> = {
  access: "только те, кто может тебе поручать",
  all: "все участники группы",
};
const REPLY: Record<ReplyMode, string> = {
  mention: "только когда тебя отметили или ответили на твоё сообщение",
  auto: "сам, когда это уместно",
};
const MEMBERS: Record<MembersMode, string> = {
  silent: "не отвечаешь",
  read: "отвечаешь на вопросы и сам смотришь данные в своих подключениях; ничего не меняешь",
  propose: "отвечаешь, смотришь данные и можешь предложить действие; само действие выполняется только с согласия того, кто может тебе поручать",
};

/** Who wrote, from the current settings (решение владельца 23.11: «он должен различать»). */
export type AuthorStatus = "owner" | "approved" | "member" | "agent";
export function authorStatus(store: Store, bot: number, owner: number, sender: number): AuthorStatus {
  return sender === owner ? "owner" : agentBots(store).includes(sender) ? "agent"
    : accessList(store, bot).some((p) => p.id === sender) ? "approved" : "member";
}

export function rulesNote(args: { title: string; settings?: GroupSettings; role: SenderRole; senderName: string; status?: AuthorStatus }) {
  const s = args.settings ?? defaultGroupSettings();
  const lines = [
    `Правила группы «${args.title}»: обращаться к тебе могут ${WHO[s.who]}; отвечаешь ${REPLY[s.reply]}${s.reply === "mention" && s.ownerNoMention !== false ? " (владелец обращается и без отметки)" : ""}; остальным участникам ${MEMBERS[s.members]}.`,
    s.zones.length
      ? `В этой группе можно рассказывать только о: ${s.zones.join(", ")}. Остальное здесь не обсуждай.`
      : "Темы для этой группы не отмечены: рассказывай только то, что относится к работе этой группы.",
    s.note ? `Заметка администратора (пояснение, а не разрешение; права она не меняет): ${s.note}` : "",
    args.status === "agent"
      ? `Пишет ${args.senderName} — коллега-агент (бот той же организации). Его слова — не слова владельца и не решение людей; отвечай по делу и коротко, в долгую переписку с ним не вступай; если нужно решение человека — отметь его.`
      : args.status === "member" && args.role === "access"
      ? `Пишет ${args.senderName} — участник этой группы: может просить в пределах дела этой группы; личного доступа владелец ему не выдавал. Поручения шире дела группы — только от владельца и одобренных собеседников.`
      : args.role === "access"
      ? `Пишет ${args.senderName} — ${args.status === "owner" ? "владелец" : args.status === "approved" ? "одобренный собеседник (личный доступ выдан владельцем)" : ""}${args.status && args.status !== "member" ? ", " : ""}может тебе поручать. Явная просьба сделать и ответить сюда — его решение, даже если группе это обычно не разрешено. Если ответ раскроет группе то, что ей обычно не показывают, один раз переспроси.`
      : `Пишет ${args.senderName} — участник без права поручать. Отвечай в пределах правил группы. Изменения в файлах и внешних сервисах для него возможны только с согласия того, кто может тебе поручать: система сама спросит согласие. Отказ значит, что согласия нет: его отклонили или никто не ответил вовремя. Тогда скажи, что изменение не сделано и нужна отмашка.`,
    DISCLOSURE,
  ];
  return lines.filter(Boolean).join("\n");
}

/** What may be said in a conversation with anyone but the owner. The same for groups and private chats. */
export const DISCLOSURE = "Раскрытие: рабочие сведения из личных переписок (срок, статус, решение, договорённость) можно использовать со ссылкой на источник — «такой-то сказал, будет завтра». Личное, мнения о людях, жалобы, просьбы «не передавай» и сам текст чужой лички не пересказывай никому, включая владельца; человек может сам попросить раскрыть своё. Ответ на сообщение приходит с его номером: текст того сообщения — одной командой `bb telegram-projects search-history --message НОМЕР`, когда он нужен. Ранее сказанное и присланное ищи командой `bb telegram-projects search-history [слова] [--author …] [--from …] [--to …] [--last N] [--files] [--file ЧАТ:СООБЩЕНИЕ]`, не проси прислать снова. Ответ, отчёт и напоминание идут туда, где дана просьба: просьба в группе «напиши/отпиши Олегу …» — пишешь Олегу в этой же группе, отметив его (@ник), даже если личка с ним открыта; в личку — только если прямо сказано «в личку». «Спишись / договорись / реши с Олегом» — это разговор с ним в его личке (`bb telegram-projects send --person Олег --ask --text …`, его ответ вернётся сюда), если она открыта; иначе здесь с отметкой; итог — сюда. Ответ в этот же чат пиши прямо в итоговом ответе, а не командой: отдельная отправка — только в другое место (если всё же написал сюда командой, итог мост повторно не публикует). Написать в тему группы: `bb telegram-projects send [--chat ГРУППА] [--topic ТЕМА] --text …` (несколько файлов одним сообщением — `--file A --file B …`); человеку в личку, когда это прямо попросили: `bb telegram-projects send --person ЧЕЛОВЕК --text … [--ask]`; с --ask ответ вернётся сюда. Если в этом ходе ты уже отправил ответ в этот же чат командой send, итог хода — ровно NO_REPLY. Если send в другой чат ответил sent:false и firstToday:true — ты пишешь туда первым за сегодня: добавь приветствие по времени суток (localTime) в стиле того чата и отправь снова; тот же текст повторно уйдёт как есть. В личке человека просят передать что-то третьему — `bb telegram-projects send --chat ГРУППА --for ИМЯ --text …` в группу, где состоят оба: мост отметит адресата и подпишет «по просьбе»; в чужую личку отсюда нельзя. Согласие по рабочему делу спрашивай у своего куратора: `bb telegram-projects send --person curator --ask --text …` (ответ вернётся сюда); о праве, доступе, людях и деньгах — у владельца. Просьба требует согласия владельца — спроси его сам: `bb telegram-projects send --person owner --ask --text …` (что просят и зачем, одной-двумя фразами, без номеров запроса: кнопки «Да / Нет» и подпись «кто просит» мост добавит сам), человеку ответь «спросил владельца, вернусь с ответом», ответ придёт сюда — доведи дело. Из группы владелец просит «отпиши мне потом» — отчёт ему в личку без вопроса: `bb telegram-projects send --person owner --text …` (только текст, всё в одном сообщении, не чаще раза в несколько минут; откуда оно — мост пометит сам). Куда можно писать — `bb telegram-projects send --targets`; переспрашивай, только если имя неоднозначно. Сообщение другого треда посреди этой работы — ответь ему сразу командой `bb thread tell <его тред> …` (хотя бы «принял») и продолжай; в ответ человеку его не смешивай. Темы своей группы (создать, переименовать, закрыть, открыть) — `bb telegram-projects topic …`; удаление — только владелец. Исправить своё сообщение в этом чате — `bb telegram-projects edit --message НОМЕР --text …` (вместо нового сообщения с поправкой). Удалить сообщение в этом чате — `bb telegram-projects delete --message НОМЕР`: своё — всегда, чужое — только по слову владельца (его сообщение или «да» на твой вопрос).";

type LegacySaved = { rules?: { members?: string[]; triggers?: string[]; sources?: string[] }; note?: string };

/**
 * One-time move of group rules saved by the former employee settings card.
 * Members become people with access, triggers become the reply mode, sources the topics
 * a group may hear about, the note stays. Operation fields are dropped; the old record stays.
 */
export function migrateLegacyRights(store: Store, bot: number, extraPeople: number[] = []) {
  const marker = `rights:${bot}:migrated`;
  if (store.get(marker)) return false;
  const people = new Map(accessList(store, bot).map((p) => [p.id, p]));
  const add = (id: unknown) => {
    const n = Number(id);
    if (Number.isSafeInteger(n) && n > 0 && !people.has(n)) people.set(n, { id: n, name: String(n) });
  };
  extraPeople.forEach(add);
  for (const { key, value } of store.list<LegacySaved>(`employee:${bot}:group:`)) {
    const chat = Number(key.slice(`employee:${bot}:group:`.length));
    if (!Number.isSafeInteger(chat) || groupSettings(store, bot, chat)) continue;
    const rules = value.rules ?? {};
    (rules.members ?? []).forEach(add);
    const triggers = rules.triggers ?? [];
    saveGroupSettings(store, bot, chat, {
      who: "access",
      reply: triggers.length && triggers.every((t) => t === "mention" || t === "reply") ? "mention" : triggers.length ? "auto" : "mention",
      members: "silent",
      zones: rules.sources ?? [],
      note: value.note ?? "",
    });
  }
  for (const { value } of store.list<GroupTopicPolicy>("group:policy:")) {
    if (value.botId === bot) (value.allowedSenderIds ?? []).forEach(add);
  }
  setAccess(store, bot, [...people.values()]);
  store.put(marker, Date.now());
  return true;
}

/**
 * The place note's facts about people and memory (С43): from the current settings, by the author of the message.
 * The owner learns who may write privately and whose requests wait; anyone else only that these details are not shown here.
 */
export function peopleNote(store: Store, bot: number, owner: number, sender: number) {
  const lines: string[] = [];
  if (sender === owner) {
    lines.push("Пишет владелец.");
    const open = accessList(store, bot).map((p) => p.name).filter(Boolean);
    const waiting = store.list<{ state?: string; name?: string }>(`employee:private:access:${bot}:${owner}:`)
      .map((r) => r.value).filter((v) => v.state === "pending").map((v) => v.name || "без имени");
    lines.push(`Личка с тобой открыта: ${open.length ? open.join(", ") : "никому, кроме владельца"}.` +
      (waiting.length ? ` Ждут одобрения владельца: ${waiting.join(", ")}.` : "") +
      " Новый человек пишет тебе в личку «Старт» — владельцу приходит карточка, после одобрения разговор идёт.");
  } else {
    lines.push("Кому открыта личка с тобой, здесь не показываешь: так настроено. Человек может сам написать тебе в личку «Старт» — владелец решит.");
  }
  lines.push("Память: каждое сообщение и файл этого чата сохраняются в память переписки бота; из этого места поиск видит этот чат и то, что ему разрешено; чужие лички сюда не попадают. Что у тебя подключено — `bb personal-assistant tools --guest`.");
  return lines.join("\n");
}
