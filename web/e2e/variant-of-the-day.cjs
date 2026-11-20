// End-to-end check of the variant of the day against a running server in dev auth mode that serves web/dist, with
// `ann` as admin (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/variant-of-the-day.cjs [http://localhost:8080] [screenshot dir]
//
// A fresh player sees the variant of the day's card under the daily games, titled by its variant ("Killer of the
// day") and never naming a generator or difficulty. They play it, solving it through the UI with the solution from
// the app's own generator; its result uploads with a replay the server accepts. The card then shows the time, the
// daily Leaderboard has the variant of the day's board beneath the classic one, and the admin's Results page lists
// it with a valid replay drawn with the puzzle's layout. Seed play has the card too, with no leaderboard, and
// History lists the solve. Screenshots are at phone width, in light and dark.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const player = { sub: "votd" + run, name: "Vera" + run };
const ann = { sub: "ann", name: "Ann" };
const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, colorScheme: "light" };
const NAMES = { 1: "Diagonal", 2: "Jigsaw", 3: "Killer" };
const LAYOUT_CLASS = { 1: "layout-diagonal", 2: "layout-jigsaw", 3: "layout-killer" };
const HIDDEN = /Classic|Graded|Expert|Diabolical|Easy|Medium|Hard/;

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

/** The app's own generator (Node runs the TypeScript sources), for the day's puzzle and its solution. */
async function engine() {
  const src = path.resolve(__dirname, "../src/generator");
  const variants = await import(pathToFileURL(path.join(src, "variants.ts")).href);
  const weekSeed = await import(pathToFileURL(path.join(src, "week-seed.ts")).href);
  return { daily: (seed, day, date) => variants.generateDailyVariant(weekSeed.parseWeekSeed(seed), day, variants.dailyVariantVersion(date)) };
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

/** Places `digit` in `cell` with the keyboard. */
async function place(page, cell, digit) {
  await page.locator("[role=gridcell]").nth(cell).click();
  await page.keyboard.press(String(digit));
  await page.waitForTimeout(40);
}

async function solve(page, day) {
  for (let i = 0; i < 81; i++) if (day.givens[i] === "0") await place(page, i, Number(day.solution[i]));
  await page.getByText("Solved in", { exact: false }).waitFor();
}

(async () => {
  const { daily } = await engine();
  const browser = await chromium.launch();
  const page = await signIn(browser, player);
  const week = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.week")));
  const day = daily(week.seed, week.dayOfWeek, week.today);
  const name = NAMES[day.variant];
  check(name !== undefined, `today's variant of the day is ${name}`);

  // The card sits under the day's games and names only its variant.
  const card = page.locator("#variant-day");
  await card.waitFor();
  check((await card.locator("h2").innerText()) === `${name} of the day`, `the card is titled "${name} of the day"`);
  check((await card.innerText()).includes("Not started yet"), "it has not been started");
  check(!HIDDEN.test(await card.innerText()), "the card names no generator or difficulty");
  const cardBelowGames = await page.evaluate(() => {
    const list = document.querySelector("ul.puzzles");
    return list && document.querySelector("#variant-day").getBoundingClientRect().top > list.getBoundingClientRect().bottom - 1;
  });
  check(cardBelowGames, "the card is under the daily games");
  await shot(page, "votd-home");

  // Play it: the header is the variant only, and the board is drawn under the variant's rules.
  await card.getByRole("button", { name: "Play" }).click();
  await page.getByText(`${name} of the day`).first().waitFor();
  await page.locator("[role=gridcell]").first().waitFor();
  const header = await page.locator("header.bar").first().innerText();
  check(header.includes(`${name} of the day`) && !HIDDEN.test(header), "the play header says only the variant");
  check(await page.locator(`.board.${LAYOUT_CLASS[day.variant]}`).count() === 1, `the board is drawn as ${name}`);
  const givens = (await page.locator("[role=gridcell]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));
  check(givens.join("") === day.givens, "the app's puzzle is the generator's");
  await shot(page, "votd-play");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "votd-play-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Resume: leaving the puzzle and coming back finds it in progress.
  await page.getByText("‹ Back").click();
  check((await card.innerText()).includes("In progress"), "leaving it mid-puzzle leaves it in progress");
  await card.getByRole("button", { name: "Resume" }).click();
  await page.locator("[role=gridcell]").first().waitFor();

  // Solve it: the server rejects solves faster than its minimum time, so wait a few seconds first.
  await page.waitForTimeout(5000);
  await solve(page, day);
  await shot(page, "votd-solved");
  await page.waitForFunction(() => localStorage.getItem("sudoku.variant-day-pending") == null, null, { timeout: 15000 });
  const mine = await api(player, `me/results?date=${week.today}`);
  check(mine.variantDaily && mine.variantDaily.variant === day.variant, "the result reached the server with the day's variant");
  check(mine.results.length === 0, "and no classic daily result was made");

  // Back on the Daily tab the card shows the time and a Scores button.
  await page.getByRole("button", { name: "Today's puzzles" }).click();
  check((await card.innerText()).includes("Solved in"), "the card shows the solve time");
  check(!(await card.innerText()).includes("not uploaded"), "it is uploaded");
  check(await card.getByRole("button", { name: "Scores" }).count() === 1, "the card offers Scores");
  check((await page.locator(".streak").innerText()).length > 0, "the daily streak counts the day");

  // The Leaderboard has the variant of the day's board beneath the classic one, for the same date.
  await card.getByRole("button", { name: "Scores" }).click();
  const board = page.locator("#variant-board");
  await board.waitFor();
  await board.getByText(player.name).waitFor();
  check((await board.locator("h2").innerText()) === `${name} of the day`, "the board is titled by the variant");
  check(!HIDDEN.test(await board.innerText()), "the board names no generator or difficulty");
  check(await page.getByRole("button", { name: "Total" }).count() === 1, "the classic boards are still there");
  const order = await page.evaluate(() => {
    const total = [...document.querySelectorAll(".card")].filter((c) => c.id !== "variant-board");
    const variant = document.querySelector("#variant-board");
    return total.length > 0 && total.every((c) => c.getBoundingClientRect().top < variant.getBoundingClientRect().top);
  });
  check(order, "the variant of the day's board is beneath the classic content");
  await shot(page, "votd-leaderboard");
  await page.getByRole("button", { name: "‹ Earlier" }).click();
  await board.getByText("No one has solved it yet.").waitFor();
  check((await board.locator("h2").innerText()).endsWith("of the day"), "the date navigation moves the variant of the day's board too");
  await page.getByRole("button", { name: "Later ›" }).click();
  await board.getByText(player.name).waitFor();
  await page.getByText("‹ Back").click();

  // The admin sees the result with a valid replay, drawn with the puzzle's layout, and no generator or difficulty.
  const listed = (await api(ann, `admin/results?date=${week.today}`)).variantResults.find((r) => r.displayName === player.name);
  check(listed && listed.variant === day.variant && listed.replay === "valid", "the admin list has the result with a valid replay");
  const admin = await signIn(browser, ann);
  await admin.getByRole("button", { name: "About" }).click();
  await admin.getByRole("button", { name: "Admin" }).click();
  await admin.getByRole("button", { name: "Results and replays" }).click();
  const adminCard = admin.locator("#admin-variant-day");
  await adminCard.getByText(player.name).waitFor();
  check((await adminCard.locator("h2").innerText()) === `${name} of the day`, "the admin card is titled by the variant");
  check(!HIDDEN.test(await adminCard.innerText()), "the admin card names no generator or difficulty");
  await adminCard.getByText(player.name).click();
  await admin.getByText("Reveal digits (shows the solution)").waitFor();
  check(await admin.getByText(`${name} of the day`, { exact: false }).count() >= 1, "the replay names the variant");
  check(await admin.locator(`.board.${LAYOUT_CLASS[day.variant]}`).count() === 1, "the replay draws the variant's board");
  await shot(admin, "votd-admin-replay");
  await admin.getByRole("button", { name: "Flag as suspicious" }).click();
  await admin.getByText("Remove flag").waitFor();
  check((await api(player, `variant-daily/leaderboard?date=${week.today}`)).entries[0].suspicious === true, "an admin flag shows on the board");

  // Seed play has the card too: no leaderboard, and History lists the solve.
  const seedPage = await (await browser.newContext(phone)).newPage();
  seedPage.on("pageerror", (e) => console.log("page error:", e.message));
  await seedPage.goto(`${base}/#seed=votd-${run}&levels=5`);
  const seedCard = seedPage.locator("#variant-day");
  await seedCard.waitFor();
  const { weekAt } = await import(pathToFileURL(path.resolve(__dirname, "../src/game/calendar.ts")).href);
  const { weekSeed: seedWeekSeed } = await import(pathToFileURL(path.resolve(__dirname, "../src/serverless/seed.ts")).href);
  const info = weekAt(Date.now());
  const seedDay = daily(await seedWeekSeed(`votd-${run}`, info.isoWeek), info.dayOfWeek, info.today);
  const seedName = NAMES[seedDay.variant];
  check((await seedCard.locator("h2").innerText()) === `${seedName} of the day`, `the seed's card is titled "${seedName} of the day"`);
  check(!HIDDEN.test(await seedCard.innerText()), "the seed's card names no generator or difficulty");
  await seedCard.getByRole("button", { name: "Play" }).click();
  await seedPage.locator("[role=gridcell]").first().waitFor();
  const seedHeader = await seedPage.locator("header.bar").first().innerText();
  check(seedHeader.includes(`${seedName} of the day`) && !HIDDEN.test(seedHeader), "the seed's play header says only the variant");
  await solve(seedPage, seedDay);
  check(await seedPage.getByRole("button", { name: "History" }).count() >= 1 && await seedPage.getByRole("button", { name: "See scores" }).count() === 0, "after a solve the button reads History");
  await seedPage.getByRole("button", { name: "Today's puzzles" }).click();
  check((await seedCard.innerText()).includes("Solved in") && await seedCard.getByRole("button").count() === 0, "the seed's card shows the time and no Scores");
  await seedPage.getByRole("button", { name: "History" }).first().click();
  const seedHistory = seedPage.locator("#history-variant-day");
  await seedHistory.waitFor();
  check((await seedHistory.innerText()).includes(seedName), "History lists the solve");
  await shot(seedPage, "votd-seed-history");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
