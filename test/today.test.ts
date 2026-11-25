import test from "node:test";
import assert from "node:assert/strict";
import {holdFirstToday,today,todayLine} from "../today";

test("С103: «today» is the organization's day; the line says whether the agent wrote here and the local time", () => {
  // 2026-11-25 06:10 UTC = 09:10 in Moscow.
  const now = Date.UTC(2026, 10, 25, 6, 10);
  const first = today(undefined, now, "");
  assert.deepEqual([first.firstToday, first.localTime, first.timeZone], [true, "09:10", "Europe/Moscow"]);
  assert.equal(todayLine(first), "Сегодня ты в этом чате ещё не писал; сейчас 09:10 (Europe/Moscow).");
  // Wrote at 22:30 UTC the day before = 01:30 Moscow today: already wrote today.
  const night = today(Date.UTC(2026, 10, 24, 22, 30) / 1000, now, "Europe/Moscow");
  assert.equal(night.firstToday, false);
  assert.equal(todayLine(night), "Сегодня ты здесь уже писал (в 01:30); сейчас 09:10 (Europe/Moscow).");
  // Wrote at 20:00 UTC the day before = 23:00 Moscow yesterday: not today.
  assert.equal(today(Date.UTC(2026, 10, 24, 20, 0) / 1000, now, "Europe/Moscow").firstToday, true);
  // An unknown zone falls back to Moscow.
  assert.equal(today(undefined, now, "Nowhere/City").timeZone, "Europe/Moscow");
});

test("С103: the first send of the day into another place waits once per place and day, whatever the text", () => {
  const rows = new Map<string, unknown>();
  const store = { get: <T>(k: string) => rows.get(k) as T, put: (k: string, v: unknown) => { rows.set(k, v); } };
  const now = Date.UTC(2026, 10, 25, 6, 10);
  const first = today(undefined, now, "Europe/Moscow");
  assert.equal(holdFirstToday(store, "-1001:3", first), true, "the first one waits");
  assert.equal(holdFirstToday(store, "-1001:3", first), false, "the corrected text (any text) goes at once");
  assert.equal(holdFirstToday(store, "-1001:4", first), true, "another topic is another place");
  const wrote = today(Date.UTC(2026, 10, 25, 5, 0) / 1000, now, "Europe/Moscow");
  assert.equal(holdFirstToday(store, "-1002:0", wrote), false, "already wrote there today: no wait");
  const tomorrow = today(Date.UTC(2026, 10, 25, 6, 10) / 1000, now + 24 * 3600_000, "Europe/Moscow");
  assert.equal(holdFirstToday(store, "-1001:3", tomorrow), true, "a new day waits once again");
});
