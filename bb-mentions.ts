import type {Store} from "./model";
import {installKind} from "./rights";

// A person in Telegram talks to the agent, not to BB (owner, 22.11.2026). One bridge setting decides
// whether the owner sees links and mentions of BB: "auto" follows the install kind (an employee — off,
// a personal assistant, which manages BB, — on). Guests never get these texts: they go only to the owner.

export type BbMentionsSetting = "auto" | "on" | "off";

export function bbMentionsOn(store: Store, setting: BbMentionsSetting | undefined) {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return installKind(store) === "assistant";
}

/** Buttons that only open BB; without BB mentions they are not shown. */
export const BB_BUTTONS = new Set(["Открыть чат в BB", "Открыть BB", "Открыть в BB", "Чат BB"]);

const EXACT: Record<string, string> = {
  "Рабочий тред завершился. Подтверждение передачи результата помощнику пока не пришло. История задачи сохранена в BB.":
    "Работа по поручению закончилась, но её итог пока не дошёл до меня. Проверю и напишу.",
  "Рабочий тред завершился. BB исчерпал попытки передать его результат помощнику. Результат сохранён в истории рабочего треда.":
    "Работа по поручению закончилась, но её итог не удалось получить. Он сохранён, могу пересказать по просьбе.",
  "✅ Бот привязан к BB. Темы проектов появятся в этом чате в течение минуты.":
    "✅ Бот подключён. Темы проектов появятся в этом чате в течение минуты.",
  "⚠️ BB был перезапущен во время обработки сообщения. Исход действия не подтверждён. Открой /chats и проверь чат перед повторной отправкой.":
    "⚠️ Я перезапускался во время обработки сообщения, исход действия не подтверждён. Проверь /chats перед повтором.",
  "⚠️ Не удалось подтвердить действие. Проверь /status и /chats перед повтором; подробности доступны в BB.":
    "⚠️ Не удалось подтвердить действие. Проверь /status и /chats перед повтором.",
  "по умолчанию BB": "по умолчанию",
  "По умолчанию BB": "По умолчанию",
  "🤖 Агент для нового чата. Его модели берутся из настроек BB.": "🤖 Агент для нового чата.",
  "Сообщение в очереди. Помощник получит его, когда BB разрешит продолжить.":
    "Сообщение в очереди. Помощник получит его, как только сможет продолжить.",
  "Отправь текст или голосовое сообщение. Вложения пока открывай в BB.": "Отправь текст или голосовое сообщение.",
  "В чате есть вопрос. Ответь через кнопку или ответом на его карточку. Если форма сложная — открой BB.":
    "В чате есть вопрос. Ответь через кнопку или ответом на его карточку.",
  "📨 Сообщение принято BB. Ответ придёт сюда.\n/stop — остановить, /menu — текущий чат.":
    "📨 Сообщение принято. Ответ придёт сюда.\n/stop — остановить, /menu — текущий чат.",
  "Команда остановки отправлена BB.": "Остановка принята.",
  "Для этого вопроса выбери кнопку или открой BB.": "Для этого вопроса выбери кнопку.",
  "\n\nНесколько вопросов: открой форму в BB.": "\n\nЗдесь несколько вопросов: ответь, пожалуйста, текстом по каждому.",
  "Эта форма открывается в BB.": "Ответь, пожалуйста, текстом.",
  "⚠️ Запуск завершился ошибкой. Подробности в BB.": "⚠️ Запуск завершился ошибкой.",
  " — в BB.": ".",
  "окружение BB": "окружение",
  "Для этой машины ещё не настроена папка проекта в BB. Добавь источник проекта и повтори выбор сервера.":
    "Для этой машины ещё не настроена папка проекта. Добавь её и повтори выбор сервера.",
  "Запрос уже решён в BB.": "Запрос уже решён.",
  "Откройте исходную личку, связанную с BB.": "Откройте исходную личку владельца.",
};
// Parts of long menu texts.
const PARTS: [string, string][] = [
  ["Рабочее пространство BB", "Рабочее пространство"],
  ["управление чатом BB", "управление чатом"],
  ["чаты BB", "чаты"],
  ["чат BB", "чат"],
  ["тред BB", "тред"],
  ["проекта BB", "проекта"],
  ["Машина BB", "Машина"],
  ["в BB остаются", "остаются"],
];

