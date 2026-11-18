import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYING_CLASS, type ZoomLockTarget, lockZoom } from "../src/ui/zoom-lock.ts";

/** A stand-in document that records its root classes and listeners. */
class FakeDocument implements ZoomLockTarget {
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, { listener: (e: Event) => void; options: AddEventListenerOptions }>();
  readonly documentElement = {
    classList: { add: (name: string): void => { this.classes.add(name); }, remove: (name: string): void => { this.classes.delete(name); } },
  };

  addEventListener(type: string, listener: (e: Event) => void, options: AddEventListenerOptions): void {
    this.listeners.set(type, { listener, options });
  }

  removeEventListener(type: string, listener: (e: Event) => void): void {
    if (this.listeners.get(type)?.listener === listener) this.listeners.delete(type);
  }
}

test("locking marks the root element and cancels a pinch beginning", () => {
  const doc = new FakeDocument();
  lockZoom(doc);
  assert.deepEqual([...doc.classes], [PLAYING_CLASS]);
  const gesture = doc.listeners.get("gesturestart");
  assert.ok(gesture);
  assert.equal(gesture.options.passive, false, "a passive listener could not cancel the gesture");
  let cancelled = 0;
  gesture.listener({ preventDefault: () => { cancelled++; } } as Event);
  assert.equal(cancelled, 1);
});

test("unlocking leaves the document as it was", () => {
  const doc = new FakeDocument();
  doc.classes.add("other");
  const unlock = lockZoom(doc);
  unlock();
  assert.deepEqual([...doc.classes], ["other"]);
  assert.equal(doc.listeners.size, 0);
});
