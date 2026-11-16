// End-to-end check of the Variants tab (Diagonal, Jigsaw, Killer) against a running server in dev auth mode that
// serves web/dist, with `ann` as admin (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/variants.cjs [http://localhost:8080] [screenshot dir]
//
// A fresh player opens the Variants tab, which explains itself once, and picks each variant in turn: Easy #1 of
// each draws its layout (shaded diagonals, jigsaw region borders, killer cages with their sums). A digit that only
// breaks a variant's rule (a repeat on a diagonal, or in a jigsaw region) shows as a conflict. Killer Easy #1 is
// solved through the UI with the solution from the app's own generator (the endless seed is in localStorage), its
// result uploads with a replay the server accepts, and the Killer leaderboard, the puzzle's board, Stats and the
// admin replay (drawn with its cages) all have it. Seed play has the tab too. Screenshots are at phone width, in
// light and dark.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const player = { sub: "variants" + run, name: "Vera" + run };
const ann = { sub: "ann", name: "Ann" };
const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, colorScheme: "light" };

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

const api = (user, p) => fetch(`${base}/api/v1/${p}`, { headers: { Authorization: `Bearer dev:${user.sub}:${user.name}` } }).then((r) => r.json());

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

/** The app's own puzzle generator (Node runs the TypeScript sources), for the solution of a variant puzzle. */
async function engine() {
  const src = path.resolve(__dirname, "../src/generator");
  const variants = await import(pathToFileURL(path.join(src, "variants.ts")).href);
  const weekSeed = await import(pathToFileURL(path.join(src, "week-seed.ts")).href);
  return { generate: (seed, generator, variant, tier, number) => variants.generateEndlessVariant(generator, variant, weekSeed.parseWeekSeed(seed), tier, number) };
}

const readGrid = async (cells) =>
  (await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));

const rowOf = (i) => Math.floor(i / 9);
const colOf = (i) => i % 9;
const boxOf = (i) => 3 * Math.floor(rowOf(i) / 3) + Math.floor(colOf(i) / 3);
/** Whether two cells share a row, column or box: a standard Sudoku conflict. */
const standardPeers = (a, b) => a !== b && (rowOf(a) === rowOf(b) || colOf(a) === colOf(b) || boxOf(a) === boxOf(b));

/**
 * An empty cell and a digit that repeat a digit of `group` (another cell's given) without repeating one in the empty
 * cell's row, column or box: a conflict only the variant's rule catches.
 */
function variantOnlyConflict(grid, groups) {
  for (const group of groups) {
    for (const i of group) {
      if (grid[i] !== 0) continue;
      for (const j of group) {
        const d = grid[j];
        if (d === 0 || standardPeers(i, j)) continue;
        if (grid.some((x, k) => x === d && standardPeers(i, k))) continue;
        return { cell: i, digit: d, other: j };
      }
    }
  }
  return null;
}

async function signIn(browser, user) {
  const page = await (await browser.newContext(phone)).newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(base + "/");
  await page.fill("#sub", user.sub);
  await page.fill("#name", user.name);
  await page.click("button[type=submit]");
  await page.getByRole("tab", { name: "Daily" }).waitFor();
  return page;
}

/** Picks `name` on the Variants tab and opens its Easy #1. */
async function openEasyOne(page, name) {
  await page.getByRole("group", { name: "Variant" }).getByRole("button", { name }).click();
  await page.locator("#endless-series", { hasText: `${name} series` }).waitFor();
  check(await page.getByRole("button", { name, pressed: true }).count() === 1, `${name} is picked`);
  await page.getByRole("button", { name: "Play #1" }).first().click();
  await page.getByText(`${name} · Easy #1`).waitFor();
  await page.locator("[role=gridcell]").first().waitFor();
}

/** Places `digit` in `cell` with the keyboard. */
async function place(page, cell, digit) {
  await page.locator("[role=gridcell]").nth(cell).click();
  await page.keyboard.press(String(digit));
  await page.waitForTimeout(40);
}

