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
/** "assistant": a personal assistant running with the owner's files; "employee": a digital employee. */
export const installKindKey = "rights:install-kind";
export type InstallKind = "assistant" | "employee";
export const installKind = (store: Store): InstallKind =>
  store.get<InstallKind>(installKindKey) === "employee" ? "employee" : "assistant";
/** Why only people with access may call the bot here, or undefined when everyone may. */
export function openGroupLock(store: Store, provider?: string): "codex" | "assistant" | undefined {
  if (provider === "codex") return "codex";
  return installKind(store) === "assistant" ? "assistant" : undefined;
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
  const current = groupSettings(store, bot, chat) ?? defaultGroupSettings();
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

/** Codex employees accept only people with access until the Codex boundary is verified. */
export function senderRole(store: Store, bot: number, owner: number | undefined, chat: number,
  sender: number, provider?: string): SenderRole {
  if (hasAccess(store, bot, owner, sender)) return "access";
  // Strangers reach only employees on a verified boundary (see openGroupLock).
  if (openGroupLock(store, provider)) return "none";
  const s = groupSettings(store, bot, chat) ?? defaultGroupSettings();
  return s.who === "all" && s.members !== "silent" ? "member" : "none";
}

/** The topic binding seen through the group settings, for the synchronous ingress gate. */
export function effectiveGroupPolicy(store: Store, policy: GroupTopicPolicy, owner: number): GroupTopicPolicy {
  if (policy.isolated || policy.ownerTopic) return policy;
  const s = groupSettings(store, policy.botId, policy.chatId);
  const access = [...new Set([owner, ...accessList(store, policy.botId).map((p) => p.id)])];
  const open = s ? s.who === "all" && s.members !== "silent" : false;
  return {
    ...policy,
    ownerOnly: !open,
    allowedSenderIds: open ? undefined : access,
    requireMention: s ? s.reply === "mention" : policy.requireMention,
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

export function rulesNote(args: { title: string; settings?: GroupSettings; role: SenderRole; senderName: string }) {
  const s = args.settings ?? defaultGroupSettings();
  const lines = [
    `Правила группы «${args.title}»: обращаться к тебе могут ${WHO[s.who]}; отвечаешь ${REPLY[s.reply]}; остальным участникам ${MEMBERS[s.members]}.`,
    s.zones.length
      ? `В этой группе можно рассказывать только о: ${s.zones.join(", ")}. Остальное здесь не обсуждай.`
      : "Темы для этой группы не отмечены: рассказывай только то, что относится к работе этой группы.",
    s.note ? `Заметка администратора (пояснение, а не разрешение; права она не меняет): ${s.note}` : "",
    args.role === "access"
      ? `Пишет ${args.senderName} — может тебе поручать. Явная просьба сделать и ответить сюда — его решение, даже если группе это обычно не разрешено. Если ответ раскроет группе то, что ей обычно не показывают, один раз переспроси.`
      : `Пишет ${args.senderName} — участник без права поручать. Отвечай в пределах правил группы. Изменения в файлах и внешних сервисах для него возможны только с согласия того, кто может тебе поручать: система сама спросит согласие. Отказ значит, что согласия нет: его отклонили или никто не ответил вовремя. Тогда скажи, что изменение не сделано и нужна отмашка.`,
  ];
  return lines.filter(Boolean).join("\n");
}

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
