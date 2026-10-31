import { addDays, DEFAULT_TIMEZONE, describeDate, isValidZone } from "../game/calendar.ts";
import { formatDuration } from "../game/timer.ts";
import { DEFAULT_LEVELS, MAX_LEVELS, puzzleTitle } from "../generator/generator.ts";
import { generateSeed, normalizeSeed, seedSettings, type SeedSettings } from "../serverless/seed.ts";
import { parseShareLink } from "../serverless/share-link.ts";
import { WEB_VERSION } from "../version.ts";
import { type AdminModel, actionLabel, flavourOf, formatBytes, progressFraction } from "./admin.ts";
import type { AppController, Phase, ServerInfo } from "./controller.ts";
import { type Child, Component, h, topBar } from "./dom.ts";
import { actionButton, canShare, copyText, share, shareResultsButton } from "./share.ts";

/** A screen: a component that renders from the app's state. */
abstract class Screen extends Component {
  app!: AppController;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function describeSettings(settings: SeedSettings): string {
  return `${settings.levels === 1 ? "1 game a day" : `${settings.levels} games a day`}, days in ${settings.timezone}`;
}

const notice = (app: AppController) => app.notice && h("div", { class: "notice" }, app.notice);

/** `<sudoku-loading>` */
export class LoadingScreen extends Screen {
  protected render(): Child {
    return h("p", { class: "boot" }, "Loading…");
  }
}

/** `<sudoku-failed>`: couldn't sign in, or reach the server while signed out. */
export class FailedScreen extends Screen {
  protected render(): Child {
    const phase = this.app.phase as Extract<Phase, { kind: "failed" }>;
    return [
      topBar("Sudoku"),
      h("div", { class: "card center" },
        h("p", { class: "error" }, phase.message),
        h("button", { class: "primary", onclick: () => this.app.reload() }, "Try again"),
      ),
    ];
  }
}

/** `<sudoku-sign-in>`: OIDC sign-in, or the dev auth mode's form. */
export class SignInScreen extends Screen {
  #rendered = false;