/** The same text without BB: exact replacements first, then parts of longer texts. */
export function withoutBB(text: string) {
  if (BB_BUTTONS.has(text)) return "";
  let out = EXACT[text] ?? text;
  for (const [from, to] of PARTS) out = out.split(from).join(to);
  return out;
}

const EXACT_EN: Record<string, string> = {
  "The worker thread finished. Delivery to the assistant has not been confirmed. The task history is available in BB.":
    "The work on the task finished, but its result has not reached me yet. I will check and write.",
  "The worker thread finished. BB exhausted its attempts to deliver the result to the assistant. The result is in the worker thread history.":
    "The work on the task finished, but its result could not be received. It is kept; I can retell it on request.",
  "✅ The bot is linked to BB. Project topics will appear in this chat within a minute.":
    "✅ The bot is connected. Project topics will appear in this chat within a minute.",
  "⚠️ BB restarted while processing the message. The outcome is unconfirmed. Open /chats and check before sending again.":
    "⚠️ I restarted while processing the message; the outcome is unconfirmed. Check /chats before sending again.",
  "⚠️ Could not confirm the action. Check /status and /chats before retrying; details are available in BB.":
    "⚠️ Could not confirm the action. Check /status and /chats before retrying.",
  "🤖 Agent for the new chat. Models come from BB settings.": "🤖 Agent for the new chat.",
  "Could not transcribe the recording. Send text or check BB transcription settings. Limit: 10 minutes and 15 MB.":
    "Could not transcribe the recording. Please send text. Limit: 10 minutes and 15 MB.",
  "Your message is queued. The assistant will receive it when BB can continue.":
    "Your message is queued. The assistant will receive it as soon as it can continue.",
  "Send text or a voice message. Open attachments in BB for now.": "Send text or a voice message.",
  "The chat has a question. Use a button or reply to its card. Open BB for complex forms.":
    "The chat has a question. Use a button or reply to its card.",
  "📨 BB received your message. The reply will arrive here.\n/stop — stop; /menu — current chat.":
    "📨 Message received. The reply will arrive here.\n/stop — stop; /menu — current chat.",
  "Stop request sent to BB.": "Stop accepted.",
  "Choose a button or open BB for this question.": "Choose a button for this question.",
  "\n\nMultiple questions: open the form in BB.": "\n\nSeveral questions here: please answer each in text.",
  "Open this form in BB.": "Please answer in text.",
  "⚠️ The run failed. See details in BB.": "⚠️ The run failed.",
  " — in BB.": ".",
  "This machine has no project folder configured in BB yet. Add a project source and select the server again.":
    "This machine has no project folder configured yet. Add it and select the server again.",
};
const PARTS_EN: [string, string][] = [
  ["🧭 BB workspace", "🧭 Workspace"], ["Project topics hold BB chats", "Project topics hold chats"],
  ["Project topics contain BB chats", "Project topics contain chats"], ["BB chat controls", "chat controls"],
  ["BB chats", "chats"], ["BB default", "Default"], ["BB environment", "environment"],
];

/** The English text without BB, for an English bridge. Buttons that only open BB become empty. */
export function withoutBBEn(text: string) {
  if (["Open chat in BB", "Open BB", "Open in BB", "BB chat"].includes(text)) return "";
  let out = EXACT_EN[text] ?? text;
  for (const [from, to] of PARTS_EN) out = out.split(from).join(to);
  return out;
}

/** The bridge's text function with the BB setting applied. */
export function bbText(translate: (s: string) => string, language: string, on: boolean, s: string) {
  if (on) return translate(s);
  return language === "en" ? withoutBBEn(translate(s)) : translate(withoutBB(s));
}
