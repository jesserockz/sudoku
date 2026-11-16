// End-to-end check of maintenance mode against a running server in dev auth mode that serves web/dist, with `ann`
// as the admin (SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann) and an empty database (see docs/WEB.md):
//
//   node web/e2e/maintenance.cjs [http://localhost:8080] [screenshot dir]
//
// The admin switches maintenance on with an end time. A player who has this week's seed sees the banner with the end
// time in local time, solves a puzzle and the result stays queued; a device without this week's puzzles is told to try
// again later; the admin sees the big reminder, plays and uses the leaderboard as usual. The admin switches it off, the
// player's banner clears by itself (no reload) and the queued score uploads. With a screenshot dir it also saves
// 390x844 pictures of the banners and the Admin card in light and dark.
const { chromium } = require("playwright");
const fs = require("fs");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || "";
const stamp = Date.now();
const player = "mp" + stamp;
const fresh = "mf" + stamp;
const same = (a, b) => a != null && new Date(a).getTime() === new Date(b).getTime();
const SIZES = [[320, 568], [360, 640], [390, 844], [412, 915]];

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

async function signIn(page, sub, name) {
  await page.goto(base + "/");
  await page.fill("#sub", sub);
  await page.fill("#name", name);
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();
}

const api = (path, token, init = {}) => fetch(base + "/api/v1/" + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) } });

