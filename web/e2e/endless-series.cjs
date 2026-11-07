// End-to-end check of the endless series (one numbered series per generator version) against a running
// server in dev auth mode that serves web/dist (see docs/WEB.md, "Checking offline play"), with any database:
//
//   node web/e2e/endless-series.cjs [http://localhost:8080] [screenshot dir] [database file]
//
// The week's generator can only be scheduled from next week, so the script changes it the way an elapsed
// week would: it writes a generator_schedule row for the current ISO week into the database file with the
// sqlite3 command line tool, and removes it again at the end (the server reads the schedule on every request).
//
// A player solves Classic Easy #1 and leaves Classic Easy #2 half done. The week then flips to Graded: the
// Endless tab shows the "Graded series" with nothing solved and lists the unfinished Classic game, which can
// still be resumed and solved. Graded Easy #1 is a different puzzle with its own result, leaderboard and Stats
// numbers; flipping back to Classic resumes the Classic progress exactly where it was. Screenshots are taken
// at phone width.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const db = process.argv[4] || null;
const run = String(Date.now()).slice(-6);
const player = { sub: "series" + run, name: "Sera" + run };

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

/** Backtracking solver over 81 digits (0 = empty). */
function solve(grid) {
  const i = grid.indexOf(0);
  if (i < 0) return true;
  const r = Math.floor(i / 9), c = i % 9;
  for (let d = 1; d <= 9; d++) {
    let ok = true;
    for (let k = 0; k < 9 && ok; k++) {
      const br = 3 * Math.floor(r / 3) + Math.floor(k / 3), bc = 3 * Math.floor(c / 3) + (k % 3);
      if (grid[r * 9 + k] === d || grid[k * 9 + c] === d || grid[br * 9 + bc] === d) ok = false;
    }
    if (!ok) continue;
    grid[i] = d;
    if (solve(grid)) return true;
  }
  grid[i] = 0;
  return false;
}

const api = (path) => fetch(`${base}/api/v1/${path}`, { headers: { Authorization: `Bearer dev:${player.sub}:${player.name}` } }).then((r) => r.json());

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

const sqlite = (sql) => execFileSync("sqlite3", [db, sql], { encoding: "utf8" });

const readGrid = async (cells) =>
  (await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));

/** Fills `count` of the empty cells (all when omitted) with their solution digits. Returns the starting grid. */
async function fill(page, count = Infinity) {
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const grid = await readGrid(cells);
  const solution = grid.slice();
  check(solve(solution), "the puzzle has a solution");
  const empties = grid.flatMap((d, k) => (d === 0 ? [k] : [])).slice(0, count);
  // The server rejects solves faster than its minimum time, so a whole puzzle takes a few seconds.
  if (count === Infinity) await page.waitForTimeout(5000);
  for (const i of empties) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(40);
  }
  return grid;
}

const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, colorScheme: "light" };

