// End-to-end check of the enabled puzzle generators against a running server in dev auth mode that serves
// web/dist, with `ann` as admin (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/generator.cjs [http://localhost:8080] [screenshot dir]
//
// Ann (admin) opens Server admin: the Puzzle generators card has Classic / Graded / Both with Classic marked.
// Bob (a player) has no switch and an explainer that names Classic with no word of a choice. Ann switches to
// Graded (straight away: Bob's next load names Graded, still without a switch), then to Both: Bob gets the
// Classic / Graded switch on the Daily and Endless tabs with its "What's this?" link, picks Graded (remembered),
// plays and solves a Graded daily, sees it on the Graded leaderboard and not on the Classic one, and Stats opens
// on Graded. Ann's results list names the generator. In a fresh browser, serverless play has the same three
// choices in its seed card, kept per seed in localStorage (an old #64 schedule reads as its latest entry), with
// the switch while both are on and a history named per generator. Ann goes back to Classic at the end.
// Screenshots are taken at phone width.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const bob = { sub: "bob" + run, name: "Bob" + run };

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

const api = (token, path, init = {}) => fetch(`${base}/api/v1/${path}`, {
  ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
});

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

async function signIn(page, sub, name) {
  await page.goto(base + "/");
  await page.fill("#sub", sub);
  await page.fill("#name", name);
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();
}

async function openAdmin(page) {
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.locator(".generator-admin .generator-choices").waitFor();
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

const readGrid = async (page) => (await page.locator("[role=gridcell]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))))
  .map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));

/** Solves the puzzle on screen. `wait` leaves time for the server's minimum solve time. */
async function fill(page, wait = true) {
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const grid = await readGrid(page);
  const solution = grid.slice();
  check(solve(solution), "the puzzle has a solution");
  if (wait) await page.waitForTimeout(5000);
  for (const i of grid.flatMap((d, k) => (d === 0 ? [k] : []))) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(40);
  }
  await page.getByText("Solved in", { exact: false }).waitFor();
}

/** Opens today's Easy, returns its starting grid and checks the play screen's title, then goes back. */
async function easyGrid(page, title) {
  await page.locator(".puzzles li", { hasText: "Easy" }).first().getByRole("button").click();
  await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
  const grid = await readGrid(page);
  await page.getByText("‹ Back").click();
  await page.locator(".puzzles").waitFor();
  return grid.join("");
}

/** Reloads a signed-in page and waits for its first sync (it starts from the cached week), which ends with the stats. */
async function reloadSynced(page) {
  const synced = page.waitForResponse((r) => r.url().includes("/api/v1/me/stats"));
  await page.reload();
  await synced;
  await page.waitForTimeout(200);
}

// Checks the "Classic and Graded puzzles" dialog that is open (title, five levels, its lead and closing lines) and closes it.
async function checkExplainer(page, where, lead, { choice = false, seed = false } = {}) {
  const dialog = page.getByRole("dialog", { name: "Classic and Graded puzzles" });
  await dialog.waitFor();
  check(await dialog.locator("li strong").allInnerTexts().then((t) => t.join(" ") === "Easy: Medium: Hard: Expert: Diabolical:"), `${where}: the explainer lists the five levels`);
  const text = await dialog.innerText();
  check(text.split("\n").filter(Boolean)[1] === lead, `${where}: the explainer starts with "${lead}"`);
  check(!/next week|pending/i.test(text), `${where}: nothing waits for next week`);
  if (seed) check(text.includes("in the seed card"), `${where}: seed play points to the seed card`);
  else if (choice) check(text.includes("pick with the switch"), `${where}: with both on, it points to the switch`);
  else check(!/choose|choice|pick|switch|both/i.test(text), `${where}: with one generator, no word of a choice`);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await dialog.waitFor({ state: "detached" });
}

/** The admin card's Classic / Graded / Both buttons: clicks `label` and waits for the server's answer. */
async function adminChoose(card, label, on) {
  await card.getByRole("button", { name: label, exact: true }).click();
  await card.getByText(`On: ${on}`, { exact: true }).waitFor();
  check((await card.locator("button[aria-pressed=true]").innerText()) === label, `the admin card marks ${label}`);
  check(await card.getByRole("button", { name: label, exact: true }).isDisabled(), `${label} can't be chosen again`);
}

