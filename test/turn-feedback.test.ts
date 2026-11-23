import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acknowledge, decideChooser, decideRequest, parseReactionOptions, progressText, stepLabel,
  DEFAULT_REACTION_OPTIONS, BOT_REACTIONS } from "../turn-feedback";

test("the default reaction set uses only reactions Telegram allows bots, funny ones included", () => {
  assert.ok(DEFAULT_REACTION_OPTIONS.length >= 10 && DEFAULT_REACTION_OPTIONS.length <= 15);
  for (const o of DEFAULT_REACTION_OPTIONS) assert.ok(BOT_REACTIONS.has(o.emoji), o.emoji);
  assert.ok(DEFAULT_REACTION_OPTIONS.some(o => o.emoji === "🤣"));
  assert.deepEqual(parseReactionOptions("👍=ок; 🦖=нет такого; 😁=смешно").map(o => o.emoji), ["👍", "😁"]);
  assert.equal(parseReactionOptions("мусор"), DEFAULT_REACTION_OPTIONS);
});

test("step labels name the work in plain words, never the command", () => {
  assert.equal(stepLabel({ type: "commandExecution", command: "bb telegram-projects search-history поставки" }), "Ищу в переписке…");
  assert.equal(stepLabel({ type: "commandExecution", command: "bb telegram-projects rights show" }), "Смотрю настройки доступа…");
  assert.equal(stepLabel({ type: "commandExecution", command: "python3 read.py tasks.xlsx" }), "Читаю таблицу…");
  assert.equal(stepLabel({ type: "webSearch", queries: ["x"] }), "Ищу в интернете…");
  assert.equal(stepLabel({ type: "fileChange", changes: [{ path: "a.ts" }] }), "Правлю файлы…");
  assert.equal(stepLabel({ type: "commandExecution", command: "make build" }), "Выполняю шаг задачи…");
});

test("the live status shows the agent's first line and the step; a guest sees the step only; the template waits", () => {
  const now = 100_000;
  assert.equal(progressText({ agentLine: "Сейчас гляну, кому открыта личка", step: "Смотрю настройки доступа…", startedAt: now, now }),
    "⏳ Сейчас гляну, кому открыта личка\\nСмотрю настройки доступа…".replace("\\n", "\n"));
  assert.equal(progressText({ agentLine: "секрет из лички", step: "Ищу в переписке…", guest: true, startedAt: now, now }),
    "⏳ Ищу в переписке…");
  assert.equal(progressText({ startedAt: now, now: now + 2000 }), undefined);
  assert.equal(progressText({ startedAt: now, now: now + 9000 }), "⏳ Работаю над задачей…");
});

test("the quick decision chooses through vallis-decide; no service or an off-list answer keeps 👀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decide-"));
  const fake = (name: string, out: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\ncat >/dev/null\necho '${out}'\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const options = DEFAULT_REACTION_OPTIONS;
  assert.equal(await decideChooser(fake("ok", '{"answers":[{"name":"reaction","choice":"🤣"}]}'))("x", options), "🤣");
  assert.equal(await decideChooser(fake("off", '{"answers":[{"name":"reaction","choice":"🦖"}]}'))("x", options), undefined);
  assert.equal(await decideChooser(join(dir, "absent"))("x", options), undefined);
  assert.equal(decideRequest("x", options).questions[0].choices.length, options.length);

  const calls: string[] = [];
  const tg = async (_m: string, b: Record<string, unknown>) => { calls.push((b.reaction as {emoji: string}[])[0]?.emoji); return {}; };
  await acknowledge(tg, 1, 2, "смешной текст", async () => "🤣", options, () => false);
  assert.deepEqual(calls, ["👀", "🤣"]);
  calls.length = 0;
  await acknowledge(tg, 1, 2, "текст", async () => "🤣", options, () => true);   // a service reaction came first
  assert.deepEqual(calls, ["👀"]);
});
