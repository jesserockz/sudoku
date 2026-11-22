// End-to-end check of the Server admin progress cards (docs/WEB.md, "Server admin"), against a running server in dev
// auth mode that serves web/dist, with `ann` as the admin (SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann):
//
//   node web/e2e/update-progress.cjs [http://localhost:8080]
//
// The update status is mocked with page.route (the real server never updates itself here). While downloading, the
// card shows the message and the bytes. While restarting, for an update and for a rollback, it says only that this
// can take a minute, and reopening the page mid-restart shows the card again. Nothing tells the admin to keep the
// page open: the server does the work itself.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const WAIT = "This can take a minute.";

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => console.log("page error:", e.message));

  /** The mocked status, or null to let the real server answer. */
  let mocked = null;
  const status = (state, extra) => ({
    state, action: "update", target: "v99.0.0", message: "", error: "", bytesDone: 0, bytesTotal: 0,
    startedAt: new Date().toISOString(), finishedAt: null, rollbackAvailable: true, ...extra,
  });
  await page.route("**/api/v1/admin/update", (route) => {
    if (mocked === null || route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: mocked });
  });
  // The page picks an update up from the release list, so patch the real list's status.
  await page.route("**/api/v1/admin/releases*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (mocked !== null) json.update = mocked;
    await route.fulfill({ response, json });
  });
  const page_text = () => page.locator("body").innerText();
  const openAdmin = async () => {
    await page.goto(base + "/");
    if (await page.locator("#sub").count()) {
      await page.fill("#sub", "ann");
      await page.fill("#name", "Ann");
      await page.click("button[type=submit]");
    }
    await page.getByText("Easy", { exact: true }).waitFor();
    await page.getByText("About").click();
    await page.getByRole("button", { name: "Admin", exact: true }).click();
  };

  mocked = status("downloading", { message: "Downloading v99.0.0", bytesDone: 1048576, bytesTotal: 4194304 });
  await openAdmin();
  await page.getByText("Downloading v99.0.0", { exact: true }).waitFor();
  check(await page.getByText("1.0 MB of 4.0 MB").count() === 1, "the running card shows the bytes");
  check(!/close/i.test(await page_text()), "the running card says nothing about closing the page");

  mocked = status("restarting");
  await openAdmin();
  await page.getByText("Restarting the server on 99.0.0").waitFor();
  check(await page.getByText(WAIT, { exact: true }).count() === 1, "the restarting card for an update says it can take a minute");
  check(!/close/i.test(await page_text()), "the restarting card says nothing about closing the page");

  mocked = status("restarting", { action: "rollback" });
  await openAdmin();
  await page.getByText("Restarting the server on 99.0.0").waitFor();
  check(await page.getByText(WAIT, { exact: true }).count() === 1, "the restarting card for a rollback says the same");

  // Reopening: leave the page and come back while the server still says it is restarting.
  await page.goto("about:blank");
  await openAdmin();
  await page.getByText("Restarting the server on 99.0.0").waitFor();
  check(await page.getByText(WAIT, { exact: true }).count() === 1, "reopening the page mid-restart shows the card again");

  await browser.close();
  console.log("all ok");
})().catch((e) => { console.error(e); process.exit(1); });
