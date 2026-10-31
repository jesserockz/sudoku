// End-to-end check of the "new version available" banner against the
// production bundle on a plain static file server with no /api (see
// docs/WEB.md, "Hosting without a server"):
//
//   (cd web && npm run build)
//   (cd web/dist && python3 -m http.server 8090) &
//   node web/e2e/update.cjs http://localhost:8090/ web/dist
//
// Loads the app and checks the first install shows no banner, simulates a
// deployment by changing the BUILD_VERSION in the served sw.js (restored
// afterwards), triggers the update check the way real users do (going offline
// and back online), checks the banner appears above the current screen, then
// clicks Reload and checks the banner is gone and the new worker is in control.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const base = new URL(process.argv[2] || "http://localhost:8090/").href;
const swPath = path.join(process.argv[3] || path.join(__dirname, "..", "dist"), "sw.js");

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

const controlled = (page) => page.evaluate(() => navigator.serviceWorker.controller != null);
const shellCaches = (page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("sudoku-shell-")));

(async () => {
  const original = fs.readFileSync(swPath, "utf8");
  const pattern = /const BUILD_VERSION = "[^"]*";/;
  check(pattern.test(original), "sw.js has a BUILD_VERSION to change");
  const newVersion = "e2e-update-" + Date.now();

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("page error:", e.message));
    const banner = page.locator(".update-banner");

    // 1. First install: the worker claims the page, which is not an update.
    await page.goto(base);
    await page.getByText("Play with a seed").first().waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await controlled(page))) await page.reload(); // a first install claims after the page loaded
    await page.waitForFunction(() => navigator.serviceWorker.controller != null);
    await page.getByText("Play with a seed").first().waitFor();
    check(await controlled(page), "the page is controlled by the service worker");
    const oldCaches = await shellCaches(page);
    check(oldCaches.length === 1 && !oldCaches[0].includes(newVersion), `one shell cache for the current build (${oldCaches[0]})`);
    await page.waitForTimeout(500); // room for a (wrong) controllerchange banner
    check(await banner.count() === 0, "no banner after the first install");

    // 2. A "deployment": the server now serves a different sw.js.
    fs.writeFileSync(swPath, original.replace(pattern, `const BUILD_VERSION = "${newVersion}";`));

    // 3. Coming back online makes the page ask for the new worker.
    await context.setOffline(true);
    await context.setOffline(false);
    await banner.waitFor({ timeout: 15000 });
    check((await banner.getAttribute("role")) === "status", "the banner is a status region");
    check((await banner.innerText()).includes("A new version is available"), "the banner says a new version is available");
    const reload = banner.getByRole("button", { name: "Reload", exact: true });
    check(await reload.isVisible(), "the banner has a Reload button");
    check(await page.getByText("Play with a seed").first().isVisible(), "the current screen is still shown");
    check(await page.evaluate(() => {
      const el = document.querySelector(".update-banner");
      return el.nextElementSibling != null && el.nextElementSibling.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 1;
    }), "the screen is below the banner");
    check(await banner.count() === 1, "only one banner");

    // 4. Reload picks up the new version.
    await Promise.all([page.waitForNavigation(), reload.click()]);
    await page.getByText("Play with a seed").first().waitFor();
    check(await banner.count() === 0, "the banner is gone after reloading");
    await page.waitForFunction(() => navigator.serviceWorker.controller != null);
    check(await controlled(page), "the page is controlled by the new worker");
    await page.waitForFunction(async (v) => (await caches.keys()).some((k) => k.startsWith("sudoku-shell-" + v)), newVersion);
    const caches2 = await shellCaches(page);
    check(caches2.length === 1 && caches2[0].includes(newVersion), `only the new build's shell cache remains (${caches2[0]})`);
    await page.waitForTimeout(500);
    check(await banner.count() === 0, "no banner right after the update either");
  } finally {
    fs.writeFileSync(swPath, original);
    await browser.close();
  }
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
