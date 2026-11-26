import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {agentText} from "../outbound-message";

// 0.9.77: an agent's text reaches people only through one conversion (Markdown → Telegram HTML, plain words if
// refused). A direct Telegram send is allowed only where the bridge sends its own words or renders through that
// conversion itself — every such file is named here with the reason. A new file that sends directly must be added
// here on purpose, after a look at where its text comes from.
const ALLOWED: Record<string, string> = {
  "outbound-message.ts": "the conversion itself (agentText, sendFormattedText, sendFormattedFile, captions, edits)",
  "chat.ts": "the owner's chat: renders through renderTelegramParts, falls back to plainFromHtml; its own service lines",
  "group-worker.ts": "group answers: parts of renderTelegramParts, captions through formattedCaption, plainFromHtml fallback",
  "group-result.ts": "subthread and task results: renderTelegramParts, plainFromHtml fallback",
  "media-album.ts": "albums: captions are file labels",
  "server.ts": "the bridge's own lines (menus, statuses, errors); agent text goes through outbound-message helpers",
  "consent.ts": "consent cards — the bridge's own words",
  "employee-policy.ts": "the employee's setup screens — the bridge's own words",
  "employee-private.ts": "access requests and statuses — the bridge's own words",
  "forum-commands.ts": "forum command replies — the bridge's own words",
  "forum-delegation.ts": "delegation statuses — the bridge's own words",
  "group-visibility.ts": "visibility notices — the bridge's own words",
  "owner-ask.ts": "forwarding the person's original message (a quote, not the agent's Markdown)",
  "owner-selection.ts": "selection screens — the bridge's own words",
  "setup-screens.ts": "group setup screens and the greeting — the bridge's own words",
  "action-buttons.ts": "С118 click mark (✓ Label — Name) appended to existing message while keeping inline buttons",
};
const SEND = /\(\s*"(sendMessage|editMessageText|editMessageCaption|sendPhoto|sendDocument|sendVideo|sendMediaGroup)"\s*,/;

test("0.9.77: no file sends to Telegram directly unless it is on the reviewed list; agent texts of channels and new topics go through the one point", () => {
  const root = new URL("..", import.meta.url).pathname;
  const direct = readdirSync(root).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .filter(f => SEND.test(readFileSync(root + f, "utf8")));
  for (const f of direct) assert.ok(ALLOWED[f], `${f} sends to Telegram directly — route an agent's text through outbound-message or list the file with a reason`);
  for (const f of ["channel-post.ts", "owner-topic.ts"]) assert.ok(!direct.includes(f), `${f} carries an agent's text: only through sendAgentText`);
});

test("0.9.77: the one point gives HTML for Telegram and the same words without marks for a refused formatting", () => {
  const {html, plain} = agentText("**Итог:** см. [отчёт](https://example.org/r)");
  assert.match(html!, /<b>Итог:<\/b>/);
  assert.doesNotMatch(plain, /\*\*|<b>|\]\(/);
  assert.match(plain, /отчёт \(https:\/\/example\.org\/r\)/);
});
