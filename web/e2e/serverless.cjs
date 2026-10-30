// End-to-end check of serverless play (a shared seed, no server) against the
// production bundle on a plain static file server with no /api, at the site
// root or under a sub-path (see docs/WEB.md, "Hosting without a server"):
//
//   (cd web && npm run build)
//   (cd web/dist && python3 -m http.server 8090) &
//   node web/e2e/serverless.cjs http://localhost:8090/
//
// Generates a seed and solves a puzzle, opens the share link in a fresh
// browser and checks it gets the identical puzzle, checks switching seeds
// keeps each seed's progress, round-trips an awkward Unicode seed, and starts
// offline from the service worker.
const { chromium } = require("playwright");

const base = new URL(process.argv[2] || "http://localhost:8090/").href;

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

/** The open puzzle's cells as digits (0 = empty). */
async function readGrid(page) {
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  return labels.map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));
}

/** Opens game [index] from today's list and returns its starting grid, then goes back. */
async function peekGrid(page, index = 0) {
  await page.locator(".puzzles li").nth(index).locator("button").click();
  const grid = await readGrid(page);
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.locator(".puzzles").waitFor();
  return grid;
}

async function newPage(browser) {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  return { context, page };
}

async function start(page, seed) {
  await page.goto(base);
  await page.getByText("Play with a seed").first().waitFor();
  await page.fill("#seed", seed);
  await page.getByRole("button", { name: "Start playing", exact: true }).click();
  await page.locator(".puzzles").waitFor();
}

