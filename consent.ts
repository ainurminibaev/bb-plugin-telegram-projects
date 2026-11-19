import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GroupTopicPolicy } from "./ingress";
import { TelegramFailure, type Store, type Telegram } from "./model";
import { accessList, senderRole } from "./rights";

/**
 * Consent for changes asked in a turn started by a group member without access.
 * The agent's provider raises a BB approval; the bridge turns it into a plain sentence for
 * the people with access who administer this group. The first answer wins. Without an
 * answer the request closes after the time limit and the group gets one line.
 */
type Card = { chat: number; message: number };
export type Consent = {
  interactionId: string;
  threadId: string;
  chatId: number;
  topicId: number;
  messageId: number;
  title: string;
  requester: string;
  what: string;
  kind: string;
  approvers: number[];
  cards: Card[];
  state: "pending" | "allowed" | "denied" | "expired" | "closed";
  expiresAt: number;
  decidedBy?: string;
};
type Job = { state: string; ownerId: number; route: { chatId: number; topicId: number; messageId: number; senderId: number; senderName?: string; threadId: string } };
type Interaction = { id: string; status?: string; payload?: any };
export type ConsentContext = {
  store: Store;
  sdk: Pick<BbPluginApi["sdk"], "threads">;
  bot: number;
  owner: number;
  tg: (chat: number) => Telegram;
  ttlMs: number;
  now?: () => number;
  signal?: AbortSignal;
};

const key = (id: string) => "rights:consent:" + id;

export function describeInteraction(payload: any): string {
  const subject = payload?.subject ?? {};
  if (payload?.kind === "approval") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    // The employee's guard hook writes what exactly would happen into the reason.
    const known = reason && !/^This command requires approval$/i.test(reason);
    if (subject.kind === "command")
      return known ? reason : "выполнить команду: " + String(subject.command ?? "").slice(0, 160);
    if (known) return reason;
    if (subject.kind === "file_change") return "изменить файлы в рабочей папке";
    if (subject.kind === "permission_grant") return "действие " + String(subject.toolName ?? "во внешнем сервисе");
    return "выполнить действие";
  }
  if (typeof payload?.kind === "string" && payload.kind.endsWith("mcp-elicitation")) {
    const data = payload.data ?? {};
    const params = (data.params ?? []).map((p: any) => `${p.label ?? p.name}=${String(p.value).slice(0, 60)}`).join(", ");
    return `действие ${data.toolName ?? "во внешнем сервисе"}${data.serverName ? " в " + data.serverName : ""}${params ? ": " + params : ""}`;
  }
  return String(payload?.title ?? "выполнить действие");
}

function cardText(c: Consent, now: number) {
  const time = new Date(now).toISOString().slice(11, 16);
  const head = `${c.requester} (может только спрашивать) в группе «${c.title}» просит: ${c.what}.`;
  if (c.state === "pending") return head + " Разрешить?";
  if (c.state === "allowed") return `${head}\nРазрешил ${c.decidedBy}, ${time} UTC.`;
  if (c.state === "denied") return `${head}\nОтказал ${c.decidedBy}, ${time} UTC.`;
  if (c.state === "expired") return `${head}\nНикто не ответил — запрос закрыт.`;
  return `${head}\nЗапрос уже решён в BB.`;
}

async function approversFor(ctx: ConsentContext, chat: number) {
  const people = [ctx.owner, ...accessList(ctx.store, ctx.bot).map((p) => p.id)];
  const admins: number[] = [];
  for (const id of [...new Set(people)].slice(0, 30)) {
    try {
      const m = await ctx.tg(chat)<{ status: string }>("getChatMember", { chat_id: chat, user_id: id });
      if (["creator", "administrator"].includes(m.status)) admins.push(id);
    } catch { /* not a member or unavailable */ }
  }
  return admins.length ? admins : [ctx.owner];
}

async function refreshCards(ctx: ConsentContext, c: Consent, now: number) {
  for (const card of c.cards) {
    await ctx.tg(card.chat)("editMessageText", { chat_id: card.chat, message_id: card.message, text: cardText(c, now) })
      .catch(() => {});
  }
}

async function resolve(ctx: ConsentContext, c: Consent, allow: boolean) {
  if (c.kind.endsWith("mcp-elicitation"))
    await ctx.sdk.threads.interactions.respond({ threadId: c.threadId, interactionId: c.interactionId, value: { action: allow ? "accept" : "decline" } });
  else
    await ctx.sdk.threads.interactions.resolve({ threadId: c.threadId, interactionId: c.interactionId,
      resolution: allow ? { decision: "allow_once", grantedPermissions: null } : { decision: "deny" } });
}

