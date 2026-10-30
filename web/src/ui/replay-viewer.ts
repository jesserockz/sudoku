// The admin replay viewer's logic, free of the DOM: rebuilds the board after every event, plays the
// replay back on the game clock, and points out what's worth a closer look (long gaps, time hidden or
// paused, a steady machine-like pace). Digits stay hidden unless the admin reveals them.
import type { ReplayDetail } from "../api/models.ts";
import { colOf, rowOf } from "../core/geometry.ts";
import { Game } from "../game/game.ts";
import type { ReplayEvent } from "../game/replay.ts";

export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** A gap between moves at least this long, and {@link LONG_GAP_FACTOR} times the median, is "long". */
export const LONG_GAP_MS = 30_000;
export const LONG_GAP_FACTOR = 3;
/** Placements needed before the pace is judged. */
export const PACE_MIN_PLACEMENTS = 10;
/** Gaps between placements varying less than this (standard deviation / mean) look machine-like. */
export const STEADY_VARIATION = 0.35;
/** Paused or hidden stretches shorter than this aren't listed (they still count in the totals). */
export const MIN_STRETCH_MS = 1000;

const MOVES = new Set(["place", "erase", "noteAdd", "noteRemove", "undo", "clear"]);
export const isMove = (e: ReplayEvent): boolean => MOVES.has(e.a);

/** A stretch of wall-clock time with the timer stopped or the app hidden, from event `from` to event `to`. */
export interface Stretch {
  kind: "paused" | "hidden";
  from: number;
  to: number;
  wallMs: number;
}

export interface Pace {
  placements: number;
  medianMs: number;
  /** Standard deviation over mean of the timer gaps between placements. */
  variation: number;
  steady: boolean;
}

