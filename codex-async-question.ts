import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Threads = BbPluginApi["sdk"]["threads"];
type Interaction = Awaited<ReturnType<Threads["interactions"]["get"]>>;

const questionData = z.object({
  questions: z.array(z.object({
    title: z.string().min(1),
    options: z.array(z.string().min(1)).nullable().default(null),
  })).min(1),
});

export function codexAsyncQuestions(interaction: Interaction) {
  if (interaction.payload?.kind !== "plugin" || interaction.origin?.kind !== "plugin" ||
      interaction.origin.pluginId !== "provider-codex" || interaction.origin.rendererId !== "async-question")
    return undefined;
  return questionData.safeParse(interaction.payload.data).data?.questions;
}

export function interactionOpen(interaction: Interaction) {
  return interaction.status === "pending" &&
    (interaction.expiresAt == null || interaction.expiresAt > Date.now());
}

export function codexAsyncAnswer(questions: NonNullable<ReturnType<typeof codexAsyncQuestions>>,
  answer: {option: string} | {text: string}): Parameters<Threads["interactions"]["respond"]>[0]["value"] | undefined {
  if (questions.length !== 1) return undefined;
  if ("text" in answer) return {answers: {"question-1": {selected: [], freeText: answer.text}}};
  const choices = questions[0].options ?? [];
  const selected = choices.map((_, index) => "option-" + (index + 1)).find(value => value === answer.option);
  if (selected) return {answers: {"question-1": {selected: [selected]}}};
}

// Codex's plugin form does not carry its source item or turn ID. Match only a
// unique question emission before the form opened, inside one recorded turn.
// Ambiguous, delayed across an unobserved start, or incomplete history stays in BB.
export async function codexAsyncQuestionTurn(threads: Threads, threadId: string, interaction: Interaction,
  questions: NonNullable<ReturnType<typeof codexAsyncQuestions>>, signal: AbortSignal) {
  const signature = JSON.stringify(questions);
  let beforeSeq: string | undefined;
  let awaitingStart = false;
  const acceptedTurns = new Set<string>();
  let turnId: string | undefined;
  for (let page = 0; page < 10; page++) {
    const events = await threads.events.list({
      threadId, beforeSeq, order: "desc", limit: "100", signal,
      types: ["thread/extensionState/updated", "turn/started", "turn/input/accepted", "turn/completed"],
    });
    for (const event of events) {
      if (event.createdAt > interaction.createdAt) continue;
      if (event.type === "thread/extensionState/updated" && event.data.kind === "provider-codex/async-question") {
        const emission = questionData.safeParse(event.data.payload);
        if (emission.success && JSON.stringify(emission.data.questions) === signature) {
          if (awaitingStart || turnId) return undefined;
          awaitingStart = true;
        }
      } else if (awaitingStart) {
        if (event.type === "turn/completed") return undefined;
        if (event.type === "turn/input/accepted" && event.scope.kind === "turn")
          acceptedTurns.add(event.scope.turnId);
        if (event.type === "turn/started" && event.scope.kind === "turn") {
          if (!acceptedTurns.has(event.scope.turnId)) return undefined;
          turnId = event.scope.turnId;
          awaitingStart = false;
        }
      }
    }
    if (events.length < 100) return turnId;
    beforeSeq = String(events[events.length - 1].seq);
  }
  return undefined;
}

/** The note to the agent about questions still open (or just closed) when the person wrote in words. */
export function openQuestionsNote(open: readonly Interaction[], closedOne: boolean) {
  const title = (i: any) => String(i.payload?.questions?.[0]?.question ?? i.payload?.questions?.[0]?.title ??
    i.payload?.title ?? i.payload?.reason ?? i.payload?.description ?? i.payload?.kind ?? "вопрос").replace(/\s+/g, " ").slice(0, 120);
  if (!closedOne && open.length === 1 && (open[0] as any).payload?.kind === "approval")
    return `[Служебно: открыт твой запрос разрешения «${title(open[0])}» — человек ответил словами, а не кнопкой; его слова выше. Словами разрешение не выдаётся и не отклоняется — запрос остаётся открытым. Человеку не пересказывай служебное.]`;
  return closedOne
    ? `[Служебно: твой вопрос «${title(open[0])}» закрыт — человек ответил словами, а не кнопкой; его слова выше. Реши сам, нужен ли вопрос снова. Человеку об этом не пиши.]`
    : `[Служебно: открыты твои вопросы: ${open.map(i => "«" + title(i) + "»").join(", ")}. Человек написал словами, а не кнопкой; его слова выше — пойми, к какому вопросу они, или ответь по сути.]`;
}
