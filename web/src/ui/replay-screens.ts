import type { AdminResult, ReplayStatus } from "../api/models.ts";
import { CELLS, colOf, rowOf } from "../core/geometry.ts";
import { formatDuration } from "../game/timer.ts";
import { puzzleTitle } from "../generator/generator.ts";
import type { AdminResultsModel } from "./admin-results.ts";
import type { AppController } from "./controller.ts";
import { type Child, Component, h, topBar } from "./dom.ts";
import { MIN_STRETCH_MS, SPEEDS, type ReplayViewer, formatGap, formatWall } from "./replay-viewer.ts";

interface Controls {
  viewer: ReplayViewer;
  reveal: HTMLInputElement;
  scrub: HTMLInputElement;
  prev: HTMLButtonElement;
  play: HTMLButtonElement;
  next: HTMLButtonElement;
  speeds: HTMLButtonElement[];
}

abstract class AdminResultsScreenBase extends Component {
  app!: AppController;
  protected model: AdminResultsModel | null = null;
  readonly #onChange = () => this.update();

  override connectedCallback(): void {
    this.model = this.app.adminResults;
    this.model?.addEventListener("change", this.#onChange);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.model?.removeEventListener("change", this.#onChange);
  }
}

const REPLAY_LABELS: Record<ReplayStatus, string> = {
  valid: "Replay OK", invalid: "Replay failed", missing: "No replay", none: "Before replays",
};

function statusBadges(r: AdminResult): Child {
  return [
    h("span", { class: ["badge", r.replay === "valid" && "current", r.replay === "invalid" && "warn"] }, REPLAY_LABELS[r.replay]),
    r.flag && h("span", { class: "badge suspicious" }, r.flag.auto ? "Suspicious (auto)" : "Suspicious"),
  ];
}

/** `<sudoku-admin-results>`: a day's results by game, each opening its replay. Behaviour is in {@link AdminResultsModel}. */
export class AdminResultsScreen extends AdminResultsScreenBase {
  protected render(): Child {
    const back = () => this.app.openAdmin();
    const m = this.model;
    if (!m) return topBar("Results", back);
    const levels = m.data?.levels ?? 0;
    return [
      topBar("Results", back),
      h("div", { class: "date-nav" },
        h("button", { class: "link", disabled: m.loading, onclick: () => void m.shiftDate(-1) }, "‹ Earlier"),
        h("span", null, m.date === m.today ? "Today" : m.date),
        h("button", { class: "link", disabled: m.loading || m.date >= m.today, onclick: () => void m.shiftDate(1) }, "Later ›"),
      ),
      m.loadError && h("div", { class: "notice" }, m.loadError),
      m.loading && h("p", { class: "boot" }, "Loading…"),
      Array.from({ length: levels }, (_, i) => i + 1).map((level) => {
        const results = m.resultsFor(level);
        return h("div", { class: "card" },
          h("h2", null, puzzleTitle(level, levels)),
          results.length === 0
            ? h("p", { class: "muted" }, "No results.")
            : h("table", { class: "board-table results-table" }, h("tbody", null, results.map((r) =>
              h("tr", { class: "clickable", onclick: () => this.app.openReplay(r) },
                h("td", null, r.displayName, h("div", { class: "small" }, statusBadges(r))),
                h("td", { class: "time" }, formatDuration(r.elapsedMs)),
              )))),
        );
      }),
    ];
  }
}

/**
 * `<sudoku-replay>`: watches one result's replay. Digits are hidden until the
 * admin ticks the reveal box, which starts unticked in every new viewer.
 */
export class ReplayScreen extends AdminResultsScreenBase {
  #frame = 0;
  #last = 0;
  #reason = "";
  /**
   * The playback controls, made once per viewer and reused by every render,
   * so a click or a drag isn't lost when playback re-renders the screen.
   */
  #controls: Controls | null = null;