/** One pass: notice new requests from strangers' turns, close expired or settled ones. */
export async function watchConsents(ctx: ConsentContext) {
  const now = ctx.now ?? Date.now;
  const threads = new Map<string, GroupTopicPolicy>();
  for (const { value } of ctx.store.list<GroupTopicPolicy>("group:policy:"))
    if (value.botId === ctx.bot && !value.isolated && value.threadId) threads.set(value.threadId, value);
  for (const [threadId, policy] of threads) {
    if (ctx.signal?.aborted) return;
    let pending: Interaction[];
    try {
      pending = ((await ctx.sdk.threads.interactions.list({ threadId, signal: ctx.signal })) as Interaction[])
        .filter((i) => !i.status || i.status === "pending");
    } catch { continue; }
    const open = new Set(pending.map((i) => i.id));
    for (const i of pending) {
      if (ctx.store.get(key(i.id))) continue;
      const job = ctx.store.list<Job>(`group:in:${ctx.bot}:`).map((j) => j.value)
        .filter((j) => j.state === "submitted" && j.route.threadId === threadId && j.ownerId === ctx.owner)
        .sort((a, b) => b.route.messageId - a.route.messageId)[0];
      if (!job) continue; // Not a group turn: BB itself shows the request to the owner.
      if (senderRole(ctx.store, ctx.bot, ctx.owner, job.route.chatId, job.route.senderId) === "access") continue;
      const member = job.route.senderName ? undefined : await ctx.tg(job.route.chatId)<{ user?: { first_name?: string; last_name?: string } }>(
        "getChatMember", { chat_id: job.route.chatId, user_id: job.route.senderId }).catch(() => undefined);
      const c: Consent = {
        interactionId: i.id, threadId, chatId: job.route.chatId, topicId: job.route.topicId, messageId: job.route.messageId,
        title: ctx.store.get<{ title?: string }>(`visibility:${ctx.bot}:group:${job.route.chatId}`)?.title ?? String(policy.chatId),
        requester: job.route.senderName || [member?.user?.first_name, member?.user?.last_name].filter(Boolean).join(" ") || "Участник",
        what: describeInteraction(i.payload), kind: String(i.payload?.kind ?? ""),
        approvers: await approversFor(ctx, job.route.chatId), cards: [], state: "pending", expiresAt: now() + ctx.ttlMs,
      };
      ctx.store.put(key(i.id), c);
      for (const person of c.approvers) {
        try {
          const sent = await ctx.tg(person)<{ message_id: number }>("sendMessage", {
            chat_id: person, text: cardText(c, now()),
            reply_markup: { inline_keyboard: [[
              { text: "✅ Разрешить", callback_data: `rc:y:${i.id}` },
              { text: "❌ Отказать", callback_data: `rc:n:${i.id}` }]] },
          });
          c.cards.push({ chat: person, message: sent.message_id });
        } catch { /* the person has not started the bot */ }
      }
      ctx.store.put(key(i.id), c);
    }
    for (const { value: c } of ctx.store.list<Consent>("rights:consent:")) {
      if (c.threadId !== threadId || c.state !== "pending") continue;
      if (!open.has(c.interactionId)) {
        c.state = "closed";
        ctx.store.put(key(c.interactionId), c);
        await refreshCards(ctx, c, now());
      } else if (now() >= c.expiresAt) {
        c.state = "expired";
        ctx.store.put(key(c.interactionId), c);
        await resolve(ctx, c, false).catch(() => {});
        await refreshCards(ctx, c, now());
        await ctx.tg(c.chatId)("sendMessage", {
          chat_id: c.chatId, message_thread_id: c.topicId || undefined,
          reply_parameters: { message_id: c.messageId, allow_sending_without_reply: true },
          text: "Для этого нужна отмашка того, кто может мне поручать. Запрос закрыт.",
        }).catch(() => {});
      }
    }
  }
}

/** Handles «Разрешить / Отказать»; returns true when the update was a consent answer. */
export async function handleConsentCallback(ctx: ConsentContext, update: any) {
  const cb = update?.callback_query;
  const m = /^rc:([yn]):(.+)$/.exec(cb?.data ?? "");
  if (!m) return false;
  const answer = (text: string) => ctx.tg(cb.from.id)("answerCallbackQuery", { callback_query_id: cb.id, text }).catch(() => {});
  const c = ctx.store.get<Consent>(key(m[2]));
  if (!c || !c.approvers.includes(cb.from.id)) {
    await answer("Этот запрос вам не адресован.");
    return true;
  }
  if (c.state !== "pending") {
    await answer("Запрос уже закрыт.");
    return true;
  }
  const allow = m[1] === "y";
  c.state = allow ? "allowed" : "denied";
  c.decidedBy = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ") || String(cb.from.id);
  ctx.store.put(key(c.interactionId), c);
  try {
    await resolve(ctx, c, allow);
  } catch (error) {
    if (!(error instanceof TelegramFailure)) {
      c.state = "closed";
      ctx.store.put(key(c.interactionId), c);
    }
  }
  await refreshCards(ctx, c, (ctx.now ?? Date.now)());
  await answer(allow ? "Разрешено." : "Отказано.");
  return true;
}