(async () => {
  const { generate } = await engine();
  const browser = await chromium.launch();
  const page = await signIn(browser, player);

  // The tab explains itself the first time.
  await page.getByRole("tab", { name: "Variants" }).click();
  const help = page.getByRole("dialog", { name: "How Variants works" });
  await help.waitFor();
  const helpText = await help.innerText();
  check(helpText.includes("the two long diagonals also hold 1 to 9 once each.")
    && helpText.includes("the bold shapes replace the 3x3 boxes; each holds 1 to 9 once.")
    && helpText.includes("dashed cages show a sum: the digits in a cage add up to it and don't repeat."), "the explainer gives each rule");
  await shot(page, "help-variants");
  await page.getByRole("button", { name: "Got it" }).click();
  check(await page.getByRole("button", { name: "Diagonal", pressed: true }).count() === 1, "Diagonal is picked first");
  check(await page.getByText("None solved yet").count() === 5, "every difficulty starts with nothing solved");
  const series = (await page.locator("#endless-series").innerText()).split(" ")[0];
  const generator = series === "Graded" ? 2 : 1;
  check(series === "Classic" || series === "Graded", `the heading names the series (${series})`);
  await shot(page, "home-variants");
  await page.reload();
  await page.locator("#endless-series").waitFor();
  check(await page.getByRole("tab", { name: "Variants", selected: true }).count() === 1, "the tab is remembered after a reload");
  await page.waitForTimeout(300);
  check(await page.getByRole("dialog").count() === 0, "the explainer only pops up once");
  const seed = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.endless")).seed);

  // Diagonal: both diagonals shaded, and a repeat on a diagonal is a conflict.
  await openEasyOne(page, "Diagonal");
  check(await page.locator(".board.layout-diagonal").count() === 1, "the board is drawn as Diagonal");
  check(await page.locator(".cell.diag").count() === 17, "both long diagonals are shaded");
  let cells = page.locator("[role=gridcell]");
  let grid = await readGrid(cells);
  const diagonals = [[0, 10, 20, 30, 40, 50, 60, 70, 80], [8, 16, 24, 32, 40, 48, 56, 64, 72]];
  const diag = variantOnlyConflict(grid, diagonals);
  check(diag !== null, "a digit can repeat on a diagonal without a standard conflict");
  await place(page, diag.cell, diag.digit);
  check(await cells.nth(diag.cell).evaluate((e) => e.classList.contains("conflict")), "a repeat on a diagonal is a conflict");
  check(await cells.nth(diag.other).evaluate((e) => e.classList.contains("conflict")), "and so is the digit it repeats");
  await shot(page, "variant-diagonal-conflict");
  await page.keyboard.press("Backspace");
  check(await page.locator(".cell.conflict").count() === 0, "erasing it clears the conflict");
  await page.getByText("‹ Back").click();

  // Jigsaw: region borders instead of the boxes', and a repeat in a region is a conflict.
  await openEasyOne(page, "Jigsaw");
  check(await page.locator(".board.layout-jigsaw").count() === 1, "the board is drawn as Jigsaw");
  const borders = await page.locator(".cell").evaluateAll((els) => els.map((e) => [e.classList.contains("jr"), e.classList.contains("jb")]));
  const boxBorders = borders.every(([right, bottom], i) => right === (i % 9 === 2 || i % 9 === 5) && bottom === (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5));
  check(borders.some(([r, b]) => r || b) && !boxBorders, "region borders are drawn, not the boxes'");
  const width = await page.locator(".cell.jr").first().evaluate((e) => getComputedStyle(e).borderRightWidth);
  check(width === "2px", "region borders are bold");
  cells = page.locator("[role=gridcell]");
  grid = await readGrid(cells);
  const jigsaw = generate(seed, generator, 2, 1, 1);
  check(grid.join("") === jigsaw.givens, "the app's Jigsaw Easy #1 is the generator's");
  const regions = Array.from({ length: 9 }, (_, g) => jigsaw.layout.regions.flatMap((r, i) => (r === g ? [i] : [])));
  const inRegion = variantOnlyConflict(grid, regions);
  if (inRegion) {
    await place(page, inRegion.cell, inRegion.digit);
    check(await cells.nth(inRegion.cell).evaluate((e) => e.classList.contains("conflict")), "a repeat in a jigsaw region is a conflict");
    await page.keyboard.press("Backspace");
  } else {
    console.log("   (no region repeat without a standard conflict in this puzzle)");
  }
  await shot(page, "variant-jigsaw");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "variant-jigsaw-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByText("‹ Back").click();

  // Killer: dashed cages with their sums, drawn over notes and colour pens.
  await openEasyOne(page, "Killer");
  const killer = generate(seed, generator, 3, 1, 1);
  check(await page.locator(".board.layout-killer").count() === 1, "the board is drawn as Killer");
  check(await page.locator(".cell.cage").count() === 81, "every cell is in a cage");
  const sums = await page.locator(".cage-sum").allInnerTexts();
  check(sums.length === killer.layout.cages.length, `every cage shows its sum (${sums.length} cages)`);
  check(sums.reduce((s, x) => s + Number(x), 0) === 405, "the sums add up to 405");
  const dashed = await page.locator(".cell.ct").first().evaluate((e) => getComputedStyle(e, "::before").borderTopStyle);
  check(dashed === "dashed", "cage outlines are dashed");
  cells = page.locator("[role=gridcell]");
  check((await readGrid(cells)).join("") === killer.givens, "the app's Killer Easy #1 is the generator's");
  // Paused, the overlay covers the sums too: the topmost element over each sum is the overlay.
  await page.getByRole("button", { name: "Pause" }).click();
  await page.locator(".paused").waitFor();
  const covered = await page.locator(".cage-sum").evaluateAll((els) => els.every((e) => {
    const r = e.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".paused") != null;
  }));
  check(covered, "pausing hides the cage sums");
  await page.getByRole("button", { name: "Resume" }).click();
  // Notes in the first cell of a cage, and a colour pen, for the screenshots.
  const first = killer.layout.cages.find((c) => killer.givens[c.cells[0]] === "0").cells[0];
  await cells.nth(first).click();
  await page.keyboard.press("n");
  for (const d of [1, 2, 3, 5, 9]) await page.keyboard.press(String(d));
  await page.keyboard.press("n");
  const coloured = killer.givens.split("").findIndex((d, i) => d === "0" && i !== first);
  await page.keyboard.press("c");
  await cells.nth(coloured).click();
  await page.keyboard.press("c");
  await cells.nth(first).click();
  await shot(page, "variant-killer");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "variant-killer-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Solve it: the server rejects solves faster than its minimum time, so wait a few seconds first.
  await page.waitForTimeout(5000);
  await cells.nth(first).click();
  await page.keyboard.press("Backspace");
  for (let i = 0; i < 81; i++) if (killer.givens[i] === "0") await place(page, i, Number(killer.solution[i]));
  await page.getByText("Solved in", { exact: false }).waitFor();
  await shot(page, "variant-killer-solved");
  await page.waitForFunction(() => localStorage.getItem("sudoku.endless-pending") == null, null, { timeout: 15000 });
  const mine = (await api(player, "me/endless")).results;
  check(mine.length === 1 && mine[0].variant === 3 && mine[0].difficulty === 1 && mine[0].number === 1, "the Killer result reached the server");

  // The tab moves on, for Killer only.
  await page.getByRole("button", { name: "Killer puzzles" }).click();
  await page.getByRole("button", { name: "Play #2" }).waitFor();
  check(await page.getByText("1 solved").count() === 1, "Killer Easy shows one solved");
  await page.getByRole("group", { name: "Variant" }).getByRole("button", { name: "Diagonal" }).click();
  await page.locator("#endless-series", { hasText: "Diagonal series" }).waitFor();
  check(await page.getByText("None solved yet").count() === 5, "Diagonal still has nothing solved");
  check((await page.locator("#endless-elsewhere").innerText()).includes(`${series} Jigsaw Easy #1`), "the unfinished Jigsaw game is listed");
  await page.getByRole("tab", { name: "Endless" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  check(await page.getByText("None solved yet").count() === 5, "standard Endless is untouched");
  await page.getByRole("tab", { name: "Variants" }).click();
  await page.getByRole("group", { name: "Variant" }).getByRole("button", { name: "Killer" }).click();

  // Leaderboards: Killer's progress, and the puzzle's own times.
  await page.getByRole("button", { name: "Leaderboard" }).click();
  await page.getByRole("heading", { name: "Killer leaderboard" }).waitFor();
  await page.getByText(player.name).waitFor();
  check(await page.getByText("up to #1").count() >= 1, "the Killer board lists the player");
  await shot(page, "variant-leaderboard");
  await page.getByRole("group", { name: "Variant" }).getByRole("button", { name: "Jigsaw" }).click();
  await page.getByRole("heading", { name: "Jigsaw leaderboard" }).waitFor();
  await page.waitForTimeout(500);
  check(await page.getByText(player.name).count() === 0, "the Jigsaw board doesn't");
  await page.getByRole("group", { name: "Variant" }).getByRole("button", { name: "Killer" }).click();
  await page.fill("#endless-board-number", "1");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText(`${series} Killer Easy #1`).waitFor();
  await page.getByText(player.name).waitFor();
  check(true, "the puzzle's board has the time");
  await page.getByText("‹ Back").click();

  // Stats: a Variants card with Killer's numbers.
  await page.getByRole("button", { name: "Stats" }).click();
  const variantStats = page.locator("#stats-variants");
  await variantStats.waitFor();
  const killerRow = variantStats.locator("table").nth(2).locator("tr").nth(1);
  check((await killerRow.innerText()).replace(/\s+/g, " ").startsWith("Easy 1 #1"), "Stats shows Killer Easy: 1 solved, up to #1");
  await shot(page, "stats-variants");
  await page.getByText("‹ Back").click();

  // The admin sees the result, with a valid replay drawn with its cages.
  const today = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.week")).today);
  const listed = (await api(ann, `admin/endless/results?date=${today}`)).results.find((r) => r.displayName === player.name);
  check(listed && listed.variant === 3 && listed.replay === "valid", "the admin list has the Killer result with a valid replay");
  const admin = await signIn(browser, ann);
  await admin.getByRole("button", { name: "About" }).click();
  check(await admin.getByRole("button", { name: "How Variants works" }).count() === 1, "About explains Variants");
  await admin.getByRole("button", { name: "Admin" }).click();
  await admin.getByRole("button", { name: "Results and replays" }).click();
  await admin.getByRole("button", { name: "Endless" }).click();
  await admin.getByText(player.name).first().click();
  await admin.getByText("Reveal digits (shows the solution)").waitFor();
  check(await admin.getByText(`${series} Killer Easy #1`, { exact: false }).count() >= 1, "the replay names the variant");
  check(await admin.locator(".board.layout-killer .cage-sum").count() === killer.layout.cages.length, "the replay draws the cages");
  await shot(admin, "admin-replay-killer");

  // Seed play has the tab too.
  const seedPage = await (await browser.newContext(phone)).newPage();
  seedPage.on("pageerror", (e) => console.log("page error:", e.message));
  await seedPage.goto(`${base}/#seed=variants-${run}&levels=5`);
  await seedPage.getByRole("tab", { name: "Variants" }).click();
  await seedPage.getByRole("dialog", { name: "How Variants works" }).waitFor();
  check((await seedPage.getByRole("dialog").innerText()).includes("History lists your times."), "seed play's explainer points to History");
  await seedPage.getByRole("button", { name: "Got it" }).click();
  await openEasyOne(seedPage, "Diagonal");
  check(await seedPage.locator(".cell.diag").count() === 17, "seed play draws the variant");
  await seedPage.getByText("‹ Back").click();
  check(await seedPage.getByRole("button", { name: "History" }).count() >= 1, "seed play's Variants tab offers History");
  await shot(seedPage, "seed-variants");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
