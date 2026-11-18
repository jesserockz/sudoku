// End-to-end check that the play screen can't be zoomed or have its text selected (docs/WEB.md, "What it does"), in
// a real browser with a touch screen, in serverless seed play so it needs no server, against the production bundle
// on a plain static file server:
//
//   (cd web && npm run build)
//   (cd web/dist && python3 -m http.server 8090) &
//   node web/e2e/zoom-lock.cjs http://localhost:8090/
//
// On the home page a real pinch zooms the page and a double click selects a word, which shows the checks can fail.
// On the play screen the same pinch and double click do nothing, a long press selects nothing, and taps, the number
// pad and the keyboard still play. Leaving the game gives zoom and selection back, on the home page and on About.
const { chromium } = require("playwright");

const base = new URL(process.argv[2] || "http://localhost:8090/").href;

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const cdp = await context.newCDPSession(page);

  /** Moves two fingers along a line through the middle of the page, from `from` pixels either side of it to `to`. */
  const twoFingers = async (from, to) => {
    const touch = (type, d) => cdp.send("Input.dispatchTouchEvent", {
      type, touchPoints: type === "touchEnd" ? [] : [{ x: 195 - d, y: 300, id: 1 }, { x: 195 + d, y: 300, id: 2 }],
    });
    await touch("touchStart", from);
    for (let k = 1; k <= 12; k++) {
      await touch("touchMove", from + ((to - from) * k) / 12);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", to);
    await page.waitForTimeout(300);
  };
  /** Pinches out with two fingers and returns how far the page is zoomed afterwards (1 is not at all). */
  const pinch = async () => {
    await twoFingers(20, 150);
    return page.evaluate(() => window.visualViewport.scale);
  };
  /** Pinches back in until the page is not zoomed, for the next check. */
  const unpinch = async () => {
    for (let k = 0; k < 5 && (await page.evaluate(() => window.visualViewport.scale)) > 1; k++) await twoFingers(150, 10);
    check((await page.evaluate(() => window.visualViewport.scale)) === 1, "pinching in zooms back out");
  };
  /** Double clicks the element and returns the text that selects. */
  const selectByDoubleClick = async (locator) => {
    await page.evaluate(() => getSelection().removeAllRanges());
    await locator.dblclick();
    return page.evaluate(() => getSelection().toString().trim());
  };
  const rootStyle = (prop) => page.evaluate((p) => getComputedStyle(document.documentElement)[p], prop);
  const playing = () => page.evaluate(() => document.documentElement.classList.contains("playing"));

  await page.goto(base);
  await page.getByText("There's no Sudoku server here", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByRole("button", { name: "Start playing", exact: true }).click();
  await page.locator(".puzzles").waitFor();

  // The home page zooms and selects as any page does.
  check(!(await playing()), "the home page is not locked");
  check((await pinch()) > 1.2, "a pinch zooms the home page");
  await unpinch();
  check((await selectByDoubleClick(page.locator("h1").first())) !== "", "a double click selects text on the home page");

  // The play screen does neither.
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  check(await playing(), "the play screen locks the page");
  check((await rootStyle("touchAction")) === "pan-x pan-y", "touch-action leaves panning only");
  check((await rootStyle("userSelect")) === "none", "text selection is off");
  check((await pinch()) === 1, "a pinch does not zoom the play screen");
  check((await selectByDoubleClick(page.locator(".topbar h1, h1").first())) === "", "a double click on the title selects nothing");
  check((await selectByDoubleClick(page.locator(".timer"))) === "", "a double click on the timer selects nothing");
  const box = await cells.first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  check((await page.evaluate(() => getSelection().toString())) === "", "a long press on the board selects nothing");

  // Playing still works: a tap selects, the number pad and the keyboard fill squares.
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const empties = labels.flatMap((l, i) => (l.endsWith("empty") ? [i] : []));
  await cells.nth(empties[0]).tap();
  check((await cells.nth(empties[0]).getAttribute("class")).includes("selected"), "a tap selects a square");
  await page.locator(".keypad button", { hasText: /^5/ }).first().tap();
  check((await cells.nth(empties[0]).getAttribute("aria-label")).includes("5"), "the number pad fills the square");
  await cells.nth(empties[1]).tap();
  await page.keyboard.press("7");
  check((await cells.nth(empties[1]).getAttribute("aria-label")).includes("7"), "the keyboard fills a square");
  check((await page.evaluate(() => window.visualViewport.scale)) === 1, "none of that zoomed the page");

  // Leaving the game unlocks the page again.
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.locator(".puzzles").waitFor();
  check(!(await playing()), "leaving the game unlocks the page");
  check((await rootStyle("userSelect")) !== "none", "text selection is back");
  check((await pinch()) > 1.2, "a pinch zooms the home page again");
  await unpinch();
  await page.getByRole("button", { name: "About" }).click();
  check((await selectByDoubleClick(page.locator("td", { hasText: "Web version" }))) !== "", "a double click selects text on About");

  await browser.close();
  console.log("zoom lock: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