const enabledNow = async () => JSON.stringify((await (await api("dev:ann:Ann", "week")).json()).generators);

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" };

(async () => {
  const reset = await api("dev:ann:Ann", "admin/generator", { method: "PUT", body: JSON.stringify({ enabled: [1] }) });
  check(reset.ok, "Ann can set the generators (she is an admin)");
  check(await enabledNow() === "[1]", "the server starts on Classic alone");
  const browser = await chromium.launch();
  const admin = await (await browser.newContext(phone)).newPage();
  const player = await (await browser.newContext(phone)).newPage();
  const seedPage = await (await browser.newContext(phone)).newPage();
  for (const page of [admin, player, seedPage]) page.on("pageerror", (e) => console.log("page error:", e.message));

  try {
    // The admin card.
    await signIn(admin, "ann", "Ann");
    await openAdmin(admin);
    const card = admin.locator(".generator-admin");
    const cardText = await card.innerText();
    check(cardText.includes("Puzzle generators") && cardText.includes("On: Classic"), "the admin card shows Classic on");
    check(JSON.stringify(await card.locator(".generator-choices button").allInnerTexts()) === '["Classic","Graded","Both"]', "it offers Classic, Graded and Both");
    check((await card.locator("button[aria-pressed=true]").innerText()) === "Classic", "Classic is marked");
    check(cardText.includes("Changes apply straight away") && !/next week|pending|from the beginning/i.test(cardText), "it applies straight away, with no pending change or history");
    await shot(admin, "admin-generators-classic");

    // A player with Classic alone: no switch, and the explainer only names it.
    await signIn(player, bob.sub, bob.name);
    check(await player.locator(".generator-switch").count() === 0, "with one generator there is no switch");
    check(await player.locator(".generator-notice").count() === 0, "there is no pending notice any more");
    const classicEasy = await easyGrid(player, "Easy");
    await player.getByRole("button", { name: "About", exact: true }).click();
    check((await player.locator("tr", { hasText: "Puzzle generator" }).innerText()).includes("Classic"), "About names the generator");
    await player.getByRole("button", { name: "Classic and Graded", exact: true }).click();
    await checkExplainer(player, "About, Classic", "Puzzles here use Classic.");
    await player.getByRole("button", { name: "‹ Back", exact: true }).click();

    // Graded alone, straight away.
    await adminChoose(card, "Graded", "Graded");
    check(await enabledNow() === "[2]", "the server enables Graded alone");
    await reloadSynced(player);
    await player.locator(".puzzles").waitFor();
    check(await player.locator(".generator-switch").count() === 0, "still no switch with Graded alone");
    const gradedEasy = await easyGrid(player, "Easy");
    check(gradedEasy !== classicEasy, "the player gets the Graded puzzles at once");
    await player.getByRole("button", { name: "About", exact: true }).click();
    await player.getByRole("button", { name: "Classic and Graded", exact: true }).click();
    await checkExplainer(player, "About, Graded", "Puzzles here use Graded.");
    await player.getByRole("button", { name: "‹ Back", exact: true }).click();

    // Both.
    await adminChoose(card, "Both", "Classic and Graded");
    await shot(admin, "admin-generators-both");
    check(await enabledNow() === "[1,2]", "the server enables both");
    await reloadSynced(player);
    const sw = player.locator(".generator-switch");
    await sw.waitFor();
    check((await sw.locator("button.active").innerText()) === "Classic", "the switch starts on the first, Classic");
    check(await easyGrid(player, "Classic · Easy") === classicEasy, "Classic's puzzles, named in the play screen");
    await shot(player, "daily-switch-classic");
    await sw.getByRole("button", { name: "What's this?" }).click();
    await checkExplainer(player, "switch", "You can play Classic or Graded: pick with the switch on the Daily and Endless tabs.", { choice: true });
    await sw.getByRole("button", { name: "Graded", exact: true }).click();
    await player.locator(".generator-switch button.active", { hasText: "Graded" }).waitFor();
    check(await player.evaluate(() => localStorage.getItem("sudoku.generator")) === "2", "the pick is kept in localStorage");
    check(await easyGrid(player, "Graded · Easy") === gradedEasy, "the switch plays the Graded puzzles");
    await player.getByRole("button", { name: "About", exact: true }).click();
    check((await player.locator("tr", { hasText: "Puzzle generators" }).innerText()).includes("Classic and Graded"), "About names both");
    await player.getByRole("button", { name: "‹ Back", exact: true }).click();

    // The pick is shared with the Endless tab, which has the switch too.
    await player.getByRole("tab", { name: "Endless" }).click();
    const gotIt = player.getByRole("button", { name: "Got it" });
    if (await gotIt.count()) await gotIt.click();
    await player.locator("#endless-series", { hasText: "Graded series" }).waitFor();
    check(await player.locator(".generator-switch button.active").innerText() === "Graded", "the Endless tab has the switch, on Graded");
    check(await player.getByText("Each generator has its own series").count() === 1, "it says each generator has its own series");
    await shot(player, "endless-switch-graded");
    await player.locator(".generator-switch").getByRole("button", { name: "Classic", exact: true }).click();
    await player.locator("#endless-series", { hasText: "Classic series" }).waitFor();
    await player.locator(".generator-switch").getByRole("button", { name: "Graded", exact: true }).click();
    await player.locator("#endless-series", { hasText: "Graded series" }).waitFor();
    check(true, "switching on the Endless tab changes the series");
    await player.getByRole("tab", { name: "Daily" }).click();
    await reloadSynced(player);
    await player.locator(".generator-switch button.active", { hasText: "Graded" }).waitFor();
    check(true, "the pick survives a reload");

    // Solve the Graded Easy: the result is Graded's.
    await player.locator(".puzzles li", { hasText: "Easy" }).first().getByRole("button").click();
    await fill(player);
    await player.waitForFunction(() => localStorage.getItem("sudoku.pending") == null, null, { timeout: 15000 });
    const mine = (await (await api(`dev:${bob.sub}:${bob.name}`, "me/results")).json()).results;
    check(mine.length === 1 && mine[0].generator === 2 && mine[0].level === 1, "the result is stored as Graded's");

    // The leaderboard has the switch, on Graded.
    const request = player.waitForRequest((r) => r.url().includes("/leaderboard?") && r.url().includes("generator=2"));
    await player.getByRole("button", { name: "See scores" }).click();
    await request;
    await player.getByText(bob.name).first().waitFor();
    const boardSwitch = player.locator(".generator-switch");
    check((await boardSwitch.locator("button.active").innerText()) === "Graded", "the leaderboard opens on Graded");
    check(await boardSwitch.getByRole("button", { name: "What's this?" }).count() === 0, "the leaderboard's switch has no explainer link");
    await shot(player, "leaderboard-graded");
    const classicResponse = player.waitForResponse((r) => r.url().includes("/leaderboard?") && r.url().includes("generator=1"));
    await boardSwitch.getByRole("button", { name: "Classic", exact: true }).click();
    const classicBoard = await (await classicResponse).json();
    check(classicBoard.generator === 1, "the Classic leaderboard is asked for");
    await player.locator(".generator-switch button.active", { hasText: "Classic" }).waitFor();
    await player.getByText("Loading…").waitFor({ state: "detached" });
    check(await player.locator(".board-table", { hasText: bob.name }).count() === 0, "the Classic leaderboard doesn't count the Graded solve");
    await player.getByText("‹ Earlier").click();
    await player.locator(".generator-switch button.active", { hasText: "Classic" }).waitFor();
    check(true, "an earlier day keeps the generator");
    await player.getByText("‹ Back").click();

    // Stats opens on the pick.
    await player.getByRole("button", { name: "Stats", exact: true }).click();
    await player.locator(".generator-tabs button.active", { hasText: "Graded" }).waitFor();
    check(true, "Stats opens on Graded, the generator in use");

    // The admin results list names the generator.
    await admin.getByRole("button", { name: "Results and replays" }).click();
    const row = admin.locator("tr", { hasText: bob.name });
    await row.waitFor();
    check((await row.innerText()).startsWith("Graded "), "the admin results list names the generator");
    await row.click();
    await admin.getByText(`${bob.name}, Graded Easy on`, { exact: false }).waitFor();
    check(true, "the replay heading names the generator");
    await admin.getByText("‹ Back").click();
    await admin.getByText("‹ Back").click();
    await admin.locator(".generator-admin .generator-choices").waitFor();

    // Serverless play.
    await seedPage.goto(base + "/");
    await seedPage.getByText("Play with a seed instead").click();
    await seedPage.fill("#seed", "generator-e2e-" + run);
    await seedPage.getByRole("button", { name: "Start playing", exact: true }).click();
    await seedPage.locator(".puzzles").waitFor();
    const setting = seedPage.locator(".generator-setting");
    check((await setting.innerText()).includes("On: Classic."), "the seed card shows Classic on");
    check(JSON.stringify(await setting.locator(".generator-choices button").allInnerTexts()) === '["Classic","Graded","Both"]', "the seed card offers Classic, Graded and Both");
    check((await setting.locator("button[aria-pressed=true]").innerText()) === "Classic", "Classic is marked");
    check(await seedPage.locator(".generator-switch").count() === 0, "no switch with one generator");
    await setting.getByRole("button", { name: "What's this?" }).click();
    await checkExplainer(seedPage, "seed card", "This seed's puzzles use Classic.", { seed: true });

    await setting.getByRole("button", { name: "Both", exact: true }).click();
    await seedPage.locator(".generator-switch").waitFor();
    check((await setting.innerText()).includes("On: Classic and Graded."), "Both applies straight away");
    const stored = await seedPage.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("sudoku.seed-generator-")).map(([, v]) => v));
    check(JSON.stringify(stored) === '["[1,2]"]', "the seed's enabled set is in localStorage");
    await seedPage.locator(".generator-switch").getByRole("button", { name: "What's this?" }).click();
    await checkExplainer(seedPage, "seed switch", "You can play Classic or Graded: pick with the switch on the Daily and Endless tabs.", { seed: true });
    await seedPage.locator(".generator-switch").getByRole("button", { name: "Graded", exact: true }).click();
    await seedPage.locator(".generator-switch button.active", { hasText: "Graded" }).waitFor();
    await setting.scrollIntoViewIfNeeded();
    await shot(seedPage, "seed-generators-both");

    // A Graded seed game shows in the history under its generator.
    await seedPage.locator(".puzzles li", { hasText: "Easy" }).first().getByRole("button").click();
    await seedPage.getByRole("heading", { level: 1, name: "Graded · Easy", exact: true }).waitFor();
    await fill(seedPage, false);
    await seedPage.getByRole("button", { name: "Today's puzzles" }).click();
    await seedPage.getByRole("button", { name: "History", exact: true }).first().click();
    await seedPage.getByText("Today · Graded").waitFor();
    check(true, "the history names the generator while both are on");
    await seedPage.getByText("‹ Back").click();

    await seedPage.reload();
    await seedPage.locator(".generator-switch button.active", { hasText: "Graded" }).waitFor();
    check(true, "the seed's setting and the pick survive a reload");
    await seedPage.locator(".generator-setting").getByRole("button", { name: "Graded", exact: true }).click();
    await seedPage.locator(".generator-switch").waitFor({ state: "detached" });
    check((await seedPage.locator(".generator-setting").innerText()).includes("On: Graded."), "Graded alone removes the switch");

    // An old #64 schedule reads as its latest entry, a pending change included.
    await seedPage.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sudoku.seed-generator-"));
      localStorage.setItem(key, JSON.stringify([{ fromWeek: "0000-W00", version: 2 }, { fromWeek: "2099-W01", version: 1 }]));
    });
    await seedPage.reload();
    await seedPage.locator(".generator-setting", { hasText: "On: Classic." }).waitFor();
    check(true, "an old schedule reads as its latest entry");

    // Back to Classic on the server.
    await adminChoose(card, "Classic", "Classic");
    check(await enabledNow() === "[1]", "the server is back on Classic alone");
    await player.getByText("‹ Back").click();
    await reloadSynced(player);
    await player.locator(".puzzles").waitFor();
    check(await player.locator(".generator-switch").count() === 0, "the player's switch is gone");
    check(await easyGrid(player, "Easy") === classicEasy, "and Classic plays, whatever was picked");
  } catch (e) {
    for (const [page, name] of [[admin, "failure-admin"], [player, "failure-player"], [seedPage, "failure-seed"]]) await shot(page, name);
    throw e;
  } finally {
    await api("dev:ann:Ann", "admin/generator", { method: "PUT", body: JSON.stringify({ enabled: [1] }) });
    await browser.close();
  }
  console.log("all generator checks passed");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
