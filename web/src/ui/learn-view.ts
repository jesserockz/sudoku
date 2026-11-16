// What the Learn screens draw, worked out without the DOM so it can be tested.
import { CELLS, colOf, rowOf } from "../core/geometry.ts";
import type { Layout } from "../core/layout.ts";
import { LESSONS, type Lesson, type Level, practiceCount } from "../learn/lessons.ts";
import type { LearnProgress, Status } from "../learn/progress.ts";
import { type Role, type Step, bit, digitsOf } from "../learn/state.ts";
import { cellDecor } from "./cell-view.ts";

/** A board to draw: a position, the candidates to show in it, and what to highlight. */
export interface BoardView {
  /** The digits the position started with, which are drawn as givens. */
  given: readonly number[];
  grid: readonly number[];
  /** The candidate mask to draw in each empty cell (`0` for none). */
  marks: readonly number[];
  /** The step to highlight, or `null`. */
  step: Step | null;
  /** Whether the step's result is drawn too: its digit, and its removed candidates struck out. */
  result: boolean;
  /** The selected cell, or `-1`. */
  selected: number;
  /** The cells an exercise asks about. */
  targets: readonly number[];
  /** The position's rules: a variant's diagonals, regions or cages are drawn, and its units and peers highlighted. */
  layout: Layout;
}

/** One slot of a cell's 3x3 candidate grid: `hot` is part of the pattern, `struck` has just been removed. */
export interface NoteModel {
  text: string;
  kind: "" | "hot" | "struck";
}

export interface CellModel {
  /** Class names after `cell`, `r<row>` and `c<col>`: the layout's decor (see `cellDecor`), then the highlights. */
  classes: string[];
  /** A killer cage's sum, on the cage's first cell only. */
  sum?: number;
  /** The digit, or `""` for an empty cell. */
  text: string;
  /** The nine candidate slots, or `null` when the cell has a digit or nothing to show. */
  notes: NoteModel[] | null;
  /** How a screen reader names the cell. */
  label: string;
}

const ROLE_NAMES: Record<Role, string> = {
  pattern: "part of the pattern", pivot: "the pivot", wing: "a wing", see: "sees the pattern", colourA: "colour A", colourB: "colour B",
};

/** What to draw in each of the 81 cells of a board. */
export function cellModels(view: BoardView): CellModel[] {
  const { step, selected, layout } = view;
  const inUnit = new Set(step ? step.units.flatMap((u) => layout.units[u]!) : []);
  const selectedPeers = new Set(selected >= 0 ? layout.peers[selected] : []);
  const selectedDigit = selected >= 0 ? view.grid[selected]! : 0;
  return Array.from({ length: CELLS }, (_, c) => {
    const decor = cellDecor(layout, c);
    const digit = view.grid[c]!;
    const marks = step ? step.marks.filter((m) => m.cell === c) : [];
    const roles = [...new Set(marks.map((m) => m.role))];
    const placed = view.result && step?.place?.cell === c;
    const classes = [
      ...decor.classes,
      view.given[c] !== 0 ? "given" : digit !== 0 ? "entry" : "",
      inUnit.has(c) ? "unit" : "",
      ...roles.map((r) => `hl-${r}`),
      placed ? "placed" : "",
      view.targets.includes(c) ? "target" : "",
      selectedPeers.has(c) ? "peer" : "",
      selectedDigit !== 0 && digit === selectedDigit && c !== selected ? "same" : "",
      c === selected ? "selected" : "",
    ].filter((name) => name !== "");
    let notes: NoteModel[] | null = null;
    let candidates: number[] = [];
    if (digit === 0) {
      const struck = view.result && step ? step.eliminations.filter((e) => e.cell === c).reduce((m, e) => m | bit(e.digit), 0) : 0;
      const hot = marks.reduce((m, mark) => m | (mark.digits ?? []).reduce((n, d) => n | bit(d), 0), 0);
      const shown = view.marks[c]! | struck;
      candidates = digitsOf(view.marks[c]!);
      if (shown !== 0) {
        notes = Array.from({ length: 9 }, (_, k): NoteModel => {
          const mask = bit(k + 1);
          if (!(shown & mask)) return { text: "", kind: "" };
          return { text: String(k + 1), kind: struck & mask ? "struck" : hot & mask ? "hot" : "" };
        });
      }
    }
    const content = digit !== 0 ? String(digit) : candidates.length > 0 ? `empty, candidates ${candidates.join(" ")}` : "empty";
    const extra = [...roles.map((r) => ROLE_NAMES[r]), ...(placed ? ["just placed"] : []), ...(view.targets.includes(c) ? ["to fill in"] : [])];
    return {
      classes, text: digit !== 0 ? String(digit) : "", notes,
      ...(decor.sum !== null ? { sum: decor.sum } : {}),
      label: `Row ${rowOf(c) + 1} column ${colOf(c) + 1}, ${[...(decor.label ? [decor.label] : []), content, ...extra].join(", ")}`,
    };
  });
}

