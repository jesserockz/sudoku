// How far the player has got in each lesson, kept on this device only.
import { type KeyValueStore, StoredValue, bool, list, num, obj, record } from "../data/store.ts";

export interface LessonProgress {
  /** The lesson has been opened. */
  seen: boolean;
  /** The practice positions finished, by index. */
  done: number[];
  /** Those finished without the answer being shown. */
  clean: number[];
  /** The lesson's full puzzle has been solved. */
  solved: boolean;
}

/** `new`, then `seen` once opened, `practised` after one position, `mastered` after all of them unaided. */
export type Status = "new" | "seen" | "practised" | "mastered";

const empty = (): LessonProgress => ({ seen: false, done: [], clean: [], solved: false });

const indexes = (json: unknown): number[] => [...new Set(list(json, num).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);

function decode(json: unknown): Record<string, LessonProgress> {
  return record(json, (value) => {
    const o = obj(value);
    return { seen: bool(o.seen), done: indexes(o.done), clean: indexes(o.clean), solved: bool(o.solved) };
  });
}

export class LearnProgress {
  readonly #stored: StoredValue<Record<string, LessonProgress>>;

  constructor(store: KeyValueStore) {
    this.#stored = new StoredValue(store, "learn", decode);
  }

  get(lesson: string): LessonProgress {
    return this.#stored.read()?.[lesson] ?? empty();
  }

  #change(lesson: string, change: (progress: LessonProgress) => void): void {
    this.#stored.update((all) => {
      const next = { ...all };
      const progress = next[lesson] ?? empty();
      change(progress);
      next[lesson] = progress;
      return next;
    });
  }

  markSeen(lesson: string): void {
    if (!this.get(lesson).seen) this.#change(lesson, (p) => { p.seen = true; });
  }

  /** Records practice position `index` as finished; `clean` when the answer was never shown. */
  markDone(lesson: string, index: number, clean: boolean): void {
    this.#change(lesson, (p) => {
      p.seen = true;
      p.done = indexes([...p.done, index]);
      if (clean) p.clean = indexes([...p.clean, index]);
    });
  }

  markSolved(lesson: string): void {
    this.#change(lesson, (p) => {
      p.seen = true;
      p.solved = true;
    });
  }

  /** Where a lesson with `positions` practice positions stands. */
  status(lesson: string, positions: number): Status {
    const p = this.get(lesson);
    if (positions > 0 && Array.from({ length: positions }, (_, i) => i).every((i) => p.clean.includes(i))) return "mastered";
    if (p.done.length > 0) return "practised";
    return p.seen ? "seen" : "new";
  }

  /** Forgets everything. */
  reset(): void {
    this.#stored.write(null);
  }
}
