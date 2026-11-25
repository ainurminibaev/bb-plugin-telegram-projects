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
  await reactByMeaning(tg, chatId, messageId, text, chooser, options, serviceSet, earlier, signal);
}

/** The reaction by meaning, chosen from the text (a voice — from its transcript, once it is ready); 👀 stays otherwise. */
export async function reactByMeaning(tg: Tg, chatId: number, messageId: number, text: string,
  chooser: ReactionChooser | undefined, options: ReactionOption[], serviceSet: () => boolean, earlier: string[] = [],
  signal?: AbortSignal) {
  if (!chooser || !text.trim()) return;
  const emoji = await chooser(reactionPrompt(text, options, earlier), options, signal).catch(() => undefined);
  if (emoji && emoji !== SERVICE_REACTIONS.seen && !serviceSet() && !signal?.aborted) await react(tg, chatId, messageId, emoji);
}

// ---------- Живое сообщение о работе (С46) ----------

type Item = { type?: string; command?: string; tool?: string; server?: string; queries?: string[];
  changes?: { path?: string }[] };

/**
 * Второстепенная строка хода — только понятное человеку действие из короткого списка. Служебная механика (разговоры
 * BB, очереди, расписания, настройки, доступы, команды, код) в строку не попадает: undefined.
 */
export function stepLabel(item: Item): string | undefined {
  const cmd = String(item.command ?? "").toLowerCase();
  const tool = `${item.server ?? ""} ${item.tool ?? ""}`.toLowerCase();
  const paths = (item.changes ?? []).map(c => String(c.path ?? "").toLowerCase()).join(" ");
  const any = `${cmd} ${tool} ${paths}`;
  if (item.type === "webSearch") return "Ищу в интернете…";
  if (/search-history|telegram.*(history|archive)|переписк/.test(any)) return "Ищу в переписке…";
  if (/\bbb (thread|automation|schedule|plugin|settings|agents?)\b|rights|access|consent|permission|queue|cron/.test(any))
    return undefined;
  if (/voice-to-text|transcri/.test(any)) return "Расшифровываю запись…";
  if (/gmail|mail|почт/.test(any)) return "Смотрю почту…";
  if (/calendar|календар/.test(any)) return "Смотрю календарь…";
  if (/\.(xlsx|xls|csv|tsv)\b|spreadsheet|sheets?\b|таблиц/.test(any)) return "Читаю таблицу…";
  if (/\.(pdf|docx?|txt)\b/.test(any) && item.type !== "fileChange") return "Читаю файл…";
  return undefined;
}

/** Первая строка реплики агента — его живое начало по сути задачи. */
export function firstLine(text: string): string {
  return text.split("\n").map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

/** Главная строка, если агент сам за несколько секунд не написал, что делает по сути: нейтрально, без инструментов. */
export const THINKING = "Думаю над ответом…";

/**
 * Текст живого сообщения (С46). Главная строка — слова самого агента о сути просьбы; молчит дольше `quietMs` —
 * нейтральное «Думаю над ответом…». Понятное человеку действие — второй строкой. Гостевой тред — без текста агента,
 * чтобы в группу не ушло содержимое из других мест.
 */
export function progressText(o: { agentLine?: string; step?: string; guest?: boolean; startedAt: number; now?: number;
  quietMs?: number }): string | undefined {
  const line = (o.guest ? "" : (o.agentLine ?? "")) ||
    ((o.now ?? Date.now()) - o.startedAt >= (o.quietMs ?? 4000) ? THINKING : "");
  if (!line) return undefined;
  return o.step ? `⏳ ${line}\n${o.step}` : `⏳ ${line}`;
}

/** С56: «Голосовое (3 мин 12 с): » — the length goes with the transcript, so a long one is handled as such. */
export function voiceHeader(seconds: number | undefined, label = "Голосовое"): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (!s) return label + ": ";
  return `${label} (${s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`}): `;
}

/** A choice from any list through the quick decision service: the value, or undefined (no service, error, off-list). */
export function decideChoice(command = "vallis-decide", timeoutMs = 6000) {
  return (input: string, instructions: string, choices: { value: string; description?: string }[], signal?: AbortSignal) =>
    new Promise<string | undefined>(resolve => {
      const child = execFile(command, ["--timeout", String(Math.max(1, Math.floor(timeoutMs / 1000)))],
        { cwd: tmpdir(), timeout: timeoutMs + 1000, maxBuffer: 1 << 20, signal }, (error, stdout) => {
          if (error) return resolve(undefined);
          try {
            const value = JSON.parse(String(stdout)).answers?.[0]?.choice;
            resolve(typeof value === "string" && choices.some(c => c.value === value) ? value : undefined);
          } catch { resolve(undefined); }
        });
      child.stdin?.end(JSON.stringify({ input, questions: [{ type: "choice", name: "choice", instructions, choices }] }));
    });
}

type IconSticker = { emoji?: string; custom_emoji_id?: string };

/**
 * С58: a topic picked up or created by the bridge gets a standard topic icon that fits its name. An icon a person
 * already set is kept; no quick decision service or no right to manage topics — nothing changes, silently.
 */
export async function chooseTopicIcon(tg: Tg, chatId: number, topicId: number, name: string, existingIcon: string | undefined,
  choose: ReturnType<typeof decideChoice> | undefined, signal?: AbortSignal) {
  if (existingIcon || !choose || !name.trim()) return undefined;
  try {
    const stickers = await tg("getForumTopicIconStickers", {}) as IconSticker[];
    const choices = (Array.isArray(stickers) ? stickers : []).filter(s => s.custom_emoji_id && s.emoji)
      .slice(0, 255).map(s => ({ value: s.custom_emoji_id!, description: s.emoji! }));
    if (choices.length < 2) return undefined;
    const icon = await choose("Название темы: «" + name.slice(0, 128) + "»",
      "Выбери значок темы, который лучше всего подходит к её названию.", choices, signal);
    if (!icon) return undefined;
    await tg("editForumTopic", { chat_id: chatId, message_thread_id: topicId, icon_custom_emoji_id: icon });
    return icon;
  } catch { return undefined; }   // no right to manage topics, a gone topic: leave it as it is
}