  override disconnectedCallback(): void {
    cancelAnimationFrame(this.#frame);
    super.disconnectedCallback();
  }

  override update(): void {
    // Keep a half-typed flag reason across re-renders.
    const input = this.querySelector<HTMLInputElement>("input.flag-reason");
    if (input) this.#reason = input.value;
    super.update();
    if (this.model?.viewer?.playing && !this.#frame) {
      this.#last = performance.now();
      this.#frame = requestAnimationFrame(this.#tick);
    }
  }

  readonly #tick = (now: number): void => {
    this.#frame = 0;
    const viewer = this.model?.viewer;
    if (!viewer?.playing) return;
    const elapsed = now - this.#last;
    this.#last = now;
    viewer.tick(elapsed);
    // The viewer only reports a change when something visible changed, so keep going regardless.
    if (viewer.playing && !this.#frame) this.#frame = requestAnimationFrame(this.#tick);
  };

  #controlsFor(v: ReplayViewer): Controls {
    if (this.#controls?.viewer === v) return this.#controls;
    const button = (label: string, onclick: () => void, props: Record<string, unknown> = {}) =>
      h("button", { ...props, onclick }, label) as HTMLButtonElement;
    this.#controls = {
      viewer: v,
      reveal: h("input", { type: "checkbox", onchange: (e: Event) => v.setRevealDigits((e.target as HTMLInputElement).checked) }),
      scrub: h("input", {
        class: "scrub", type: "range", min: 0, step: 100, "aria-label": "Position",
        oninput: (e: Event) => v.seek(Number((e.target as HTMLInputElement).value)),
      }),
      prev: button("‹ Prev", () => v.previous(), { "aria-label": "Previous action" }),
      play: button("Play", () => (v.playing ? v.pause() : v.play()), { class: "primary" }),
      next: button("Next ›", () => v.next(), { "aria-label": "Next action" }),
      speeds: SPEEDS.map((s) => button(`${s}x`, () => v.setSpeed(s))),
    };
    return this.#controls;
  }

