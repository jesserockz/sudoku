import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, describeDate, formatTimestamp, inWeek, isIsoDate, isValidZone, weekAt, weekOf } from "../src/game/calendar.ts";

// The same cases as the server's week_test.go, so both sides agree.
const cases: [string, string, string, string, string, string, number][] = [
  ["wednesday", "2026-10-28T01:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-28", 3],
  ["sunday last second", "2026-10-25T10:59:59Z", "2026-W43", "2026-10-19", "2026-10-25", "2026-10-25", 7],
  ["monday first second", "2026-10-25T11:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-26", 1],
  ["before DST start", "2026-09-26T13:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7],
  ["after DST start", "2026-09-26T14:00:00Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7],
  ["week after DST start, Sunday end", "2026-09-27T10:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7],
  ["week after DST start, Monday", "2026-09-27T11:00:00Z", "2026-W40", "2026-09-28", "2026-10-04", "2026-09-28", 1],
  ["DST end Sunday late", "2026-04-05T11:59:59Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7],
  ["DST end next Monday", "2026-04-05T12:00:00Z", "2026-W15", "2026-04-06", "2026-04-12", "2026-04-06", 1],
  ["DST end repeated hour", "2026-04-04T14:30:00Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7],
  ["2020-W53 new year's day", "2021-01-01T00:00:00+13:00", "2020-W53", "2020-12-28", "2021-01-03", "2021-01-01", 5],
  ["2021-W01 monday", "2021-01-04T00:00:00+13:00", "2021-W01", "2021-01-04", "2021-01-10", "2021-01-04", 1],
  ["2026-W01 starts in 2025", "2025-12-29T09:00:00+13:00", "2026-W01", "2025-12-29", "2026-01-04", "2025-12-29", 1],
  ["2026-W53", "2026-12-31T12:00:00+13:00", "2026-W53", "2026-12-28", "2027-01-03", "2026-12-31", 4],
  ["auckland new year before UTC", "2026-12-31T11:00:00Z", "2026-W53", "2026-12-28", "2027-01-03", "2027-01-01", 5],
  ["2027-W01", "2027-01-04T00:00:00+13:00", "2027-W01", "2027-01-04", "2027-01-10", "2027-01-04", 1],
  ["2027-W52 last week", "2028-01-02T12:00:00+13:00", "2027-W52", "2027-12-27", "2028-01-02", "2028-01-02", 7],
  ["2028-W01", "2028-01-03T00:00:00+13:00", "2028-W01", "2028-01-03", "2028-01-09", "2028-01-03", 1],
];

test("weekAt matches the server's rules", () => {
  for (const [name, at, isoWeek, weekStart, weekEnd, today, dayOfWeek] of cases) {
    assert.deepEqual(weekAt(Date.parse(at)), { isoWeek, weekStart, weekEnd, today, dayOfWeek }, name);
  }
});

test("other timezones", () => {
  // Monday in Auckland is still Sunday morning in London.
  assert.equal(weekAt(Date.parse("2026-10-25T11:00:00Z"), "Europe/London").isoWeek, "2026-W43");
  assert.ok(isValidZone("Europe/London"));
  assert.ok(!isValidZone("Mars/Olympus"));
  assert.ok(!isValidZone(""));
});

test("weeks contain their days", () => {
  const week = weekOf("2026-10-28");
  assert.ok(inWeek(week, "2026-10-26") && inWeek(week, "2026-11-01"));
  assert.ok(!inWeek(week, "2026-10-25") && !inWeek(week, "2026-11-02"));
});

test("date helpers", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(describeDate("2026-10-26"), "Monday 2026-10-26");
  assert.ok(isIsoDate("2026-02-28") && !isIsoDate("2026-02-30") && !isIsoDate("26-2-1"));
});

test("timestamps carry the Auckland offset", () => {
  assert.equal(formatTimestamp(Date.parse("2026-10-25T20:15:00Z")), "2026-10-26T09:15:00+13:00");
  assert.equal(formatTimestamp(Date.parse("2026-07-05T21:15:07.900Z")), "2026-07-06T09:15:07+12:00");
  const now = Date.parse("2026-12-31T11:00:00Z");
  assert.equal(Date.parse(formatTimestamp(now)), now);
});
