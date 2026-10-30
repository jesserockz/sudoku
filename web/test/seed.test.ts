import assert from "node:assert/strict";
import { test } from "node:test";
import { weekPuzzles } from "../src/api/models.ts";
import { generateDay } from "../src/generator/generator.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import {
  fingerprint, generateSeed, normalizeSeed, resultsSummary, seedSettings, seedWeek, weekSeed,
} from "../src/serverless/seed.ts";
import { buildShareLink, parseShareLink, percentEncode, shareFragment } from "../src/serverless/share-link.ts";

// The Go server's test secret (server/internal/seed/seed_test.go).
const serverSecret = "test-secret-0123456789";
const s = seedSettings;

test("the week seed matches the server's KDF", async () => {
  assert.equal(await weekSeed(serverSecret, "2026-W44"), "e4d2e1e00e3549cc");
  assert.equal(await weekSeed(serverSecret, "2020-W53"), "8ef3b5d3a4a37a74");
  // UTF-8 seeds, and one longer than SHA-256's block (hashed first).
  assert.equal(await weekSeed("Kōwhai 🌼 whānau", "2026-W44"), "45065fa404bf2ffe");
  assert.equal(await weekSeed("a".repeat(100), "2026-W44"), "8acc740767e736a8");
});

test("the week matches the server's week endpoint", async () => {
  // Monday 00:00 in Auckland is Sunday 11:00 UTC.
  assert.deepEqual(await seedWeek(s(serverSecret), Date.parse("2026-10-25T11:00:00Z")), {
    isoWeek: "2026-W44", seed: "e4d2e1e00e3549cc", weekStart: "2026-10-26", weekEnd: "2026-11-01",
    today: "2026-10-26", dayOfWeek: 1, timezone: "Pacific/Auckland", levels: 5,
  });
  const sunday = await seedWeek(s(serverSecret), Date.parse("2026-10-25T10:59:59Z"));
  assert.equal(sunday.isoWeek, "2026-W43");
  assert.equal(sunday.dayOfWeek, 7);
  const london = await seedWeek(s(serverSecret, 3, "Europe/London"), Date.parse("2026-10-25T11:00:00Z"));
  assert.equal(london.today, "2026-10-25");
  assert.equal(weekPuzzles(london).length, 3);
});

test("puzzles are the generator's for the derived week seed", async () => {
  const week = await seedWeek(s(serverSecret), Date.parse("2026-10-27T01:00:00Z"));
  const puzzles = weekPuzzles(week);
  assert.deepEqual(puzzles.map((p) => p.givens), generateDay(parseWeekSeed("e4d2e1e00e3549cc"), 2, 5).map((p) => p.givens));
  // Golden: pins the whole chain from seed text to puzzle.
  assert.equal(puzzles[0]!.givens, "160027450780100000050000008010094027427000301800702045598241060306008002001605000");
  // Case matters: the seed is used exactly as typed (after trimming).
  const other = await seedWeek(s("Rimu-Totara-Kauri"), Date.parse("2026-10-27T01:00:00Z"));
  assert.notEqual(weekPuzzles(other)[0]!.givens, puzzles[0]!.givens);
  assert.throws(() => weekPuzzles(week, "2026-11-02"));
});

test("seeds: normalised, generated and fingerprinted", async () => {
  assert.equal(normalizeSeed("  Rimu Kauri \n"), "Rimu Kauri");
  const seeds = Array.from({ length: 50 }, generateSeed);
  for (const seed of seeds) assert.match(seed, /^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$/);
  assert.equal(new Set(seeds).size, 50);
  assert.equal(await fingerprint(serverSecret), "#287caf");
  assert.notEqual(await fingerprint("a"), await fingerprint("b"));
  assert.throws(() => s(""));
  assert.throws(() => s(" padded "));
  assert.throws(() => s("x", 0));
  assert.throws(() => s("x", 11));
});

