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