export interface Analysis {
  /** Timer at the last event. */
  timerMs: number;
  /** Wall clock from the first event to the last. */
  wallSpanMs: number;
  /** Wall-clock time with the timer stopped (paused, closed or reloaded). */
  pausedMs: number;
  /** Wall-clock time with the app hidden. */
  hiddenMs: number;
  stretches: Stretch[];
  /** Timer gap before each event since the previous move (for moves) or event. */
  gaps: number[];
  /** Wall gap before each event since the previous event. */
  wallGaps: number[];
  /** Indices of moves that came after a long gap. */
  longGaps: Set<number>;
  pace: Pace | null;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function analyse(events: readonly ReplayEvent[]): Analysis {
  const gaps: number[] = [];
  const wallGaps: number[] = [];
  const stretches: Stretch[] = [];
  let running = false;
  let lastMoveT = 0;
  let pausedMs = 0;
  let hiddenMs = 0;
  /** The event that stopped the timer (the timer starts stopped), or `null` while it runs. */
  let stoppedFrom: number | null = 0;
  let hiddenFrom: number | null = null;
  const stretch = (kind: Stretch["kind"], from: number, to: number) => {
    const wallMs = Math.max(0, events[to]!.w - events[from]!.w);
    if (wallMs >= MIN_STRETCH_MS) stretches.push({ kind, from, to, wallMs });
    return wallMs;
  };
  events.forEach((e, i) => {
    const prev = events[i - 1];
    const dw = prev ? Math.max(0, e.w - prev.w) : 0;
    wallGaps.push(dw);
    if (!running && i > 0) pausedMs += dw;
    if (isMove(e)) {
      gaps.push(e.t - lastMoveT);
      lastMoveT = e.t;
    } else {
      gaps.push(prev ? e.t - prev.t : 0);
    }
    if (e.a === "hidden" && hiddenFrom === null) hiddenFrom = i;
    if (e.a === "visible" && hiddenFrom !== null) {
      hiddenMs += stretch("hidden", hiddenFrom, i);
      hiddenFrom = null;
    }
    if (e.a === "resume" && stoppedFrom !== null) {
      stretch("paused", stoppedFrom, i);
      stoppedFrom = null;
    } else if ((e.a === "pause" || e.a === "restore") && stoppedFrom === null) {
      stoppedFrom = i;
    }
    running = stoppedFrom === null;
  });
  stretches.sort((a, b) => a.from - b.from || a.to - b.to);

  const moveGaps = events.flatMap((e, i) => (isMove(e) ? [gaps[i]!] : []));
  const typical = moveGaps.length > 0 ? median(moveGaps) : 0;
  const longGaps = new Set(events.flatMap((e, i) =>
    isMove(e) && gaps[i]! >= LONG_GAP_MS && gaps[i]! >= LONG_GAP_FACTOR * typical ? [i] : []));

  const placeTimes = events.filter((e) => e.a === "place").map((e) => e.t);
  let pace: Pace | null = null;
  if (placeTimes.length >= PACE_MIN_PLACEMENTS) {
    const between = placeTimes.slice(1).map((t, i) => t - placeTimes[i]!);
    const mean = between.reduce((a, b) => a + b, 0) / between.length;
    const sd = Math.sqrt(between.reduce((a, b) => a + (b - mean) ** 2, 0) / between.length);
    const variation = mean > 0 ? sd / mean : 0;
    pace = { placements: placeTimes.length, medianMs: median(between), variation, steady: variation < STEADY_VARIATION };
  }

  const first = events[0];
  const last = events[events.length - 1];
  return {
    timerMs: last?.t ?? 0,
    wallSpanMs: first && last ? Math.max(0, last.w - first.w) : 0,
    pausedMs, hiddenMs, stretches, gaps, wallGaps, longGaps, pace,
  };
}

/** Applies one event to a game, leniently: an event that doesn't fit (an invalid replay) changes nothing. */
export function applyEvent(game: Game, e: ReplayEvent): Game {
  const c = e.c ?? -1;
  const valid = c >= 0 && c < 81;
  const digit = e.d !== undefined && e.d >= 1 && e.d <= 9 ? e.d : 0;
  switch (e.a) {
    case "place": return valid && digit ? game.place(c, digit, e.t) : game;
    case "erase": return valid ? game.erase(c) : game;
    case "noteAdd": return valid && digit && !game.notes.has(c, digit) ? game.toggleNote(c, digit) : game;
    case "noteRemove": return valid && digit && game.notes.has(c, digit) ? game.toggleNote(c, digit) : game;
    case "undo": return game.undo();
    case "clear": return game.clearAll();
    // A reload loses the undo history.
    case "restore": return Game.restore(game.save(0));
    default: return game;
  }
}

/** `R3C5`, 1-based. */
export const cellName = (i: number): string => `R${rowOf(i) + 1}C${colOf(i) + 1}`;

/** What to draw in a cell. Hidden digits become `•`; hidden notes become one `·` per mark. */
export interface CellView {
  kind: "given" | "entry" | "notes" | "empty";
  text: string;
}

/**
 * State of the replay viewer. Fires `change` whenever anything does. It
 * keeps no timers: the screen calls {@link tick} with real elapsed time while
 * {@link playing}.
 *
 * `revealDigits` starts `false` for every viewer and is never stored: the
 * admin is also a player and shouldn't see a solution by accident.
 */
export class ReplayViewer extends EventTarget {
  readonly detail: ReplayDetail;
  readonly events: readonly ReplayEvent[];
  readonly analysis: Analysis;
  /** `frames[k]` is the game after the first `k` events. */
  readonly #frames: Game[];
  /** Events applied so far, `0..events.length`. */
  index = 0;
  /** Playback position on the game timer. */
  cursorMs = 0;
  playing = false;
  speed: Speed = 1;
  revealDigits = false;

  constructor(detail: ReplayDetail) {
    super();
    this.detail = detail;
    this.events = detail.events;
    this.analysis = analyse(this.events);
    let game = Game.create(detail.givens);
    this.#frames = [game];
    for (const e of this.events) this.#frames.push(game = applyEvent(game, e));
  }

  get length(): number {
    return this.events.length;
  }

  get endMs(): number {
    return this.analysis.timerMs;
  }

  /** The board after the events applied so far. */
  get game(): Game {
    return this.#frames[this.index]!;
  }

  /** The event applied last, or `null` at the start. */
  get current(): ReplayEvent | null {
    return this.events[this.index - 1] ?? null;
  }

