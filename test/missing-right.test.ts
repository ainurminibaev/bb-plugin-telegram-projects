import test from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../adapters";
import { TelegramFailure } from "../model";
import { missingRightRefusal } from "../forum-commands";

// С77: Telegram refuses for want of an admin right — the agent learns which right, where, and how to ask the owner.
test("a refusal for a missing admin right is told apart and explained", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 400,
      description: "Bad Request: not enough rights to create a topic" }), { status: 400 });
    const api = telegram(async () => "test-token", new AbortController().signal, 1000, () => -100500);
    await assert.rejects(api("createForumTopic", { chat_id: -100500, name: "Новая" }),
      (e: unknown) => e instanceof TelegramFailure && e.code === "telegram_rights");
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 400,
      description: "Bad Request: message to edit not found" }), { status: 400 });
    await assert.rejects(api("editMessageText", { chat_id: -100500, message_id: 1, text: "x" }),
      (e: unknown) => e instanceof TelegramFailure && e.code === "telegram_400");
  } finally { globalThis.fetch = original; }
  const text = missingRightRefusal("create", "Команда");
  assert.match(text, /^bot_lacks_right: /);
  assert.match(text, /«Управление темами» в группе «Команда»/);
  assert.match(text, /send --person owner --ask/);
  assert.match(text, /Администраторы/);
});