  protected render(): Child {
    const back = () => this.app.openAdminResults();
    const m = this.model;
    const v = m?.viewer;
    if (!m || !v) {
      return [
        topBar("Replay", back),
        m?.viewerError ? h("div", { class: "notice" }, m.viewerError) : h("p", { class: "boot" }, "Loading…"),
      ];
    }
    const d = v.detail;
    const result = m.find(d) ?? d;
    return [
      topBar("Replay", back),
      m.error && h("div", { class: "notice" }, m.error),
      h("div", { class: "card" },
        h("h2", null, `${d.displayName}, ${puzzleTitle(d.level, d.levels)} on ${d.date}`),
        h("p", null, `Time ${formatDuration(d.elapsedMs)}. `, statusBadges(result)),
        d.replayError && h("p", { class: "error small" }, d.replayError),
        this.#flag(m, result),
      ),
      v.length === 0
        ? h("div", { class: "card" }, h("p", { class: "muted" }, "There is no replay for this result."))
        : [this.#player(v), this.#insights(v), this.#events(v)],
    ];
  }

  #flag(m: AdminResultsModel, r: AdminResult): Child {
    const flag = r.flag;
    if (flag) {
      return h("div", { class: "flag" },
        h("p", { class: "small" },
          `Flagged ${flag.auto ? "by the server" : `by ${flag.flaggedBy?.displayName ?? "an admin"}`} at ${flag.flaggedAt}`,
          flag.reason && `: ${flag.reason}`),
        h("button", { disabled: m.busy, onclick: () => void m.unflag(r) }, "Remove flag"),
      );
    }
    return h("div", { class: "flag inline" },
      h("input", { class: "flag-reason", type: "text", maxlength: 500, placeholder: "Reason (optional)", value: this.#reason }),
      h("button", {
        class: "danger", disabled: m.busy,
        onclick: () => {
          const reason = this.querySelector<HTMLInputElement>("input.flag-reason")?.value ?? "";
          this.#reason = "";
          void m.flag(r, reason);
        },
      }, "Flag as suspicious"),
    );
  }

  #player(v: ReplayViewer): Child {
    const game = v.game;
    const changed = v.changedCell;
    const cells: HTMLElement[] = [];
    for (let i = 0; i < CELLS; i++) {
      const view = v.cell(i);
      cells.push(h("div", {
        class: ["cell", `r${rowOf(i)}`, `c${colOf(i)}`, view.kind === "given" && "given", view.kind === "notes" && "note-text", i === changed && "changed"],
        "data-index": i,
      }, view.text));
    }
    const current = v.current;
    const gap = v.index > 0 ? v.analysis.gaps[v.index - 1]! : 0;
    const c = this.#controlsFor(v);
    c.reveal.checked = v.revealDigits;
    c.scrub.max = String(v.endMs);
    c.scrub.value = String(v.cursorMs);
    c.prev.disabled = v.index === 0;
    c.next.disabled = v.index >= v.length;
    c.play.textContent = v.playing ? "Pause" : "Play";
    SPEEDS.forEach((s, i) => c.speeds[i]!.classList.toggle("active", v.speed === s));
    return h("div", { class: "card replay-player" },
      h("label", { class: "check reveal" }, c.reveal, " Reveal digits (shows the solution)"),
      h("div", { class: "replay-board" }, h("div", { class: ["board", game.isComplete && "solved"] }, cells)),
      h("div", { class: "clocks" },
        h("span", null, h("span", { class: "muted" }, "Timer "), formatDuration(v.cursorMs), " / ", formatDuration(v.endMs)),
        h("span", null, h("span", { class: "muted" }, "Wall "), current ? formatWall(current.w) : "-"),
      ),
      h("p", { class: "now" },
        v.index === 0 ? "Start" : `${v.index}/${v.length}: ${v.describe(v.index - 1)}`,
        v.index > 0 && h("span", { class: "muted" }, ` (+${formatGap(gap)})`)),
      c.scrub,
      h("div", { class: "replay-controls" }, c.prev, c.play, c.next),
      h("div", { class: "tabs speeds" }, c.speeds),
    );
  }

  #insights(v: ReplayViewer): Child {
    const a = v.analysis;
    const row = (label: string, value: string, warn = false) =>
      h("tr", { class: warn && "warn" }, h("td", null, label), h("td", { class: "time" }, value));
    const running = Math.max(0, a.wallSpanMs - a.pausedMs);
    return h("div", { class: "card" },
      h("h2", null, "Timing"),
      h("table", { class: "board-table" }, h("tbody", null,
        row("Timer", formatGap(a.timerMs)),
        row("Wall clock, start to finish", formatGap(a.wallSpanMs)),
        row("Wall clock with the timer running", formatGap(running), running + 2000 < a.timerMs),
        row("Paused or closed", formatGap(a.pausedMs), a.pausedMs >= MIN_STRETCH_MS),
        row("App hidden", formatGap(a.hiddenMs), a.hiddenMs >= MIN_STRETCH_MS),
        row("Long gaps between moves", String(a.longGaps.size), a.longGaps.size > 0),
        a.pace
          ? row("Entry pace", `median ${formatGap(a.pace.medianMs)}, varies ${Math.round(a.pace.variation * 100)}%`, a.pace.steady)
          : row("Entry pace", "too few placements"),
      )),
      a.pace?.steady && h("p", { class: "error small" }, "Placements came at a steady, machine-like pace."),
    );
  }

  #events(v: ReplayViewer): Child {
    const a = v.analysis;
    return h("div", { class: "card" },
      h("h2", null, "Actions"),
      h("table", { class: "board-table replay-events" }, h("tbody", null, v.events.map((e, k) => {
        const stretch = v.stretchAt(k);
        const long = a.longGaps.has(k);
        return h("tr", {
          class: ["clickable", k === v.index - 1 && "current", long && "long", stretch && `stretch-${stretch.kind}`],
          onclick: () => v.goTo(k + 1),
        },
        h("td", { class: "rank" }, formatDuration(e.t)),
        h("td", null, v.describe(k),
          long && h("div", { class: "small error" }, `Long gap: ${formatGap(a.gaps[k]!)} on the timer`),
          stretch && stretch.to === k && h("div", { class: "small warn-text" },
            `${stretch.kind === "hidden" ? "Hidden" : "Paused"} for ${formatGap(stretch.wallMs)} of wall clock`)),
        h("td", { class: "time small" }, formatWall(e.w), h("div", { class: "muted" }, `+${formatGap(a.wallGaps[k]!)}`)),
        );
      }))),
    );
  }
}

customElements.define("sudoku-admin-results", AdminResultsScreen);
customElements.define("sudoku-replay", ReplayScreen);