(async () => {
  if (!db) throw new Error("usage: endless-series.cjs <base url> <screenshot dir or ''> <database file>");
  const week = await (await fetch(`${base}/api/v1/week`, { headers: { Authorization: "Bearer dev:ann:Ann" } })).json();
  check(week.generator === 1, "the week starts on Classic");
  const thisWeek = week.isoWeek;
  const flipTo = (version) => {
    sqlite(`DELETE FROM generator_schedule WHERE effective_week = '${thisWeek}'`);
    if (version !== 1) sqlite(`INSERT INTO generator_schedule (effective_week, version) VALUES ('${thisWeek}', ${version})`);
  };
  flipTo(1);

  const browser = await chromium.launch();
  let page;
  try {
    page = await (await browser.newContext(phone)).newPage();
    page.on("pageerror", (e) => console.log("page error:", e.message));
    await page.goto(base + "/");
    await page.fill("#sub", player.sub);
    await page.fill("#name", player.name);
    await page.click("button[type=submit]");
    await page.getByRole("tab", { name: "Endless" }).click();
    await page.getByRole("button", { name: "Got it" }).click();
    await page.locator("#endless-series", { hasText: "Classic series" }).waitFor();
    check(true, "a Classic week shows the Classic series");

    // Classic Easy #1 solved, Classic Easy #2 half done.
    await page.getByRole("button", { name: "Play #1" }).first().click();
    await page.getByText("Classic · Easy #1").waitFor();
    check(true, "the play screen names the series");
    const classicOne = await fill(page);
    await page.getByText("Solved in", { exact: false }).waitFor();
    await page.waitForFunction(() => localStorage.getItem("sudoku.endless-pending") == null, null, { timeout: 15000 });
    await page.getByRole("button", { name: "Endless puzzles" }).click();
    await page.getByRole("button", { name: "Play #2" }).first().click();
    await page.getByText("Classic · Easy #2").waitFor();
    const classicTwo = await fill(page, 20);
    await page.getByText("‹ Back").click();
    await page.getByRole("button", { name: "Resume #2" }).waitFor();
    check((await api("me/endless")).results.length === 1, "one Classic result is on the server");

    // The week moves to Graded.
    flipTo(2);
    await page.reload();
    await page.locator("#endless-series", { hasText: "Graded series" }).waitFor();
    check(await page.getByText("None solved yet").count() === 5, "the Graded series starts with nothing solved");
    check(await page.getByRole("button", { name: "Play #1" }).count() === 5, "every difficulty offers Graded #1");
    const elsewhere = page.locator("#endless-elsewhere");
    await elsewhere.waitFor();
    check((await elsewhere.innerText()).includes("Classic Easy #2"), "the unfinished Classic game is listed");
    await shot(page, "endless-graded-leftover-classic");

    // Graded Easy #1 is another puzzle, and solving it makes a Graded result.
    await page.getByRole("button", { name: "Play #1" }).first().click();
    await page.getByText("Graded · Easy #1").waitFor();
    const gradedOne = await fill(page);
    check(gradedOne.join("") !== classicOne.join(""), "Graded Easy #1 is not Classic Easy #1");
    await page.getByText("Solved in", { exact: false }).waitFor();
    await page.waitForFunction(() => localStorage.getItem("sudoku.endless-pending") == null, null, { timeout: 15000 });
    const mine = (await api("me/endless")).results;
    check(mine.length === 2 && mine.some((r) => r.generator === 2 && r.number === 1) && mine.some((r) => r.generator === 1 && r.number === 1),
      "the server holds one result per series");
    const admin = await fetch(`${base}/api/v1/admin/endless/results?date=${week.today}`, { headers: { Authorization: "Bearer dev:ann:Ann" } });
    if (admin.ok) {
      const listed = (await admin.json()).results.find((r) => r.displayName === player.name && r.generator === 2);
      check(listed && listed.replay === "valid", "the Graded replay is checked against the Graded puzzle");
    }
    await page.getByRole("button", { name: "Endless puzzles" }).click();
    await page.getByRole("button", { name: "Play #2" }).first().waitFor();
    check(await page.getByText("1 solved").count() === 1, "the Graded series shows one solved");
    await page.locator("#endless-elsewhere").waitFor();
    await shot(page, "endless-graded-progress");

    // The leaderboard is the Graded one, with a switch to Classic.
    await page.getByRole("button", { name: "Leaderboard" }).click();
    await page.getByText(player.name).waitFor();
    check((await page.locator(".generator-tabs button.active").innerText()) === "Graded", "the leaderboard opens on the Graded series");
    check(await page.getByText("Graded Easy: puzzles solved").count() === 1, "its heading names the series");
    await shot(page, "endless-leaderboard-graded");
    await page.locator(".generator-tabs").getByRole("button", { name: "Classic" }).click();
    await page.getByText("Classic Easy: puzzles solved").waitFor();
    await page.getByText(player.name).waitFor();
    const classicBoard = await api("endless/leaderboard?generator=1");
    check(classicBoard.generator === 1 && classicBoard.difficulties[0].players.some((p) => p.displayName === player.name && p.completed === 1),
      "the Classic leaderboard counts only Classic");
    await page.getByText("‹ Back").click();

    // The unfinished Classic game resumes where it was and can be finished.
    await page.locator("#endless-elsewhere").getByRole("button", { name: "Resume" }).click();
    await page.getByText("Classic · Easy #2").waitFor();
    const resumed = await readGrid(page.locator("[role=gridcell]"));
    check(resumed.filter((d) => d !== 0).length === classicTwo.filter((d) => d !== 0).length + 20, "the Classic game resumes where it was");
    await fill(page);
    await page.getByText("Solved in", { exact: false }).waitFor();
    await page.waitForFunction(() => localStorage.getItem("sudoku.endless-pending") == null, null, { timeout: 15000 });
    check((await api("me/endless")).results.length === 3, "the Classic result of #2 reached the server");

    // Stats follow the same toggle as the daily numbers.
    await page.getByRole("button", { name: "Endless puzzles" }).click();
    await page.locator("#endless-elsewhere").waitFor({ state: "detached" });
    check(true, "nothing is left unfinished in another series");
    await page.getByRole("button", { name: "Stats" }).click();
    await page.locator(".generator-tabs").waitFor();
    const statsOf = async (generator) => {
      await page.locator(".generator-tabs").getByRole("button", { name: generator }).click();
      await page.locator(`.generator-tabs button.active`, { hasText: generator }).waitFor();
      await page.getByText(`The ${generator} series`).waitFor();
      return page.locator(".card", { hasText: "Endless" }).last().locator("tbody tr").first().innerText();
    };
    check((await statsOf("Graded")).replace(/\s+/g, " ").includes("Easy 1 #1"), "Stats shows the Graded series: one solved, up to #1");
    await shot(page, "stats-endless-graded");
    check((await statsOf("Classic")).replace(/\s+/g, " ").includes("Easy 2 #2"), "Stats shows the Classic series: two solved, up to #2");
    await page.getByText("‹ Back").click();

    // Back to Classic: that series is where it was left.
    flipTo(1);
    await page.reload();
    await page.locator("#endless-series", { hasText: "Classic series" }).waitFor();
    await page.getByRole("button", { name: "Play #3" }).first().waitFor();
    check(await page.getByText("2 solved").count() === 1, "Classic resumes with its two solved");
  } catch (e) {
    await shot(page, "failure");
    throw e;
  } finally {
    flipTo(1);
    await browser.close();
  }
  console.log("all endless series checks passed");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
