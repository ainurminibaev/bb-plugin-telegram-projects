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

for (const fail of [false,true]) test(`configured bot-only transcription ${fail?'failure':'success'} never calls BB ASR`,async()=>{
 const original=globalThis.fetch;
 let bbCalls=0,routerCalls=0;
 globalThis.fetch=async(url)=>String(url).endsWith('/getFile')
  ? Response.json({ok:true,result:{file_path:'voice/sample.ogg'}})
  :new Response('fixture');
 try {
  const sdk={system:{transcribeVoice:async()=>{bbCalls++;throw Error('unexpected_bb_asr');}}} as unknown as Parameters<typeof transcribeTelegramVoice>[1];
  const run=transcribeTelegramVoice(async()=>'fixture',sdk,
   {fileId:'id',mime:'audio/ogg',size:7,duration:1},new AbortController().signal,
   undefined,undefined,async audio=>{routerCalls++;assert.equal(audio.name,'voice.ogg');if(fail)throw Error('local_asr_down');return 'Татарча';});
  if(fail)await assert.rejects(run,{message:'local_asr_down'});
  else assert.equal(await run,'Татарча');
  assert.equal(routerCalls,1);assert.equal(bbCalls,0);
 } finally {globalThis.fetch=original;}
});

test('incomplete cloud downloads never reach transcription', async () => {
  const original = globalThis.fetch;
  try {
    for (const [messageSize, fileSize, received] of [[9, 9, 4], [0, 9, 4], [0, 0, 0], [9, 4, 4]]) {
      globalThis.fetch = async url => String(url).endsWith('/getFile')
        ? Response.json({ok: true, result: {file_path: 'voice/sample.ogg', file_size: fileSize}})
        : new Response(new Uint8Array(received));
      let calls = 0;
      const transcribe = async () => { calls++; return 'partial'; };
      const sdk = {system: {transcribeVoice: transcribe}} as unknown as Parameters<typeof transcribeTelegramVoice>[1];
      await assert.rejects(transcribeTelegramVoice(async () => 'fixture', sdk,
        {fileId: 'id', mime: 'audio/ogg', size: messageSize, duration: 1},
        new AbortController().signal, undefined, undefined, transcribe), /voice_(download_failed|file_invalid)/);
      assert.equal(calls, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('local Bot API forwards only complete voice bytes, including on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-voice-retry-'));
  const source = join(root, 'source.ogg');
  const original = globalThis.fetch;
  let declared = 0;
  globalThis.fetch = async () => Response.json({ok:true, result:{file_path:source, file_size:declared}});
  const seen: string[] = [];
  const sdk = {system:{transcribeVoice: async ({file}: {file: File}) => {
    seen.push(await file.text());
    return {text:'Распознано'};
  }}} as Parameters<typeof transcribeTelegramVoice>[1];
  const run = (fileId: string) => transcribeTelegramVoice(async () => 'fixture', sdk,
    {fileId, mime:'audio/ogg', size:0, duration:1}, new AbortController().signal,
    async () => 'http://127.0.0.1:8083', async () => ({localRoot:root, inboxRoot:join(root,'inbox')}));
  try {
    await writeFile(source, '');
    await assert.rejects(run('empty'), /voice_download_failed/);
    declared = 8;
    await writeFile(source, 'part');
    await assert.rejects(run('retry'), /attachment_size_mismatch/);
    assert.deepEqual(seen, []);
    await writeFile(source, 'complete');
    assert.equal(await run('retry'), 'Распознано');
    assert.deepEqual(seen, ['complete']);
  } finally {globalThis.fetch = original; await rm(root,{recursive:true,force:true});}
});
