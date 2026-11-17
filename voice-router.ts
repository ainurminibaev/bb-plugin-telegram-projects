import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
const exec = promisify(execFile);

/** Admin-selected local router. Never changes BB's global transcription service. */
export async function transcribeWithVoiceRouter(router: string, audio: File, signal: AbortSignal): Promise<string> {
  if (!isAbsolute(router) || router.includes('\0')) throw Error('voice_router_invalid');
  if (audio.size === 0 || audio.size > 15_000_000) throw Error('voice_too_large');
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'bb-telegram-voice-'));
  try {
    const file = join(directory, 'voice.ogg');
    await writeFile(file, Buffer.from(await audio.arrayBuffer()), {mode: 0o600});
    const { stdout } = await exec(router, [file, '--lang', 'auto'], {
      signal, timeout: 650_000, maxBuffer: 256 * 1024, encoding: 'utf8',
    });
    const text = stdout.trim();
    if (!text || text.length > 16_000) throw Error('voice_transcription_empty');
    return text;
  } catch {
    // Child stderr can contain paths or transcript fragments; do not expose it.
    throw Error(signal.aborted ? 'voice_transcription_cancelled' : 'voice_local_asr_failed');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
