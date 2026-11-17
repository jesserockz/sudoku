import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../src/data/store.ts";
import { LearnProgress } from "../src/learn/progress.ts";

const fresh = (): { store: MemoryStore; progress: LearnProgress } => {
  const store = new MemoryStore();
  return { store, progress: new LearnProgress(store) };
};

test("an unknown lesson is new and empty", () => {
  const { progress, store } = fresh();
  assert.deepEqual(progress.get("pointing"), { seen: false, done: [], clean: [], solved: false });
  assert.equal(progress.status("pointing", 3), "new");
  assert.equal(store.values.size, 0, "reading writes nothing");
});

test("markSeen records the lesson as opened, once", () => {
  const { progress, store } = fresh();
  progress.markSeen("pointing");
  assert.equal(progress.get("pointing").seen, true);
  assert.equal(progress.status("pointing", 3), "seen");
  const before = store.values.get("learn");
  store.values.set("learn", before + " ");
  progress.markSeen("pointing");
  assert.equal(store.values.get("learn"), before + " ", "already seen: nothing is written");
});

test("markDone keeps finished positions sorted and unique, and clean ones apart", () => {
  const { progress } = fresh();
  progress.markDone("xWing", 2, false);
  progress.markDone("xWing", 0, true);
  progress.markDone("xWing", 2, true);
  progress.markDone("xWing", 0, false);
  assert.deepEqual(progress.get("xWing"), { seen: true, done: [0, 2], clean: [0, 2], solved: false });
  progress.markDone("xWing", 1, false);
  assert.deepEqual(progress.get("xWing").done, [0, 1, 2]);
  assert.deepEqual(progress.get("xWing").clean, [0, 2]);
});

test("markSolved marks the lesson seen and solved without touching practice", () => {
  const { progress } = fresh();
  progress.markDone("nakedPair", 0, true);
  progress.markSolved("nakedPair");
  assert.deepEqual(progress.get("nakedPair"), { seen: true, done: [0], clean: [0], solved: true });
  progress.markSolved("hiddenPair");
  assert.deepEqual(progress.get("hiddenPair"), { seen: true, done: [], clean: [], solved: true });
});

test("lessons are tracked separately", () => {
  const { progress } = fresh();
  progress.markDone("a", 0, true);
  progress.markSeen("b");
  assert.equal(progress.get("a").seen, true);
  assert.deepEqual(progress.get("b").done, []);
  assert.deepEqual(progress.get("c"), { seen: false, done: [], clean: [], solved: false });
});

test("status: new, seen, practised, then mastered once every position was clean", () => {
  const { progress } = fresh();
  assert.equal(progress.status("l", 2), "new");
  progress.markSeen("l");
  assert.equal(progress.status("l", 2), "seen");
  progress.markDone("l", 0, false);
  assert.equal(progress.status("l", 2), "practised");
  progress.markDone("l", 0, true);
  assert.equal(progress.status("l", 2), "practised", "one position of two");
  progress.markDone("l", 1, false);
  assert.equal(progress.status("l", 2), "practised", "the second was not clean");
  progress.markDone("l", 1, true);
  assert.equal(progress.status("l", 2), "mastered");
  assert.equal(progress.status("l", 3), "practised", "a third position is still to do");
  assert.equal(progress.status("l", 1), "mastered");
});

test("status: a lesson with no practice positions can be seen or new but never mastered", () => {
  const { progress } = fresh();
  assert.equal(progress.status("l", 0), "new");
  progress.markSeen("l");
  assert.equal(progress.status("l", 0), "seen");
  progress.markSolved("l");
  assert.equal(progress.status("l", 0), "seen");
});

test("progress persists through the store", () => {
  const { progress, store } = fresh();
  progress.markDone("l", 1, true);
  progress.markSolved("l");
  const again = new LearnProgress(store);
  assert.deepEqual(again.get("l"), { seen: true, done: [1], clean: [1], solved: true });
});

test("reset forgets everything", () => {
  const { progress, store } = fresh();
  progress.markDone("l", 0, true);
  progress.reset();
  assert.equal(store.values.has("learn"), false);
  assert.deepEqual(progress.get("l"), { seen: false, done: [], clean: [], solved: false });
  assert.equal(progress.status("l", 1), "new");
});

test("stored indexes are cleaned when read: sorted, unique, whole and not negative", () => {
  const { store } = fresh();
  store.set("learn", JSON.stringify({ l: { seen: true, done: [3, 1, 1, -2, 2.5, 0], clean: [2, 2], solved: false } }));
  assert.deepEqual(new LearnProgress(store).get("l"), { seen: true, done: [0, 1, 3], clean: [2], solved: false });
});

test("unreadable storage reads as no progress and is then overwritten", () => {
  for (const text of ["not json", "[]", '{"l": 3}', '{"l": {"seen": "yes", "done": [], "clean": [], "solved": false}}', '{"l": {"seen": true, "done": [1, "x"], "clean": [], "solved": false}}']) {
    const store = new MemoryStore();
    store.set("learn", text);
    const progress = new LearnProgress(store);
    assert.deepEqual(progress.get("l"), { seen: false, done: [], clean: [], solved: false }, text);
    progress.markSeen("l");
    assert.equal(progress.get("l").seen, true, text);
  }
});
