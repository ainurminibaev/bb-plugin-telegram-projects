// Without a mention, the agent decides via the quick decision service (vallis-decide) whether to join the turn
// (agents-in-chats.md: «Без отметки агент сам решает, включаться ли»).
// The main model is never started unless the quick decision says so (or falls back to the table on service failure).
import type { Store } from "./model";
import type { decideChoice } from "./turn-feedback";

export const fastDecideEnabledKey = "fast-decide:enabled";
export const lastBotMessageKey = (botId: number, chatId: number, topicId: number) =>
  `group:last-bot-msg:${botId}:${chatId}:${topicId}`;

/** How long a non-leader agent waits before joining on «my_zone_only», to make sure no colleague answered first. */
export const NON_LEADER_WAIT_MS = 5_000;

export type FastDecideChoice = "my_zone_only" | "relevant" | "ignore";
export type FastDecideOutcome = "pass" | "wait" | "drop";
export type FastDecideChooser = ReturnType<typeof decideChoice>;

export type FastDecideMeta = {
  isLeader: boolean;
  fallbackPass: boolean;
  mentions?: string[];
};

export type FastDecideContext = {
  chatTitle: string;
  chatId: number;
  topicTitle: string;
  topicId: number;
  messageText: string;
  senderName: string;
  senderKind: "владелец" | "участник";
  mentions: string[];
  recentMessages: string[];
  isLeader: boolean;
  leaderName?: string;
  agentName: string;
  agentRole: string;
  agentZones: string[];
};

export const FAST_DECIDE_INSTRUCTIONS =
  "Оцени, касается ли это неадресованное сообщение данного агента в групповом чате. " +
  "Выбери один из трёх вариантов: " +
  "my_zone_only — явно зона ответственности этого агента и не зона ведущего; " +
  "relevant — касается этого агента или темы, которую он ведёт; " +
  "ignore — не касается этого агента, отвечать не нужно.";

export const FAST_DECIDE_CHOICES: { value: FastDecideChoice; description: string }[] = [
  { value: "my_zone_only", description: "Явно зона ответственности этого агента и не зона ведущего" },
  { value: "relevant", description: "Касается этого агента или темы, которую он ведёт" },
  { value: "ignore", description: "Не касается этого агента, отвечать не нужно" },
];

export function fastDecideEnabled(store: Store): boolean {
  return store.get<boolean>(fastDecideEnabledKey) === true;
}

export function noteBotMessageInTopic(
  store: Store,
  botId: number,
  chatId: number,
  topicId: number,
  messageId: number,
): void {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
  const key = lastBotMessageKey(botId, chatId, topicId);
  const prev = store.get<number>(key) ?? 0;
  if (messageId > prev) store.put(key, messageId);
}

export function anyBotRepliedAfter(
  store: Store,
  botId: number,
  chatId: number,
  topicId: number,
  messageId: number,
  archiveCheck?: (chatId: number, topicId: number, messageId: number) => boolean,
): boolean {
  const lastBot = store.get<number>(lastBotMessageKey(botId, chatId, topicId)) ?? 0;
  if (lastBot > messageId) return true;
  try {
    return archiveCheck ? archiveCheck(chatId, topicId, messageId) : false;
  } catch {
    return false;
  }
}

export function buildFastDecidePrompt(ctx: FastDecideContext): string {
  const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
  const lines: string[] = [];
  lines.push(`Чат: ${clip(ctx.chatTitle || String(ctx.chatId), 120)} (${ctx.chatId})`);
  lines.push(`Тема: ${clip(ctx.topicTitle || (ctx.topicId ? `тема ${ctx.topicId}` : "General"), 120)} (${ctx.topicId})`);
  lines.push(
    ctx.isLeader
      ? `Ведущий темы: этот агент (${clip(ctx.agentName || "агент", 60)})`
      : `Ведущий темы: ${ctx.leaderName ? clip(ctx.leaderName, 60) : "другой агент или не назначен"} (этот агент — не ведущий)`,
  );
  lines.push(`Агент: ${clip(ctx.agentName || "агент", 60)}`);
  if (ctx.agentRole.trim()) lines.push(`Роль агента: ${clip(ctx.agentRole, 300)}`);
  if (ctx.agentZones.length) lines.push(`Зоны агента: ${ctx.agentZones.map(z => clip(z, 60)).join(", ").slice(0, 300)}`);
  if (ctx.recentMessages.length) {
    lines.push("Недавние сообщения темы:");
    for (const m of ctx.recentMessages.slice(-6)) {
      const c = clip(m, 220);
      if (c) lines.push(`- ${c}`);
    }
  }
  lines.push(`Автор сообщения: ${clip(ctx.senderName || ctx.senderKind, 80)} (${ctx.senderKind})`);
  lines.push(`Отметки в сообщении: ${ctx.mentions.length ? ctx.mentions.join(", ") : "нет"}`);
  lines.push(`Сообщение: ${clip(ctx.messageText, 800)}`);
  return lines.join("\n").slice(0, 3200);
}

/**
 * Decides whether to include the unaddressed message in a turn:
 * - Service unavailable / error / timeout → safe fallback to the existing mode table (fallbackPass).
 * - Leader: joins on "relevant" or "my_zone_only", drops on "ignore".
 * - Non-leader: waits ("wait") only on "my_zone_only", drops on "relevant" or "ignore".
 */
export async function decideUnaddressed(
  ctx: FastDecideContext,
  choose: FastDecideChooser | undefined,
  fallbackPass: boolean,
  signal?: AbortSignal,
): Promise<FastDecideOutcome> {
  if (!choose) return fallbackPass ? "pass" : "drop";
  let choice: string | undefined;
  try {
    choice = await choose(buildFastDecidePrompt(ctx), FAST_DECIDE_INSTRUCTIONS, FAST_DECIDE_CHOICES, signal);
  } catch {
    choice = undefined;
  }
  if (choice !== "my_zone_only" && choice !== "relevant" && choice !== "ignore") {
    return fallbackPass ? "pass" : "drop";
  }
  if (ctx.isLeader) {
    return choice === "ignore" ? "drop" : "pass";
  }
  return choice === "my_zone_only" ? "wait" : "drop";
}
