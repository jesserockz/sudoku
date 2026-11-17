// Game replays (docs/API.md, "Replays"): every action of a game with its game-timer and wall-clock time.
import { bool, list, num, obj, optional, str } from "../data/store.ts";

export const REPLAY_VERSION = 1;
/** The most events the server accepts; a longer replay is left out of the result. */
export const MAX_REPLAY_EVENTS = 10_000;

export const REPLAY_ACTIONS = [
  "start", "place", "erase", "noteAdd", "noteRemove", "undo", "clear", "notes",
  "pause", "resume", "hidden", "visible", "restore", "finish", "colour", "clearColours",
] as const;

export type ReplayAction = (typeof REPLAY_ACTIONS)[number];

/** What happened, without the timestamps. `c` is a cell `0..80`, `d` a digit `1..9`, `on` the new notes mode, `p` the colour pen a `colour` event leaves the cell with (0 none, 1 A, 2 B). */
export interface ReplayInput {
  a: ReplayAction;
  c?: number;
  d?: number;
  on?: boolean;
  p?: number;
}

/** One recorded action: `t` is the game timer in ms (stops while paused), `w` the wall clock in epoch ms. */
export interface ReplayEvent extends ReplayInput {
  t: number;
  w: number;
}

/** A replay as sent with a result. */
export interface Replay {
  version: number;
  events: ReplayEvent[];
}

export function decodeReplayEvent(json: unknown): ReplayEvent {
  const o = obj(json);
  const a = str(o.a);
  if (!(REPLAY_ACTIONS as readonly string[]).includes(a)) throw new TypeError(`unknown replay action: ${a}`);
  const c = optional(o.c, num);
  const d = optional(o.d, num);
  const on = optional(o.on, bool);
  const p = optional(o.p, num);
  return { t: num(o.t), w: num(o.w), a: a as ReplayAction, ...(c === null ? {} : { c }), ...(d === null ? {} : { d }), ...(on === null ? {} : { on }), ...(p === null ? {} : { p }) };
}

export function decodeReplay(json: unknown): Replay {
  const o = obj(json);
  return { version: num(o.version), events: list(o.events, decodeReplayEvent) };
}

/** Whether `e` is a colour pen event: the player's own aid, which the server ignores. */
export const isColourEvent = (e: ReplayEvent): boolean => e.a === "colour" || e.a === "clearColours";

/**
 * The events to send with a result: all of them, or without the colour pen events when they alone push the replay
 * past {@link MAX_REPLAY_EVENTS}, so painting never costs a game its replay. `null` when it is too long even then.
 */
export function replayToSend(events: readonly ReplayEvent[]): Replay | null {
  const fit = events.length <= MAX_REPLAY_EVENTS ? events : events.filter((e) => !isColourEvent(e));
  return fit.length <= MAX_REPLAY_EVENTS ? { version: REPLAY_VERSION, events: fit.slice() } : null;
}

/** `result` with the colour pen events taken out of its replay (the same object when it has none). */
export function withoutColourEvents<T extends { replay?: Replay }>(result: T): T {
  if (!result.replay?.events.some(isColourEvent)) return result;
  return { ...result, replay: { ...result.replay, events: result.replay.events.filter((e) => !isColourEvent(e)) } };
}
