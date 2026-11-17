import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeTelegramVoice } from '../adapters';

for (const local of [false, true]) test(`voice preserves filename through SDK multipart (${local ? 'local' : 'cloud'} Bot API)`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-voice-'));
  const source = join(root, 'source.ogg');
  const bytes = Buffer.from('synthetic audio fixture');
  await writeFile(source, bytes);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith('/getFile')
    ? Response.json({ok:true, result:{file_path: local ? source : 'voice/source.ogg'}})
    : new Response(bytes);
  try {
    const sdk = {system:{transcribeVoice: async ({file}: {file:Blob}) => {
      const form = new FormData(); form.set('file', file);
      const wire = await new Response(form).formData();
      const audio = wire.get('file') as File;
      assert.equal(audio.name, 'voice.ogg');
      assert.equal(audio.type, 'audio/ogg');
      assert.deepEqual(Buffer.from(await audio.arrayBuffer()), bytes);
      return {text:'Распознано'};
    }}} as Parameters<typeof transcribeTelegramVoice>[1];
    const result = await transcribeTelegramVoice(async () => 'fixture', sdk,
      {fileId:'fixture-id',mime:'audio/ogg',size:bytes.length,duration:1},
      new AbortController().signal, async () => local ? 'http://127.0.0.1:8083' : 'https://api.telegram.org',
      async () => ({localRoot:root,inboxRoot:join(root,'inbox')}));
    assert.equal(result,'Распознано');
  } finally { globalThis.fetch = original; await rm(root,{recursive:true,force:true}); }
});
