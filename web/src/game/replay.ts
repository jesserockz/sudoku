// Game replays (docs/API.md, "Replays"): every action of a game with its game-timer and wall-clock time.
import { bool, list, num, obj, optional, str } from "../data/store.ts";

export const REPLAY_VERSION = 1;
/** The most events the server accepts; a longer replay is left out of the result. */
export const MAX_REPLAY_EVENTS = 10_000;

export const REPLAY_ACTIONS = [
  "start", "place", "erase", "noteAdd", "noteRemove", "undo", "clear", "notes",
  "pause", "resume", "hidden", "visible", "restore", "finish",
] as const;

export type ReplayAction = (typeof REPLAY_ACTIONS)[number];

/** What happened, without the timestamps. `c` is a cell `0..80`, `d` a digit `1..9`, `on` the new notes mode. */
export interface ReplayInput {
  a: ReplayAction;
  c?: number;
  d?: number;
  on?: boolean;
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
  return { t: num(o.t), w: num(o.w), a: a as ReplayAction, ...(c === null ? {} : { c }), ...(d === null ? {} : { d }), ...(on === null ? {} : { on }) };
}

export function decodeReplay(json: unknown): Replay {
  const o = obj(json);
  return { version: num(o.version), events: list(o.events, decodeReplayEvent) };
}
