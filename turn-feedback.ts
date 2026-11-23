// Видимый знак на каждое адресованное агенту сообщение и живое сообщение о работе (С45, С46).
// Один код для лички помощника, лички сотрудника, группы и темы.
//
// Реакция. У бота одна реакция на сообщение (Telegram): новая заменяет прежнюю.
//   1. Сразу при приёме — 👀 «увидел» от моста, без ожидания.
//   2. Параллельно быстрая модель выбирает значок по смыслу сообщения из набора (в том числе смешные);
//      успела за несколько секунд — заменяет 👀; не успела или ошибка — остаётся 👀.
//   3. Служебные состояния ставит мост по событиям хода поверх выбора: вопрос, отказ, ошибка.
//      «Готово» отдельно не ставится: завершение видно по ответу, выбранный значок остаётся.
// Способ выбора — сменный; по умолчанию общая служба платформы «быстрое решение» (команда `vallis-decide`, С47):
// провайдер и вход — в службе, мост только спрашивает.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

/** Реакции, которые Telegram разрешает ставить ботам (ReactionTypeEmoji). */
export const BOT_REACTIONS = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
  "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋",
  "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃",
  "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
]);

export type Stage = "seen" | "question" | "refused" | "failed";
/** Служебные значки моста. */
export const SERVICE_REACTIONS: Record<Stage, string> = { seen: "👀", question: "🤔", refused: "🤷", failed: "😢" };

export type ReactionOption = { emoji: string; meaning: string };
/** Набор по умолчанию: значок и смысл, по которому модель выбирает. Смешные — намеренно. */
export const DEFAULT_REACTION_OPTIONS: ReactionOption[] = [
  { emoji: "👀", meaning: "увидел, ответ не нужен" },
  { emoji: "👍", meaning: "согласен, принято" },
  { emoji: "👌", meaning: "договорились" },
  { emoji: "🫡", meaning: "есть, выполняю поручение" },
  { emoji: "✍", meaning: "записываю, берусь" },
  { emoji: "🔥", meaning: "отличная новость, огонь" },
  { emoji: "🎉", meaning: "поздравляю, праздник" },
  { emoji: "🙏", meaning: "спасибо или вежливая просьба" },
  { emoji: "🤝", meaning: "сделка, договорённость" },
  { emoji: "💯", meaning: "точно в цель, полностью согласен" },
  { emoji: "😁", meaning: "забавно" },
  { emoji: "🤣", meaning: "очень смешно" },
  { emoji: "🗿", meaning: "невозмутимо принял странное" },
  { emoji: "🦄", meaning: "необычная, смелая идея" },
  { emoji: "🌚", meaning: "хитро, с подвохом" },
];

/** Настройка набора: «👍=согласен; 😁=забавно; …». Значки, которых Telegram не даёт ботам, отбрасываются. */
export function parseReactionOptions(setting?: string): ReactionOption[] {
  const parsed = (setting ?? "").split(/[;\n]/).map(part => {
    const i = part.indexOf("=");
    return i < 0 ? undefined : { emoji: part.slice(0, i).trim(), meaning: part.slice(i + 1).trim() };
  }).filter((o): o is ReactionOption => !!o && BOT_REACTIONS.has(o.emoji) && !!o.meaning);
  return parsed.length >= 2 ? parsed : DEFAULT_REACTION_OPTIONS;
}

export function reactionPrompt(text: string, options: ReactionOption[], earlier: string[] = []): string {
  return [
    "Выбери одну реакцию-значок на сообщение в рабочем чате Telegram. Ответь только одним значком из списка, без слов.",
    "Варианты: " + options.map(o => `${o.emoji} ${o.meaning}`).join(" | "),
    ...(earlier.length ? ["Предыдущие реплики: " + earlier.map(e => "«" + e.slice(0, 300) + "»").join(" ")] : []),
    "Сообщение: «" + text.slice(0, 1500) + "»",
  ].join("\n");
}

/** Значок из ответа модели — только из набора; иначе ничего. */
export function pickFromReply(reply: string, options: ReactionOption[]): string | undefined {
  const t = reply.trim();
  // Длинные значки (с модификаторами) проверяются первыми, чтобы «🤷‍♂» не прочитался как «🤷».
  return [...options].sort((a, b) => b.emoji.length - a.emoji.length).find(o => t.includes(o.emoji))?.emoji;
}

/** Выборщик реакции: текст и набор → значок или undefined. Сменный; по умолчанию — общая служба «быстрое решение». */
export type ReactionChooser = (prompt: string, options: ReactionOption[], signal?: AbortSignal) => Promise<string | undefined>;

/** Запрос к службе «быстрое решение» (форма Decisions): один вопрос «выбор из списка». */
export function decideRequest(prompt: string, options: ReactionOption[]) {
  return { input: prompt, questions: [{ type: "choice", name: "reaction",
    instructions: "Выбери одну реакцию на сообщение.",
    choices: options.map(o => ({ value: o.emoji, description: o.meaning })) }] };
}

/**
 * Выбор через команду службы «быстрое решение» (`vallis-decide`): провайдера мост не знает. Службы нет, ошибка или
 * таймаут — undefined: остаётся «увидел».
 */