  // Rendered once, so typing isn't lost when the app's state changes.
  override update(): void {
    if (!this.#rendered) super.update();
    this.#rendered = true;
  }

  protected render(): Child {
    const app = this.app;
    const phase = app.phase as Extract<Phase, { kind: "sign-in" }>;
    return [
      topBar("Sudoku"),
      phase.config.authMode === "dev"
        ? this.#devForm()
        : h("div", { class: "card center" },
          h("p", null, "Sign in to play today's puzzles and see the leaderboard."),
          h("button", { class: "primary", onclick: () => app.signIn() }, "Sign in"),
        ),
      h("div", { class: "actions" },
        h("button", { class: "link", onclick: () => app.chooseSeed() }, "Play with a seed instead"),
      ),
    ];
  }

  #devForm(): HTMLElement {
    const sub = h("input", { id: "sub", type: "text", autocomplete: "username", autocapitalize: "none" });
    const name = h("input", { id: "name", type: "text" });
    const error = h("p", { class: "error", hidden: true });
    const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
    const onSubmit = async (e: Event) => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.hidden = true;
      try {
        await this.app.signInDev(sub.value.trim(), name.value.trim());
      } catch (err) {
        error.textContent = err instanceof RangeError
          ? "User id can't be empty or contain ':', and a name is required."
          : "Sign-in failed: couldn't reach the server.";
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    };
    return h("div", { class: "card" },
      h("h2", null, "Dev sign-in"),
      h("p", { class: "muted" }, "The server is in dev auth mode. Pick any user id and display name."),
      h("form", { class: "login", onsubmit: onSubmit },
        h("label", { for: "sub" }, "User id"), sub,
        h("label", { for: "name" }, "Display name"), name,
        error, submit,
      ),
    );
  }
}

/** `<sudoku-today>`: the day's games, and either the leaderboard or the seed's sharing options. */
export class TodayScreen extends Screen {
  protected render(): Child {
    const app = this.app;
    const serverless = app.seed !== null;
    const header = [
      topBar("Sudoku", null,
        h("button", { class: "link", onclick: () => app.openAbout() }, "About"),
        serverless
          ? h("button", { class: "link", onclick: () => app.openHistory() }, "History")
          : h("button", { class: "link", onclick: () => void app.signOut() }, "Sign out")),
      app.needsSignIn && h("div", { class: "notice" },
        "Your sign-in has expired. ",
        h("button", { class: "link", onclick: () => app.signIn() }, "Sign in again"),
      ),
      notice(app),
    ];
    const puzzles = app.puzzles;
    if (!puzzles) {
      return [
        header,
        h("div", { class: "card center" },
          h("p", null, "This week's puzzles haven't been downloaded yet."),
          h("p", { class: "muted" }, "Connect to the internet once this week to get them; after that they play offline all week."),
          h("button", { class: "primary", disabled: app.syncing, onclick: () => app.sync() }, app.syncing ? "Checking…" : "Try again"),
        ),
      ];
    }
    const rows = puzzles.map((p) => {
      const status = app.statusOf(p.level);
      let text: string;
      let action: Child = null;
      if (status.kind === "new") {
        text = `${p.givenCount} givens`;
        action = h("button", { class: "primary", onclick: () => app.openPuzzle(p.level) }, "Play");
      } else if (status.kind === "in-progress") {
        text = `In progress · ${formatDuration(status.elapsedMs)}`;
        action = h("button", { class: "primary", onclick: () => app.openPuzzle(p.level) }, "Resume");
      } else {
        text = `Solved in ${formatDuration(status.elapsedMs)}${status.synced ? "" : " · not uploaded yet"}`;
        if (!serverless) action = h("button", { onclick: () => app.openScores(p.level) }, "Scores");
      }
      return h("li", null,
        h("div", null,
          h("div", { class: "name" }, p.title),
          h("div", { class: ["status", status.kind === "done" && "done"] }, text),
        ),
        action,
      );
    });
    return [
      header,
      h("div", { class: "card" },
        h("p", { class: "muted" }, describeDate(app.today), app.me && ` · ${app.me.displayName}`),
        h("ul", { class: "puzzles" }, rows),
      ),
      serverless
        ? [
          h("div", { class: "actions" },
            shareResultsButton(() => app.resultsSummary(), true),
            h("button", { onclick: () => app.openHistory() }, "History"),
          ),
          this.#seedCard(),
        ]
        : h("div", { class: "actions" }, h("button", { onclick: () => app.openScores(0) }, "Leaderboard")),
    ];
  }

