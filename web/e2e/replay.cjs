// End-to-end check of game replays and the admin anti-cheat tools against a running server in dev
// auth mode that serves web/dist, with `ann` as admin (see docs/WEB.md, "Checking offline play"):
//
//   SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann ... server/sudoku-server &
//   node web/e2e/replay.cjs [http://localhost:8080] [screenshot dir]
//
// Ann plays the Easy puzzle in the browser (notes, a wrong digit and undo, colour pens, a pause, a reload), which
// records a replay the server accepts. "Speedy" submits a suspiciously steady replay through the API and
// "Nora" a result with no replay, which the server flags by itself (admin-only). Ann then opens the replays
// as admin (digits hidden until revealed), flags Speedy's result and confirms Nora's, and the leaderboard
// shows both markers. The colour pen events must reach the server, be accepted, and show on the admin replay board in step.
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:8080";
const shots = process.argv[3] || null;
const run = String(Date.now()).slice(-6);
const ann = { sub: "ann", name: "Ann" };
const speedy = { sub: "speedy" + run, name: "Speedy" };
const nora = { sub: "nora" + run, name: "Nora" };

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

const api = (user, path, init = {}) => fetch(`${base}/api/v1/${path}`, {
  ...init, headers: { Authorization: `Bearer dev:${user.sub}:${user.name}`, "Content-Type": "application/json", ...init.headers },
});

