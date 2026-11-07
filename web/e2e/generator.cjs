// End-to-end check of the puzzle generator setting against a running server in dev auth mode that serves
// web/dist, with `ann` as admin and an empty database (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/generator.cjs [http://localhost:8080] [screenshot dir]
//
// Ann (admin) opens Server admin: the Puzzle generator card says Classic is active with nothing pending.
// She schedules Graded, which is pending until next week ("Graded from <next ISO week>") and shows the
// player-facing notice on the Daily tab, cancels it, schedules it again and replaces it. Bob (not an admin)
// sees the notice and the generator on About, and the Stats toggle refetches with ?generator=. In a fresh
// browser, serverless play (a seed) has the same setting in its seed card: pending, cancellable, kept in
// localStorage per seed. Screenshots are taken at phone width.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);

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
  await page.locator(".generator-admin").waitFor();
}

// Checks the "Classic and Graded puzzles" dialog that is open (title, five levels, this week's line) and closes it.
async function checkExplainer(page, where, lead, seed = false) {
  const dialog = page.getByRole("dialog", { name: "Classic and Graded puzzles" });
  await dialog.waitFor();
  check(await dialog.locator("li strong").allInnerTexts().then((t) => t.join(" ") === "Easy: Medium: Hard: Expert: Diabolical:"), `${where}: the explainer lists the five levels`);
  const text = await dialog.innerText();
  check(text.includes(lead), `${where}: the explainer starts with "${lead}"`);
  check(/choose/i.test(text) === seed, `${where}: ${seed ? "seed play points to the choice" : "players with a server are not offered a choice"}`);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await dialog.waitFor({ state: "detached" });
  check(true, `${where}: the explainer closes`);
}

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };

