import test from "node:test";
import assert from "node:assert/strict";
import {today,todayLine} from "../today";

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
