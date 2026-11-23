// С71: the owner switches the model and the provider of a group or topic conversation with one command, as in the
// private chat (/model there). `/model` shows the current one and the choices; `/model <модель>` changes the model of
// this conversation's thread; `/model <исполнитель> [модель]` moves the conversation to a new thread of that provider
// (a thread keeps its provider in BB, as in the private chat a new provider means a new chat). It acts from the next
// message, only for the owner, and only for this topic: other topics keep theirs.
import type { Store } from "./model";
import type { GroupTopicPolicy } from "./ingress";
import { messageTopic } from "./ingress";
import { bindGroupTopic } from "./group-worker";

type Thread = { id: string; projectId: string; environmentId?: string | null; providerId?: string | null; model?: string | null;
  status?: string; archivedAt?: unknown; deletedAt?: unknown };
export type ModelSdk = {
  threads: {
    get(args: { threadId: string }): Promise<Thread>;
    update(args: { threadId: string; model: string }): Promise<unknown>;
    spawn(args: Record<string, unknown>): Promise<{ id: string; projectId: string }>;
  };
  providers: {
    list(args: { environmentId: string }): Promise<{ id: string; displayName?: string }[]>;
    models(args: { providerId: string; environmentId: string }): Promise<{ models: { model: string; displayName?: string }[];
      modelLoadError?: unknown }>;
  };
};
type Send = (text: string) => Promise<unknown>;

const COMMAND = /^\/model(?:@(\w+))?(?:\s+([\s\S]*))?$/i;

/** The command for this bot in this message, or undefined (not a /model command, another bot's). */
export function parseModelCommand(text: unknown, botUsername: string) {
  const m = typeof text === "string" ? text.trim().match(COMMAND) : null;
  if (!m || (m[1] && m[1].toLowerCase() !== botUsername.toLowerCase())) return;
  return (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
}

const said = (p: { id: string; displayName?: string } | undefined, id: string) => p?.displayName || id;

/**
 * Handle `/model` in a bound group or topic. True when the message was the command (answered or ignored);
 * false — not this command here, the message goes on as usual.
 */
export async function groupModelCommand(o: { store: Store; sdk: ModelSdk; owner: number; bot: number;
  send: (chat: number, topic: number) => Send; update: any }): Promise<boolean> {
  const m = o.update?.message;
  if (!m || !["group", "supergroup"].includes(m.chat?.type) || !Number.isSafeInteger(m.chat?.id)) return false;
  if (typeof m.text !== "string" || !/^\/model\b/i.test(m.text.trim())) return false;
  const topic = messageTopic(m);
  const policy = o.store.get<GroupTopicPolicy>(`group:policy:${m.chat.id}:${topic}`);
  if (!policy?.threadId || policy.botId !== o.bot) return false;
  const args = parseModelCommand(m.text, policy.botUsername);
  if (!args) return false;
  // Only the owner, writing himself: anyone else's /model is swallowed silently (no agent turn, no answer).
  if (m.from?.id !== o.owner || m.from?.is_bot || m.sender_chat || m.forward_origin || m.forward_date) return true;
  const send = o.send(m.chat.id, topic);
  try {
    const thread = await o.sdk.threads.get({ threadId: policy.threadId });
    if (!thread || thread.archivedAt || thread.deletedAt || !thread.environmentId) {
      await send("Разговор этой темы сейчас недоступен — модель не сменить.");
      return true;
    }
    const environmentId = thread.environmentId;
    const providers = await o.sdk.providers.list({ environmentId });
    const provider = thread.providerId ?? "";
    const models = async (providerId: string) => {
      const c = await o.sdk.providers.models({ providerId, environmentId });
      if (c.modelLoadError) throw Error("models_unavailable");
      return c.models;
    };
    if (!args.length) {
      const own = await models(provider).catch(() => []);
      const others = providers.filter(p => p.id !== provider).map(p => p.id);
      await send([
        `Сейчас: ${said(providers.find(p => p.id === provider), provider)} · ${thread.model || "по умолчанию"}`,
        own.length ? `Модели: ${own.slice(0, 20).map(x => x.model).join(", ")}` : "",
        others.length ? `Другие исполнители: ${others.join(", ")}` : "",
        "Сменить: /model <модель> или /model <исполнитель> [модель]. Действует со следующего сообщения, только в этой теме.",
      ].filter(Boolean).join("\n"));
      return true;
    }
    if (thread.status && !["idle", "error", "completed"].includes(thread.status)) {
      await send("Сейчас идёт ответ. Повторите команду после него.");
      return true;
    }
    const [first, second] = args;
    const asProvider = providers.find(p => p.id.toLowerCase() === first.toLowerCase());
    if (!asProvider || asProvider.id === provider) {
      // A model of the current provider.
      const model = asProvider ? second : first;
      if (!model) { await send(`Исполнитель уже ${said(asProvider, provider)}. Укажите модель: /model <модель>.`); return true; }
      const list = await models(provider);
      if (!list.some(x => x.model === model)) {
        await send(`Нет такой модели у ${said(providers.find(p => p.id === provider), provider)}. Есть: ${list.slice(0, 20).map(x => x.model).join(", ")}`);
        return true;
      }
      await o.sdk.threads.update({ threadId: thread.id, model });
      await send(`Готово: ${said(providers.find(p => p.id === provider), provider)} · ${model} — со следующего сообщения.`);
      return true;
    }
    // Another provider: a new thread of that provider in the same project and environment takes this topic.
    if (policy.isolated) { await send("У этой темы отдельный исполнитель — сменить можно только модель."); return true; }
    const list = await models(asProvider.id);
    const model = second;
    if (model && !list.some(x => x.model === model)) {
      await send(`Нет такой модели у ${said(asProvider, asProvider.id)}. Есть: ${list.slice(0, 20).map(x => x.model).join(", ")}`);
      return true;
    }
    const child = await o.sdk.threads.spawn({ projectId: thread.projectId, visibility: "visible",
      environment: { type: "reuse", environmentId }, providerId: asProvider.id, ...(model && { model }),
      permissionMode: "accept-edits",
      input: [{ type: "text", visibility: "agent-only", mentions: [],
        text: "Initialize a Telegram topic conversation moved from another provider. Wait for a Telegram request and reply NO_REPLY." }] });
    if (child.projectId !== thread.projectId) throw Error("thread_unconfirmed");
    const current = o.store.get<GroupTopicPolicy>(`group:policy:${m.chat.id}:${topic}`);
    if (current?.threadId !== policy.threadId || current.revision !== policy.revision) {
      await send("Тема за это время изменилась — повторите команду.");
      return true;
    }
    bindGroupTopic(o.store, { ...policy, threadId: child.id, revision: crypto.randomUUID() }, thread.projectId);
    await send(`Готово: ${said(asProvider, asProvider.id)}${model ? " · " + model : ""} — со следующего сообщения. ` +
      "Это новый разговор: прежний остался в BB с его историей.");
  } catch {
    await send("Не получилось сменить модель. Попробуйте ещё раз позже.").catch(() => undefined);
  }
  return true;
}
