import type {Store} from "./model";
import {TelegramFailure} from "./model";

/**
 * Telegram keeps a document under its own spelling of the name: runs of spaces (and spaces around «_») become one «_».
 * The receipt compares names the way Telegram stores them; a different spelling is not a failed delivery.
 */
export function sameTelegramFilename(sent:string,stored:string) {
  const norm=(name:string)=>name.normalize("NFC").replace(/[\s_]+/gu,"_").replace(/^_+|_+$/g,"");
  return norm(sent)===norm(stored);
}

/**
 * What became of one Telegram call (unknown ≠ not delivered):
 * - rejected  — Telegram answered with a refusal, nothing was posted: the same may be sent again;
 * - delivered — Telegram answered «ok»: posted, even when the bridge's check of the answer did not agree;
 * - unknown   — no answer (network, timeout, a broken or 5xx answer): it may well have been posted.
 */
export type SendOutcome = "rejected"|"delivered"|"unknown";
export function sendOutcome(error:unknown):SendOutcome {
  if (error instanceof TelegramFailure) return error.ambiguous && !error.notSent ? "unknown" : "rejected";
  const message=error instanceof Error ? error.message : String(error);
  if (/^(unconfirmed_album|outbound_receipt_missing)/.test(message)) return "delivered";
  return "rejected";   // nothing reached Telegram (a file that cannot be read, a bad argument)
}

/** A repeat of the same files to the same place within this time is taken for a repeat (not sent without --again). */
export const REPEAT_WINDOW_MS=15*60_000;
type Recent = {at:number; outcome:"delivered"|"unknown"; name:string};
const prefix=(bot:number,chat:number,topic:number)=>`send:recent-file:${bot}:${chat}:${topic}:`;

export function rememberSentFiles(store:Store,bot:number,chat:number,topic:number,
  files:{sha256:string;name:string}[],outcome:Recent["outcome"],now=Date.now()) {
  for (const {key,value} of store.list<Recent>(`send:recent-file:${bot}:`))
    if (now-value.at>REPEAT_WINDOW_MS) store.del(key);
  for (const file of files) store.put(prefix(bot,chat,topic)+file.sha256,{at:now,outcome,name:file.name} satisfies Recent);
}

/** The files of this send that already went (or may have gone) to the same place a short while ago. */
export function recentlySentFiles(store:Store,bot:number,chat:number,topic:number,
  files:{sha256:string;name:string}[],now=Date.now()) {
  return files.flatMap(file=>{
    const row=store.get<Recent>(prefix(bot,chat,topic)+file.sha256);
    return row && now-row.at<=REPEAT_WINDOW_MS ? [{...row,name:file.name,minutes:Math.max(1,Math.round((now-row.at)/60_000))}] : [];
  });
}

/** The answer to the agent when a send did not end cleanly: never «send again» when it may have gone. */
export function unsettledSendText(args:{went:string; outcome:Exclude<SendOutcome,"rejected">; from:string; rest:string[]}) {
  const {went,outcome,from,rest}=args;
  return outcome==="delivered"
    ? `sent_unverified: ушло: ${went}; файлы начиная с ${from} Telegram принял, но его ответ не совпал с ожидаемым — `+
      `считай их доставленными и НЕ повторяй; при сомнении проверь в чате: bb telegram-projects search-history --files --last ${rest.length+2}.`
    : `send_outcome_unknown: ушло: ${went}; про файлы начиная с ${from} Telegram не ответил — исход не подтверждён, возможно, доставлено. `+
      `НЕ повторяй отправку: мост их не видит (Telegram не прислал ответа), а в чате они могут уже быть. Скажи в чате, что файлы могли `+
      `прийти, и попроси написать, если их нет; отправить ещё раз — только тогда, с --again (${rest.join(" ")}).`;
}
