// End-to-end check of seed play offered by a real server (dev auth mode),
// started as in docs/CLIENTS.md, "Checking offline play":
//
//   node webApp/e2e/serverless-on-server.js http://localhost:8080 dev-secret-change-me
//
// The sign-in screen offers "Play with a seed instead", and a seed equal to
// the server's secret plays exactly the server's puzzles. Leaving the seed
// goes back to the signed-in server.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const secret = process.argv[3] || "dev-secret-change-me";

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

async function easyGrid(page) {
  await page.locator(".puzzles li").first().locator("button").click();
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.locator(".puzzles").waitFor();
  return labels.map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));

  // Signed in to the server: today's Easy puzzle from the server's week.
  await page.goto(base + "/");
  await page.fill("#sub", "seedcheck" + Date.now());
  await page.fill("#name", "Seed check");
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();
  const fromServer = await easyGrid(page);

  // A fresh browser chooses seed play from the sign-in screen, with the server's secret.
  const other = await (await browser.newContext()).newPage();
  await other.goto(base + "/");
  await other.getByRole("button", { name: "Play with a seed instead", exact: true }).click();
  await other.getByText("Play with a seed").first().waitFor();
  check(await other.getByText("There's no Sudoku server here", { exact: false }).count() === 0, "a real server offers seed play next to sign-in");
  await other.fill("#seed", secret);
  await other.getByRole("button", { name: "Start playing", exact: true }).click();
  await other.getByText("Easy", { exact: true }).waitFor();
  check(JSON.stringify(await easyGrid(other)) === JSON.stringify(fromServer), "the server's secret as a seed plays the server's puzzles");
  check(await other.getByRole("button", { name: "Leaderboard" }).count() === 0, "seed play has no server leaderboard");

  // A share link opened while signed in asks before switching; leaving the seed returns to the server.
  await page.evaluate(() => { location.hash = "#seed=family&levels=5"; });
  await page.getByText("Switch to this seed?").waitFor();
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await page.locator("#share-link").waitFor();
  await page.getByRole("button", { name: "Leave seed", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  check(JSON.stringify(await easyGrid(page)) === JSON.stringify(fromServer), "leaving the seed goes back to the signed-in server");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