  /** The cell the last applied event touched, or `-1`. */
  get changedCell(): number {
    return this.current?.c ?? -1;
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  play(): void {
    if (this.length === 0) return;
    if (this.index >= this.length) this.seek(0);
    this.playing = true;
    this.#changed();
  }

  pause(): void {
    this.playing = false;
    this.#changed();
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
    this.#changed();
  }

  /** Shows or hides the digits. Only ever set by the admin's explicit toggle. */
  setRevealDigits(reveal: boolean): void {
    this.revealDigits = reveal;
    this.#changed();
  }

  /**
   * Advances playback by `realMs` of real time (times the speed). Stops at the
   * end. Fires `change` only when something shown changes: an action, the
   * timer's whole second, or the end.
   */
  tick(realMs: number): void {
    if (!this.playing) return;
    const before = { index: this.index, second: Math.floor(this.cursorMs / 1000) };
    this.cursorMs = Math.min(this.endMs, this.cursorMs + realMs * this.speed);
    while (this.index < this.length && this.events[this.index]!.t <= this.cursorMs) this.index++;
    if (this.index >= this.length) this.playing = false;
    if (!this.playing || this.index !== before.index || Math.floor(this.cursorMs / 1000) !== before.second) this.#changed();
  }

  /** Jumps to timer position `ms`: every event at or before it is applied. */
  seek(ms: number): void {
    this.cursorMs = Math.max(0, Math.min(this.endMs, ms));
    this.index = this.events.filter((e) => e.t <= this.cursorMs).length;
    this.#changed();
  }

  /** Jumps to just after event `index - 1` (so `goTo(0)` is the start). */
  goTo(index: number): void {
    this.index = Math.max(0, Math.min(this.length, index));
    this.cursorMs = this.current?.t ?? 0;
    this.#changed();
  }

  next(): void {
    this.playing = false;
    this.goTo(this.index + 1);
  }

  previous(): void {
    this.playing = false;
    this.goTo(this.index - 1);
  }

  cell(i: number): CellView {
    const game = this.game;
    const digit = game.board.get(i);
    if (game.board.isGiven(i)) return { kind: "given", text: String(digit) };
    if (digit !== 0) return { kind: "entry", text: this.revealDigits ? String(digit) : "•" };
    const notes = game.notes.get(i);
    if (notes.length === 0) return { kind: "empty", text: "" };
    return { kind: "notes", text: this.revealDigits ? notes.join("") : "·".repeat(notes.length) };
  }

  /** A readable line for event `k`, without the digit unless revealed. */
  describe(k: number): string {
    const e = this.events[k]!;
    const before = this.#frames[k]!;
    const at = e.c !== undefined ? cellName(e.c) : "";
    const d = this.revealDigits && e.d !== undefined ? ` ${e.d}` : "";
    switch (e.a) {
      case "start": return "Opened the puzzle";
      case "place": return `Placed${d || " a digit"} in ${at}`;
      case "erase": {
        const what = e.c !== undefined && before.board.get(e.c) !== 0 ? "digit" : "notes";
        return `Erased the ${what} in ${at}`;
      }
      case "noteAdd": return `Added note${d || ""} in ${at}`;
      case "noteRemove": return `Removed note${d || ""} in ${at}`;
      case "undo": return "Undo";
      case "clear": return "Cleared the board";
      case "notes": return e.on ? "Notes mode on" : "Notes mode off";
      case "pause": return "Timer stopped";
      case "resume": return "Timer started";
      case "hidden": return "App hidden";
      case "visible": return "App visible again";
      case "restore": return "Reloaded from storage";
      case "finish": return "Solved";
    }
  }

  /** The stretch (paused or hidden) that event `k` falls inside or ends, if any. */
  stretchAt(k: number): Stretch | null {
    return this.analysis.stretches.find((s) => k > s.from && k <= s.to) ?? null;
  }
}

/** Wall-clock time of day in the viewer's timezone, to the second. */
export function formatWall(epochMs: number, timeZone?: string): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", { hour12: false, ...(timeZone ? { timeZone } : {}) });
}

/** A short gap: `850 ms`, `12.4 s`, `3 m 05 s`, `1 h 02 m`. */
export function formatGap(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // Below 59.95 s, so rounding never shows "60.0 s".
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
}
