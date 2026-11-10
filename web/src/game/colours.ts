import { CELLS } from "../core/geometry.ts";

/** How many colour pens there are. */
export const COLOUR_COUNT = 2;

/** The pens' names, as a screen reader says them (index 0 is "no colour"). */
export const COLOUR_NAMES = ["", "colour A", "colour B"] as const;

/**
 * Colour pens: for each cell, no colour (0) or one of {@link COLOUR_COUNT}
 * colours (1, 2), painted by hand for the "simple colouring" technique. Purely
 * a visual aid for the player: not part of undo, the replay or the result.
 * Immutable.
 */
export class Colours {
  static readonly EMPTY = new Colours(new Uint8Array(CELLS));
  readonly #values: Uint8Array;

  private constructor(values: Uint8Array) {
    this.#values = values;
  }

  /** Reads {@link toString}'s output; anything malformed (or absent) reads as no colours. */
  static parse(text: string | undefined): Colours {
    if (text === undefined || text.length !== CELLS || !/^[0-2]+$/.test(text)) return Colours.EMPTY;
    return new Colours(Uint8Array.from(text, Number));
  }

  /** The colour of cell `i`: 0 for none, else 1 or 2. */
  get(i: number): number {
    return this.#values[i]!;
  }

  get isBlank(): boolean {
    return this.#values.every((v) => v === 0);
  }

  /** Cell `i` moved on one step: none, colour A, colour B, none. */
  cycled(i: number): Colours {
    const next = this.#values.slice();
    next[i] = (next[i]! + 1) % (COLOUR_COUNT + 1);
    return new Colours(next);
  }

  /** One digit per cell, `0` for none. */
  toString(): string {
    return Array.from(this.#values).join("");
  }
}
