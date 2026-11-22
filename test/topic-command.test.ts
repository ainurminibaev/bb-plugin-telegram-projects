import test from "node:test";
import assert from "node:assert/strict";
import {topicRefusal} from "../topic-command";

test("who may manage forum topics follows the calling conversation",()=>{
  assert.equal(topicRefusal({kind:"owner"},"delete",-1001),undefined);
  assert.equal(topicRefusal({kind:"group",chat:-1001},"rename",-1001),undefined);
  assert.equal(topicRefusal({kind:"group",chat:-1001},"create",-1001),undefined);
  assert.match(topicRefusal({kind:"group",chat:-1001},"delete",-1001)!,/for_the_owner/);
  assert.match(topicRefusal({kind:"group",chat:-1001},"close",-1002)!,/another_group/);
  assert.match(topicRefusal({kind:"person",subject:21},"close",-1001)!,/private_chat/);
  assert.match(topicRefusal(undefined,"close",-1001)!,/only_from/);
});
