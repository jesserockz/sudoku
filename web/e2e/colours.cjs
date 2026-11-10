// End-to-end check of the colour pens (docs/WEB.md, "What it does") in a real
// browser, in serverless seed play so it needs no server, against the
// production bundle on a plain static file server:
//
//   (cd web && npm run build)
//   (cd web/dist && python3 -m http.server 8090) &
//   node web/e2e/colours.cjs http://localhost:8090/
//
// Checks the Colour toggle (button and C key), tapping to cycle none, A, B,
// none without selecting or placing anything, digits and Erase being off in
// colour mode, givens refusing a colour, the tints showing together with the
// selection, notes and digits, Clear colours, undo and Clear board, the dark
// theme tokens, colours surviving a reload in Daily and Endless, the colours
// being left out of the replay and results, and being dropped on solving.
const { chromium } = require("playwright");

const base = new URL(process.argv[2] || "http://localhost:8090/").href;

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

/** The open puzzle's cells as digits (0 = empty), whatever colours they carry. */
async function readGrid(page) {
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  return labels.map((l) => {
    const content = l.split(", ")[1];
    return content === "empty" ? 0 : Number(content);
  });
}

const label = (page, i) => page.locator("[role=gridcell]").nth(i).getAttribute("aria-label");
const classes = (page, i) => page.locator("[role=gridcell]").nth(i).getAttribute("class");
const colourOf = async (page, i) => {
  const l = await label(page, i);
  return l.endsWith(", colour A") ? "A" : l.endsWith(", colour B") ? "B" : "none";
};
const colourButton = (page, on) => page.getByRole("button", { name: on ? "Colour on" : "Colour off", exact: true });
const style = (page, i, prop) => page.locator("[role=gridcell]").nth(i).evaluate((e, p) => getComputedStyle(e)[p], prop);

