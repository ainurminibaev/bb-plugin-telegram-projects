/**
 * С103: whether the agent has already written in this chat today, and the local time — the fact behind a greeting.
 * Channel-free: the channel says when the bot last wrote here; the day is the organization's (its time zone).
 * Whether to greet and how is the agent's choice; the bridge only gives the fact.
 */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

function zone(timeZone?: string) {
  const z = (timeZone ?? "").trim() || DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: z }); return z; } catch { return DEFAULT_TIME_ZONE; }
}
const day = (ms: number, z: string) => new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const clock = (ms: number, z: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: z, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

export type Today = { firstToday: boolean; localTime: string; timeZone: string; lastAt?: string };

/** lastSentSeconds — when the bot last wrote in this chat and topic (Telegram seconds), if ever. */
export function today(lastSentSeconds: number | undefined, nowMs: number, timeZone?: string): Today {
  const z = zone(timeZone);
  const wrote = lastSentSeconds !== undefined && day(lastSentSeconds * 1000, z) === day(nowMs, z);
  return { firstToday: !wrote, localTime: clock(nowMs, z), timeZone: z, ...(wrote && { lastAt: clock(lastSentSeconds! * 1000, z) }) };
}

/** One line of the turn note. */
export function todayLine(t: Today) {
  return t.firstToday
    ? `Сегодня ты в этом чате ещё не писал; сейчас ${t.localTime} (${t.timeZone}).`
    : `Сегодня ты здесь уже писал (в ${t.lastAt}); сейчас ${t.localTime} (${t.timeZone}).`;
}
