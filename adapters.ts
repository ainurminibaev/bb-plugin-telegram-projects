import {imageAttachment,maxImageBytes} from "./group-attachments";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { telegramApiRoot, saveLocalTelegramFile, maxRoutedDocumentBytes } from "./telegram-files";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelegramFailure,
  taskSchema,
  type Task,
  type Telegram,
} from "./model";
const exec = promisify(execFile);
export type TokenSource = () => Promise<string>;
export type ApiRootSource = () => Promise<string>;
export type CloudFile = {file_id?:string;file_path?:string;file_size?:number};
async function downloadCloudFile(token:TokenSource, file:CloudFile,
  size:number, signal:AbortSignal, limit:number, invalidInput:string, request:typeof fetch,allowEmpty=false) {
  const path=file.file_path;
  const expected=size || file.file_size;
  const parts=typeof path==="string" ? path.split("/") : undefined;
  if (!parts || path!.length>1024 || parts.some(segment=>!segment || segment==="." || segment===".." || /[\p{Cc}\p{Cf}\\%:?#]/u.test(segment)) ||
      (expected!==undefined && (!Number.isSafeInteger(expected) || expected<(allowEmpty?0:1) || expected>limit)) ||
      (size && file.file_size!==undefined && size!==file.file_size))
    throw Error(invalidInput);
  const response=await request(`https://api.telegram.org/file/bot${await token()}/${parts.map(encodeURIComponent).join("/")}`,{
    redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),
  }).catch(()=>{throw Error("attachment_download_failed");});
  if (!response.ok || !response.body || Number(response.headers.get("content-length"))>limit) {
    await response.body?.cancel().catch(()=>undefined);
    throw Error("attachment_download_failed");
  }
  const chunks:Uint8Array[]=[];
  const reader=response.body.getReader();
  let length=0;
  try {
    while (true) {
      const {done,value}=await reader.read().catch(()=>{throw Error("attachment_download_failed");});
      if (done) break;
      length+=value.length;
      if (length>limit || (expected!==undefined && length>expected)) throw Error("attachment_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>undefined); }
  if (expected!==undefined && length!==expected) throw Error("attachment_size_mismatch");
  return Buffer.concat(chunks,length);
}

export async function downloadGroupImage(token:TokenSource, file:CloudFile,
  size:number, signal:AbortSignal, request=fetch) {
  return imageAttachment(await downloadCloudFile(token,file,size,signal,maxImageBytes,"attachment_invalid_image",request));
}

type CloudAttachment = {
  fileId:string; name:string; size:number; threadId:string; updateId:number; inboxRoot:string; inboxBase?:string; signal:AbortSignal;
};
export function receiveCloudTelegramPdf(token:TokenSource,file:CloudFile,input:CloudAttachment,request=fetch) {
  return receiveCloudTelegramDocument(token,file,input,request,true);
}

export async function receiveCloudTelegramDocument(token:TokenSource,file:CloudFile,input:CloudAttachment,
  request=fetch,pdf=false) {
  const invalid=pdf ? "attachment_invalid_pdf" : "attachment_invalid_document";
  if (!input.fileId || file.file_id!==input.fileId || (pdf && !/\.pdf$/i.test(input.name))) throw Error(invalid);
  const data=await downloadCloudFile(token,file,input.size,input.signal,maxRoutedDocumentBytes,invalid,request,!pdf);
  if (pdf && !data.subarray(0,5).equals(Buffer.from("%PDF-"))) throw Error(invalid);
  input.signal.throwIfAborted();
  const staging=await mkdtemp(join(tmpdir(),"bb-telegram-document-"));
  try {
    const sourcePath=join(staging,"document");
    await writeFile(sourcePath,data,{mode:0o600,flag:"wx"});
    return await saveLocalTelegramFile({sourcePath,localRoot:staging,inboxRoot:input.inboxRoot,inboxBase:input.inboxBase,
      threadId:input.threadId,updateId:input.updateId,fileId:input.fileId,name:input.name,
      expectedBytes:data.length,maxBytes:maxRoutedDocumentBytes,signal:input.signal});
  } finally {
    await rm(staging,{recursive:true,force:true});
  }
}

/** Sent bot messages, for the conversation archive. Set once by the bridge. */
export const sentMessages: { observe?: (message: any) => void } = {};

export function telegram(
  token: TokenSource,
  signal: AbortSignal,
  timeoutMs = 15_000,
  /** The paired owner's private chat; every chat method targets it. */
  owner: () => number | undefined = () => undefined,
  apiRoot: ApiRootSource = async () => "https://api.telegram.org",
): Telegram {
  return async <T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const hasDestination = !["getMe", "getUpdates", "setMyCommands", "setMyDescription", "setMyShortDescription"].includes(method);
    const chatId = hasDestination ? owner() : undefined;
    // An explicitly addressed message must never be redirected to another chat.
    if (hasDestination && body.chat_id !== undefined && String(body.chat_id) !== String(chatId))
      throw Error("telegram_chat_mismatch");
    const secret = await token();
    const endpoint = telegramApiRoot(await apiRoot());
    const payload: Record<string, unknown> = { ...body,
      ...(hasDestination ? { chat_id: chatId } : {}) };
    const multipart = Object.values(payload).some(v => v instanceof Blob);
    const form = new FormData();
    if (multipart) for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      if (value instanceof Blob) form.append(key, value, String(body[`${key}_filename`] || "attachment"));
      else if (!key.endsWith("_filename")) form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    let r: Response;
    try {
      r = await fetch(`${endpoint}/bot${secret}/${method}`, {
        method: "POST",
        headers: multipart ? undefined : { "content-type": "application/json" },
        body: multipart ? form : JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      throw new TelegramFailure("telegram_network", 30, true);
    }
    let data: any;
    try {
      data = await r.json();
    } catch {
      throw new TelegramFailure("telegram_invalid_response", 30, true);
    }
    if (!data.ok) {
      const d = String(data.description ?? "");
      if (
        d.includes("TOPIC_NOT_MODIFIED") ||
        d.includes("message is not modified")
      )
        return true as T;
      const code =
        d.includes("TOPIC_ID_INVALID") || d.includes("message thread not found")
          ? "topic_missing"
          // С77: the bot lacks an admin right — said apart, so the agent can ask the owner for that right.
          : /not enough rights|CHAT_ADMIN_REQUIRED|have no rights|administrator rights|RIGHT_FORBIDDEN/i.test(d)
            ? "telegram_rights"
            : /message can't be deleted/i.test(d) ? "telegram_cannot_delete"
            : `telegram_${data.error_code ?? r.status}`;
      throw new TelegramFailure(
        code,
        Number(data.parameters?.retry_after) || 30,
        r.status >= 500,
        Number.isSafeInteger(data.parameters?.migrate_to_chat_id) ? data.parameters.migrate_to_chat_id : undefined,
      );
    }
    if (sentMessages.observe && (method.startsWith("send") || method.startsWith("edit")))
      for (const message of Array.isArray(data.result) ? data.result : [data.result])
        if (message && typeof message === "object" && "message_id" in message) {
          try { sentMessages.observe(message); } catch { /* the archive never blocks delivery */ }
        }
    return data.result as T;
  };
}
// Env Catalog prints the stored value; the trailing newline is not part of it.
export async function readEnvToken(
  binary: string,
  baseUrl: string,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, BB_SERVER_URL: baseUrl };
    const r = await exec(binary, ["env-catalog", "get", name, "--raw"], {
      env,
      timeout: 15_000,
      signal,
    });
    return r.stdout.trim();
  } catch {
    return "";
  }
}
// The first bot seen is remembered; a token of another bot is refused afterwards,
// because topics and bindings belong to the bot that created them.
export async function checkBot(tg: Telegram, expected?: number) {
  const me = await tg("getMe", {});
  if (expected && me.id !== expected) throw new Error("unexpected_bot_identity");
  return {
    id: Number(me.id),
    username: String(me.username),
    topics: me.has_topics_enabled === true,
    readsAllGroups: me.can_read_all_group_messages === true,
  };
}
export async function runBb(
  binary: string,
  baseUrl: string,
  args: string[],
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, BB_SERVER_URL: baseUrl };
    delete env.BB_PROJECT_ID;
    delete env.BB_THREAD_ID;
    delete env.BB_ENVIRONMENT_ID;
    const r = await exec(binary, args, {
      env,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
    return JSON.parse(r.stdout);
  } catch {
    throw new Error("tasks_cli_unavailable");
  }
}
export const trackersSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      linkedBbProjectId: z.string().nullable(),
    }),
  ),
});
export async function readTasks(
  run: (args: string[]) => Promise<unknown>,
  id: string,
): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = z
      .object({ tasks: z.array(taskSchema), nextCursor: z.string().nullable() })
      .parse(
        await run([
          "tasks",
          "list",
          "--project",
          id,
          "--limit",
          "500",
          "--json",
          ...(cursor ? ["--cursor", cursor] : []),
        ]),
      );
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
    if (cursor) {
      if (seen.has(cursor) || tasks.length > 50_000)
        throw new Error("tasks_pagination_invalid");
      seen.add(cursor);
    }
  } while (cursor);
  return tasks;
}

