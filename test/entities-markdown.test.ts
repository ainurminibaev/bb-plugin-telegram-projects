import test from "node:test";
import assert from "node:assert/strict";
import {entitiesToMarkdown,markdownLinks} from "../entities-markdown";
import {archiveRow} from "../archive";

test("0.9.74: a message's links and formatting are kept as Markdown common to channels", () => {
  const text = "Сводка: задача Склад и задача Касса — срочно";
  const entities = [
    {type: "text_link", offset: 15, length: 5, url: "https://ru.yougile.com/team/1/#task-1"},
    {type: "text_link", offset: 30, length: 5, url: "https://ru.yougile.com/team/1/#task-2"},
    {type: "bold", offset: 0, length: 6},
    {type: "underline", offset: 38, length: 6},
    {type: "text_mention", offset: 8, length: 6, user: {id: 1}} as any,
  ];
  const md = entitiesToMarkdown(text, entities)!;
  assert.equal(md, "**Сводка**: задача [Склад](https://ru.yougile.com/team/1/#task-1) и задача [Касса](https://ru.yougile.com/team/1/#task-2) — срочно");
  assert.deepEqual(markdownLinks(md).map(l => l.title), ["Склад", "Касса"]);
  assert.equal(entitiesToMarkdown("просто текст", []), undefined, "no entities — no field");
  assert.equal(entitiesToMarkdown("tg", [{type: "text_link", offset: 0, length: 2, url: "tg://user?id=1"}]), undefined, "a tg:// link stays text");
  assert.equal(entitiesToMarkdown("a\nb", [{type: "blockquote", offset: 0, length: 3}]), "> a\n> b");
});

test("0.9.74: the archive row of a message keeps the Markdown form", () => {
  const row = archiveRow({update_id: 1, message: {message_id: 5, date: 2_000_000_000, chat: {id: -1001, type: "supergroup"},
    from: {id: 7, first_name: "Бот"}, text: "Задача Склад", entities: [{type: "text_link", offset: 7, length: 5, url: "https://example.org/t/1"}]}});
  assert.equal(row?.markdown, "Задача [Склад](https://example.org/t/1)");
  assert.equal(row?.text, "Задача Склад");
});
