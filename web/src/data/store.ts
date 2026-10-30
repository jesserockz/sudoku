/**
 * Durable string storage, one JSON document per key (`localStorage` in the
 * app, keys prefixed `sudoku.`). Keys are short names like `week` or `games`.
 */
export interface KeyValueStore {
  get(key: string): string | null;
  /** Stores `value`, or removes the key when it's `null`. */
  set(key: string, value: string | null): void;
}

/** A store in memory, for tests. */
export class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
  }
}

/**
 * A store over Web Storage, with every key under `prefix`. Storage can be
 * unavailable (private mode, quota, blocked site data): reads then come back
 * empty and writes are dropped, so the app still works online.
 */
export class WebStorageStore implements KeyValueStore {
  readonly #storage: () => Storage;
  readonly #prefix: string;

  constructor(storage: () => Storage = () => localStorage, prefix = "sudoku.") {
    this.#storage = storage;
    this.#prefix = prefix;
  }

  get(key: string): string | null {
    try {
      return this.#storage().getItem(this.#prefix + key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string | null): void {
    try {
      if (value === null) this.#storage().removeItem(this.#prefix + key);
      else this.#storage().setItem(this.#prefix + key, value);
    } catch {
      // Dropped; see the class comment.
    }
  }
}

/**
 * One JSON document under `key`. `decode` checks and normalises what was
 * parsed (e.g. fills in defaults); a value it rejects by throwing, or that
 * isn't JSON, reads as `null`.
 */
export class StoredValue<T> {
  readonly #store: KeyValueStore;
  readonly #key: string;
  readonly #decode: (json: unknown) => T;

  constructor(store: KeyValueStore, key: string, decode: (json: unknown) => T) {
    this.#store = store;
    this.#key = key;
    this.#decode = decode;
  }

  read(): T | null {
    const text = this.#store.get(this.#key);
    if (text === null) return null;
    try {
      return this.#decode(JSON.parse(text));
    } catch {
      return null;
    }
  }

  write(value: T | null): void {
    this.#store.set(this.#key, value === null ? null : JSON.stringify(value));
  }

  update(change: (value: T | null) => T | null): void {
    this.write(change(this.read()));
  }
}

// Decoding helpers: each returns its input, typed, or throws.

export function obj(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new TypeError("expected an object");
  return json as Record<string, unknown>;
}

export function str(json: unknown): string {
  if (typeof json !== "string") throw new TypeError("expected a string");
  return json;
}

export function num(json: unknown): number {
  if (typeof json !== "number" || !Number.isFinite(json)) throw new TypeError("expected a number");
  return json;
}

export function bool(json: unknown): boolean {
  if (typeof json !== "boolean") throw new TypeError("expected a boolean");
  return json;
}

export function list<T>(json: unknown, item: (json: unknown) => T): T[] {
  if (!Array.isArray(json)) throw new TypeError("expected an array");
  return json.map(item);
}

export function record<T>(json: unknown, value: (json: unknown) => T): Record<string, T> {
  const o = obj(json);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
}

export function optional<T>(json: unknown, decode: (json: unknown) => T): T | null {
  return json === undefined || json === null ? null : decode(json);
}
