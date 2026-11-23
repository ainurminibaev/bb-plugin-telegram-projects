// С66: a thread bound to a Telegram chat or topic is named by the bridge after that place:
//   topic                «<тема> — группа «<короткое имя группы>»»   (General too: «General — группа «…»»)
//   group without topics «группа «<короткое имя группы>»»
//   a person's chat      «личка «<имя>»»
// The short name of a group is its setting (rights: shortName), by default the group's title. A renamed topic or group
// renames the thread. A title set by hand is kept: the bridge renames only a title it set itself, and in the one pass
// over threads bound before this version only a title it gave at the start (the topic's or the group's name, «Тема»).
// The assistant pair's threads (chat-pair: «имя · состояние · модель») are never touched.
import type { Store } from "./model";
import type { GroupTopicPolicy } from "./ingress";
import { forumName } from "./forum-defaults";
import { accessList, groupSettings } from "./rights";

export const TITLE_KEY = "thread-title:";          // the title the bridge last set, per thread
export const TITLES_PASS_KEY = "thread-titles:pass";
const PASS_VERSION = 1;

type Sdk = {
  threads: {
    get(args: { threadId: string }): Promise<{ title?: string | null; archivedAt?: unknown; deletedAt?: unknown }>;
    update(args: { threadId: string; title: string }): Promise<unknown>;
  };
};

const clean = (s: unknown) => typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() : "";

export const topicTitle = (topic: string, group: string) => `${topic} — группа «${group}»`;
export const groupTitle = (group: string) => `группа «${group}»`;
export const privateTitle = (name: string) => `личка «${name}»`;

/** The group's name for titles: its short name setting, else its title as the bot saw it. */
export function groupName(store: Store, bot: number, chat: number): string {
  const short = clean((groupSettings(store, bot, chat) as { shortName?: string } | undefined)?.shortName);
  return short || clean(store.get<{ title?: string }>(`visibility:${bot}:group:${chat}`)?.title);
}

/** The threads of the assistant pair: their titles are the pair's own. */
function pairThreads(store: Store): Set<string> {
  const ids = new Set<string>();
  for (const { value } of store.list<{ titles?: Record<string, string> }>("chat:pair:"))
    for (const id of Object.keys(value?.titles ?? {})) ids.add(id);
  return ids;
}

const isForum = (store: Store, bot: number, chat: number) =>
  store.list<GroupTopicPolicy>(`group:policy:${chat}:`).some(r => r.value.topicId > 0) ||
  store.list(`group:topic-name:${bot}:${chat}:`).length > 0;

type Wanted = { title: string; initial: string[] };

/** What each bound thread should be called, with the names it could have got at the start (for the one pass). */
export function wantedTitles(store: Store, bot: number, chat?: number): Map<string, Wanted> {
  const out = new Map<string, Wanted>();
  const pair = pairThreads(store);
  for (const { value: p } of store.list<GroupTopicPolicy>("group:policy:")) {
    if (!p?.threadId || p.botId !== bot || pair.has(p.threadId) || (chat !== undefined && p.chatId !== chat)) continue;
    if (p.privateChat) {
      const name = clean(accessList(store, bot).find(person => person.id === p.chatId)?.name);
      if (name) out.set(p.threadId, { title: privateTitle(name), initial: [name] });
      continue;
    }
    const group = groupName(store, bot, p.chatId);
    if (!group) continue;
    const title = clean(store.get<{ title?: string }>(`visibility:${bot}:group:${p.chatId}`)?.title);
    if (p.topicId > 0) {
      const topic = clean(forumName(store, bot, p.chatId, p.topicId));
      if (topic) out.set(p.threadId, { title: topicTitle(topic, group), initial: [topic, "Тема"] });
    } else if (isForum(store, bot, p.chatId)) {
      out.set(p.threadId, { title: topicTitle("General", group), initial: ["General", title, group] });
    } else {
      out.set(p.threadId, { title: groupTitle(group), initial: [title, group] });
    }
  }
  return out;
}

/**
 * Rename bound threads to their place. `chat` limits it to one group (its rename or its topic's). Only titles the
 * bridge set are changed; a thread never named by the bridge is renamed only when its title is one it got at the start.
 */
export async function applyThreadTitles(store: Store, sdk: Sdk, bot: number, chat?: number) {
  let renamed = 0;
  for (const [threadId, want] of wantedTitles(store, bot, chat)) {
    const last = store.get<string>(TITLE_KEY + threadId);
    let thread;
    try { thread = await sdk.threads.get({ threadId }); } catch { continue; }
    if (!thread || thread.archivedAt || thread.deletedAt) continue;
    const current = clean(thread.title);
    if (current === want.title) { if (last !== want.title) store.put(TITLE_KEY + threadId, want.title); continue; }
    const bridgeSet = last !== undefined ? current === last : !current || want.initial.includes(current);
    if (!bridgeSet) continue;                                     // named by hand: kept
    try {
      await sdk.threads.update({ threadId, title: want.title });
      store.put(TITLE_KEY + threadId, want.title);
      renamed++;
    } catch { /* a thread that cannot be renamed now keeps its name; the next event tries again */ }
  }
  return renamed;
}

/** The one pass over threads bound before this version: once per pass version. */
export async function threadTitlesPass(store: Store, sdk: Sdk, bot: number) {
  if ((store.get<number>(TITLES_PASS_KEY + ":" + bot) ?? 0) >= PASS_VERSION) return 0;
  store.put(TITLES_PASS_KEY + ":" + bot, PASS_VERSION);   // marked first: updates arriving meanwhile start no second pass
  return applyThreadTitles(store, sdk, bot);
}

/** A group's own rename (service message new_chat_title): the stored title follows it. True when it changed. */
export function rememberGroupTitle(store: Store, bot: number, update: any): number | undefined {
  const m = update?.message;
  const chat = m?.chat?.id;
  const title = clean(m?.new_chat_title);
  if (!title || !Number.isSafeInteger(chat)) return;
  const key = `visibility:${bot}:group:${chat}`;
  const seen = store.get<Record<string, unknown>>(key);
  if (!seen || seen.title === title) return;
  store.put(key, { ...seen, title });
  return chat;
}