test("share links carry the settings in the fragment", () => {
  assert.equal(buildShareLink("https://sudoku.example.com/", s("k7mq4-xzp2a")), "https://sudoku.example.com/#seed=k7mq4-xzp2a&levels=5");
  assert.equal(
    buildShareLink("https://example.github.io/sudoku/#seed=old&levels=5", s("Rimu Kauri", 3, "Europe/London")),
    "https://example.github.io/sudoku/#seed=Rimu%20Kauri&levels=3&tz=Europe%2FLondon",
  );
  assert.equal(percentEncode("Kōwhai 🌼"), "K%C5%8Dwhai%20%F0%9F%8C%BC");
});

test("share links round-trip awkward seeds", () => {
  const seeds = ["plain", "Kōwhai 🌼 whānau", "a&b=c#d?e/f%g+h i", "%41 is not A", "100% sure", "tab\there", "日本語のシード", "'\"<>\\{}|^`[]", "~-._"];
  for (const seed of seeds) {
    for (const settings of [s(seed), s(seed, 10, "America/New_York")]) {
      const link = buildShareLink("https://h.example/sub/", settings);
      assert.deepEqual(parseShareLink(link), settings, link);
      assert.deepEqual(parseShareLink("#" + shareFragment(settings)), settings);
      assert.deepEqual(parseShareLink(shareFragment(settings)), settings);
      assert.match(link.split("#")[1]!, /^[A-Za-z0-9\-._~%=&]*$/);
    }
  }
});

test("share links written by other tools, or inside a message", () => {
  assert.deepEqual(parseShareLink("https://h/#seed=Rimu+Kauri"), s("Rimu Kauri"));
  assert.deepEqual(parseShareLink("#seed=a%2fb&levels=5"), s("a/b"));
  assert.deepEqual(parseShareLink("  https://h/#seed=Kōwhai 🌼&levels=5&v=2\n"), s("Kōwhai 🌼"));
  assert.deepEqual(parseShareLink("https://h/?ref=chat#levels=7&seed=x&seed=ignored"), s("x", 7));
  assert.deepEqual(parseShareLink("Play with us! https://h.example/sudoku/#seed=abc&levels=3 see you tomorrow"), s("abc", 3));
  assert.deepEqual(parseShareLink("Join:\nhttps://h/#seed=a%20b&levels=5\n"), s("a b"));
  assert.deepEqual(parseShareLink("#seed=%20abc%0A"), s("abc"));
  assert.deepEqual(parseShareLink("#seed=abc&tz="), s("abc"));
});

test("share links without valid settings are rejected", () => {
  const bad = ["", "just a seed", "the seed= is missing", "https://sudoku.example.com/", "https://sudoku.example.com/#", "#levels=5",
    "#seed=", "#seed=%20%20", "#seed=abc&levels=0", "#seed=abc&levels=11", "#seed=abc&levels=five",
    "#seed=abc&tz=Mars/Olympus_Mons", "#seed=%", "#seed=%4", "#seed=%zz", "#seed=%C3%28"];
  for (const text of bad) assert.equal(parseShareLink(text), null, text);
});

test("results summary", () => {
  assert.equal(
    resultsSummary("2026-10-27", "#3fa9c1", [{ title: "Easy", elapsedMs: 192_400 }, { title: "Medium", elapsedMs: 340_999 }, { title: "Hard", elapsedMs: null }]),
    "Sudoku 2026-10-27 #3fa9c1\nEasy 3:12\nMedium 5:40\nHard -\nSolved 2/3 in 8:53",
  );
  assert.equal(
    resultsSummary("2026-10-27", " ", [{ title: "Easy", elapsedMs: 60_000 }, { title: "Diabolical", elapsedMs: 3_600_000 }]),
    "Sudoku 2026-10-27\nEasy 1:00\nDiabolical 1:00:00\nTotal 1:01:00",
  );
});
