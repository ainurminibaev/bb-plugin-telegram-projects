import { createReadStream, createWriteStream, constants } from "node:fs";
import { mkdir, open, realpath, stat, statfs, readFile, writeFile, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, join, basename, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const maxRoutedDocumentBytes = 2 * 1024 * 1024;
export const MAX_INCOMING_BYTES = 2 * 1024 * 1024 * 1024;

export function safeTelegramFilename(filename:string) {
  // The client filename is metadata, never a filesystem path.
  const safeName = Array.from(basename(filename.replaceAll("\\", "/"))
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "_")).slice(0, 160).join("");
  let name = !safeName || [".", ".."].includes(safeName) ? "attachment.bin" : safeName;
  if (name.startsWith(".")) name = "file_" + name;
  while (Buffer.byteLength(name) > 180) name = Array.from(name).slice(0, -1).join("");
  return name;
}

/** Credentials belong in the token setting, never in an API URL. */
export function telegramApiRoot(value = "https://api.telegram.org"): string {
  let u: URL;
  try { u = new URL(value); } catch { throw Error("telegram_api_root_invalid"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!["http:", "https:"].includes(u.protocol) ||
      (u.protocol === "http:" && !loopback) || u.username || u.password ||
      u.search || u.hash || u.pathname !== "/")
    throw Error("telegram_api_root_invalid");
  return u.origin;
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

export type SavedTelegramFile = {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
};

/**
 * Materialize a getFile result from a local Bot API volume. No bytes enter
 * a Blob/Buffer of file size; the copy and digest use bounded streams.
 * Paths returned by Bot API are untrusted until confined to the mounted root.
 * Secrets and raw source paths must not be included in caller error messages.
 */
export async function saveLocalTelegramFile(input: {
  sourcePath: string;
  localRoot: string;
  inboxRoot: string;
  threadId?: string;
  updateId: number;
  fileId: string;
  name: string;
  expectedBytes?: number;
  maxBytes?: number;
  signal: AbortSignal;
}): Promise<SavedTelegramFile> {
  const max = input.maxBytes ?? MAX_INCOMING_BYTES;
  if (!Number.isSafeInteger(input.updateId) || input.updateId < 0 || !input.fileId ||
      !Number.isSafeInteger(max) || max < 1 || max > MAX_INCOMING_BYTES ||
      !isAbsolute(input.localRoot) || !isAbsolute(input.inboxRoot) || !isAbsolute(input.sourcePath))
    throw Error("attachment_configuration_invalid");
  if (input.expectedBytes !== undefined &&
      (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0 || input.expectedBytes > max))
    throw Error("attachment_too_large");
  if (input.signal.aborted) throw Error("attachment_cancelled");
  const key = `${input.updateId}-${createHash("sha256").update(input.fileId).digest("hex").slice(0, 20)}`;
  const name = safeTelegramFilename(input.name);
  let temporary: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const localRoot = await realpath(input.localRoot);
    const source = await realpath(input.sourcePath);
    if (!inside(localRoot, source)) throw Error("attachment_path_outside_local_root");
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw Error("attachment_not_regular_file");
    if (info.size > max) throw Error("attachment_too_large");
    if (input.expectedBytes && info.size !== input.expectedBytes)
      throw Error("attachment_size_mismatch");
    // Группа папки входящих может читать файлы (агент под своей учёткой); чужим — нет.
    await mkdir(input.inboxRoot, { recursive: true, mode: 0o750 });
    const inbox = await realpath(input.inboxRoot);
    const directory = join(inbox, key);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    if (!inside(inbox, await realpath(directory))) throw Error("attachment_inbox_invalid");
    const destination = join(directory, name);
    const receiptPath = join(directory, ".complete.json");
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (receipt.path === destination && receipt.bytes === info.size &&
          /^[a-f0-9]{64}$/.test(receipt.sha256) &&
          inside(directory, await realpath(destination)) &&
          (await stat(destination)).size === info.size) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(destination, { signal: input.signal })) digest.update(chunk);
        if (digest.digest("hex") !== receipt.sha256) throw Error("attachment_cached_copy_invalid");
        return receipt;
      }
      throw Error("attachment_cached_copy_invalid");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    const disk = await statfs(inbox);
    if (disk.bavail * disk.bsize < info.size + 256 * 1024 * 1024)
      throw Error("attachment_disk_space_low");
    temporary = join(directory, `.partial-${randomUUID()}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.length;
        if (bytes > max || bytes > info.size) return next(Error("attachment_too_large"));
        hash.update(chunk);
        next(null, chunk);
      },
    });
    await pipeline(
      createReadStream(source, { fd: handle.fd, autoClose: false, highWaterMark: 256 * 1024 }),
      meter,
      createWriteStream(temporary, { flags: "wx", mode: 0o640 }),
      { signal: input.signal },
    );
    if (bytes !== info.size) throw Error("attachment_size_mismatch");
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw Error("attachment_source_changed");
    await rename(temporary, destination);
    temporary = undefined;
    const receipt = { ...(input.threadId?{threadId:input.threadId}:{}), path: destination, name, bytes, sha256: hash.digest("hex") };
    const pendingReceipt = join(directory, `.receipt-${randomUUID()}`);
    await writeFile(pendingReceipt, JSON.stringify(receipt), { mode: 0o600 });
    await rename(pendingReceipt, receiptPath);
    return receipt;
  } catch (error: any) {
    const message = String(error?.message ?? "");
    if (/^attachment_[a-z_]+$/.test(message)) throw Error(message);
    if (input.signal.aborted) throw Error("attachment_cancelled");
    throw Error("attachment_local_copy_failed");
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
