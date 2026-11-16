// End-to-end check of the Learn tab against the production bundle on a plain
// static file server (see docs/WEB.md, "Learn"):
//
//   (cd web && npm run build)
//   (cd web/dist && python3 -m http.server 8090) &
//   node web/e2e/learn.cjs [http://localhost:8090/] [screenshot dir]
//
// Starts seed play, opens the Learn tab and its first lesson, steps through the
// worked example, gets a practice position wrong (and is told why), then
// finishes every position (one of them by keyboard alone) and the lesson's
// full puzzle. Progress shows in the lesson list and survives a reload. A
// candidate lesson is finished with hints, and the Graded explainer links to
// the lessons. The Variants level teaches on Diagonal, Jigsaw and Killer
// boards: each draws its layout, and a placing and a removing variant lesson
// are answered wrong, then right. The home tabs fit a 320px phone. Ends with
// dark-theme and wide-screen screenshots.
const { chromium } = require("playwright");

const base = new URL(process.argv[2] || "http://localhost:8090/").href;
const shots = process.argv[3] || null;

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

/** The board's cells as digits (0 = empty). */
async function readGrid(page) {
  const labels = await page.locator(".learn-board [role=gridcell]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  return labels.map((l) => {
    const digit = /^Row \d column \d, (\d)/.exec(l);
    return digit ? Number(digit[1]) : 0;
  });
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

/** A full house: the one empty cell of a row, column or box, and its digit. */
function fullHouse(grid) {
  const units = [];
  for (let i = 0; i < 9; i++) {
    units.push(Array.from({ length: 9 }, (_, k) => i * 9 + k));
    units.push(Array.from({ length: 9 }, (_, k) => k * 9 + i));
    units.push(Array.from({ length: 9 }, (_, k) => (3 * Math.floor(i / 3) + Math.floor(k / 3)) * 9 + 3 * (i % 3) + (k % 3)));
  }
  for (const unit of units) {
    const empty = unit.filter((c) => grid[c] === 0);
    if (empty.length !== 1) continue;
    const digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => !unit.some((c) => grid[c] === d));
    return { cell: empty[0], digit };
  }
  throw new Error("FAILED: no full house on the board");
}

