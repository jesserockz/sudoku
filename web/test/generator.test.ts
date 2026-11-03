import assert from "node:assert/strict";
import { test } from "node:test";
import { countSolutions, solve } from "../src/generator/solver.ts";
import {
  DEFAULT_LEVELS, DIFFICULTIES, GENERATOR_VERSION, MAX_ENDLESS_NUMBER, MAX_LEVELS, difficultyFor, endlessPuzzleSeed, endlessTitle,
  generate, generateDay, generateEndless, isEndlessNumber, puzzleSeed, puzzleTitle,
} from "../src/generator/generator.ts";
import { Board } from "../src/core/board.ts";
import { SplitMix64, Xoshiro256StarStar } from "../src/generator/random.ts";
import { formatWeekSeed, parseWeekSeed } from "../src/generator/week-seed.ts";

const signed = (x: bigint) => BigInt.asIntN(64, x);

test("SplitMix64 matches the reference", () => {
  const sm = new SplitMix64(1234567n);
  assert.deepEqual([sm.next(), sm.next(), sm.next()].map(signed), [6457827717110365317n, 3203168211198807973n, -8629252141511181193n]);
});

test("xoshiro256** matches the reference", () => {
  const x = new Xoshiro256StarStar(42n);
  assert.deepEqual(
    Array.from({ length: 4 }, () => signed(x.nextU64())),
    [1546998764402558742n, 6990951692964543102n, -5902157311460992607n, -1389169964527427423n],
  );
});

test("nextInt sequence is pinned and stays in range", () => {
  const x = new Xoshiro256StarStar(42n);
  assert.deepEqual(Array.from({ length: 8 }, () => x.nextInt(9)), [6, 2, 6, 1, 8, 7, 2, 6]);
  const y = new Xoshiro256StarStar(7n);
  const seen = new Array(9).fill(0);
  for (let i = 0; i < 9000; i++) seen[y.nextInt(9)]++;
  assert.ok(seen.every((n) => n >= 800 && n <= 1200), `skewed: ${seen}`);
  assert.equal(y.nextInt(1), 0);
  assert.throws(() => y.nextInt(0));
});

test("week seeds round-trip as 16 hex characters", () => {
  assert.equal(formatWeekSeed(parseWeekSeed("9F2C4A1B7E30D5C8")), "9f2c4a1b7e30d5c8");
  assert.equal(formatWeekSeed(0n), "0000000000000000");
  assert.throws(() => parseWeekSeed("123"));
  assert.throws(() => parseWeekSeed("zzzzzzzzzzzzzzzz"));
});

// Golden puzzles: what guarantees everyone (and every app version) generates the same puzzles.
// Don't update these unless the change is deliberate, and bump GENERATOR_VERSION when it is.
const goldens: [string, number, number, string, string][] = [
  ["9f2c4a1b7e30d5c8", 1, 1,
    "020091683006050000817600520080405071002080946470069000700918000100006754203000090",
    "524791683936852417817643529689435271352187946471269835745918362198326754263574198"],
  ["9f2c4a1b7e30d5c8", 1, 2,
    "630897020480650700025031000010005000800019003002068104260004300004003008007006040",
    "631897425489652731725431986913245867846719253572368194268574319154923678397186542"],
  ["9f2c4a1b7e30d5c8", 1, 3,
    "090054010504000007000830090050009000000020309930760004068203070109070800300180000",
    "793654218584912637216837495851349726647521389932768154468293571129475863375186942"],
  ["9f2c4a1b7e30d5c8", 1, 4,
    "007008903001000082020004710309000000100206000800090306003000600204000079010000500",
    "457128963631579482928364715369785241145236897872491356593817624284653179716942538"],
  ["9f2c4a1b7e30d5c8", 1, 5,
    "000004010600000009801057002005600000930000805000000400700040006004000020302080000",
    "593264718627813549841957632415678293936421875278395461759142386184536927362789154"],
  ["0000000000000000", 7, 5,
    "000300001504009600000000080020917050005000000000850030406705020000000004030020000",
    "289376541514289673367541289823917456975463812641852937496735128752198364138624795"],
  ["ffffffffffffffff", 4, 3,
    "700300000259108006000024800000000100017002003823610007000780630061050000370060000",
    "784396215259178346136524879495837162617942583823615497542789631961453728378261954"],
  ["0123456789abcdef", 3, 1,
    "003000061000010732028003005260807000480060000307021680030006408015030296946002570",
    "573249861694518732128673945261897354489365127357421689732956418815734296946182573"],
  ["8000000000000000", 6, 4,
    "001000009637000000800657301003000000500008006900500487060705000070094008000000090",
    "251843679637921854894657321783469512542178936916532487169785243375294168428316795"],
];

test("generator version and puzzle seed are pinned", () => {
  assert.equal(GENERATOR_VERSION, 1);
  assert.equal(signed(puzzleSeed(parseWeekSeed("9f2c4a1b7e30d5c8"), 1, 1)), 4473328950258826066n);
});

test("golden puzzles", () => {
  for (const [seed, day, level, givens, solution] of goldens) {
    const p = generate(parseWeekSeed(seed), day, level);
    assert.equal(p.givens, givens, `givens for ${seed} day ${day} level ${level}`);
    assert.equal(p.solution, solution, `solution for ${seed} day ${day} level ${level}`);
  }
});

