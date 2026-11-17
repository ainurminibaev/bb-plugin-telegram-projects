import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transcribeWithVoiceRouter} from '../voice-router';

for (const fail of [false,true]) test(`local voice router ${fail?'fails without leaking stderr':'returns transcript'} and removes private audio`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'router-test-'));
 try {
  const executable=join(dir,'router');
  await writeFile(executable,`#!/bin/sh\nprintf '%s' "$1" > "${dir}/observed"\n[ "$2" = '--lang' ] && [ "$3" = 'auto' ] || exit 9\n${fail ? 'echo private-details >&2; exit 3' : 'cat "$1"'}\n`,{mode:0o700});
  const run=transcribeWithVoiceRouter(executable,new File(['Татарча тест'],'voice.ogg'),new AbortController().signal);
  if(fail) await assert.rejects(run,{message:'voice_local_asr_failed'});
  else assert.equal(await run,'Татарча тест');
  await assert.rejects(access(await readFile(join(dir,'observed'),'utf8')),{code:'ENOENT'});
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('local router rejects relative command paths',async()=>{
 await assert.rejects(transcribeWithVoiceRouter('router',new File(['audio'],'voice.ogg'),new AbortController().signal),{message:'voice_router_invalid'});
});