const feedback = (page) => page.locator(".learn-feedback");
const row = (page, id) => page.locator(`[data-lesson="${id}"]`);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. Seed play on a static host, then the Learn tab.
  await page.goto(base);
  await page.getByText("Play with a seed").first().waitFor();
  await page.fill("#seed", "learn-e2e");
  await page.getByRole("button", { name: "Start playing", exact: true }).click();
  await page.locator(".puzzles").first().waitFor();
  await page.getByRole("tab", { name: "Learn" }).click();
  await page.getByText("Learn to solve without guessing").waitFor();
  const lessons = await page.locator("[data-lesson]").count();
  check(lessons === 33, `the Learn tab lists every lesson (${lessons})`);
  check((await page.locator(".learn-level h2").allInnerTexts()).join() === "Easy,Medium,Hard,Expert,Diabolical,Variants", "lessons are grouped by the Graded levels, then the variants");
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    const tabs = await page.locator(".home-tabs").evaluate((row) => {
      const buttons = [...row.querySelectorAll("button")];
      return {
        count: buttons.length,
        overflow: row.scrollWidth > row.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth,
        tops: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
        clipped: buttons.some((b) => b.scrollWidth > b.clientWidth + 1),
        wrapped: buttons.some((b) => b.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(b).lineHeight || "20") + 4 && b.innerText.includes(" ")),
        heights: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height))).size,
      };
    });
    check(tabs.count === 4 && !tabs.overflow && tabs.tops === 1 && !tabs.clipped && tabs.heights === 1,
      `the four home tabs sit on one row at ${width}px (${JSON.stringify(tabs)})`);
    await shot(page, `learn-tabs-${width}`);
  }
  check(await page.locator(".generator-choices").count() === 0, "the Learn tab has no generator switch");
  await shot(page, "learn-list");

  // 2. The first lesson: explanation and a worked example to step through.
  await row(page, "fullHouse").getByRole("button").click();
  await page.getByText("How to spot it").waitFor();
  check(await page.getByRole("tab", { name: "Learn" }).getAttribute("aria-selected") === "true", "a lesson opens on its explanation");
  const first = await page.locator(".learn-step").innerText();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const second = await page.locator(".learn-step").innerText();
  check(first !== second && (await page.getByText("Step 2 of").count()) === 1, "Next steps through the worked example");
  check(await page.locator(".learn-demo .cell.unit, .learn-demo .cell.hl-pattern").count() > 0, "the worked example highlights cells");
  await page.keyboard.press("ArrowLeft");
  check(await page.getByText("Step 1 of").count() === 1, "the arrow keys step through it too");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await shot(page, "learn-example");

  // 3. Practice: a wrong digit explains itself, the right one finishes the position.
  await page.getByRole("button", { name: "Start practice" }).click();
  await page.locator(".learn-task").waitFor();
  let grid = await readGrid(page);
  let answer = fullHouse(grid);
  // The keypad greys out a digit once all nine are on the board, so pick one that is still live.
  const wrong = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => d !== answer.digit && grid.filter((g) => g === d).length < 9);
  await page.keyboard.press("5");
  check((await feedback(page).innerText()).includes("Pick a square first"), "a digit with no square picked asks for one");
  await page.locator(".learn-board [role=gridcell]").nth(answer.cell).click();
  await page.locator("sudoku-keypad button").nth(wrong - 1).click();
  check(await feedback(page).evaluate((e) => e.classList.contains("bad")), "a wrong digit is marked wrong");
  const why = await feedback(page).innerText();
  check(why.length > 20 && why.includes(String(wrong)), `and says why: "${why}"`);
  check((await readGrid(page))[answer.cell] === 0, "the wrong digit isn't placed");
  await shot(page, "learn-wrong");
  await page.locator("sudoku-keypad button").nth(answer.digit - 1).click();
  check(await feedback(page).evaluate((e) => e.classList.contains("good")), "the right digit is marked right");
  check((await readGrid(page))[answer.cell] === answer.digit, "and is placed");
  check(await page.locator(".learn-positions button.done").count() === 1, "the position is ticked off");
  await shot(page, "learn-right");

  // 4. The next position by keyboard alone: arrows to the square, then the digit.
  await page.getByRole("button", { name: "Next position" }).click();
  grid = await readGrid(page);
  answer = fullHouse(grid);
  await page.keyboard.press("ArrowDown"); // selects the middle square
  for (let r = 4; r !== Math.floor(answer.cell / 9); r = (r + 1) % 9) await page.keyboard.press("ArrowDown");
  for (let c = 4; c !== answer.cell % 9; c = (c + 1) % 9) await page.keyboard.press("ArrowRight");
  check(await page.locator(".learn-board .cell.selected").getAttribute("data-index") === String(answer.cell), "the arrow keys move the selection");
  await page.keyboard.press(String(answer.digit));
  check(await feedback(page).evaluate((e) => e.classList.contains("good")), "a position can be finished by keyboard alone");

  // 5. The other positions, then the lesson's full puzzle if it has one.
  for (let i = 2; i < 4; i++) {
    await page.getByRole("button", { name: "Next position" }).click();
    answer = fullHouse(await readGrid(page));
    await page.locator(".learn-board [role=gridcell]").nth(answer.cell).click();
    await page.keyboard.press(String(answer.digit));
  }
  check(await page.locator(".learn-positions button.done").count() === 4, "all four positions are done");
  await page.getByRole("button", { name: "All lessons" }).click();
  check((await row(page, "fullHouse").innerText()).includes("Mastered"), "the lesson list shows the lesson as mastered");
  check((await row(page, "fullHouse").getByRole("button").innerText()) === "Review", "and offers to review it");

  // 6. Progress, and the Learn tab itself, survive a reload.
  await page.reload();
  await page.getByText("Learn to solve without guessing").waitFor();
  check((await row(page, "fullHouse").innerText()).includes("Mastered"), "progress survives a reload");
  check((await page.locator("#learn-intro").innerText()).includes(`1 of ${lessons} lessons mastered`), "the summary counts it");
  await shot(page, "learn-progress");

  // 7. A full puzzle: solved digit by digit, with one hint along the way.
  await row(page, "hiddenSingle").getByRole("button").click();
  await page.getByRole("tab", { name: "Full puzzle" }).click();
  await page.getByRole("button", { name: "Hint", exact: true }).click();
  check(await feedback(page).evaluate((e) => e.classList.contains("hint")), "Hint points at the next step");
  await shot(page, "learn-puzzle-hint");
  grid = await readGrid(page);
  const solution = grid.slice();
  check(solve(solution), "the lesson's puzzle has a solution");
  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue;
    await page.locator(".learn-board [role=gridcell]").nth(i).click();
    await page.keyboard.press(String(solution[i]));
  }
  check((await feedback(page).innerText()).includes("Solved"), "the full puzzle can be solved to the end");
  await page.getByRole("button", { name: "All lessons" }).click();
  check((await row(page, "hiddenSingle").innerText()).includes("Started · puzzle solved"), "the solved puzzle is recorded");

  // 8. A candidate lesson: the board shows candidates, and hints walk through to the answer.
  await row(page, "pointing").getByRole("button").click();
  await page.getByRole("button", { name: "Start practice" }).click();
  check(await page.locator(".learn-board .notes").count() > 0, "a candidate lesson shows candidates");
  for (let i = 0; i < 6 && !(await page.locator(".learn-onward").count()); i++) await page.keyboard.press("h");
  check(await page.locator(".learn-onward").count() === 1, "hints finish a position when the player is stuck");
  check(await page.locator(".learn-board .notes span.struck").count() > 0, "the removed candidates are struck out");
  await shot(page, "learn-elimination");
  await page.getByRole("button", { name: "All lessons" }).click();
  check((await row(page, "pointing").innerText()).includes("Practised 1 of 4"), "a position finished with hints counts as practised, not mastered");

  // 9. The Graded explainer links to the lessons.
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Classic and Graded" }).click();
  await page.getByRole("button", { name: "Learn the Hard techniques" }).click();
  await page.locator("sudoku-learn").waitFor();
  check(await page.getByRole("dialog").count() === 0 && (await page.locator("sudoku-learn h1, sudoku-learn header").first().innerText()).length > 0, "the Graded explainer's levels link to their lessons");
  await page.getByRole("button", { name: "‹ Back", exact: true }).click();
  await page.getByText("Learn to solve without guessing").waitFor();
  check(true, "Back from a lesson returns to the lesson list");

  // 10. The Variants level: each lesson's board carries its variant's layout.
  /** Opens a lesson, steps its worked example to the end, and returns what the last frame shows. */
  async function example(id) {
    await page.getByRole("button", { name: "‹ Back", exact: true }).click().catch(() => {});
    await row(page, id).getByRole("button").click();
    await page.getByText("How to spot it").waitFor();
    for (let i = 0; i < 8 && await page.getByRole("button", { name: "Next", exact: true }).isEnabled(); i++) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    return page.locator(".learn-demo [role=gridcell]").evaluateAll((els) => ({
      placed: els.map((e, i) => (e.classList.contains("placed") ? { cell: i, digit: Number(e.innerText.trim()) } : null)).filter(Boolean),
      struck: els.flatMap((e, i) => [...e.querySelectorAll(".notes span.struck")].map((s) => ({ cell: i, digit: Number(s.innerText) }))),
    }));
  }
  /** Opens practice position 4, the worked example's own. */
  async function lastPosition() {
    await page.getByRole("button", { name: "Start practice" }).click();
    await page.getByRole("button", { name: "Position 4" }).click();
    await page.locator(".learn-task").waitFor();
  }
  const cellAt = (i) => page.locator(".learn-board [role=gridcell]").nth(i);

  const diagonal = await example("diagonalSingle");
  check(await page.locator(".learn-demo .board.layout-diagonal").count() === 1, "a Diagonal lesson's board is a Diagonal board");
  check(await page.locator(".learn-demo .cell.diag").count() === 17, "with both diagonals shaded");
  check(diagonal.placed.length === 1, "the worked example places a digit");
  check((await page.locator(".learn-step").innerText()).includes("diagonal"), "and argues along a diagonal");
  await shot(page, "learn-diagonal");
  await lastPosition();
  grid = await readGrid(page);
  // A wrong digit: one already on the empty square's diagonal (and not in its row, column or box).
  const diagonals = [[0, 10, 20, 30, 40, 50, 60, 70, 80], [8, 16, 24, 32, 40, 48, 56, 64, 72]];
  let tried = false;
  for (const line of diagonals) {
    for (const c of line.filter((x) => grid[x] === 0 && x !== diagonal.placed[0].cell)) {
      const sees = (x) => Math.floor(x / 9) === Math.floor(c / 9) || x % 9 === c % 9
        || (Math.floor(x / 27) === Math.floor(c / 27) && Math.floor((x % 9) / 3) === Math.floor((c % 9) / 3));
      const d = line.map((x) => grid[x]).find((v) => v !== 0 && !grid.some((g, x) => g === v && sees(x)));
      if (d === undefined || tried) continue;
      tried = true;
      await cellAt(c).click();
      await page.keyboard.press(String(d));
      check(await feedback(page).evaluate((e) => e.classList.contains("bad")), "a digit already on the diagonal is wrong");
      const text = await feedback(page).innerText();
      check(text.includes("diagonal"), `and the diagonal is named: "${text}"`);
    }
  }
  check(tried, "the position has a square to get wrong by its diagonal");
  await cellAt(diagonal.placed[0].cell).click();
  await page.keyboard.press(String(diagonal.placed[0].digit));
  check(await page.locator(".learn-onward").count() === 1 && await feedback(page).evaluate((e) => e.classList.contains("good")), "the diagonal single is placed");

  await example("jigsawSingle");
  check(await page.locator(".learn-demo .board.layout-jigsaw").count() === 1, "a Jigsaw lesson's board is a Jigsaw board");
  check(await page.locator(".learn-demo .cell.jr").count() > 0 && await page.locator(".learn-demo .cell.jb").count() > 0, "with its regions' borders drawn");
  check((await page.locator(".learn-step").innerText()).includes("region"), "and argues about a region");
  await shot(page, "learn-jigsaw");
  const leftover = await example("leftovers");
  check(await page.locator(".learn-demo .cell.hl-colourA").count() > 0 && await page.locator(".learn-demo .cell.hl-colourB").count() > 0, "the law of leftovers colours its two sides");
  check(leftover.struck.length > 0, "and strikes what it removes");
  check(await page.getByText("The Graded puzzles don't use this one").count() === 1, "a technique the grader lacks says so");
  await shot(page, "learn-leftovers");

  const cages = await example("cageCombination");
  check(await page.locator(".learn-demo .board.layout-killer").count() === 1, "a Killer lesson's board is a Killer board");
  check(await page.locator(".learn-demo .cage-sum").count() > 10 && await page.locator(".learn-demo .cell.cage").count() === 81, "with its cages and their sums");
  check((await page.locator(".learn-demo [role=gridcell]").first().getAttribute("aria-label")).includes("cage of"), "the first square names its cage");
  check(cages.struck.length > 0, "the worked example removes candidates");
  await shot(page, "learn-killer");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "learn-killer-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await lastPosition();
  check(await page.locator(".learn-board .board.layout-killer").count() === 1, "the practice board keeps the cages");
  // A wrong removal: a candidate in a square the pattern doesn't touch.
  const other = await page.locator(".learn-board [role=gridcell]").evaluateAll((els, struck) => {
    for (let i = 0; i < els.length; i++) {
      if (struck.some((s) => s.cell === i)) continue;
      const note = [...els[i].querySelectorAll(".notes span")].find((s) => s.innerText.trim() !== "");
      if (note) return { cell: i, digit: Number(note.innerText) };
    }
    return null;
  }, cages.struck);
  await cellAt(other.cell).click();
  await page.keyboard.press(String(other.digit));
  check(await feedback(page).evaluate((e) => e.classList.contains("bad")), `removing a candidate the cage doesn't rule out is wrong: "${await feedback(page).innerText()}"`);
  let at = other.cell;
  for (const { cell, digit } of cages.struck) {
    if (await page.locator(".learn-onward").count()) break;
    // Tapping the selected square again would deselect it.
    if (cell !== at) await cellAt(cell).click();
    at = cell;
    await page.keyboard.press(String(digit));
  }
  check(await page.locator(".learn-onward").count() === 1 && (await feedback(page).innerText()).includes("cage combination"), "removing the cage's candidates finishes the position");
  await shot(page, "learn-killer-practice");
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "a Killer lesson fits a phone's width");
  await page.getByRole("button", { name: "All lessons" }).click();
  check((await row(page, "cageCombination").innerText()).includes("Practised 1 of 4"), "the variant lesson's progress is recorded");

  // 11. Nothing overflows a phone, and the dark theme and a wide screen draw.
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!wide, "the lesson list fits a phone's width");
  await row(page, "xyWing").getByRole("button").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "a lesson fits a phone's width");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "learn-dark");
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, "learn-wide-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, "learn-wide");

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await browser.close();
  console.log("Learn e2e passed");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