  /** The seed's details and ways to bring others in. */
  #seedCard(): Child {
    const app = this.app;
    const profile = app.seed;
    const link = app.shareLink();
    if (!profile || !link) return null;
    // One message line under all the buttons, e.g. "Link copied.".
    const message = h("p", { class: "muted center", hidden: !this.#seedMessage }, this.#seedMessage);
    const show = (text: string) => {
      this.#seedMessage = text;
      message.textContent = text;
      message.hidden = false;
    };
    return h("div", { class: "card" },
      h("h2", null, `Seed ${profile.fingerprint}`),
      h("p", { class: "muted" }, `${describeSettings(profile.settings)}. Anyone with this link plays the same puzzles.`),
      h("input", {
        id: "share-link", class: "share-link", type: "text", value: link, readonly: true, "aria-label": "Share link",
        onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
      }),
      h("div", { class: "actions" },
        h("button", {
          onclick: async () => show((await copyText(link)) ? "Link copied." : "Couldn't copy: select the link above and copy it."),
        }, "Copy link"),
        canShare() && h("button", {
          onclick: () => void share({ title: "Sudoku", text: "Play today's Sudoku with us", url: link }),
        }, "Share…"),
        h("button", {
          onclick: async () => show((await copyText(profile.settings.seed)) ? "Seed copied." : "Couldn't copy the seed."),
        }, "Copy seed"),
        h("button", { class: "link", onclick: () => app.leaveSeed() }, "Leave seed"),
      ),
      message,
    );
  }

  #seedMessage = "";
}

/** `<sudoku-scores>`: the leaderboard for a day, by game and in total. */
export class ScoresScreen extends Screen {
  protected render(): Child {
    const app = this.app;
    if (app.screen.kind !== "scores") return null;
    const { date, tab } = app.screen;
    const board = app.leaderboard?.date === date ? app.leaderboard : null;
    const meId = app.me?.id;
    // That day's game count: from its leaderboard once loaded (a past week may differ).
    const levels = (board?.puzzles.length || app.puzzles?.length) ?? 0;

    const scoreRow = (rank: number, name: string, ms: number, isMe: boolean, suspicious: boolean) =>
      h("tr", { class: [isMe && "me", suspicious && "flagged"] },
        h("td", { class: "rank" }, String(rank)),
        h("td", null, name, suspicious && h("span", { class: "badge suspicious", title: "An admin flagged this result as suspicious" }, "suspicious")),
        h("td", { class: "time" }, formatDuration(ms)),
      );
    let body: Child;
    if (app.leaderboardError !== null) {
      body = h("p", { class: "error" }, app.leaderboardError);
    } else if (!board) {
      body = h("p", { class: "muted" }, "Loading…");
    } else if (tab === 0) {
      body = board.total.entries.length === 0
        ? h("p", { class: "muted" }, `Nobody has finished all ${levels} yet.`)
        : h("table", { class: "board-table" }, h("tbody", null,
          board.total.entries.map((e) => scoreRow(e.rank, e.displayName, e.totalMs, e.userId === meId, e.suspicious))));
    } else {
      const entries = board.puzzles.find((p) => p.level === tab)?.entries ?? [];
      body = entries.length === 0
        ? h("p", { class: "muted" }, "No one has solved this one yet.")
        : h("table", { class: "board-table" }, h("tbody", null,
          entries.map((e) => scoreRow(e.rank, e.displayName, e.elapsedMs, e.userId === meId, e.suspicious))));
    }

    const players = board?.players.slice().sort((a, b) =>
      b.completedLevels.length - a.completedLevels.length || a.displayName.localeCompare(b.displayName)) ?? [];
    return [
      topBar("Leaderboard", () => app.openToday()),
      h("div", { class: "date-nav" },
        h("button", { class: "link", disabled: date <= addDays(app.today, -8), onclick: () => app.shiftScoresDate(-1) }, "‹ Earlier"),
        h("span", null, date === app.today ? "Today" : date),
        h("button", { class: "link", disabled: date >= app.today, onclick: () => app.shiftScoresDate(1) }, "Later ›"),
      ),
      h("div", { class: "tabs" },
        [0, ...range(1, levels)].map((t) =>
          h("button", { class: tab === t && "active", onclick: () => app.showScoresTab(t) }, t === 0 ? "Total" : puzzleTitle(t, levels))),
      ),
      h("div", { class: "card" }, body),
      players.length > 0 && h("div", { class: "card" },
        h("h2", null, "Progress"),
        h("table", { class: "board-table" }, h("tbody", null, players.map((p) =>
          h("tr", { class: p.userId === meId && "me" },
            h("td", null, p.displayName),
            h("td", { class: "time" },
              h("span", { class: "levels" }, range(1, levels).map((l) => h("span", { class: p.completedLevels.includes(l) && "on" }, String(l)))),
              ` ${p.completedLevels.length}/${levels}`,
            ),
          )))),
      ),
    ];
  }
}

/** `<sudoku-history>`: serverless play's history of solve times. */
export class HistoryScreen extends Screen {
  protected render(): Child {
    const app = this.app;
    const history = app.history();
    const byDate = new Map<string, typeof history>();
    for (const r of history) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    return [
      topBar("History", () => app.openToday()),
      history.length === 0
        ? h("div", { class: "card center" }, h("p", { class: "muted" }, "Solved puzzles show up here."))
        : [...byDate].map(([date, results]) => h("div", { class: "card" },
          h("h2", null, date === app.today ? "Today" : describeDate(date)),
          h("table", { class: "board-table" }, h("tbody", null,
            results.map((r) => h("tr", null,
              h("td", null, puzzleTitle(r.level, r.levels)),
              h("td", { class: "time" }, formatDuration(r.elapsedMs)),
            )),
            h("tr", null,
              h("td", null, `Total (${results.length}/${results[0]!.levels})`),
              h("td", { class: "time" }, formatDuration(results.reduce((sum, r) => sum + r.elapsedMs, 0))),
            ),
          )),
        )),
    ];
  }
}

const REPO_URL = "https://github.com/jesserockz/sudoku";

function describeServer(info: ServerInfo): string {
  switch (info.kind) {
    case "none": return "Not connected (playing with a seed)";
    case "loading": return "Checking…";
    case "ok": return info.version ?? "unknown";
    case "unreachable": return "Can't reach the server";
  }
}

/** `<sudoku-about>`: the web client's and the server's versions, and where to find the project. */
export class AboutScreen extends Screen {
  protected render(): Child {
    const app = this.app;
    return [
      topBar("About", () => app.openToday()),
      h("div", { class: "card" },
        h("table", { class: "board-table" }, h("tbody", null,
          h("tr", null, h("td", null, "Web version"), h("td", { class: "time" }, WEB_VERSION)),
          h("tr", null, h("td", null, "Server version"), h("td", { class: "time" }, describeServer(app.serverInfo))),
        )),
      ),
      app.me?.admin && !app.seed && h("div", { class: "actions" },
        h("button", { onclick: () => app.openAdmin() }, "Admin"),
      ),
      h("div", { class: "actions" },
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "GitHub"),
        h("a", { href: `${REPO_URL}/releases`, target: "_blank", rel: "noopener" }, "Releases"),
      ),
    ];
  }
}

/** `<sudoku-admin>`: install a server release or roll back. All behaviour is in {@link AdminModel}. */
export class AdminScreen extends Screen {
  #model: AdminModel | null = null;
  readonly #onChange = () => this.update();

