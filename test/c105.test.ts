import test from "node:test";
import assert from "node:assert/strict";
import {deleteRefusal,ownMessageChat} from "../delete-command";

const owner=7,bot=5,group=-1001,other=-1002;

test("С105: the owner's conversation edits and removes the bot's own message in any chat; a group only in its own", () => {
  const ownerConv={kind:"owner" as const};
  const groupConv={kind:"group" as const,chat:group,topic:3};
  assert.equal(ownMessageChat(ownerConv,owner,other),other);
  assert.equal(ownMessageChat(ownerConv,owner,undefined),owner);
  assert.equal(ownMessageChat(groupConv,owner,undefined),group);
  assert.equal(ownMessageChat(groupConv,owner,group),group);
  assert.equal(ownMessageChat(groupConv,owner,other),undefined,"a group's conversation does not reach another chat");
  assert.equal(deleteRefusal({caller:ownerConv,owner,bot,chat:other,sender:bot,author:undefined}),undefined,"own message, any chat");
  assert.match(deleteRefusal({caller:ownerConv,owner,bot,chat:other,sender:42,author:owner})!,/delete_only_in_own_chat/,
    "someone else's message elsewhere — as before");
  assert.match(deleteRefusal({caller:groupConv,owner,bot,chat:other,sender:bot,author:undefined})!,/delete_only_in_own_chat/);
});
