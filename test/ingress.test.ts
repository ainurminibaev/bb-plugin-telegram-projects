import test from "node:test";
import assert from "node:assert/strict";
import { routeUpdate as route } from "../ingress";
const routeUpdate = (u: unknown) => route(u, OWNER_ID);
const OWNER_ID = 259034221;
const chat = { id: OWNER_ID, type: "private" };
const from = { id: OWNER_ID };
test("owner text in a topic becomes a chat input", () => {
  const r = routeUpdate({
    update_id: 7,
    message: {
      message_id: 3,
      chat,
      from,
      message_thread_id: 42,
      text: "привет",
    },
  });
  assert.equal(r.kind, "chat");
  assert.deepEqual(r.kind === "chat" && r.input, {
    updateId: 7,
    ownerId: OWNER_ID,
    chatId: OWNER_ID,
    topicId: 42,
    messageId: 3,
    text: "привет",
    callback: undefined,
    replyTo: undefined,
    voice: undefined,
    attachment: undefined,
  });
});
test("other users, groups and foreign callbacks are ignored", () => {
  const other = { message_id: 1, chat, from: { id: 1 }, text: "x" };
  assert.equal(routeUpdate({ update_id: 1, message: other }).kind, "ignore");
  const group = {
    message_id: 1,
    chat: { id: OWNER_ID, type: "group" },
    from,
    text: "x",
  };
  assert.equal(routeUpdate({ update_id: 1, message: group }).kind, "ignore");
  const cb = routeUpdate({
    update_id: 2,
    callback_query: {
      id: "9",
      from,
      data: "sms:copy",
      message: { message_id: 1, chat },
    },
  });
  assert.deepEqual(cb, { kind: "ignore", callbackId: "9" });
});
test("/tasks is answered by the plugin; bb: callbacks and new topics reach the bridge", () => {
  assert.deepEqual(
    routeUpdate({
      update_id: 3,
      message: {
        message_id: 1,
        chat,
        from,
        message_thread_id: 5,
        text: "/tasks@aivech_bot",
      },
    }),
    { kind: "tasks", topicId: 5 },
  );
  const cb = routeUpdate({
    update_id: 4,
    callback_query: {
      id: "8",
      from,
      data: "bb:menu",
      message: { message_id: 2, chat, message_thread_id: 5 },
    },
  });
  assert.equal(cb.kind === "chat" && cb.input.callback, "bb:menu");
  assert.equal(cb.kind === "chat" && cb.callbackId, "8");
  const created = routeUpdate({
    update_id: 5,
    message: {
      message_id: 3,
      chat,
      from,
      message_thread_id: 6,
      forum_topic_created: { name: "x" },
    },
  });
  assert.equal(created.kind === "chat" && created.input.text, "/project");
});
test("before pairing only /start with the page code binds the owner", () => {
  const u = (text: string, id = 42) => ({
    update_id: 1,
    message: { message_id: 1, chat: { id, type: "private" }, from: { id }, text },
  });
  assert.deepEqual(route(u("/start 123456"), undefined, "123456"), { kind: "pair", userId: 42 });
  assert.equal(route(u("/start 999999"), undefined, "123456").kind, "ignore");
  assert.equal(route(u("привет"), undefined, "123456").kind, "ignore");
  assert.equal(route(u("/start 123456"), undefined, undefined).kind, "ignore");
  assert.equal(route(u("/start 123456", 7), 42, "123456").kind, "ignore");
});

test("large documents retain caption and metadata without content", () => {
  const r = routeUpdate({update_id: 10, message: {message_id: 11, chat, from,
    caption: "Разбери видео", document: {file_id: "large", file_name: "video.mp4", file_size: 2_000_000_000, mime_type: "video/mp4"}}});
  assert.equal(r.kind, "chat");
  if (r.kind !== "chat") return;
  assert.equal(r.input.text, "Разбери видео");
  assert.equal(r.input.attachment?.size, 2_000_000_000);
  assert.equal(r.input.attachment?.fileId, "large");
  assert.equal(r.input.voice, undefined);
});
test("only short voice notes are transcribed; audio and long voice are files", () => {
  for (const [field, size, duration, transcribe] of [
    ["voice", 2000, 5, true], ["voice", 16_000_000, 5, false],
    ["voice", 2000, 601, false], ["audio", 2000, 5, false],
  ] as const) {
    const r = routeUpdate({update_id: 12, message: {message_id: 12, chat, from,
      [field]: {file_id: "a", file_size: size, duration}}});
    assert.equal(r.kind, "chat");
    if (r.kind !== "chat") continue;
    assert.equal(Boolean(r.input.voice), transcribe);
    assert.equal(Boolean(r.input.attachment), !transcribe);
  }
});
test("photo chooses largest variant, foreign owners cannot submit files", () => {
  const message = {message_id: 13, chat, from, photo: [{file_id: "small", file_size: 5}, {file_id: "big", file_size: 50}]};
  const r = routeUpdate({update_id: 13, message});
  assert.equal(r.kind === "chat" && r.input.attachment?.fileId, "big");
  assert.equal(routeUpdate({update_id: 13, message: {...message, from: {id: 99}}}).kind, "ignore");
});