async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const page = await newPage(browser);

  // Start seed play and open the first Daily puzzle.
  await page.goto(base);
  await page.getByText("There's no Sudoku server here", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByRole("button", { name: "Start playing", exact: true }).click();
  await page.locator(".puzzles").waitFor();

  // The Today explainer mentions the colour pens.
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "How Daily works" }).click();
  const help = page.getByRole("dialog", { name: "How Daily works" });
  await help.waitFor();
  check((await help.innerText()).includes("Colour pens"), "the Daily explainer mentions the colour pens");
  await help.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.locator(".puzzles").waitFor();

  await page.locator(".puzzles li button").first().click();
  const grid = await readGrid(page);
  const solution = grid.slice();
  check(solve(solution), "puzzle has a solution");
  const empties = grid.flatMap((d, i) => (d === 0 ? [i] : []));
  const given = grid.findIndex((d) => d !== 0);
  const [e1, e2, e3, e4] = empties;
  const cells = page.locator("[role=gridcell]");

  // The toggle: off by default, on by button and by C.
  check(await colourButton(page, false).getAttribute("aria-pressed") === "false", "Colour starts off and not pressed");
  check(await page.getByRole("button", { name: "Clear colours" }).count() === 0, "Clear colours is hidden while colour mode is off");
  await colourButton(page, false).click();
  check(await colourButton(page, true).getAttribute("aria-pressed") === "true", "the Colour button turns on");
  await page.keyboard.press("c");
  await colourButton(page, false).waitFor();
  await page.keyboard.press("C");
  await colourButton(page, true).waitFor();
  check(true, "the C key toggles colour mode");
  check(await page.getByRole("button", { name: "Clear colours" }).isDisabled(), "Clear colours is shown but disabled while nothing is coloured");

  // Tapping cycles the colour and neither selects nor places anything.
  await cells.nth(e1).click();
  check(await colourOf(page, e1) === "A", "a tap paints the cell colour A");
  check(!(await classes(page, e1)).includes("selected"), "a colour tap doesn't select the cell");
  check((await label(page, e1)) === `Row ${Math.floor(e1 / 9) + 1} column ${(e1 % 9) + 1}, empty, colour A`, "the colour is in the cell's accessible label");
  await cells.nth(e1).click();
  check(await colourOf(page, e1) === "B", "the second tap paints it colour B");
  await cells.nth(e1).click();
  check(await colourOf(page, e1) === "none", "the third tap clears it");
  await cells.nth(e1).click();
  await cells.nth(e2).click();
  await cells.nth(e2).click();
  await cells.nth(given).click();
  check(await colourOf(page, given) === "none", "a given can't be coloured");
  check(await colourOf(page, e1) === "A" && await colourOf(page, e2) === "B", "two cells hold colour A and colour B");
  check(await page.getByRole("button", { name: "Clear colours" }).isEnabled(), "Clear colours is enabled once something is coloured");

  // Digits and Erase are off in colour mode.
  const key = page.locator(".keypad button");
  check((await key.evaluateAll((bs) => bs.every((b) => b.disabled))), "the keypad is disabled in colour mode");
  check(await page.getByRole("button", { name: "Erase", exact: true }).isDisabled(), "Erase is disabled in colour mode");
  await page.keyboard.press(String(solution[e1]));
  await page.keyboard.press("Backspace");
  check(await colourOf(page, e1) === "A" && (await readGrid(page))[e1] === 0, "digit keys place nothing in colour mode");

  // With a cell selected, colour mode still takes no digit and no Erase; outside it they work.
  await colourButton(page, true).click();
  check(await key.first().isEnabled(), "the keypad is back with colour mode off");
  await cells.nth(e4).click();
  await page.keyboard.press(String(solution[e4]));
  check((await readGrid(page))[e4] === solution[e4], "a digit works on the selected cell with colour mode off");
  await colourButton(page, false).click();
  await page.keyboard.press("Backspace");
  await page.keyboard.press(String(solution[e4] % 9 + 1));
  check((await readGrid(page))[e4] === solution[e4], "Backspace and digit keys leave the selected cell alone in colour mode");
  await colourButton(page, true).click();
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  check((await readGrid(page))[e4] === 0, "Erase works again with colour mode off");
  await page.keyboard.press("x");
  await page.keyboard.press("Escape");
  check(!(await classes(page, e4)).includes("selected"), "Escape deselects, other keys do nothing");

  // Both tints, ring and selection together.
  await cells.nth(e1).click();
  check((await classes(page, e1)).includes("selected") && await colourOf(page, e1) === "A", "a selected cell keeps its colour");
  const selected = await page.evaluate((i) => {
    const e = document.querySelectorAll("[role=gridcell]")[i];
    const cs = getComputedStyle(e);
    return { bg: cs.backgroundColor, image: cs.backgroundImage, shadow: cs.boxShadow };
  }, e1);
  check(selected.image !== "none" && selected.shadow !== "none", "the colour tint and ring show on the selected cell");
  check(selected.bg !== "rgba(0, 0, 0, 0)", "and the selection colour is still its background");
  const ringB = await style(page, e2, "boxShadow");
  const ringA = await style(page, e1, "boxShadow");
  check(ringA !== ringB && ringB.split("inset").length > ringA.split("inset").length, "colour B has a double ring and colour A a single one");
  check(await style(page, e3, "backgroundImage") === "none", "uncoloured cells have no tint");

  // Notes and digits on coloured cells: the colour stays.
  await page.keyboard.press("n");
  await page.keyboard.press("3");
  check(await colourOf(page, e1) === "A" && (await cells.nth(e1).locator(".notes").count()) === 1, "a note on a coloured cell keeps the colour");
  await page.keyboard.press("n");
  await page.keyboard.press(String(solution[e1]));
  check(await colourOf(page, e1) === "A" && (await readGrid(page))[e1] === solution[e1], "a digit on a coloured cell keeps the colour");
  // A filled player cell can be coloured too (colour mode is on again).
  await colourButton(page, false).click();
  await cells.nth(e1).click();
  await cells.nth(e1).click();
  check(await colourOf(page, e1) === "none" && (await readGrid(page))[e1] === solution[e1], "a filled player cell can be coloured and cleared, keeping its digit");
  await cells.nth(e1).click();

  // Undo doesn't touch colours.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  check(await colourOf(page, e1) === "A" && await colourOf(page, e2) === "B" && (await readGrid(page))[e1] === 0, "undo takes back the digit but leaves the colours alone");

  // Paused: a tap through the cover paints nothing, and Clear colours is off.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByText("Paused", { exact: true }).waitFor();
  check(await page.getByRole("button", { name: "Clear colours" }).isDisabled(), "Clear colours is disabled while paused");
  await page.evaluate((i) => document.querySelectorAll("[role=gridcell]")[i].click(), e3);
  check(await colourOf(page, e3) === "none", "a tap while paused paints nothing");
  await page.getByRole("button", { name: "Resume", exact: true }).click();

  // Clear colours.
  await cells.nth(e3).click();
  await page.getByRole("button", { name: "Clear colours" }).click();
  check(await colourOf(page, e1) === "none" && await colourOf(page, e2) === "none" && await colourOf(page, e3) === "none", "Clear colours removes every colour");
  check(await page.getByRole("button", { name: "Clear colours" }).isDisabled(), "and is disabled again");
  check((await cells.evaluateAll((els) => els.filter((e) => /colour-/.test(e.className)).length)) === 0, "no cell carries a colour class");

  // Colours survive a reload, and leaving and re-opening the puzzle.
  await cells.nth(e1).click();
  await cells.nth(e2).click();
  await cells.nth(e2).click();
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.locator(".puzzles").waitFor();
  await page.locator(".puzzles li button").first().click();
  await readGrid(page);
  check(await colourOf(page, e1) === "A" && await colourOf(page, e2) === "B", "colours survive leaving and re-opening the puzzle");
  await page.reload();
  await page.locator(".puzzles").waitFor();
  await page.locator(".puzzles li button").first().click();
  await readGrid(page);
  check(await colourOf(page, e1) === "A" && await colourOf(page, e2) === "B", "colours survive a reload");
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes("games")).map(([, v]) => v).join("\n"));
  check(saved.includes('"colours"'), "the colours are in the locally saved game");
  check(await colourButton(page, false).count() === 1, "colour mode itself starts off again");

  // Not in the replay: the saved replay holds no colour action.
  const replayActions = await page.evaluate(() => {
    const out = [];
    for (const [k, v] of Object.entries(localStorage)) if (k.includes("games")) for (const g of Object.values(JSON.parse(v))) for (const e of g.replay ?? []) out.push(e.a);
    return out;
  });
  check(replayActions.length > 0 && replayActions.every((a) => /^(start|resume|pause|restore|place|erase|noteAdd|noteRemove|undo|clear|notes|hidden|visible)$/.test(a)), "the replay holds only the usual actions: " + [...new Set(replayActions)].join(", "));

  // Clear board drops colours too.
  await cells.nth(e3).click();
  await page.keyboard.press(String(solution[e3]));
  await page.getByRole("button", { name: "Clear board" }).click();
  check(await colourOf(page, e1) === "none" && await colourOf(page, e2) === "none", "Clear board drops the colours");

  // The theme tokens, in light and dark.
  const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await page.emulateMedia({ colorScheme: "light" });
  const light = [await token("--colour-a"), await token("--colour-b")];
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = [await token("--colour-a"), await token("--colour-b")];
  check(light.every(Boolean) && dark.every(Boolean) && light[0] !== dark[0] && light[1] !== dark[1] && light[0] !== light[1], `both themes define two distinct colours (${light}, ${dark})`);
  await cells.nth(e1).click();
  check(await colourOf(page, e1) === "none", "(colour mode is off after the reload, so that tap only selected)");
  await page.keyboard.press("c");
  await cells.nth(e1).click();
  check(await style(page, e1, "backgroundImage") !== "none", "colours show in the dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // Solving drops the colours.
  await cells.nth(e2).click(); // colour mode is still on
  check(await colourOf(page, e1) !== "none" && await colourOf(page, e2) !== "none", "two cells are coloured just before the last digit");
  await page.keyboard.press("c");
  for (const i of empties) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
  }
  await page.getByText("Solved in", { exact: false }).first().waitFor();
  check((await cells.evaluateAll((els) => els.filter((e) => /colour-/.test(e.className) || /colour [AB]/.test(e.getAttribute("aria-label"))).length)) === 0, "solving the puzzle drops the colours");
  check(await colourButton(page, false).count() === 0, "the controls are gone once solved");
  await page.reload();
  await page.locator(".puzzles").waitFor();
  check(!(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes("games")).map(([, v]) => v).join("\n"))).includes('"colours"'), "a solved game saves no colours");

  // Endless: colours are kept with the game in progress there too.
  await page.getByRole("tab", { name: "Endless" }).click();
  const endlessHelp = page.getByRole("dialog", { name: "How Endless works" });
  if (await endlessHelp.count()) {
    check((await endlessHelp.innerText()).includes("Colour pens"), "the Endless explainer mentions the colour pens");
    await page.getByRole("button", { name: "Got it" }).click();
  }
  await page.getByRole("button", { name: "Play #1" }).first().click();
  await page.getByText("Easy #1").first().waitFor();
  const eGrid = await readGrid(page);
  const eEmpty = eGrid.findIndex((d) => d === 0);
  await page.keyboard.press("c");
  await cells.nth(eEmpty).click();
  await cells.nth(eEmpty).click();
  check(await colourOf(page, eEmpty) === "B", "an Endless puzzle can be coloured");
  await page.reload();
  await page.getByRole("tab", { name: "Endless" }).click();
  await page.getByRole("button", { name: /Resume|Play #1|Continue/ }).first().click();
  await readGrid(page);
  check(await colourOf(page, eEmpty) === "B", "Endless colours survive a reload");

  // A game saved before colours existed still loads (leave the puzzle first: leaving saves it).
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.getByRole("tab", { name: "Endless" }).waitFor();
  await page.evaluate(() => {
    for (const [k, v] of Object.entries(localStorage)) {
      if (!k.includes("games")) continue;
      const games = JSON.parse(v);
      for (const g of Object.values(games)) delete g.colours;
      localStorage.setItem(k, JSON.stringify(games));
    }
  });
  await page.reload();
  await page.getByRole("tab", { name: "Endless" }).click();
  await page.getByRole("button", { name: /Resume|Play #1|Continue/ }).first().click();
  await readGrid(page);
  check(await colourOf(page, eEmpty) === "none", "a saved game without colours loads fine");

  await browser.close();
  console.log("all colour pen checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
