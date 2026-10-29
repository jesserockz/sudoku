// End-to-end check of the offline-first PWA against a running server in dev
// auth mode that serves web/dist (see docs/WEB.md, "Checking offline play"):
//
//   node web/e2e/offline.cjs [http://localhost:8080]
//
// Signs in, goes offline, reloads (the service worker serves the app shell and
// the cached week supplies the puzzles), solves a puzzle offline, then goes
// back online and checks the queued result reaches the server.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const user = "e2e" + Date.now();

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

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));

  // Online: sign in (dev auth) and let the service worker install.
  await page.goto(base + "/");
  await page.fill("#sub", user);
  await page.fill("#name", "E2E");
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith("sudoku-shell-"));
    return shell && (await (await caches.open(shell)).match("/app/main.js")) != null;
  });
  check(await page.evaluate(() => navigator.serviceWorker.controller != null), "service worker controls the page");

  const client = await context.newCDPSession(page);
  const manifest = await client.send("Page.getAppManifest");
  check(manifest.errors.length === 0 && manifest.data.includes('"display": "standalone"'), "manifest parses with no errors");

  // Offline: reload, and the app still opens with today's puzzles.
  await context.setOffline(true);
  await page.reload();
  await page.getByText("Easy", { exact: true }).waitFor({ timeout: 15000 });
  check(await page.getByText("Play").count() >= 1, "app opens offline with today's puzzles");
  await page.getByText("Offline.", { exact: false }).waitFor();
  check(true, "offline notice is shown");

  // A deep link (the OIDC callback path, the app's one client-side route) falls back to the cached index.html.
  const deep = await context.newPage();
  await deep.goto(base + "/auth/callback?code=x&state=y");
  await deep.getByText("Easy", { exact: true }).waitFor({ timeout: 15000 });
  check(true, "navigations to other paths serve the cached app offline");
  await deep.close();

  // Solve the first puzzle offline.
  await page.getByText("Play").first().click();
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const grid = labels.map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));
  const solution = grid.slice();
  check(solve(solution), "puzzle has a solution");
  // The server drops results under 5 s (a sanity cap), so take a little longer than that.
  await page.waitForTimeout(6000);
  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue;
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
  }
  await page.getByText("Solved in", { exact: false }).waitFor();
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.pending") || "[]"));
  check(queued.length === 1 && queued[0].level === 1, "result is queued offline");

  // The leaderboard needs the server and says so.
  await page.getByText("See scores").click();
  await page.getByText("You're offline", { exact: false }).waitFor();
  check(true, "leaderboard shows an offline message");

  // Back online: the queue uploads on the "online" event, or on the app's 30 s retry
  // (Chromium's emulation reports a page loaded offline as online, so no event fires here).
  await context.setOffline(false);
  await page.waitForFunction(() => localStorage.getItem("sudoku.pending") == null, null, { timeout: 45000 });
  const today = queued[0].date;
  const res = await fetch(`${base}/api/v1/me/results?date=${today}`, { headers: { Authorization: `Bearer dev:${user}:E2E` } });
  const body = await res.json();
  check(body.results.length === 1 && body.results[0].level === 1 && body.results[0].elapsedMs === queued[0].elapsedMs,
    "queued result uploaded (GET /api/v1/me/results)");
  await page.getByText("Total", { exact: true }).waitFor();
  await page.getByText("E2E").first().waitFor();
  check(true, "leaderboard loads once back online");

  // A cached week that doesn't cover today asks for a connection instead of showing puzzles.
  const week = JSON.parse(await page.evaluate(() => localStorage.getItem("sudoku.week")));
  await context.setOffline(true);
  await page.evaluate((w) => {
    const shift = (d) => new Date(Date.parse(d) - 7 * 86400000).toISOString().slice(0, 10);
    localStorage.setItem("sudoku.week", JSON.stringify({ ...w, isoWeek: "2000-W01", weekStart: shift(w.weekStart), weekEnd: shift(w.weekEnd), today: shift(w.today) }));
  }, week);
  await page.reload();
  await page.getByText("Connect to the internet once this week", { exact: false }).waitFor();
  check(true, "a stale week asks to connect once this week");
  await context.setOffline(false);
  await page.getByText("Try again").click();
  await page.getByText("Easy", { exact: true }).waitFor();
  check(true, "connecting fetches the current week");
  await context.close();

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
