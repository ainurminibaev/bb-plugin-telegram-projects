import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {english} from "../locale";
import {BB_BUTTONS, bbMentionsOn, bbText, withoutBB} from "../bb-mentions";
import {translate} from "../locale";

const store = (kind?: string) => ({get: (k: string) => k === "rights:install-kind" ? kind : undefined} as any);

test("every text with BB has a version without it; links to BB are dropped", () => {
  const texts = new Set(Object.keys(english).filter(k => /\bBB\b/.test(k)));
  // Texts passed through tr(...) in the chat and server code, also those without an English entry.
  for (const file of ["chat.ts", "server.ts"])
    for (const m of readFileSync(file, "utf8").matchAll(/tr\(\s*("(?:[^"\\]|\\.)*")/g)) {
      const text = JSON.parse(m[1]);
      if (/\bBB\b/.test(text)) texts.add(text);
    }
  assert.ok(texts.size >= 25);
  for (const text of texts) {
    const out = withoutBB(text);
    assert.doesNotMatch(out, /\bBB\b/, text);
    if (BB_BUTTONS.has(text)) assert.equal(out, "");
  }
});

test("a question and its confirmation never name BB", () => {
  for (const file of ["chat.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /this\.tr\("❓ Вопрос\\n"\)/);
    assert.doesNotMatch(src, /Ответ передан BB|BB ждёт ответа|уже закрыт в BB/);
  }
});

test("the setting follows the install kind unless set", () => {
  assert.equal(bbMentionsOn(store("employee"), "auto"), false);
  assert.equal(bbMentionsOn(store("assistant"), "auto"), true);
  assert.equal(bbMentionsOn(store(undefined), undefined), true, "an install without a kind is the personal assistant");
  assert.equal(bbMentionsOn(store("employee"), "on"), true);
  assert.equal(bbMentionsOn(store("assistant"), "off"), false);
});

test("an English bridge without BB mentions has no BB either", () => {
  for (const [ru, en] of Object.entries(english)) {
    if (!/\bBB\b/.test(ru) && !/\bBB\b/.test(en)) continue;
    const out = bbText(t => translate("en", t), "en", false, ru);
    assert.doesNotMatch(out, /\bBB\b/, en);
  }
});