async function shot(page, name) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  console.log(`   screenshot ${shots}/${name}.png`);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));

  await page.goto(base + "/");
  await page.fill("#sub", ann.sub);
  await page.fill("#name", ann.name);
  await page.click("button[type=submit]");
  await page.getByText("Easy", { exact: true }).waitFor();

  // Ann plays Easy: notes, a wrong digit undone, a pause, and a reload part way.
  await page.getByText("Play").first().click();
  const cells = page.locator("[role=gridcell]");
  await cells.first().waitFor();
  const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const grid = labels.map((l) => (l.endsWith("empty") ? 0 : Number(l.slice(-1))));
  const solution = grid.slice();
  check(solve(solution), "puzzle has a solution");
  const empties = grid.flatMap((d, i) => (d === 0 ? [i] : []));
  const date = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.week")).today);

  await cells.nth(empties[0]).click();
  await page.keyboard.press("n");
  await page.keyboard.press(String(solution[empties[0]]));
  await page.keyboard.press(String((solution[empties[0]] % 9) + 1));
  await page.keyboard.press("n");
  await page.keyboard.press(String((solution[empties[0]] % 9) + 1));
  await page.keyboard.press("Control+z");
  // Colour pens: e1 goes A then B, e2 and e3 go A, Clear colours, then e2 goes A again. The server must accept these
  // events, and the admin replay must show the colours in step.
  const [e1, e2, e3] = [empties[1], empties[2], empties[3]];
  await page.keyboard.press("c");
  for (const i of [e1, e1, e2, e3]) await cells.nth(i).click();
  await page.getByRole("button", { name: "Clear colours" }).click();
  await cells.nth(e2).click();
  await page.keyboard.press("c");
  await page.getByRole("button", { name: "Pause" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Resume" }).click();
  const half = Math.floor(empties.length / 2);
  for (const i of empties.slice(0, half)) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(60);
  }
  await page.reload();
  await page.getByText("Easy", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume" }).first().click();
  await cells.first().waitFor();
  await page.waitForTimeout(5000);
  for (const i of empties.slice(half)) {
    await cells.nth(i).click();
    await page.keyboard.press(String(solution[i]));
    await page.waitForTimeout(60);
  }
  await page.getByText("Solved in", { exact: false }).waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sudoku.games")));
  const replay = Object.values(saved)[0].replay;
  const actions = replay.map((e) => e.a);
  check(actions[0] === "start" && actions[actions.length - 1] === "finish", "the replay runs from start to finish");
  const colourLog = replay.filter((e) => e.a === "colour" || e.a === "clearColours").map((e) => (e.a === "colour" ? `${e.c}:${e.p}` : "clear"));
  check(colourLog.join() === [`${e1}:1`, `${e1}:2`, `${e2}:1`, `${e3}:1`, "clear", `${e2}:1`].join(), "the replay logs each colour change with its pen: " + colourLog.join(" "));
  for (const a of ["noteAdd", "notes", "undo", "pause", "resume", "restore", "place"]) check(actions.includes(a), `the replay has a ${a} event`);
  await page.waitForFunction(() => localStorage.getItem("sudoku.pending") == null, null, { timeout: 15000 });

  // Speedy: a replay that passes the server's checks but places a digit every 2.4 s like clockwork.
  const t0 = Date.now() - 600_000;
  const events = [{ t: 0, w: t0, a: "start" }, { t: 0, w: t0 + 5, a: "resume" }];
  empties.forEach((i, k) => events.push({ t: 2400 * (k + 1), w: t0 + 5 + 2400 * (k + 1), a: "place", c: i, d: solution[i] }));
  const last = events[events.length - 1];
  events.push({ t: last.t, w: last.w, a: "finish" });
  const submit = (user, body) => api(user, "results", { method: "POST", body: JSON.stringify(body) });
  const completedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let res = await submit(speedy, { date, level: 1, elapsedMs: last.t, completedAt, replay: { version: 1, events } });
  check(res.status === 201, "a steady but consistent replay is accepted");
  res = await submit(nora, { date, level: 1, elapsedMs: 400_000, completedAt });
  check(res.status === 201, "a result without a replay is accepted");
  res = await api(nora, `admin/results?date=${date}`);
  check(res.status === 403, "admin results need an admin");

  // Ann opens the results as admin.
  await page.getByText("Today's puzzles").click();
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Admin" }).click();
  await page.getByRole("button", { name: "Results and replays" }).click();
  await page.getByText("Speedy").waitFor();
  check(await page.getByText("Suspicious (auto)").count() === 1, "the result with no replay is flagged automatically");

  await page.getByText("Speedy").click();
  await page.getByText("Reveal digits (shows the solution)").waitFor();
  await page.getByRole("button", { name: "Next action" }).click();
  for (let k = 0; k < 20; k++) await page.getByRole("button", { name: "Next action" }).click();
  const board = page.locator(".replay-board .cell");
  const hidden = await board.evaluateAll((els) => els.map((e) => e.textContent));
  check(!(await page.locator(".reveal input").isChecked()), "digits are hidden when the replay opens");
  check(empties.slice(0, 19).every((i) => hidden[i] === "•"), "entered digits show as dots");
  const label = await board.nth(empties[0]).getAttribute("aria-label");
  check(label.endsWith(", hidden digit"), "screen readers don't hear hidden digits either");
  await board.nth(empties[0]).click();
  check(await page.locator(".replay-board .cell.selected, .replay-board .cell.peer").count() === 0, "the replay board is read-only");
  check(await page.getByText("Placed a digit in", { exact: false }).count() > 0, "actions don't name the digit");
  check(await page.getByText("steady, machine-like pace", { exact: false }).count() === 1, "the steady pace is pointed out");
  await shot(page, "replay-hidden");

  await page.locator(".reveal input").check();
  const shown = await board.evaluateAll((els) => els.map((e) => e.textContent));
  check(empties.slice(0, 19).every((i) => shown[i] === String(solution[i])), "revealing shows the digits");
  await shot(page, "replay-revealed");

  await page.getByRole("button", { name: "Play" }).click();
  await page.getByRole("button", { name: "8x" }).click();
  await page.waitForTimeout(500);
  check(await page.getByRole("button", { name: "Pause" }).count() >= 1, "the replay plays");
  await page.getByRole("button", { name: "Pause" }).last().click();

  await page.fill("input.flag-reason", "Placed a digit every 2.4 s");
  await page.getByRole("button", { name: "Flag as suspicious" }).click();
  await page.getByRole("button", { name: "Remove flag" }).waitFor();
  check(await page.getByText("Flagged by Ann", { exact: false }).count() === 1, "the flag records the admin");

  // Back to the list and into Ann's own replay: the digits are hidden again.
  await page.getByText("‹ Back").click();
  await page.getByText("Ann").first().click();
  await page.getByText("Reveal digits (shows the solution)").waitFor();
  check(!(await page.locator(".reveal input").isChecked()), "the next replay opens with the digits hidden again");
  check(await page.getByText("Replay OK").count() >= 1, "Ann's browser replay passed the server's checks, colours and all");


  // Ann's first note shows in the game's 3x3 note grid: a dot while hidden, in its digit's slot once revealed.
  for (let k = 0; k < 10 && await page.locator(".replay-board .notes").count() === 0; k++) {
    await page.getByRole("button", { name: "Next action" }).click();
  }
  const marks = page.locator(".replay-board .cell").nth(empties[0]).locator(".notes span");
  const hiddenMarks = await marks.evaluateAll((els) => els.map((e) => e.textContent));
  check(hiddenMarks.join(",") === "•,,,,,,,,", "a hidden note shows as a dot in the note grid");
  await page.locator(".reveal input").check();
  const shownMarks = await marks.evaluateAll((els) => els.map((e) => e.textContent));
  check(shownMarks.length === 9 && shownMarks.join("") === String(solution[empties[0]]) && shownMarks[solution[empties[0]] - 1] !== "",
    "a revealed note sits in its digit's slot, as in the game");
  await shot(page, "replay-notes");

  // The server stored the colour events as sent.
  const adminList = await (await api(ann, `admin/results?date=${date}`)).json();
  const annResult = adminList.results.find((r) => r.displayName === "Ann");
  check(annResult.replay === "valid", "the server's verdict on Ann's replay with colours is valid");
  const stored = await (await api(ann, `admin/results/${date}/1/${annResult.userId}/replay?generator=${annResult.generator}`)).json();
  const storedColours = stored.events.filter((e) => e.a === "colour" || e.a === "clearColours").map((e) => (e.a === "colour" ? `${e.c}:${e.p}` : "clear"));
  check(storedColours.join() === colourLog.join(), "the server kept the colour events");

  // The admin viewer shows the colours in step: step to each colour event and read the board.
  const rboard = page.locator(".replay-board .cell");
  const colourAt = async (i) => ((await rboard.nth(i).getAttribute("class")).match(/colour-(\d)/) || [])[1] ?? "0";
  const coloured = page.locator(".replay-board .cell.colour-1, .replay-board .cell.colour-2");
  const step = async (n) => { for (let k = 0; k < n; k++) await page.getByRole("button", { name: "Next action" }).click(); };
  const firstColour = stored.events.findIndex((e) => e.a === "colour");
  // Ann's replay is at its first note (the loop above), so step on to just before the first colour event.
  const firstNote = stored.events.findIndex((e) => e.a === "noteAdd");
  await step(firstColour - (firstNote + 1));
  check(await coloured.count() === 0, "no colours before the first colour event");
  await step(1);
  check(await colourAt(e1) === "1", "after the first colour event the cell is colour A");
  await step(1);
  check(await colourAt(e1) === "2", "after the second it is colour B");
  check((await rboard.nth(e1).getAttribute("aria-label")).endsWith(", colour B"), "a screen reader hears the colour in the replay too");
  await step(2);
  check(await colourAt(e2) === "1" && await colourAt(e3) === "1" && await colourAt(e1) === "2", "three cells are coloured");
  await step(1);
  check(await coloured.count() === 0, "Clear colours empties the replay board");
  await step(1);
  check(await colourAt(e2) === "1" && await coloured.count() === 1, "the last colour event leaves one cell coloured");
  check(await page.getByText("Coloured R", { exact: false }).count() > 0 && await page.getByText("Cleared the colours").count() === 1, "the action list describes the colour events");
  await shot(page, "replay-colours");

  // Everyone sees the markers on the leaderboard.
  res = await api(nora, `leaderboard?date=${date}`);
  const lb = await res.json();
  const easy = lb.puzzles.find((p) => p.level === 1).entries;
  const flagged = Object.fromEntries(easy.map((e) => [e.displayName, e.suspicious]));
  check(flagged.Speedy === true && flagged.Nora === false && flagged.Ann === false, "the leaderboard marks only admin flags, not the server's");
  check(easy.map((e) => e.rank).join() === "1,2,3", "flagged results stay ranked");

  // Ann confirms the server's flag on Nora's result, which makes it public.
  await page.getByText("‹ Back").click();
  await page.getByText("Nora").first().click();
  await page.getByRole("button", { name: "Confirm flag" }).waitFor();
  await shot(page, "replay-auto-flag");
  await page.getByRole("button", { name: "Confirm flag" }).click();
  await page.getByText("Flagged by Ann", { exact: false }).waitFor();
  check(await page.getByRole("button", { name: "Confirm flag" }).count() === 0, "a confirmed flag is the admin's own");
  res = await api(nora, `leaderboard?date=${date}`);
  const confirmed = (await res.json()).puzzles.find((p) => p.level === 1).entries;
  check(confirmed.find((e) => e.displayName === "Nora").suspicious === true, "a confirmed flag shows on the leaderboard");

  const viewer = await browser.newContext({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 2 });
  const other = await viewer.newPage();
  await other.goto(base + "/");
  await other.fill("#sub", nora.sub);
  await other.fill("#name", nora.name);
  await other.click("button[type=submit]");
  await other.getByRole("button", { name: "Leaderboard" }).click();
  await other.getByRole("button", { name: "Easy" }).click();
  await other.getByText("Speedy").first().waitFor();
  check(await other.locator(".badge.suspicious").count() === 2, "players see the suspicious markers");
  await shot(other, "leaderboard-flagged");

  await browser.close();
  console.log("all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