  override connectedCallback(): void {
    this.#model = this.app.admin;
    this.#model?.addEventListener("change", this.#onChange);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.#model?.removeEventListener("change", this.#onChange);
    this.#model?.dispose();
  }

  protected render(): Child {
    const m = this.#model;
    const back = () => this.app.openAbout();
    if (!m) return topBar("Server admin", back);
    const list = m.list;
    return [
      topBar("Server admin", back),
      h("div", { class: "actions" }, h("button", { onclick: () => this.app.openAdminResults() }, "Results and replays")),
      m.loadError && h("div", { class: "notice" }, m.loadError),
      m.error && h("div", { class: "notice" }, m.error),
      list && h("div", { class: "card" },
        h("table", { class: "board-table" }, h("tbody", null,
          h("tr", null, h("td", null, "Server version"), h("td", { class: "time" }, list.current.version)),
          h("tr", null, h("td", null, "Platform"), h("td", { class: "time" }, `${list.current.os}/${list.current.arch}`)),
        )),
        h("p", { class: "muted" }, list.current.updatesWeb
          ? "This updates the server binary and the web client."
          : "This updates the server binary only. The web client is updated separately."),
      ),
      this.#progress(m),
      this.#confirm(m),
      list && !m.confirm && h("div", { class: "card" },
        h("h2", null, "Releases"),
        h("label", { class: "check" },
          h("input", { type: "checkbox", checked: m.includePrereleases, disabled: m.working || m.loading, onchange: (e: Event) => void m.setIncludePrereleases((e.target as HTMLInputElement).checked) }),
          " Show prereleases"),
        list.releases.length === 0 && h("p", { class: "muted" }, "No releases found."),
        h("ul", { class: "releases" }, list.releases.map((r) => h("li", null,
          h("div", { class: "release-info" },
            h("span", { class: "name" }, r.tag),
            r.latest && h("span", { class: "badge" }, "Latest"),
            r.current && h("span", { class: "badge current" }, "Current"),
            r.prerelease && h("span", { class: "badge" }, "Prerelease"),
            r.publishedAt && h("div", { class: "muted small" }, r.publishedAt.slice(0, 10)),
            !r.installable && h("div", { class: "muted small" }, r.notInstallableReason || "Not installable"),
          ),
          r.installable && h("button", { class: flavourOf(r) === "update" && "primary", disabled: m.working, onclick: () => m.choose(r.tag) }, actionLabel(r)),
        ))),
      ),
      m.canRollback && !m.confirm && h("div", { class: "actions" },
        h("button", { onclick: () => m.chooseRollback() }, "Roll back to previous binary"),
      ),
      m.loading && !list && h("p", { class: "boot" }, "Loading…"),
    ];
  }