/** How many of each digit are on the board, indexed by digit, for the keypad's "left" counts. */
export function digitCounts(grid: readonly number[]): number[] {
  const counts = new Array<number>(10).fill(0);
  for (const d of grid) counts[d]!++;
  counts[0] = 0;
  return counts;
}

/** One lesson in the Learn tab's list. */
export interface LessonRow {
  lesson: Lesson;
  status: Status;
  /** The line under the title. */
  statusText: string;
  /** The button's label. */
  action: string;
}

export function lessonRow(lesson: Lesson, progress: LearnProgress): LessonRow {
  const total = practiceCount(lesson);
  const status = progress.status(lesson.id, total);
  const p = progress.get(lesson.id);
  const solved = p.solved ? " · puzzle solved" : "";
  const statusText = status === "new" ? lesson.summary
    : status === "seen" ? `Started${solved}`
      : status === "practised" ? `Practised ${p.done.length} of ${total}${solved}`
        : `Mastered${solved}`;
  return { lesson, status, statusText, action: status === "new" ? "Start" : status === "mastered" ? "Review" : "Continue" };
}

export const lessonRows = (level: Level, progress: LearnProgress): LessonRow[] => level.lessons.map((l) => lessonRow(l, progress));

/** The line above the lesson list: how far through the curriculum the player is. */
export function learnSummary(progress: LearnProgress): string {
  const statuses = LESSONS.map((l) => progress.status(l.id, practiceCount(l)));
  const mastered = statuses.filter((s) => s === "mastered").length;
  const practised = statuses.filter((s) => s === "practised").length;
  if (mastered === 0 && practised === 0) return `${LESSONS.length} lessons, from the rules to chains and the variants. Each one has a worked example and positions to practise on.`;
  return `${mastered} of ${LESSONS.length} lessons mastered${practised > 0 ? `, ${practised} more in progress` : ""}.`;
}

/** What a key press asks for on a lesson's board. */
export type KeyCommand =
  | { kind: "digit"; digit: number }
  | { kind: "move"; row: number; col: number }
  | { kind: "mode" | "candidates" | "hint" | "deselect" };

export function keyCommand(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): KeyCommand | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (/^[1-9]$/.test(e.key)) return { kind: "digit", digit: Number(e.key) };
  switch (e.key) {
    case "ArrowUp": return { kind: "move", row: -1, col: 0 };
    case "ArrowDown": return { kind: "move", row: 1, col: 0 };
    case "ArrowLeft": return { kind: "move", row: 0, col: -1 };
    case "ArrowRight": return { kind: "move", row: 0, col: 1 };
    case "n": case "N": return { kind: "mode" };
    case "c": case "C": return { kind: "candidates" };
    case "h": case "H": case "?": return { kind: "hint" };
    case "Escape": return { kind: "deselect" };
    default: return null;
  }
}
