import test from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HandoffJob } from "../handoff";
import { coordinatorHandoffNote } from "../handoff-coordinator";

test("only the registered private source hands the project workflow to its successor", async () => {
  let lookups = 0;
  const sdk = {plugins: {
    list: async () => {lookups++; return {plugins:[{id:"personal-assistant"}]};},
    getSettings: async () => ({values:{projectId:"assistant-project",threadId:"source"}}),
  }} as unknown as BbPluginApi["sdk"];
  const job = {source:"source",binding:{topicId:0,projectId:"assistant-project"}} as HandoffJob;
  assert.equal(await coordinatorHandoffNote(sdk,{...job,binding:{...job.binding,topicId:7}}),"");
  assert.equal(lookups,0);
  assert.equal(await coordinatorHandoffNote(sdk,{...job,source:"other"}),"");
  assert.equal(await coordinatorHandoffNote(sdk,{...job,binding:{...job.binding,projectId:"other"}}),"");
  const note=await coordinatorHandoffNote(sdk,job);
  assert.match(note,/assistant-project/);
  assert.match(note,/child of your current thread/);
  assert.match(note,/after this handoff succeeds/);
});
