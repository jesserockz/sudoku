import { CELLS } from "../core/geometry.ts";

/** Pencil marks: for each cell, the set of candidate digits the player noted. Immutable. */
export class Notes {
  static readonly EMPTY = new Notes(new Uint16Array(CELLS));
  readonly #masks: Uint16Array;

  private constructor(masks: Uint16Array) {
    this.#masks = masks;
  }

  static fromMasks(masks: ArrayLike<number>): Notes {
    if (masks.length !== CELLS) throw new RangeError(`expected ${CELLS} masks, got ${masks.length}`);
    const copy = new Uint16Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      const m = masks[i]!;
      if (!(Number.isInteger(m) && m >= 0 && m <= 0x1ff)) throw new RangeError("note masks must be 9-bit");
      copy[i] = m;
    }
    return new Notes(copy);
  }

  /** The noted digits of a cell, ascending. */
  get(i: number): number[] {
    const out: number[] = [];
    for (let d = 1; d <= 9; d++) if (this.has(i, d)) out.push(d);
    return out;
  }

  has(i: number, digit: number): boolean {
    return (this.#masks[i]! & bit(digit)) !== 0;
  }

  isEmpty(i: number): boolean {
    return this.#masks[i] === 0;
  }

  get isBlank(): boolean {
    return this.#masks.every((m) => m === 0);
  }

  /** The raw 9-bit mask for a cell: bit `d - 1` set when digit `d` is noted. */
  mask(i: number): number {
    return this.#masks[i]!;
  }

  toggled(i: number, digit: number): Notes {
    return this.#withMask(i, this.#masks[i]! ^ bit(digit));
  }

  cleared(i: number): Notes {
    return this.#withMask(i, 0);
  }

  /** Removes `digit` from the notes of every cell in `indices`. */
  withoutDigit(indices: readonly number[], digit: number): Notes {
    const b = bit(digit);
    if (!indices.some((i) => this.#masks[i]! & b)) return this;
    const next = this.#masks.slice();
    for (const i of indices) next[i]! &= ~b;
    return new Notes(next);
  }

  toMasks(): number[] {
    return Array.from(this.#masks);
  }

  #withMask(i: number, mask: number): Notes {
    if (this.#masks[i] === mask) return this;
    const next = this.#masks.slice();
    next[i] = mask;
    return new Notes(next);
  }
}

function bit(digit: number): number {
  if (!(Number.isInteger(digit) && digit >= 1 && digit <= 9)) throw new RangeError(`digit out of range: ${digit}`);
  return 1 << (digit - 1);
}