  #progress(m: AdminModel): Child {
    const p = m.progress;
    switch (p.kind) {
      case "none": return null;
      case "running": {
        const fraction = progressFraction(p.status);
        return h("div", { class: "card" },
          h("p", null, p.status.message || p.status.state),
          h("progress", { max: 1, ...(fraction === null ? {} : { value: fraction }) }),
          p.status.bytesTotal > 0 && h("p", { class: "muted small" }, `${formatBytes(p.status.bytesDone)} of ${formatBytes(p.status.bytesTotal)}`),
        );
      }
      case "restarting":
        return h("div", { class: "card" },
          h("p", null, `Restarting the server${p.target ? ` on ${p.target}` : ""}…`),
          h("progress", { max: 1 }),
          h("p", { class: "muted small" }, "This can take a minute. Don't close this page."),
        );
      case "done": return h("div", { class: "card" }, h("p", null, p.message));
      case "failed": return h("div", { class: "notice" }, p.message);
    }
  }

  #confirm(m: AdminModel): Child {
    const c = m.confirm;
    if (!c) return null;
    const buttons = (label: string) => h("div", { class: "actions" },
      h("button", { class: "primary", disabled: m.busy, onclick: () => void m.confirmAction() }, label),
      h("button", { disabled: m.busy, onclick: () => m.cancel() }, "Cancel"),
    );
    if (c.kind === "rollback") {
      return h("div", { class: "card" },
        h("h2", null, "Roll back?"),
        h("p", null, `The server will swap the previous binary ${m.list?.current.updatesWeb ? "and web client " : ""}back in and restart. Sudoku is unavailable for a moment.`),
        buttons("Roll back"),
      );
    }
    const warning = {
      update: null,
      reinstall: "This is the version already running. It will be downloaded and installed again.",
      downgrade: "This is an older version than the one running. Downgrading can break things if the database has changed. Only continue if you are sure.",
      unknown: "This version can't be compared with the running one, so it may be older. Only continue if you are sure.",
    }[c.flavour];
    return h("div", { class: "card" },
      h("h2", null, actionLabel(c.release)),
      h("p", null, "The server will download it, check its checksum, install it and restart. Sudoku is unavailable for a moment."),
      warning && h("p", { class: "error" }, warning),
      buttons(actionLabel(c.release)),
    );
  }
}

/** `<sudoku-seed-setup>`: enter, paste or generate a seed, and the settings the group shares. */
export class SeedSetupScreen extends Screen {
  readonly #notice = h("div");

  // The form is rendered once, so typing isn't lost when the app's state changes.
  override update(): void {
    if (!this.firstChild) super.update();
    this.#notice.replaceChildren(notice(this.app) || "");
  }

