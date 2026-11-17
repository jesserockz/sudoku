import assert from "node:assert/strict";
import test from "node:test";
import { toggleMode } from "../src/ui/input-mode.ts";

test("Notes and Colours are exclusive toggles", () => {
  // From digits, each toggle switches its own mode on.
  assert.equal(toggleMode("digits", "notes"), "notes");
  assert.equal(toggleMode("digits", "colour"), "colour");
  // Turning one on turns the other off.
  assert.equal(toggleMode("notes", "colour"), "colour");
  assert.equal(toggleMode("colour", "notes"), "notes");
  // Turning one off leaves both off.
  assert.equal(toggleMode("notes", "notes"), "digits");
  assert.equal(toggleMode("colour", "colour"), "digits");
});
