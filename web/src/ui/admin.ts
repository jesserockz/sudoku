// The Admin page's logic, free of the DOM: lists the server's releases, installs or rolls back one
// after a confirmation, follows the progress and waits for the restarted server to report the new version.
import { ApiException } from "../api/client.ts";
import type { Release, ReleaseList, UpdateStatus } from "../api/models.ts";

/** The parts of {@link SudokuApi} the admin page uses. */
export interface AdminApi {
  adminReleases(includePrereleases: boolean): Promise<ReleaseList>;
  adminUpdateStatus(): Promise<UpdateStatus>;
  startUpdate(tag: string, allowDowngrade: boolean): Promise<UpdateStatus>;
  rollback(): Promise<UpdateStatus>;
}

/** What the page needs from outside; tests supply their own clock and sleep. */
export interface AdminHost {
  /** The server's version from `GET /api/v1/config` (unauthenticated: the server is restarting), or `null` if it reports none. Rejects while unreachable. */
  serverVersion(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, monotonic enough for the restart timeout. */
  now(): number;
}

export const POLL_MS = 1000;
export const RESTART_TIMEOUT_MS = 2 * 60 * 1000;

/** How installing a release differs from the running version; all but `update` need the extra confirmation. */
export type Flavour = "update" | "reinstall" | "downgrade" | "unknown";

export type Confirm =
  | { kind: "update"; release: Release; flavour: Flavour }
  | { kind: "rollback" };

export type Progress =
  | { kind: "none" }
  /** The server is downloading, verifying or installing. */
  | { kind: "running"; status: UpdateStatus }
  /** The server says it is restarting (or already has): waiting for it to report the new version. */
  | { kind: "restarting"; action: "update" | "rollback"; target: string }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

const RUNNING = new Set(["downloading", "verifying", "installing"]);

export function flavourOf(release: Release): Flavour {
  switch (release.comparison) {
    case "newer": return "update";
    case "same": return "reinstall";
    case "older": return "downgrade";
    case "unknown": return "unknown";
  }
}

/** The verb on a release's button, e.g. "Update to v0.3.0". */
export function actionLabel(release: Release): string {
  switch (flavourOf(release)) {
    case "update": return `Update to ${release.tag}`;
    case "reinstall": return `Reinstall ${release.tag}`;
    case "downgrade": return `Downgrade to ${release.tag}`;
    case "unknown": return `Install ${release.tag}`;
  }
}

/** Fraction done in `0..1`, or `null` when the total is unknown. */
export function progressFraction(status: UpdateStatus): number | null {
  return status.bytesTotal > 0 ? Math.min(1, status.bytesDone / status.bytesTotal) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A readable message for a failed admin request. */
export function describeError(e: unknown): string {
  if (e instanceof ApiException) {
    if (e.status === 403) return "Your account isn't an admin";
    if (e.status === 401) return "Your session has expired. Sign in again.";
    return e.error?.message || `The server answered with an error (HTTP ${e.status}).`;
  }
  return "Couldn't reach the server. Check your connection and try again.";
}

/** The server is restarting, so not answering (or a proxy in front of it isn't): worth waiting out. */
function unreachable(e: unknown): boolean {
  return !(e instanceof ApiException) || e.status >= 500;
}

const bare = (version: string) => version.replace(/^v/, "");

/**
 * State and actions of the Admin page. Fires `change` whenever anything
 * does; the screen renders from the fields. Call {@link dispose} when the
 * screen goes away, which stops any polling.
 */
export class AdminModel extends EventTarget {
  list: ReleaseList | null = null;
  /** Loading the release list failed (the message), or `null`. */
  loadError: string | null = null;
  loading = false;
  includePrereleases = false;
  confirm: Confirm | null = null;
  /** A request is in flight (starting an update); buttons are disabled. */
  busy = false;
  /** Why the last request (choosing, starting) failed, or `null`. */
  error: string | null = null;
  progress: Progress = { kind: "none" };

  readonly #api: AdminApi;
  readonly #host: AdminHost;
  /** Bumped on dispose and when a new job starts, so stale loops stop. */
  #generation = 0;

  constructor(api: AdminApi, host: AdminHost) {
    super();
    this.#api = api;
    this.#host = host;
  }

  /** Update or rollback is in progress, so the page can't start another. */
  get working(): boolean {
    return this.busy || this.progress.kind === "running" || this.progress.kind === "restarting";
  }

  /** The server has a previous binary to go back to (and nothing is running). */
  get canRollback(): boolean {
    return !this.working && (this.list?.update.rollbackAvailable ?? false);
  }

  dispose(): void {
    this.#generation++;
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  /** Loads the releases, and picks up an update that is already under way (e.g. the page was reopened). */
  async load(): Promise<void> {
    await this.#fetchList();
    const update = this.list?.update;
    if (!update || this.progress.kind !== "none") return;
    if (RUNNING.has(update.state) || update.state === "restarting") {
      void this.#track(update, this.list!.current.version);
    } else if (update.state === "failed") {
      this.progress = { kind: "failed", message: update.error || update.message || "The last update failed." };
      this.#changed();
    }
  }

  async #fetchList(): Promise<void> {
    this.loading = true;
    this.#changed();
    try {
      this.list = await this.#api.adminReleases(this.includePrereleases);
      this.loadError = null;
    } catch (e) {
      this.loadError = describeError(e);
    }
    this.loading = false;
    this.#changed();
  }

  async setIncludePrereleases(include: boolean): Promise<void> {
    if (include === this.includePrereleases) return;
    this.includePrereleases = include;
    this.confirm = null;
    await this.#fetchList();
  }

  /** Asks for confirmation to install `tag`. Ignored for unknown or non-installable releases, or while working. */
  choose(tag: string): void {
    const release = this.list?.releases.find((r) => r.tag === tag);
    if (this.working || !release?.installable) return;
    this.error = null;
    this.confirm = { kind: "update", release, flavour: flavourOf(release) };
    this.#changed();
  }

  chooseRollback(): void {
    if (!this.canRollback) return;
    this.error = null;
    this.confirm = { kind: "rollback" };
    this.#changed();
  }

  cancel(): void {
    this.confirm = null;
    this.#changed();
  }

  /** Does what was asked for in the confirmation. `allowDowngrade` is sent only for a reinstall or downgrade. */
  async confirmAction(): Promise<void> {
    const confirm = this.confirm;
    if (!confirm || this.working) return;
    this.busy = true;
    this.error = null;
    this.#changed();
    let status: UpdateStatus;
    try {
      status = confirm.kind === "rollback"
        ? await this.#api.rollback()
        : await this.#api.startUpdate(confirm.release.tag, confirm.flavour !== "update");
    } catch (e) {
      this.busy = false;
      this.confirm = null;
      this.error = describeError(e);
      this.#changed();
      return;
    }
    this.busy = false;
    this.confirm = null;
    await this.#track(status, this.list!.current.version);
  }

  /** Follows a job from its first status to the end, then refreshes the release list. */
  async #track(first: UpdateStatus, before: string): Promise<void> {
    const generation = ++this.#generation;
    const live = () => generation === this.#generation;
    let status = first;
    let restarted = false;
    while (RUNNING.has(status.state)) {
      this.progress = { kind: "running", status };
      this.#changed();
      await this.#host.sleep(POLL_MS);
      if (!live()) return;
      try {
        status = await this.#api.adminUpdateStatus();
      } catch (e) {
        if (!unreachable(e)) return this.#finish(false, describeError(e));
        restarted = true; // The server went away before saying so: it has begun restarting.
        break;
      }
      if (!live()) return;
    }
    if (status.state === "failed") return this.#finish(false, status.error || status.message || "The update failed.");
    // A new process starts out idle.
    const action = status.action || first.action || "update";
    if (status.state === "idle") restarted = true;
    const target = bare(status.target || first.target);
    this.progress = { kind: "restarting", action, target };
    this.#changed();
    await this.#awaitRestart(target, before, action === "rollback" ? "Rolled back to" : "Updated to", restarted, live);
  }

  /**
   * Polls the server until it reports `target` (or, when the target is unknown, any version but
   * `before`), giving up after {@link RESTART_TIMEOUT_MS}. Reinstalling reports the same version
   * as before, so there the restart itself must also have been seen: a failed request, or a
   * status that has gone back to idle.
   */
  async #awaitRestart(target: string, before: string, verb: string, seen: boolean, live: () => boolean): Promise<void> {
    const deadline = this.#host.now() + RESTART_TIMEOUT_MS;
    let restarted = seen;
    while (this.#host.now() < deadline) {
      await this.#host.sleep(POLL_MS);
      if (!live()) return;
      let version: string | null;
      try {
        version = await this.#host.serverVersion();
      } catch {
        restarted = true;
        continue;
      }
      if (!live()) return;
      const reached = target ? version !== null && bare(version) === target : version !== null && bare(version) !== bare(before);
      if (!reached) continue;
      const changed = bare(version!) !== bare(before);
      if (!changed && !restarted) {
        try {
          restarted = (await this.#api.adminUpdateStatus()).state === "idle";
        } catch {
          restarted = true;
        }
        if (!live()) return;
        if (!restarted) continue;
      }
      return this.#finish(true, `${verb} ${bare(version!)}`);
    }
    await this.#finish(false, `The server didn't report ${target ? `version ${target}` : "a new version"} within 2 minutes. Check the service logs on the server.`);
  }

  async #finish(ok: boolean, message: string): Promise<void> {
    this.progress = ok ? { kind: "done", message } : { kind: "failed", message };
    this.#changed();
    if (ok) await this.#fetchList();
  }
}
