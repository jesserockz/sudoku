// End-to-end check of endless puzzles against a running server in dev auth mode that serves web/dist,
// with `ann` as admin (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/endless.cjs [http://localhost:8080] [screenshot dir]
//
// A fresh player opens the Endless tab (remembered across a reload), plays Easy #1 with a reload part
// way, and solves it. The result uploads with a replay the server accepts; the tab then offers #2, and
// the endless leaderboards list the player. A second player gets the same puzzle, and the admin results
// screen lists the result under Endless.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const player = { sub: "endless" + run, name: "Edna" + run };
const ann = { sub: "ann", name: "Ann" };

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

const api = (user, path) => fetch(`${base}/api/v1/${path}`, { headers: { Authorization: `Bearer dev:${user.sub}:${user.name}` } });

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

async function signIn(browser, user) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(base + "/");
  await page.fill("#sub", user.sub);
  await page.fill("#name", user.name);
  await page.click("button[type=submit]");
  await page.getByRole("tab", { name: "Daily" }).waitFor();
  return page;
}

const readGrid = async (cells) =>
  (await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));

(async () => {
  const browser = await chromium.launch();
  const page = await signIn(browser, player);
  await shot(page, "home-daily");

  await page.getByRole("tab", { name: "Endless" }).click();
  await page.getByRole("button", { name: "Play #1" }).first().waitFor();
  check(await page.getByText("None solved yet").count() === 5, "every difficulty starts with nothing solved");
  await shot(page, "home-endless");
  await page.reload();
  await page.getByRole("button", { name: "Play #1" }).first().waitFor();
  check(await page.getByRole("tab", { name: "Endless", selected: true }).count() === 1, "the tab is remembered after a reload");

  // Easy #1, with a reload part way: it resumes like a daily.
  await page.getByRole("button", { name: "Play #1" }).first().click();
  await page.getByText("Easy #1").waitFor();
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const grid = await readGrid(cells);
  const solution = grid.slice();
  check(solve(solution), "the puzzle has a solution");
  const empties = grid.flatMap((d, i) => (d === 0 ? [i] : []));
  const half = Math.floor(empties.length / 2);
  for (const i of empties.slice(0, half)) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(40);
  }
  await page.reload();
  await page.getByRole("button", { name: "Resume #1" }).waitFor();
  await shot(page, "home-endless-in-progress");
  await page.getByRole("button", { name: "Resume #1" }).click();
  await cells.first().waitFor();
  check((await readGrid(cells)).filter((d) => d !== 0).length === grid.filter((d) => d !== 0).length + half, "the game resumes where it was");
  await page.waitForTimeout(5000);
  for (const i of empties.slice(half)) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(40);
  }
  await page.getByText("Solved in", { exact: false }).waitFor();
  await shot(page, "endless-solved");
  await page.waitForFunction(() => localStorage.getItem("sudoku.endless-pending") == null, null, { timeout: 15000 });

  let res = await api(player, "me/endless");
  const mine = (await res.json()).results;
  check(mine.length === 1 && mine[0].difficulty === 1 && mine[0].number === 1, "the result reached the server");

  // The tab moves on to #2.
  await page.getByRole("button", { name: "Endless puzzles" }).click();
  await page.getByRole("button", { name: "Play #2" }).waitFor();
  check(await page.getByText("1 solved").count() === 1, "Easy shows one solved");
  await shot(page, "home-endless-progress");

  // Leaderboards: progress per difficulty, and the puzzle's own times.
  await page.getByRole("button", { name: "Leaderboard" }).click();
  await page.getByText(player.name).waitFor();
  check(await page.getByText("up to #1").count() >= 1, "the progress board shows the highest number");
  await shot(page, "endless-leaderboard");
  await page.fill("#endless-board-number", "1");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Easy #1").waitFor();
  await page.getByText(player.name).waitFor();
  await shot(page, "endless-puzzle-board");

  // Any number can be opened.
  await page.getByText("‹ Back").click();
  await page.selectOption("#endless-difficulty", "3");
  await page.fill("#endless-number", "42");
  await page.getByRole("button", { name: "Open" }).click();
  await page.getByText("Hard #42").waitFor();
  check(true, "a chosen number opens");

  // Everyone gets the same puzzle.
  const other = await signIn(browser, { sub: "other" + run, name: "Otto" + run });
  await other.getByRole("tab", { name: "Endless" }).click();
  await other.getByRole("button", { name: "Play #1" }).first().click();
  await other.locator("[role=gridcell]").first().waitFor();
  check((await readGrid(other.locator("[role=gridcell]"))).join("") === grid.join(""), "another player gets the same Easy #1");

  // The admin sees the result, and its replay passed the server's checks.
  const today = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.week")).today);
  res = await api(ann, `admin/endless/results?date=${today}`);
  const listed = (await res.json()).results.find((r) => r.displayName === player.name);
  check(listed && listed.replay === "valid" && listed.flag === null, "the admin list has the result with a valid replay");
  const admin = await signIn(browser, ann);
  await admin.getByRole("button", { name: "About" }).click();
  await admin.getByRole("button", { name: "Admin" }).click();
  await admin.getByRole("button", { name: "Results and replays" }).click();
  await admin.getByRole("button", { name: "Endless" }).click();
  await admin.getByText(player.name).first().click();
  await admin.getByText("Reveal digits (shows the solution)").waitFor();
  check(await admin.getByText("Easy #1", { exact: false }).count() >= 1, "the endless replay opens");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