export async function transcribeTelegramVoice(
  token: TokenSource,
  sdk: import("@get-bb/plugin-sdk").BbPluginApi["sdk"],
  voice: { fileId: string; mime: string; size: number; duration: number },
  signal: AbortSignal,
  apiRoot: ApiRootSource = async () => "https://api.telegram.org",
  localFiles?: () => Promise<{ localRoot: string; inboxRoot: string }>,
  transcribe?: (audio: File) => Promise<string>,
  language?: "ru" | "en",
): Promise<string> {
  if (voice.size > 15_000_000 || voice.duration > 600)
    throw Error("voice_too_large");
  const endpoint = telegramApiRoot(await apiRoot());
  const file = await telegram(token, signal, 30_000, undefined, apiRoot)("getFile", {
    file_id: voice.fileId,
  });
  const expectedBytes = voice.size || file.file_size || undefined;
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 15_000_000))
    throw Error("voice_file_invalid");
  if (voice.size && file.file_size && voice.size !== file.file_size)
    throw Error("voice_file_invalid");
  if (endpoint !== "https://api.telegram.org") {
    if (!localFiles || typeof file.file_path !== "string") throw Error("voice_file_invalid");
    const config = await localFiles();
    const saved = await saveLocalTelegramFile({ ...config, sourcePath: file.file_path,
      updateId: 0, fileId: voice.fileId, name: "voice.ogg", expectedBytes,
      maxBytes: 15_000_000, signal });
    const bytes = await readFile(saved.path);
    if (bytes.length === 0 || bytes.length !== saved.bytes) throw Error("voice_download_failed");
    const audio = new File([bytes], "voice.ogg", {type: voice.mime});
    const result = transcribe ? {text: await transcribe(audio)} : await sdk.system.transcribeVoice({ file: audio, signal,
      // Without a hint the service guesses the language and may take Russian speech for Polish.
      ...(language && { prompt: language === "ru" ? "Речь на русском языке." : "Speech in English." }) });
    const text = (result as {text?:string}).text;
    if (!text?.trim() || text.length > 16000) throw Error("voice_transcription_empty");
    return text;
  }
  if (
    typeof file.file_path !== "string" ||
    !/^[a-zA-Z0-9_/.\-]+$/.test(file.file_path) ||
    file.file_path.includes("..")
  )
    throw Error("voice_file_invalid");
  const response = await fetch(
    `${endpoint}/file/bot${await token()}/${file.file_path}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) },
  ).catch(() => {
    throw Error("voice_download_failed");
  });
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > 15_000_000
  )
    throw Error("voice_download_failed");
  const reader = response.body!.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 15_000_000) {
      await reader.cancel();
      throw Error("voice_too_large");
    }
    chunks.push(value);
  }
  if (length === 0 || (expectedBytes !== undefined && length !== expectedBytes))
    throw Error("voice_download_failed");
  const bytes = Buffer.concat(chunks);
  const audio = new File([bytes], "voice.ogg", {type: voice.mime});
  const result = transcribe ? {text: await transcribe(audio)} : await sdk.system.transcribeVoice({file: audio, signal});
  const text = (result as { text?: string }).text;
  if (!text?.trim() || text.length > 16000)
    throw Error("voice_transcription_empty");
  return text;
}