/** The page has no vertical scroll: the play screen's banner took its height from the board, not from the page. */
async function noScroll(page, what) {
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: window.innerHeight, sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    check(m.sh <= m.ih && m.sw <= m.iw, `${what} fits ${width}x${height} without scrolling (${m.sh}/${m.ih}, ${m.sw}/${m.iw})`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

const back = (page) => page.getByRole("button", { name: /Back/ }).first().click();

async function shot(page, name, scrollTo) {
  if (!shots) return;
  if (scrollTo) await page.locator(scrollTo).scrollIntoViewIfNeeded();
  fs.mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Solves the open puzzle by clicking the cells. */
async function solveOpen(page) {
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
}

(async () => {
  const browser = await chromium.launch();
  const mobile = { viewport: { width: 390, height: 844 } };
  const playerCtx = await browser.newContext(mobile);
  const freshCtx = await browser.newContext(mobile);
  const adminCtx = await browser.newContext(mobile);
  const pPage = await playerCtx.newPage();
  const fPage = await freshCtx.newPage();
  const aPage = await adminCtx.newPage();
  for (const p of [pPage, fPage, aPage]) p.on("pageerror", (e) => console.log("page error:", e.message));

  // Before maintenance: a player and another device sign in and get the week's puzzles.
  await signIn(pPage, player, "Maia");
  await signIn(fPage, fresh, "Finn");
  check(await pPage.locator(".maintenance-banner").count() === 0, "no banner while maintenance is off");
  // Without maintenance, a device that never got the endless seed says to connect, as before.
  await fPage.evaluate(() => localStorage.removeItem("sudoku.endless"));
  await fPage.route("**/api/v1/endless", (route) => route.abort());
  await fPage.reload();
  await fPage.getByRole("tab", { name: "Endless" }).click();
  await fPage.getByRole("button", { name: "Got it" }).click(); // the first-visit explainer
  await fPage.getByText("The endless puzzles haven't been downloaded yet.").waitFor();
  check(await fPage.locator(".maintenance-later").count() === 0, "the usual 'connect once' message shows without maintenance");
  await fPage.unroute("**/api/v1/endless");
  await fPage.getByRole("tab", { name: "Daily" }).click();
  // The second device loses this week's puzzles (as a device that was away for a week would have).
  await fPage.evaluate(() => { localStorage.removeItem("sudoku.week"); localStorage.removeItem("sudoku.endless"); });

  // The admin switches it on, with an end time three hours from now, from the Admin page.
  await signIn(aPage, "ann", "Ann");
  await aPage.getByText("About").click();
  await aPage.getByRole("button", { name: "Admin", exact: true }).click();
  await aPage.locator("#maintenance-on").waitFor();
  check(!(await aPage.locator("#maintenance-on").isChecked()) && (await aPage.locator("#maintenance-until").inputValue()) === "", "the Admin card starts off, with no end time");
  const until = await aPage.evaluate(() => {
    const d = new Date(Date.now() + 3 * 3600e3);
    const p = (n) => String(n).padStart(2, "0");
    return { local: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` };
  });
  const untilIso = await aPage.evaluate((local) => new Date(local).toISOString(), until.local);
  await aPage.locator("#maintenance-on").check();
  await aPage.fill("#maintenance-until", until.local);
  // A save that can't reach the server says so, and nothing changes.
  await aPage.route("**/api/v1/admin/maintenance", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await aPage.click("#maintenance-save");
  await aPage.locator(".maintenance-admin .error").waitFor();
  check((await aPage.locator(".maintenance-admin .error").innerText()).includes("Couldn't reach the server"), "a failed save shows why on the card");
  check((await (await api("admin/maintenance", "dev:ann:Ann")).json()).enabled === false, "and the server is still off");
  await aPage.unroute("**/api/v1/admin/maintenance");
  check(await aPage.locator("#maintenance-on").isChecked() && (await aPage.locator("#maintenance-until").inputValue()) === until.local, "the typed values are kept");
  await aPage.click("#maintenance-save");
  await aPage.getByText("On: players can't reach the server.").waitFor();
  const stored = await (await api("admin/maintenance", "dev:ann:Ann")).json();
  check(stored.enabled === true && same(stored.until, untilIso), `the server stored it on, ending ${untilIso}`);
  check(same((await (await fetch(base + "/api/v1/config")).json()).maintenance?.until, untilIso), "the public config reports it");
  const adminBanner = aPage.locator(".maintenance-banner.admin");
  await adminBanner.waitFor();
  check((await adminBanner.innerText()).includes("Maintenance mode is on. Players can't reach the server."), "the admin gets the big reminder at once");
  check((await adminBanner.innerText()).includes("Players see: Back around"), "the reminder shows the end time");
  await shot(aPage, "admin-page", "#maintenance-save");

  // The player's next sync finds out: a banner with the end time in their local time, puzzles still there.
  const backAround = await pPage.evaluate((iso) => "Back around " + new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)), untilIso);
  await pPage.reload();
  const banner = pPage.locator(".maintenance-banner.player");
  await banner.waitFor();
  // From here on the page is never reloaded, so the marker proves the banner clears by itself.
  await pPage.evaluate(() => { window.__sameDocument = true; });
  const text = await banner.innerText();
  check(text.includes("The server is down for maintenance. Puzzles still work and your scores will upload when it's back. There's nothing you need to do."), "the player's banner explains what is happening");
  check(text.includes(backAround), `it says "${backAround}" in the player's local time`);
  check(await pPage.getByText("Play", { exact: true }).count() >= 1, "today's puzzles are still there to play");
  check(await pPage.locator(".notice").count() === 0, "no error notice next to the banner");
  await shot(pPage, "player-banner");

  // Solving offline-style: the result is queued, not rejected.
  await pPage.getByText("Play", { exact: true }).first().click();
  const compact = pPage.locator(".maintenance-banner.player.compact");
  await compact.waitFor();
  check((await compact.innerText()).includes(backAround), "on the play screen the banner is one line with the time");
  await noScroll(pPage, "the play screen with the player banner");
  await solveOpen(pPage);
  const queued = await pPage.evaluate(() => JSON.parse(localStorage.getItem("sudoku.pending") || "[]"));
  check(queued.length === 1 && queued[0].level === 1, "the solved result is queued on the device");
  await pPage.getByText("See scores").click();
  await pPage.getByText("The server is down for maintenance. " + backAround, { exact: false }).waitFor();
  check(true, "the leaderboard says the server is down, with the time");
  await back(pPage);
  await pPage.getByText("Easy", { exact: true }).waitFor();
  check(await pPage.locator(".maintenance-banner.player").count() === 1, "the banner stays on the Today screen");
  check((await pPage.evaluate(() => JSON.parse(localStorage.getItem("sudoku.pending") || "[]"))).length === 1, "the result is still queued after the retry (not dropped)");

  // A device without this week's puzzles is told to come back, not offered play.
  await fPage.reload();
  await fPage.getByText("The server is down for maintenance. Please try again later.").waitFor();
  check((await fPage.locator("sudoku-app").innerText()).includes(backAround), "the device without puzzles shows the end time too");
  check(await fPage.getByText("Play", { exact: true }).count() === 0, "and offers no puzzle to play");
  await shot(fPage, "try-later");
  await fPage.getByRole("tab", { name: "Endless" }).click();
  await fPage.locator(".maintenance-later").waitFor();
  check((await fPage.locator(".maintenance-later").innerText()).includes("The server is down for maintenance. Please try again later."), "the Endless tab says the same when its puzzles were never downloaded");
  await fPage.getByRole("tab", { name: "Daily" }).click();
  // "Try again" while it lasts shows it is checking, then the same message.
  await fPage.route("**/api/v1/me", async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
  await fPage.getByRole("button", { name: "Try again" }).click();
  await fPage.getByRole("button", { name: "Checking…" }).waitFor();
  await fPage.getByRole("button", { name: "Try again" }).waitFor();
  await fPage.unroute("**/api/v1/me");
  check(true, "Try again shows it is checking, and the message stays");
  // Signing in on a device that has never signed in also says so rather than "couldn't reach the server".
  const newCtx = await browser.newContext(mobile);
  const nPage = await newCtx.newPage();
  await nPage.goto(base + "/");
  await nPage.fill("#sub", "mn" + stamp);
  await nPage.fill("#name", "Newbie");
  await nPage.route("**/api/v1/me", (route) => route.abort());
  await nPage.click("button[type=submit]");
  await nPage.getByText("Sign-in failed: couldn't reach the server.").waitFor();
  check(true, "an unreachable server is still reported as that");
  await nPage.unroute("**/api/v1/me");
  await nPage.click("button[type=submit]");
  await nPage.getByText("The server is down for maintenance. " + backAround, { exact: false }).waitFor();
  check(true, "dev sign-in during maintenance explains why it failed");

  // Everything else a player asks of the server is refused the same way, while an unauthenticated request keeps its 401.
  const alice = await api("week", `dev:${player}:Maia`);
  const refused = await alice.json();
  check(alice.status === 503 && refused.error.code === "maintenance" && same(refused.error.until, untilIso), "the API answers 503 maintenance with the end time to a player");
  check((await fetch(base + "/api/v1/week")).status === 401, "a request with no token keeps its 401");

  // The admin plays and uses the leaderboard as usual, with the reminder on every screen.
  await back(aPage); // Admin -> About
  await back(aPage); // About -> Today
  await aPage.getByText("Easy", { exact: true }).waitFor();
  check(await aPage.locator(".maintenance-banner.admin").count() === 1, "the reminder is on the Today screen");
  check(await aPage.locator(".maintenance-banner.player").count() === 0, "an admin gets no player banner");
  await shot(aPage, "admin-banner");
  await aPage.getByText("Play", { exact: true }).first().click();
  await aPage.locator(".maintenance-banner.admin.compact").waitFor();
  check(true, "the reminder shrinks to one line on the play screen");
  await noScroll(aPage, "the play screen with the admin reminder");
  await back(aPage);
  await aPage.getByText("Easy", { exact: true }).waitFor();
  // The admin's leaderboard (the endless one, as nothing is solved yet) answers normally.
  await aPage.getByRole("tab", { name: "Endless" }).click();
  await aPage.getByRole("button", { name: "Got it" }).click(); // the first-visit explainer
  const board = aPage.waitForResponse((r) => r.url().includes("/api/v1/endless/leaderboard"));
  await aPage.getByRole("button", { name: "Leaderboard" }).click();
  check((await board).status() === 200, "the admin's leaderboard request is answered normally");
  await aPage.getByText("Easy", { exact: false }).first().waitFor();
  check(await aPage.getByText("down for maintenance").count() === 0, "and shows no maintenance message");
  await aPage.locator(".maintenance-banner.admin").waitFor();
  check(true, "the reminder is on the leaderboard screen too");
  await back(aPage);
  await aPage.getByText("About").click();
  await aPage.getByRole("button", { name: "Admin", exact: true }).click();

  // Switch it off from the reminder, through the Admin page.
  await back(aPage); // Admin -> About
  await back(aPage); // About -> Today
  await aPage.getByRole("button", { name: "Switch off in Admin" }).click();
  await aPage.locator("#maintenance-on").waitFor();
  check(await aPage.locator("#maintenance-on").isChecked(), "the Admin card shows it on");
  check((await aPage.locator("#maintenance-until").inputValue()) === until.local, "with the end time in the admin's local time");
  await aPage.click("#maintenance-clear");
  check((await aPage.locator("#maintenance-until").inputValue()) === "", "Clear empties the end time");
  await aPage.locator("#maintenance-on").uncheck();
  await aPage.click("#maintenance-save");
  await aPage.getByText("Off.", { exact: true }).waitFor();
  await aPage.locator(".maintenance-banner").waitFor({ state: "detached" });
  check((await (await api("admin/maintenance", "dev:ann:Ann")).json()).enabled === false, "the server has it off");
  check((await (await fetch(base + "/api/v1/config")).json()).maintenance === null, "the public config is back to null");

  // The player's banner clears by itself (the 30 s retry), with no reload, and the queued score uploads.
  await pPage.waitForFunction(() => document.querySelectorAll(".maintenance-banner").length === 0, null, { timeout: 60000 });
  check(await pPage.evaluate(() => window.__sameDocument === true), "the banner cleared without a reload");
  await pPage.waitForFunction(() => localStorage.getItem("sudoku.pending") == null, null, { timeout: 30000 });
  const mine = await (await api(`me/results?date=${queued[0].date}`, `dev:${player}:Maia`)).json();
  check(mine.results.length === 1 && mine.results[0].level === 1 && mine.results[0].elapsedMs === queued[0].elapsedMs, "the queued score uploaded by itself");
  await pPage.getByText("Solved in", { exact: false }).waitFor();
  check(!(await pPage.getByText("not uploaded yet", { exact: false }).count()), "Today no longer says the score is waiting");

  // The device without puzzles recovers too, and gets them.
  await fPage.getByText("Easy", { exact: true }).waitFor({ timeout: 60000 });
  check(await fPage.getByText("down for maintenance").count() === 0, "the device without puzzles got them once the server was back");

  // Switched on again with no end time: the banner has no "Back around", on Today and on the play screen.
  await api("admin/maintenance", "dev:ann:Ann", { method: "PUT", body: JSON.stringify({ enabled: true, until: null }) });
  await pPage.reload();
  await pPage.locator(".maintenance-banner.player").waitFor();
  check(!(await pPage.locator(".maintenance-banner").innerText()).includes("Back around"), "without an end time the banner has no time");
  await pPage.getByText("Play", { exact: true }).first().click();
  const plain = pPage.locator(".maintenance-banner.player.compact");
  await plain.waitFor();
  check((await plain.innerText()).includes("Server down for maintenance. Scores upload when it's back."), "the play screen's one-liner needs no time either");
  await noScroll(pPage, "the play screen with the timeless banner");
  await api("admin/maintenance", "dev:ann:Ann", { method: "PUT", body: JSON.stringify({ enabled: false, until: null }) });

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