(async () => {
  const browser = await chromium.launch();

  // 1. No server here: the app offers seed play. Generate a seed and start.
  const a = await newPage(browser);
  await a.page.goto(base);
  await a.page.getByText("There's no Sudoku server here", { exact: false }).waitFor();
  check(true, "a static host without /api offers seed play");
  await a.page.getByRole("button", { name: "Generate", exact: true }).click();
  const seed = await a.page.inputValue("#seed");
  check(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$/.test(seed), `Generate fills in a random seed (${seed})`);
  await a.page.getByRole("button", { name: "Start playing", exact: true }).click();
  await a.page.getByText("Easy", { exact: true }).waitFor();
  check(await a.page.locator(".puzzles li").count() === 5, "five games a day by default");
  check(await a.page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.seed")).settings.seed) === seed, "the seed is kept in localStorage");

  const link = await a.page.inputValue("#share-link");
  check(link === `${base}#seed=${seed}&levels=5`, `share link carries the seed in the fragment (${link})`);
  await a.page.getByRole("button", { name: "Copy link", exact: true }).click();
  await a.page.getByText("Link copied.").waitFor();
  check(await a.page.evaluate(() => navigator.clipboard.readText()) === link, "Copy link copies it");
  await a.page.getByRole("button", { name: "Copy seed", exact: true }).click();
  await a.page.getByText("Seed copied.").waitFor();
  check(await a.page.evaluate(() => navigator.clipboard.readText()) === seed, "Copy seed copies the seed");

  // 2. Solve Easy and share the results.
  await a.page.locator(".puzzles li button").first().click();
  const easy = await readGrid(a.page);
  const solution = easy.slice();
  check(solve(solution), "puzzle has a solution");
  const cells = a.page.locator("[role=gridcell]");
  for (let i = 0; i < 81; i++) {
    if (easy[i] !== 0) continue;
    await cells.nth(i).click();
    await a.page.keyboard.press(String(solution[i]));
  }
  await a.page.getByText("Solved in", { exact: false }).first().waitFor();
  await a.page.getByRole("button", { name: "Share results", exact: true }).click();
  await a.page.getByText("Results copied", { exact: false }).waitFor();
  const summary = await a.page.evaluate(() => navigator.clipboard.readText());
  check(/^Sudoku \d{4}-\d{2}-\d{2} #[0-9a-f]{6}\nEasy \d+:\d\d\nMedium -\nHard -\nExpert -\nDiabolical -\nSolved 1\/5 in \d+:\d\d$/.test(summary),
    "Share results copies the day's summary:\n" + summary);
  check(!summary.includes(seed), "the summary doesn't reveal the seed");
  await a.page.getByRole("button", { name: "Today's puzzles", exact: true }).click();
  await a.page.getByText("Solved in", { exact: false }).first().waitFor();
  await a.page.getByRole("button", { name: "History", exact: true }).first().click();
  await a.page.getByText("Total (1/5)").waitFor();
  check(true, "History lists the solved game");
  await a.page.getByRole("button", { name: "‹ Back", exact: true }).click();

  // 3. A fresh browser opening the share link gets the identical puzzles, and the fragment is cleared.
  const b = await newPage(browser);
  await b.page.goto(link);
  await b.page.getByText("Easy", { exact: true }).waitFor();
  check(new URL(b.page.url()).hash === "" && b.page.url() === base, "the seed is removed from the address bar");
  check(JSON.stringify(await peekGrid(b.page, 0)) === JSON.stringify(easy), "the share link gives the identical Easy puzzle");
  check(JSON.stringify(await peekGrid(b.page, 4)) === JSON.stringify(await peekGrid(a.page, 4)), "and the identical Diabolical puzzle");
  check(await b.page.inputValue("#share-link") === link, "the receiver's share link is the same");

  // 4. A link to another seed asks first; each seed keeps its own progress.
  const other = `${base}#seed=another-group&levels=3`;
  await a.page.evaluate((href) => { location.href = href; }, other); // same tab: only the fragment changes
  await a.page.getByText("Switch to this seed?").waitFor();
  await a.page.getByRole("button", { name: "Keep current seed", exact: true }).click();
  await a.page.locator(".puzzles").waitFor();
  check(await a.page.inputValue("#share-link") === link, "declining keeps the current seed");
  await a.page.evaluate((href) => { location.href = href; }, other);
  await a.page.getByRole("button", { name: "Switch", exact: true }).click();
  await a.page.locator(".puzzles").waitFor();
  check(await a.page.locator(".puzzles li").count() === 3 && await a.page.getByText("Solved in").count() === 0,
    "switching plays the other seed's 3 games, with nothing solved");
  await a.page.getByRole("button", { name: "Leave seed", exact: true }).click();
  await a.page.getByText("Play with a seed").first().waitFor();
  await a.page.fill("#seed", link); // a pasted link works in the seed field too
  await a.page.getByRole("button", { name: "Start playing", exact: true }).click();
  await a.page.getByText("Solved in", { exact: false }).first().waitFor();
  check(true, "returning to the first seed keeps its solved game");

  // 5. Seeds with Unicode and URL-special characters survive the link.
  const awkward = "Kōwhai 🌼 & friends/#?=+%";
  const c = await newPage(browser);
  await start(c.page, "  " + awkward + " ");
  const awkwardLink = await c.page.inputValue("#share-link");
  check(!/[ #?]/.test(awkwardLink.split("#seed=")[1]), "the seed is percent-encoded in the link");
  const d = await newPage(browser);
  await d.page.goto(awkwardLink);
  await d.page.locator(".puzzles").waitFor();
  check(await d.page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.seed")).settings.seed) === awkward,
    "a Unicode seed round-trips through the link (trimmed, case kept)");
  check(JSON.stringify(await peekGrid(d.page, 2)) === JSON.stringify(await peekGrid(c.page, 2)), "and gives the same puzzles");

  // 6. The service worker serves the app shell offline, from this copy's directory.
  await b.page.evaluate(() => navigator.serviceWorker.ready);
  check(await b.page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope) === base, "service worker scope is the app's directory");
  await b.page.waitForFunction(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith("sudoku-shell-"));
    return shell && (await (await caches.open(shell)).match(new URL("app/main.js", document.baseURI).href)) != null;
  });
  await b.context.setOffline(true);
  await b.page.reload();
  await b.page.getByText("Easy", { exact: true }).waitFor({ timeout: 15000 });
  check(true, "seed play starts offline");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
