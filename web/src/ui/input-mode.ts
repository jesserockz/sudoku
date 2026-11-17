/**
 * What a tap or digit does on the play screen: place digits, toggle notes, or
 * cycle colour pens. One mode at a time, so Notes and Colours can never both
 * be on.
 */
export type InputMode = "digits" | "notes" | "colour";

/** The mode after pressing the `target` toggle: it switches on (turning the other off), or off back to digits. */
export function toggleMode(current: InputMode, target: "notes" | "colour"): InputMode {
  return current === target ? "digits" : target;
}
