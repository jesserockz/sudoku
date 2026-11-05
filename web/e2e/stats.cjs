// End-to-end check of daily streaks and the Stats screen against a running server in dev auth mode that
// serves web/dist (see docs/WEB.md, "Checking offline play"), with any database:
//
//   node web/e2e/stats.cjs [http://localhost:8080] [screenshot dir]
//
// Through the API, "Sam" gets daily results on four consecutive days ending today (so a 4-day streak),
// "Bea" on today and yesterday (2) and "Una" on today only (1), and Sam two endless solves. In the browser
// Sam sees the streak on the home page, opens Stats (streak, daily and endless tables, a sparkline) and goes
// back; the daily leaderboard shows the flame marker for Sam and Bea but not Una. Screenshots are taken at
// phone width, the Stats screen also in dark mode.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const sam = { sub: "sam" + run, name: "Sam" + run };
const bea = { sub: "bea" + run, name: "Bea" + run };
const una = { sub: "una" + run, name: "Una" + run };

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

const api = (user, path, init = {}) => fetch(`${base}/api/v1/${path}`, {
  ...init, headers: { Authorization: `Bearer dev:${user.sub}:${user.name}`, "Content-Type": "application/json", ...init.headers },
});

const daysBefore = (date, n) => new Date(Date.parse(date + "T00:00:00Z") - n * 86400_000).toISOString().slice(0, 10);

async function post(user, path, body) {
  const res = await api(user, path, { method: "POST", body: JSON.stringify(body) });
  check(res.status === 201, `${user.name} stored ${path} ${JSON.stringify(body.date ?? body.number)}`);
}

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

async function signIn(page, user) {
  await page.goto(base + "/");
  await page.fill("#sub", user.sub);
  await page.fill("#name", user.name);
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();
}

(async () => {
  const week = await (await api(sam, "week")).json();
  const today = week.today;
  const completedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const results = (user, ago, level, elapsedMs) => post(user, "results", { date: daysBefore(today, ago), level, elapsedMs, completedAt });
  // Sam: today and the three days before, with times that get faster.
  for (const [ago, ms] of [[3, 200_000], [2, 170_000], [1, 150_000], [0, 120_000]]) await results(sam, ago, 1, ms);
  await results(sam, 0, 2, 300_000);
  await results(bea, 1, 1, 220_000);
  await results(bea, 0, 1, 190_000);
  await results(una, 0, 1, 260_000);
  const endless = (n, ms) => post(sam, "endless/results", { difficulty: 1, number: n, elapsedMs: ms, completedAt });
  await endless(1, 80_000);
  await endless(2, 60_000);

  const api2 = await (await api(sam, "me/stats")).json();
  check(api2.streak.current === 4, "the API reports Sam's 4-day streak");

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await signIn(page, sam);

  // Home.
  await page.locator(".streak").waitFor();
  const streakText = (await page.locator(".streak").textContent()).replace(/\s+/g, " ").trim();
  check(streakText.includes("4-day streak"), `the home page shows the streak (${streakText})`);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.streak")).current) === 4, "the streak is kept in storage");
  await shot(page, "home-streak");

  // Stats.
  await page.getByRole("button", { name: "Stats" }).click();
  await page.locator("sudoku-stats table.stats-table").first().waitFor();
  const text = (await page.locator("sudoku-stats").textContent()).replace(/\s+/g, " ");
  check(text.includes("4-day streak") && text.includes("best 4") === false, "the Stats screen shows the streak");
  const dailyRows = page.locator("sudoku-stats table.stats-table").nth(0).locator("tbody tr");
  check(await dailyRows.count() === 5, "the daily table has a row per difficulty");
  const easy = await dailyRows.nth(0).locator("td").allTextContents();
  check(easy[0] === "Easy" && easy[1] === "4" && easy[2] === "2:00" && easy[3] === "2:40", `the Easy row has 4 played, best 2:00, average 2:40 (${easy})`);
  check(await dailyRows.nth(0).locator("svg.spark polyline").count() === 1, "the Easy row has a sparkline");
  check(await dailyRows.nth(1).locator("svg.spark").count() === 0, "a difficulty with one time has no sparkline");
  const endlessRows = page.locator("sudoku-stats table.stats-table").nth(1).locator("tbody tr");
  check(await endlessRows.count() === 5, "the endless table has a row per difficulty");
  const e1 = await endlessRows.nth(0).locator("td").allTextContents();
  check(e1[0] === "Easy" && e1[1] === "2" && e1[2] === "#2" && e1[3] === "1:00" && e1[4] === "1:10", `the endless row shows solved 2, highest #2, best 1:00, average 1:10 (${e1})`);
  await shot(page, "stats");

  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "stats-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await page.getByText("‹ Back").click();
  await page.locator(".streak").waitFor();
  check(await page.locator("sudoku-stats").count() === 0, "Back returns to the home page");

  // Leaderboard markers.
  await page.getByRole("button", { name: "Leaderboard" }).click();
  await page.getByText(bea.name).first().waitFor();
  const markerFor = async (name) => page.locator("table.board-table tr", { hasText: name }).first().locator(".streak-marker");
  const samMarker = await markerFor(sam.name);
  check(await samMarker.count() === 1 && await samMarker.getAttribute("title") === "4-day streak", "Sam has a 4-day marker");
  check((await samMarker.textContent()).includes("4"), "the marker shows the number");
  check(await (await markerFor(bea.name)).getAttribute("title") === "2-day streak", "Bea has a 2-day marker");
  check(await (await markerFor(una.name)).count() === 0, "a 1-day streak has no marker");
  await shot(page, "leaderboard-markers");
  // The same markers on a per-puzzle board.
  await page.getByRole("button", { name: "Easy" }).click();
  await page.locator("table.board-table td.time").first().waitFor();
  check(await page.locator(".card").first().locator(".streak-marker").count() === 2, "the Easy board marks Sam and Bea, not Una");
  await shot(page, "leaderboard-easy-markers");

  // A player with no streak history sees no marker line other than "No streak yet".
  const fresh = { sub: "new" + run, name: "New" + run };
  const other = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(other, fresh);
  await other.locator(".streak").waitFor();
  check((await other.locator(".streak").textContent()).includes("No streak yet"), "a new player sees 'No streak yet'");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
