import assert from "node:assert/strict";
import { test } from "node:test";
import { AppStorage, decodeSavedGame } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { COLOUR_NAMES, Colours } from "../src/game/colours.ts";
import { Game } from "../src/game/game.ts";
import { seedSettings as s } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type EndlessRef, type Host } from "../src/ui/controller.ts";

const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
const digit = (i: number) => Number(solution[i]);
const empties = () => [...puzzle].flatMap((c, i) => (c === "0" ? [i] : []));

test("Colours cycle none, A, B, none and round trip through text", () => {
  const none = Colours.EMPTY;
  assert.ok(none.isBlank);
  const a = none.cycled(5);
  const b = a.cycled(5);
  assert.deepEqual([none.get(5), a.get(5), b.get(5), b.cycled(5).get(5)], [0, 1, 2, 0]);
  assert.ok(!a.isBlank && b.cycled(5).isBlank);
  assert.equal(a.get(6), 0);
  assert.equal(none.get(5), 0);
  const text = a.cycled(80).cycled(80).toString();
  assert.equal(text.length, 81);
  assert.equal(text[5], "1");
  assert.equal(text[80], "2");
  assert.equal(Colours.parse(text).toString(), text);
  assert.deepEqual(COLOUR_NAMES, ["", "colour A", "colour B"]);
});

test("malformed or absent colour text reads as no colours", () => {
  assert.equal(Colours.parse(undefined), Colours.EMPTY);
  assert.equal(Colours.parse("12"), Colours.EMPTY);
  assert.equal(Colours.parse("3".repeat(81)), Colours.EMPTY);
  assert.equal(Colours.parse("x".repeat(81)), Colours.EMPTY);
});

test("a game's colours cycle on empty and filled player cells, never on givens", () => {
  const g = Game.create(puzzle).resume(0);
  const [e1, e2] = empties() as [number, number];
  assert.ok(!g.hasColours);
  assert.equal(g.cycleColour(0), g); // given
  const a = g.cycleColour(e1);
  assert.equal(a.colours.get(e1), 1);
  assert.ok(a.hasColours);
  assert.equal(a.cycleColour(e1).colours.get(e1), 2);
  assert.equal(a.cycleColour(e1).cycleColour(e1).colours.get(e1), 0);
  // The digit and notes of the cell are untouched, and a filled cell can be coloured.
  const filled = a.place(e2, digit(e2), 0).cycleColour(e2);
  assert.equal(filled.board.get(e2), digit(e2));
  assert.equal(filled.colours.get(e2), 1);
  assert.equal(filled.colours.get(e1), 1);
  // The original is immutable.
  assert.equal(g.colours.get(e1), 0);
});

test("colours survive moves, undo and the timer, but undo doesn't undo them", () => {
  const [e1, e2] = empties() as [number, number];
  let g = Game.create(puzzle).resume(0).cycleColour(e1);
  g = g.place(e2, digit(e2), 5).toggleNote(empties()[2]!, 3).erase(e2).pause(10).resume(20);
  assert.equal(g.colours.get(e1), 1);
  assert.ok(g.canUndo);
  const undone = g.undo().undo().undo();
  assert.equal(undone.colours.get(e1), 1);
  assert.equal(g.record({ t: 0, w: 0, a: "start" }).colours.get(e1), 1);
  // Colouring is not an undoable step.
  const fresh = Game.create(puzzle).resume(0).cycleColour(e1);
  assert.ok(!fresh.canUndo);
  assert.equal(fresh.undo(), fresh);
});

test("clearColours removes them all, and does nothing when there are none", () => {
  const [e1, e2] = empties() as [number, number];
  const none = Game.create(puzzle);
  assert.equal(none.clearColours(), none);
  const g = none.cycleColour(e1).cycleColour(e2).place(e1, digit(e1), 0);
  const cleared = g.clearColours();
  assert.ok(!cleared.hasColours);
  assert.equal(cleared.board.get(e1), digit(e1));
});

test("clearing the board drops the colours too", () => {
  const e1 = empties()[0]!;
  const g = Game.create(puzzle).resume(0).place(e1, digit(e1), 0).cycleColour(empties()[1]!);
  assert.ok(g.hasColours);
  const cleared = g.clearAll();
  assert.ok(!cleared.hasColours);
  assert.ok(cleared.board.equals(cleared.board.givensOnly()));
  // Nothing to clear: the colours stay (there is a button for them).
  const only = Game.create(puzzle).cycleColour(e1);
  assert.equal(only.clearAll(), only);
  assert.ok(only.hasColours);
});

