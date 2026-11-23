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

test("step labels: only plain actions a person understands; service mechanics give no label", () => {
  assert.equal(stepLabel({ type: "commandExecution", command: "bb telegram-projects search-history поставки" }), "Ищу в переписке…");
  assert.equal(stepLabel({ type: "commandExecution", command: "python3 read.py tasks.xlsx" }), "Читаю таблицу…");
  assert.equal(stepLabel({ type: "commandExecution", command: "pdftotext договор.pdf -" }), "Читаю файл…");
  assert.equal(stepLabel({ type: "webSearch", queries: ["x"] }), "Ищу в интернете…");
  // Owner's case 23.11: «может быстрее можно?» → the assistant asked another conversation; no «Смотрю рабочие разговоры».
  for (const command of ["bb thread tell thr_x 'можно раньше?'", "bb thread list --json", "bb automation list",
    "bb telegram-projects rights show", "bb plugin config telegram-projects", "make build", "git log -3"])
    assert.equal(stepLabel({ type: "commandExecution", command }), undefined, command);
  assert.equal(stepLabel({ type: "fileChange", changes: [{ path: "a.ts" }] }), undefined);
  assert.equal(stepLabel({ type: "mcpToolCall", server: "bb", tool: "thread_watch_set" }), undefined);
});

test("the live status: the agent's own words first, a plain step second; silence → «Думаю над ответом…», never a tool", () => {
  const now = 100_000;
  assert.equal(progressText({ agentLine: "Спрошу Валлиса, можно ли выпустить раньше", step: "Ищу в переписке…", startedAt: now, now }),
    "⏳ Спрошу Валлиса, можно ли выпустить раньше\nИщу в переписке…");
  assert.equal(progressText({ agentLine: "Спрошу Валлиса, можно ли выпустить раньше", startedAt: now, now }),
    "⏳ Спрошу Валлиса, можно ли выпустить раньше");
  // No own line yet: nothing for the first seconds, then the neutral line; a service step adds nothing.
  assert.equal(progressText({ step: stepLabel({ type: "commandExecution", command: "bb thread tell thr_x hi" }), startedAt: now, now: now + 2000 }), undefined);
  assert.equal(progressText({ step: stepLabel({ type: "commandExecution", command: "bb thread tell thr_x hi" }), startedAt: now, now: now + 5000 }),
    "⏳ Думаю над ответом…");
  assert.equal(progressText({ step: "Читаю файл…", startedAt: now, now: now + 5000 }), "⏳ Думаю над ответом…\nЧитаю файл…");
  // A guest sees no text of the agent.
  assert.equal(progressText({ agentLine: "секрет из лички", step: "Ищу в переписке…", guest: true, startedAt: now, now: now + 5000 }),
    "⏳ Думаю над ответом…\nИщу в переписке…");
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

import { chooseTopicIcon } from "../turn-feedback";

test("С58: a new topic gets a fitting standard icon; a person's icon, no service or no right — nothing changes", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const stickers = [{ emoji: "💰", custom_emoji_id: "money" }, { emoji: "🛠", custom_emoji_id: "tools" }, { emoji: "📅", custom_emoji_id: "cal" }];
  const tg = async (m: string, b: Record<string, unknown>) => { calls.push([m, b]); return m === "getForumTopicIconStickers" ? stickers : true; };
  const choose = async (_input: string, _i: string, choices: { value: string }[]) => choices.find(c => c.value === "tools")?.value;
  assert.equal(await chooseTopicIcon(tg, -1, 40, "Ремонт CRM", undefined, choose), "tools");
  assert.deepEqual(calls.at(-1), ["editForumTopic", { chat_id: -1, message_thread_id: 40, icon_custom_emoji_id: "tools" }]);
  calls.length = 0;
  assert.equal(await chooseTopicIcon(tg, -1, 41, "Финансы", "person-set", choose), undefined);   // a person's icon is kept
  assert.equal(await chooseTopicIcon(tg, -1, 42, "Финансы", undefined, undefined), undefined);   // no service
  assert.deepEqual(calls, []);
  const noRight = async (m: string) => { if (m === "editForumTopic") throw Error("not enough rights"); return stickers; };
  assert.equal(await chooseTopicIcon(noRight as never, -1, 43, "Финансы", undefined, choose), undefined);   // silently
});