  protected render(): Child {
    const app = this.app;
    const server = app.phase.kind === "seed-setup" ? app.phase.server : null;
    const seed = h("input", { id: "seed", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
    const levels = h("select", { id: "levels" },
      range(1, MAX_LEVELS).map((n) => h("option", { value: n, selected: n === DEFAULT_LEVELS }, String(n))));
    const tz = h("input", { id: "tz", type: "text", autocapitalize: "none", value: DEFAULT_TIMEZONE });
    const error = h("p", { class: "error", hidden: true }, "Enter a seed (or a share link), and a timezone like Pacific/Auckland.");
    const onSubmit = (e: Event) => {
      e.preventDefault();
      const settings = settingsFrom(seed.value, Number(levels.value), tz.value);
      error.hidden = settings !== null;
      if (settings) app.useSeed(settings);
    };
    return [
      topBar("Sudoku", server ? () => app.cancelSeed() : null),
      this.#notice,
      h("div", { class: "card" },
        h("h2", null, "Play with a seed"),
        !server && h("p", { class: "muted" }, "There's no Sudoku server here, so play with a seed instead."),
        h("p", { class: "muted" },
          "Everyone who enters the same seed gets the same puzzles each day. Make one up, generate one, or paste a link someone shared."),
        h("form", { class: "login", onsubmit: onSubmit },
          h("label", { for: "seed" }, "Seed or share link"),
          h("div", { class: "inline" },
            seed,
            h("button", { type: "button", onclick: () => { seed.value = generateSeed(); } }, "Generate"),
          ),
          h("label", { for: "levels" }, "Games per day"), levels,
          h("label", { for: "tz" }, "Day starts at midnight in"), tz,
          h("p", { class: "muted" }, "Everyone in the group needs the same seed, games per day and timezone: share a link to be sure."),
          error,
          h("button", { class: "primary", type: "submit" }, "Start playing"),
        ),
        !server && h("div", { class: "actions" },
          h("button", { class: "link", onclick: () => app.reload() }, "Look for a server again"),
        ),
      ),
    ];
  }
}

/** A pasted share link wins over the form; otherwise the typed seed with the chosen settings. */
function settingsFrom(text: string, levels: number, timezone: string): SeedSettings | null {
  const link = parseShareLink(text);
  if (link) return link;
  const seed = normalizeSeed(text);
  const zone = timezone.trim() || DEFAULT_TIMEZONE;
  if (seed === "" || !isValidZone(zone)) return null;
  return seedSettings(seed, levels, zone);
}

/** `<sudoku-confirm-seed>`: a share link was opened while another seed (or a server sign-in) is in use. */
export class ConfirmSeedScreen extends Screen {
  protected render(): Child {
    const app = this.app;
    if (app.phase.kind !== "confirm-seed") return null;
    const { incoming, incomingFingerprint, current } = app.phase;
    return [
      topBar("Sudoku"),
      h("div", { class: "card center" },
        h("h2", null, "Switch to this seed?"),
        h("p", null, `The link plays seed ${incomingFingerprint} · ${describeSettings(incoming)}.`),
        h("p", { class: "muted" }, current
          ? `You're playing seed ${current.fingerprint} now. Its games and times are kept if you switch.`
          : "You're signed in to this server. You can come back to it later with \"Leave seed\"."),
        h("div", { class: "actions" },
          h("button", { class: "primary", onclick: () => app.useSeed(incoming) }, "Switch"),
          h("button", { onclick: () => app.cancelSeed() }, current ? "Keep current seed" : "Stay signed in"),
        ),
      ),
    ];
  }
}

customElements.define("sudoku-loading", LoadingScreen);
customElements.define("sudoku-failed", FailedScreen);
customElements.define("sudoku-sign-in", SignInScreen);
customElements.define("sudoku-today", TodayScreen);
customElements.define("sudoku-scores", ScoresScreen);
customElements.define("sudoku-history", HistoryScreen);
customElements.define("sudoku-about", AboutScreen);
customElements.define("sudoku-admin", AdminScreen);
customElements.define("sudoku-seed-setup", SeedSetupScreen);
customElements.define("sudoku-confirm-seed", ConfirmSeedScreen);