test("colours are dropped when the game is solved, and a finished game can't be coloured", () => {
  const cells = empties();
  let g = Game.create(puzzle).resume(0).cycleColour(cells[0]!);
  for (const i of cells.slice(0, -1)) g = g.place(i, digit(i), 0);
  assert.ok(g.hasColours);
  const done = g.place(cells[cells.length - 1]!, digit(cells[cells.length - 1]!), 99);
  assert.ok(done.isComplete);
  assert.ok(!done.hasColours);
  assert.equal(done.cycleColour(cells[0]!), done);
  assert.equal(done.save(0).colours, undefined);
});

test("colours are saved and restored with the game, and absent from old saves", () => {
  const [e1, e2] = empties() as [number, number];
  const g = Game.create(puzzle).resume(0).cycleColour(e1).cycleColour(e2).cycleColour(e2);
  const saved = g.save(1000);
  assert.equal(saved.colours, g.colours.toString());
  const restored = Game.restore(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.colours.get(e1), 1);
  assert.equal(restored.colours.get(e2), 2);
  // No colours: the key is left out, exactly as before colours existed.
  const plain = Game.create(puzzle).save(0);
  assert.ok(!("colours" in plain));
  const old = decodeSavedGame(JSON.parse(JSON.stringify(plain)));
  assert.ok(!("colours" in old));
  assert.ok(!Game.restore(old).hasColours);
  // Decoding keeps a colours string, and a damaged one reads as none.
  assert.equal(decodeSavedGame({ ...saved }).colours, saved.colours);
  assert.ok(!Game.restore({ ...saved, colours: "garbage" }).hasColours);
  // A saved, finished game has none.
  assert.ok(!Game.restore({ ...saved, entries: solution, completed: true }).hasColours);
});

test("colours are not in the replay", () => {
  const e1 = empties()[0]!;
  const g = Game.create(puzzle).resume(0).record({ t: 0, w: 1, a: "start" }).cycleColour(e1).cycleColour(e1).clearColours();
  assert.deepEqual(g.replay, [{ t: 0, w: 1, a: "start" }]);
  assert.deepEqual(g.save(0).replay, [{ t: 0, w: 1, a: "start" }]);
});

const NOW = Date.parse("2026-10-27T01:00:00Z");
const REF: EndlessRef = { generator: 1, difficulty: 2, number: 3 };

/** A controller playing a seed on a static host, over `store`; `start()` again on the same store is a reload. */
async function seedController(store: MemoryStore): Promise<AppController> {
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => NOW,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
  const repo = new SudokuRepository(new AppStorage(store), "http://localhost/auth/callback", "", () => NOW);
  const seeds = new SeedRepository(store, () => NOW);
  if (!seeds.profile()) await seeds.use(s("test-secret-0123456789"));
  const c = new AppController(repo, seeds, host);
  c.start();
  for (let i = 0; i < 500 && c.phase.kind !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(c.phase.kind, "ready");
  return c;
}

test("through the controller, colours are saved with Daily and Endless seed games and are not logged", async () => {
  const store = new MemoryStore();
  const c = await seedController(store);
  c.openPuzzle(1);
  const cell = [...c.puzzle(1)!.givens].findIndex((g) => g === "0");
  const logged = c.games.get(1)!.replay.length;
  c.update(1, (g) => g.cycleColour(cell));
  c.update(1, (g) => g.cycleColour(cell));
  assert.equal(c.games.get(1)!.colours.get(cell), 2);
  assert.equal(c.games.get(1)!.replay.length, logged);

  c.openEndless(REF);
  const ecell = [...c.puzzleOf(REF)!.givens].findIndex((g) => g === "0");
  c.update(REF, (g) => g.cycleColour(ecell));
  assert.equal(c.gameOf(REF)!.colours.get(ecell), 1);

  // A new controller on the same storage (a reload) resumes both with their colours.
  const again = await seedController(store);
  again.openPuzzle(1);
  assert.equal(again.games.get(1)!.colours.get(cell), 2);
  again.openEndless(REF);
  assert.equal(again.gameOf(REF)!.colours.get(ecell), 1);
  again.update(1, (g) => g.clearColours());
  assert.ok(!again.games.get(1)!.hasColours);
});