test("generated puzzles have a unique solution that matches", () => {
  for (const p of generateDay(parseWeekSeed("0123456789abcdef"), 2)) {
    const grid = [...p.givens].map(Number);
    assert.equal(countSolutions(grid), 1);
    assert.equal(solve(grid)!.join(""), p.solution);
    assert.ok(p.givenCount >= p.difficulty.targetGivens);
  }
});

test("levels spread across the tiers", () => {
  const tiers = (n: number) => Array.from({ length: n }, (_, i) => difficultyFor(i + 1, n).name);
  assert.deepEqual(tiers(5), ["Easy", "Medium", "Hard", "Expert", "Diabolical"]);
  assert.deepEqual(tiers(7), ["Easy", "Medium", "Medium", "Hard", "Expert", "Expert", "Diabolical"]);
  assert.deepEqual(tiers(3), ["Easy", "Hard", "Diabolical"]);
  assert.deepEqual(tiers(1), ["Hard"]);
  assert.deepEqual(tiers(10), ["Easy", "Easy", "Medium", "Medium", "Hard", "Hard", "Expert", "Expert", "Diabolical", "Diabolical"]);
  assert.equal(puzzleTitle(2, 7), "Medium 1");
  assert.equal(puzzleTitle(3, 7), "Medium 2");
  assert.equal(puzzleTitle(4, 7), "Hard");
  assert.throws(() => difficultyFor(1, MAX_LEVELS + 1));
  assert.throws(() => difficultyFor(DEFAULT_LEVELS + 1, DEFAULT_LEVELS));
});

test("games sharing a tier get different puzzles", () => {
  const day = generateDay(parseWeekSeed("9f2c4a1b7e30d5c8"), 1, 10);
  assert.equal(new Set(day.map((p) => p.givens)).size, 10);
});

// Endless goldens: the server's Go port (server/internal/puzzle) is pinned to these same vectors.
const endlessGoldens: [string, number, number, string, string, string][] = [
  ["9f2c4a1b7e30d5c8", 1, 1, "45e399388c9d16e9", "608007201942051768000862490203700080871600520050080000060120005007040030020000046", "638497251942351768715862493293715684871634529456289317364128975587946132129573846"],
  ["9f2c4a1b7e30d5c8", 5, 1, "0e552db1aa008165", "000006004310400000000501002000200038700060040000008006520600000003000000008190700", "259786314316429857847531692694217538782365149135948276521674983973852461468193725"],
  ["0123456789abcdef", 3, 2, "e1e47b90e6f7744f", "090010000516002070000507000000041060003009204041600700300100800000780032085300107", "792418653516932478834567921978241365653879214241653789327195846169784532485326197"],
  ["0123456789abcdef", 2, 1000000, "91861766ec2934e3", "090000034538004206000300708000146903316090000984000002460089307700060020000001600", "197628534538974216642315798275146983316892475984537162461289357759463821823751649"],
  ["ffffffffffffffff", 4, 9007199254740991, "494cf19e7268c89e", "800005010007000004030000090004150002701409060600800000003200000100008320078010600", "862945713917623584435781296384156972721439865659872431593267148146598327278314659"],
];

test("golden endless puzzles", () => {
  for (const [seed, tier, number, puzzleSeedHex, givens, solution] of endlessGoldens) {
    const at = `${seed} difficulty ${tier} #${number}`;
    assert.equal(formatWeekSeed(endlessPuzzleSeed(parseWeekSeed(seed), tier, number)), puzzleSeedHex, `seed for ${at}`);
    const p = generateEndless(parseWeekSeed(seed), tier, number);
    assert.equal(p.givens, givens, `givens for ${at}`);
    assert.equal(p.solution, solution, `solution for ${at}`);
    assert.equal(p.difficulty, DIFFICULTIES[tier - 1]);
    assert.equal(p.number, number);
    assert.ok(p.givenCount >= p.difficulty.targetGivens);
    assert.equal(p.board().get(0), Board.parse(givens).get(0));
  }
  assert.equal(generateEndless(parseWeekSeed("9f2c4a1b7e30d5c8"), 3, 12).title, "Hard #12");
  assert.equal(endlessTitle(5, 1), "Diabolical #1");
});

test("endless puzzles never repeat a daily one's seed", () => {
  const seed = parseWeekSeed("9f2c4a1b7e30d5c8");
  const daily = new Set<bigint>();
  for (let day = 1; day <= 7; day++) for (let level = 1; level <= MAX_LEVELS; level++) daily.add(puzzleSeed(seed, day, level));
  for (let tier = 1; tier <= 5; tier++) for (let n = 1; n <= 10; n++) assert.ok(!daily.has(endlessPuzzleSeed(seed, tier, n)));
});

test("endless arguments are checked", () => {
  const seed = parseWeekSeed("9f2c4a1b7e30d5c8");
  for (const tier of [0, 6, 1.5]) assert.throws(() => generateEndless(seed, tier, 1), RangeError);
  for (const n of [0, -1, 1.5, MAX_ENDLESS_NUMBER + 1]) assert.throws(() => generateEndless(seed, 1, n), RangeError);
  assert.equal(isEndlessNumber(MAX_ENDLESS_NUMBER), true);
  assert.equal(isEndlessNumber(0), false);
});
