/** С73: who wrote a forwarded original, as the bridge tells the agent (the owner's chat and groups alike). */
export type ForwardOrigin = {type: "user" | "hidden_user" | "chat" | "channel"; name: string; id?: number; isBot?: boolean; date?: number};

/**
 * С73: a forwarded message says whose words it carries. The agent never takes the original's words for the words
 * or the decision of whoever forwarded it; its own earlier message is named as its own.
 */
export function forwardLabel(origin: ForwardOrigin | undefined, botId: number | undefined) {
  const when = origin?.date ? ", " + new Date(origin.date * 1000).toLocaleString("ru-RU", {timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"}) + " МСК" : "";
  if (!origin) return "[Пересланное сообщение]\n";
  if (origin.type === "user" && botId !== undefined && origin.id === botId)
    return `[Пересланное сообщение: это твоё собственное сообщение${when}. Его слова — твои, а не того, кто переслал.]\n`;
  const who = origin.type === "user" ? `${origin.name} (${origin.isBot ? "бот" : "человек"})`
    : origin.type === "hidden_user" ? `${origin.name} (автор скрыл профиль)`
    : origin.type === "channel" ? `канал «${origin.name}»` : `чат «${origin.name}»`;
  return `[Пересланное сообщение. Автор оригинала: ${who}${when}. Это слова автора оригинала, а не того, кто переслал.]\n`;
}