(async () => {
  const week = await (await api("dev:ann:Ann", "week")).json();
  check(week.generator === 1 && week.pendingGenerator === null, "the server starts on Classic with nothing pending");
  const nextWeek = (await (await api("dev:ann:Ann", "admin/generator", { method: "PUT", body: JSON.stringify({ version: 2 }) })).json()).pending.fromWeek;
  await api("dev:ann:Ann", "admin/generator/pending", { method: "DELETE" });
  check(/^\d{4}-W\d{2}$/.test(nextWeek) && nextWeek > week.isoWeek, `scheduling gives the next ISO week (${nextWeek})`);

  const browser = await chromium.launch();

  // Admin.
  const admin = await (await browser.newContext(phone)).newPage();
  admin.on("pageerror", (e) => console.log("page error:", e.message));
  await signIn(admin, "ann", "Ann");
  check(await admin.locator(".generator-notice").count() === 0, "no notice while nothing is pending");
  await openAdmin(admin);
  const card = admin.locator(".generator-admin");
  check((await card.innerText()).includes("Active: Classic"), "the admin card shows Classic as active");
  check(await card.locator(".generator-pending").count() === 0, "nothing is pending");
  check(await card.getByRole("button", { name: "Classic from next week" }).count() === 0, "no button offers the active generator");
  check(await card.getByRole("button", { name: "Cancel", exact: true }).count() === 0, "no Cancel without a pending change");
  check((await card.innerText()).includes("Classic from the beginning"), "the history lists Classic from the beginning");
  check((await card.innerText()).includes("next ISO week"), "it explains changes apply from the next ISO week");
  await shot(admin, "admin-generator-none");

  await card.getByRole("button", { name: "Graded from next week" }).click();
  await card.locator(".generator-pending").waitFor();
  check((await card.locator(".generator-pending").innerText()).includes(`Graded from ${nextWeek}`), `the pending change reads "Graded from ${nextWeek}"`);
  check((await card.innerText()).includes("Active: Classic"), "the current week is still Classic");
  check(await card.getByRole("button", { name: /from next week/ }).count() === 0, "the generator buttons are hidden while a change is pending");
  await shot(admin, "admin-generator-pending");

  // Cancel, then schedule again.
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.locator(".generator-pending").waitFor({ state: "detached" });
  check(true, "Cancel removes the pending change");
  // Schedule it again (replacing a pending change is not possible in the UI with two versions; server tests cover it).
  await card.getByRole("button", { name: "Graded from next week" }).click();
  await card.locator(".generator-pending").waitFor();

  // A player.
  const player = await (await browser.newContext(phone)).newPage();
  player.on("pageerror", (e) => console.log("page error:", e.message));
  await signIn(player, "bob" + run, "Bob" + run);
  const notice = player.locator(".generator-notice");
  await notice.waitFor();
  check((await notice.innerText()) === `From next week (${nextWeek}), daily puzzles use the Graded generator. What's this?`, "players see the pending notice on the Daily tab");
  await shot(player, "player-pending-notice");
  await notice.getByRole("button", { name: "What's this?" }).click();
  await checkExplainer(player, "Daily notice", `From next week (${nextWeek}), puzzles switch from Classic to Graded.`);
  await player.getByRole("button", { name: "About", exact: true }).click();
  await player.getByText("Daily generator").waitFor();
  check((await player.locator("tr", { hasText: "Daily generator" }).innerText()).includes("Classic (this week)"), "About shows this week's generator");
  await player.getByRole("button", { name: "Classic and Graded", exact: true }).click();
  await checkExplainer(player, "About", `From next week (${nextWeek}), puzzles switch from Classic to Graded.`);
  await player.getByRole("button", { name: "‹ Back", exact: true }).click();

  // Stats toggle.
  await player.getByRole("button", { name: "Stats", exact: true }).click();
  const tabs = player.locator(".generator-tabs");
  await tabs.waitFor();
  check((await tabs.locator("button.active").innerText()) === "Classic", "Stats opens on the generator in use");
  const request = player.waitForRequest((r) => r.url().includes("/me/stats?generator=2"));
  await tabs.getByRole("button", { name: "Graded" }).click();
  await request;
  await player.locator(".generator-tabs button.active", { hasText: "Graded" }).waitFor();
  check(true, "choosing Graded on Stats refetches with generator=2");
  await shot(player, "stats-graded");

  // Leave the server as it was.
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.locator(".generator-pending").waitFor({ state: "detached" });
  check((await (await api("dev:ann:Ann", "week")).json()).pendingGenerator === null, "the pending change is cancelled on the server");
  await player.reload();
  await player.getByText("Easy", { exact: true }).waitFor();
  await player.locator(".generator-notice").waitFor({ state: "detached" });
  check(true, "the notice is gone after the next sync");

  // Serverless play.
  const seedPage = await (await browser.newContext(phone)).newPage();
  seedPage.on("pageerror", (e) => console.log("page error:", e.message));
  await seedPage.goto(base + "/");
  await seedPage.getByText("Play with a seed instead").click();
  await seedPage.fill("#seed", "generator-e2e-" + run);
  await seedPage.getByRole("button", { name: "Start playing", exact: true }).click();
  await seedPage.locator(".puzzles").waitFor();
  const setting = seedPage.locator(".generator-setting");
  check((await setting.innerText()).includes("This week: Classic."), "the seed card shows this week's generator");
  check(await seedPage.locator(".generator-notice").count() === 0, "no notice while nothing is pending");
  await setting.getByRole("button", { name: "What's this?" }).click();
  await checkExplainer(seedPage, "seed card", "This seed's puzzles use Classic.", true);
  await setting.getByRole("button", { name: "Graded from next week" }).click();
  await seedPage.locator(".generator-pending").waitFor();
  const seedNotice = seedPage.locator(".generator-notice");
  check((await seedNotice.innerText()).includes(`From next week (${nextWeek}), daily puzzles use the Graded generator.`), "seed play shows the same pending notice");
  const stored = await seedPage.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("sudoku.seed-generator-")).map(([, v]) => JSON.parse(v)));
  check(stored.length === 1 && stored[0].length === 2 && stored[0][0].fromWeek === "0000-W00" && stored[0][1].fromWeek === nextWeek && stored[0][1].version === 2,
    "the choice is a schedule history in localStorage");
  await seedNotice.getByRole("button", { name: "What's this?" }).click();
  await checkExplainer(seedPage, "seed notice", `From next week (${nextWeek}), puzzles switch from Classic to Graded.`, true);
  await setting.scrollIntoViewIfNeeded();
  await shot(seedPage, "seed-generator-pending");
  await seedPage.reload();
  await seedPage.locator(".generator-notice").waitFor();
  check(true, "the pending change survives a reload");
  await seedPage.locator(".generator-setting").getByRole("button", { name: "Cancel", exact: true }).click();
  await seedPage.locator(".generator-pending").waitFor({ state: "detached" });
  check(await seedPage.locator(".generator-notice").count() === 0, "cancelling removes the pending change and the notice");

  await browser.close();
  console.log("all generator checks passed");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
