import test from "node:test";
import assert from "node:assert/strict";
import { activeGroupSettings, authorStatus, rulesNote, saveGroupSettings, senderRole, setAccess, installKindKey } from "../rights";

// Решение владельца 23.11: в одной группе агент различает владельца, одобренного собеседника и участника группы.
test("three statuses in one open employee group", () => {
  const rows = new Map<string, any>();
  const store = { get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); }, list: () => [], atomic: (fn: () => void) => fn() };
  const OWNER = 1, APPROVED = 2, MEMBER = 3, BOT = 9, CHAT = -100;
  store.put(installKindKey, "employee");
  setAccess(store as never, BOT, [{ id: APPROVED, name: "Одобренный" }]);
  saveGroupSettings(store as never, BOT, CHAT, { who: "all" });
  const note = (sender: number) => rulesNote({ title: "Команда", settings: activeGroupSettings(store as never, BOT, CHAT), role: senderRole(store as never, BOT, OWNER, CHAT, sender),
    senderName: "X", status: authorStatus(store as never, BOT, OWNER, sender) });
  assert.match(note(OWNER), /Пишет X — владелец, может тебе поручать/);
  assert.match(note(APPROVED), /одобренный собеседник \(личный доступ выдан владельцем\), может тебе поручать/);
  const member = note(MEMBER);
  assert.match(member, /участник этой группы: может просить в пределах дела этой группы/);
  assert.doesNotMatch(member, /Пишет X — [^\n]*может тебе поручать/);
});