export function decideChooser(command = "vallis-decide", timeoutMs = 6000): ReactionChooser {
  return (prompt, options, signal) => new Promise(resolve => {
    const child = execFile(command, ["--timeout", String(Math.max(1, Math.floor(timeoutMs / 1000)))],
      { cwd: tmpdir(), timeout: timeoutMs + 1000, maxBuffer: 1 << 20, signal },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const answer = JSON.parse(String(stdout)).answers?.find((a: { name?: string }) => a.name === "reaction");
          const emoji = typeof answer?.choice === "string" ? answer.choice : undefined;
          resolve(emoji && options.some(o => o.emoji === emoji) ? emoji : undefined);
        } catch { resolve(undefined); }
      });
    child.stdin?.end(JSON.stringify(decideRequest(prompt, options)));
  });
}

type Tg = (method: string, body: Record<string, unknown>) => Promise<unknown>;

/** Одна реакция на сообщение; null — снять. Ошибка Telegram не мешает ходу. */
export async function react(tg: Tg, chatId: number, messageId: number, emoji: string | null) {
  try {
    await tg("setMessageReaction", { chat_id: chatId, message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [], is_big: false });
  } catch { /* a reaction must never stop the work */ }
}

/**
 * Приём сообщения: 👀 сразу, затем выбор модели (если успела раньше служебного значка — заменяет 👀).
 * `serviceSet()` — служебный значок уже поставлен этим сообщением: выбор модели его не затирает.
 */
export async function acknowledge(tg: Tg, chatId: number, messageId: number, text: string,
  chooser: ReactionChooser | undefined, options: ReactionOption[], serviceSet: () => boolean, earlier: string[] = [],
  signal?: AbortSignal) {
  await react(tg, chatId, messageId, SERVICE_REACTIONS.seen);
  if (!chooser || !text.trim()) return;
  const emoji = await chooser(reactionPrompt(text, options, earlier), options, signal).catch(() => undefined);
  if (emoji && emoji !== SERVICE_REACTIONS.seen && !serviceSet() && !signal?.aborted) await react(tg, chatId, messageId, emoji);
}

// ---------- Живое сообщение о работе (С46) ----------

type Item = { type?: string; command?: string; tool?: string; server?: string; queries?: string[];
  changes?: { path?: string }[] };

/** Шаг хода понятными словами, без названий команд; не выводится из события — общий ярлык. */
export function stepLabel(item: Item): string {
  const cmd = String(item.command ?? "").toLowerCase();
  const tool = `${item.server ?? ""} ${item.tool ?? ""}`.toLowerCase();
  const paths = (item.changes ?? []).map(c => String(c.path ?? "").toLowerCase()).join(" ");
  const any = `${cmd} ${tool} ${paths}`;
  if (item.type === "webSearch") return "Ищу в интернете…";
  if (/search-history|telegram.*(history|archive)|переписк/.test(any)) return "Ищу в переписке…";
  if (/rights|access|consent|permission|plugin config|settings|доступ/.test(any)) return "Смотрю настройки доступа…";
  if (/\.(xlsx|xls|csv|tsv)\b|sheets?|spreadsheet|таблиц/.test(any)) return "Читаю таблицу…";
  if (/gmail|mail|почт/.test(any)) return "Смотрю почту…";
  if (/calendar|календар/.test(any)) return "Смотрю календарь…";
  if (/yougile|tasks?\b|задач/.test(any)) return "Смотрю задачи…";
  if (/\bgit (log|diff|show|blame)|github|\bgh /.test(any)) return "Смотрю историю изменений…";
  if (/\bbb thread|threads?\b/.test(cmd)) return "Смотрю рабочие разговоры…";
  if (/voice-to-text|transcri/.test(any)) return "Расшифровываю запись…";
  if (/\.(pdf|docx?|md|txt)\b/.test(any) && item.type !== "fileChange") return "Читаю документ…";
  if (/\b(rg|grep|find|fd)\b/.test(cmd)) return "Ищу в файлах…";
  if (/\b(curl|wget|http)/.test(cmd)) return "Обращаюсь к сервису…";
  if (item.type === "fileChange") return "Правлю файлы…";
  if (item.type === "mcpToolCall" || item.type === "toolCall") return "Получаю данные…";
  if (item.type === "commandExecution") return "Выполняю шаг задачи…";
  return "Работаю над задачей…";
}

/** Первая строка реплики агента — его живое начало по сути задачи. */
export function firstLine(text: string): string {
  return text.split("\n").map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

/**
 * Текст живого сообщения: первая строка агента и текущий шаг. Гостевой тред — только ярлык (без текста агента,
 * чтобы в группу не ушло содержимое из других мест). Запасной шаблон — только если агент молчит дольше `quietMs`.
 */
export function progressText(o: { agentLine?: string; step?: string; guest?: boolean; startedAt: number; now?: number;
  quietMs?: number }): string | undefined {
  const line = o.guest ? "" : (o.agentLine ?? "");
  if (line && o.step) return `⏳ ${line}\n${o.step}`;
  if (line) return `⏳ ${line}`;
  if (o.step) return `⏳ ${o.step}`;
  return (o.now ?? Date.now()) - o.startedAt >= (o.quietMs ?? 8000) ? "⏳ Работаю над задачей…" : undefined;
}
