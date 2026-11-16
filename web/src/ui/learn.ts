// The Learn tab's lesson list and the lesson screen. Only drawing and event
// wiring live here: what to draw comes from learn-view.ts, and what each tap
// does from learn-session.ts.
import { LESSONS, LEVELS, type Lesson, isGraded, lessonById, levelOf, nextLesson } from "../learn/lessons.ts";
import "./board.ts";
import type { SudokuKeypad } from "./board.ts";
import { layoutClass } from "./cell-view.ts";
import type { AppController } from "./controller.ts";
import { type Child, Component, h, topBar } from "./dom.ts";
import { LessonSession, type Stage } from "./learn-session.ts";
import { type BoardView, cellModels, digitCounts, keyCommand, learnSummary, lessonRows } from "./learn-view.ts";

const STAGE_NAMES: Record<Stage, string> = { learn: "Learn", practice: "Practice", puzzle: "Full puzzle" };

/** How long the worked example stays on a step when it plays by itself. */
const AUTOPLAY_MS = 3500;

/** The Learn tab of the home page: every lesson, by level, with how far the player has got. */
export function lessonList(app: AppController): Child {
  return [
    h("div", { class: "card", id: "learn-intro" },
      h("h2", null, "Learn to solve without guessing"),
      h("p", { class: "muted" }, learnSummary(app.learn))),
    LEVELS.map((level) => h("div", { class: "card learn-level" },
      h("h2", null, level.name),
      h("p", { class: "muted small" }, level.blurb),
      h("ul", { class: "puzzles" }, lessonRows(level, app.learn).map((row) => h("li", { "data-lesson": row.lesson.id },
        h("div", null,
          h("div", { class: "name" }, row.lesson.title),
          h("div", { class: ["status", row.status === "mastered" && "done", (row.status === "seen" || row.status === "practised") && "in-progress"] }, row.statusText)),
        h("button", {
          class: row.status !== "mastered" && "primary", "aria-label": `${row.action} ${row.lesson.title}`,
          onclick: () => app.openLesson(row.lesson.id),
        }, row.action)))))),
  ];
}

/** A board that shows a {@link BoardView}; `onSelect` makes its cells tappable. */
function boardElement(view: BoardView, onSelect: ((cell: number) => void) | null): HTMLElement {
  return h("div", { class: "learn-board" },
    h("div", { class: ["board", layoutClass(view.layout), !onSelect && "static"], role: "grid", "aria-label": "Sudoku board" },
      cellModels(view).map((cell, i) => h("div", {
        class: ["cell", `r${Math.floor(i / 9)}`, `c${i % 9}`, ...cell.classes], role: "gridcell", "aria-label": cell.label, "data-index": i,
        "aria-selected": onSelect ? String(i === view.selected) : undefined,
        onclick: onSelect ? () => onSelect(i) : undefined,
      },
      cell.sum !== undefined && h("span", { class: "cage-sum", "aria-hidden": "true" }, String(cell.sum)),
      cell.notes
        ? h("div", { class: "notes" }, cell.notes.map((n) => h("span", { class: n.kind || undefined }, n.text)))
        : cell.text))));
}

/** `<sudoku-learn>`: one lesson, as an explanation with a worked example, practice positions and a whole puzzle. */
export class LearnScreen extends Component {
  app!: AppController;
  lesson = "";
  #session: LessonSession | null = null;
  #autoplay = 0;

  readonly #onKey = (e: KeyboardEvent): void => {
    const session = this.#session;
    const target = e.target as HTMLElement | null;
    if (!session || this.app.help || target?.closest?.("input, select, textarea")) return;
    const command = keyCommand(e);
    if (!command) return;
    if (session.stage === "learn") {
      if (command.kind !== "move" || command.col === 0) return;
      this.#stop();
      session.showFrame(session.frame + command.col);
    } else if (command.kind === "digit") session.digit(command.digit);
    else if (command.kind === "move") session.move(command.row, command.col);
    else if (command.kind === "mode") session.switchMode();
    else if (command.kind === "candidates") session.toggleCandidates();
    else if (command.kind === "hint") session.hint();
    else session.select(session.selected);
    e.preventDefault();
    this.update();
  };

  override connectedCallback(): void {
    const lesson = lessonById(this.lesson);
    if (lesson) this.#session = new LessonSession(lesson, this.app.learn);
    window.addEventListener("keydown", this.#onKey);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.#onKey);
    this.#stop();
  }

  /** Re-renders, keeping the keyboard focus on the control it was on. */
  override update(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
    super.update();
    if (focused) this.querySelector<HTMLElement>(`[data-k="${focused}"]`)?.focus();
  }

  #stop(): void {
    clearInterval(this.#autoplay);
    this.#autoplay = 0;
  }

  #play(session: LessonSession): void {
    if (this.#autoplay) {
      this.#stop();
    } else {
      if (session.frame >= session.frames.length - 1) session.showFrame(0);
      this.#autoplay = window.setInterval(() => {
        session.showFrame(session.frame + 1);
        if (session.frame >= session.frames.length - 1) this.#stop();
        this.update();
      }, AUTOPLAY_MS);
    }
    this.update();
  }

  /** Does `action` on the session, then draws the result. */
  #act(action: () => void): () => void {
    return () => {
      this.#stop();
      action();
      this.update();
    };
  }

  protected render(): Child {
    const app = this.app;
    const session = this.#session;
    if (!session) return [topBar("Learn", () => app.openLearn()), h("div", { class: "card center" }, h("p", null, "That lesson doesn't exist."))];
    const lesson = session.lesson;
    return [
      topBar(lesson.title, () => app.openLearn()),
      h("div", { class: "tabs home-tabs", role: "tablist" }, session.stages.map((stage) => h("button", {
        role: "tab", class: session.stage === stage && "active", "aria-selected": String(session.stage === stage), "data-k": `stage-${stage}`,
        onclick: this.#act(() => session.show(stage)),
      }, STAGE_NAMES[stage]))),
      session.stage === "learn" ? this.#explain(session, lesson) : this.#exercise(session, lesson),
    ];
  }

  /** The explanation and its worked example. */
  #explain(session: LessonSession, lesson: Lesson): Child {
    const frame = session.frames[session.frame];
    const view = session.board;
    const last = session.frame >= session.frames.length - 1;
    return [
      h("div", { class: "card learn-text" },
        h("p", { class: "muted small" }, `${levelOf(lesson).name} · lesson ${LESSONS.indexOf(lesson) + 1} of ${LESSONS.length}`),
        lesson.intro.map((text) => h("p", null, text)),
        h("h2", null, "How to spot it"),
        h("ul", null, lesson.spot.map((text) => h("li", null, text))),
        !isGraded(lesson) && h("p", { class: "muted small" }, "The Graded puzzles don't use this one when they rate a puzzle, but it solves real ones all the same.")),
      frame && view && h("div", { class: "card learn-demo" },
        h("h2", null, "Worked example"),
        boardElement(view, null),
        h("p", { class: "learn-step", role: "status" }, frame.text),
        h("div", { class: "actions learn-steps" },
          h("button", { disabled: session.frame === 0, "data-k": "frame-back", onclick: this.#act(() => session.showFrame(session.frame - 1)) }, "Back"),
          h("span", { class: "muted" }, `Step ${session.frame + 1} of ${session.frames.length}`),
          h("button", { class: !last && "primary", disabled: last, "data-k": "frame-next", onclick: this.#act(() => session.showFrame(session.frame + 1)) }, "Next"),
          h("button", { "data-k": "frame-play", "aria-pressed": String(this.#autoplay !== 0), onclick: () => this.#play(session) }, this.#autoplay ? "Pause" : "Play"))),
      h("div", { class: "actions" },
        h("button", { class: "primary", "data-k": "start-practice", onclick: this.#act(() => session.show("practice")) }, "Start practice")),
    ];
  }

  /** A practice position or the whole puzzle. */
  #exercise(session: LessonSession, lesson: Lesson): Child {
    const app = this.app;
    const drill = session.drill!;
    const feedback = session.feedback;
    const finished = session.finished;
    const keypad = h("sudoku-keypad", { ondigit: (e: Event) => this.#act(() => session.digit((e as CustomEvent<number>).detail))() }) as SudokuKeypad;
    keypad.counts = digitCounts(drill.state.grid);
    keypad.notesMode = session.mode !== "place";
    keypad.disabled = drill.done;
    const next = nextLesson(lesson.id);
    const onward = session.onward;
    return [
      session.stage === "practice" && h("div", { class: "learn-positions", role: "group", "aria-label": "Practice positions" },
        Array.from({ length: session.positions }, (_, i) => h("button", {
          class: [i === session.position && "active", finished.includes(i) && "done"], "data-k": `position-${i}`,
          "aria-label": `Position ${i + 1}${finished.includes(i) ? ", done" : ""}`, "aria-pressed": String(i === session.position),
          onclick: this.#act(() => session.openPosition(i)),
        }, finished.includes(i) ? `${i + 1} ✓` : String(i + 1)))),
      h("p", { class: "learn-task" }, session.task),
      boardElement(session.board!, (cell) => this.#act(() => session.select(cell))()),
      h("p", { class: ["learn-feedback", feedback?.tone], role: "status", "aria-live": "polite" },
        feedback ? feedback.text : session.mode === "place" ? "Pick a square, then a digit." : "Pick a square, then a candidate."),
      drill.done
        ? h("div", { class: "actions learn-onward" },
          onward === "position" && h("button", { class: "primary", "data-k": "onward", onclick: this.#act(() => session.advance()) }, "Next position"),
          onward === "puzzle" && h("button", { class: "primary", "data-k": "onward", onclick: this.#act(() => session.advance()) }, "Solve a full puzzle"),
          onward === "lesson" && h("button", { class: "primary", "data-k": "onward", onclick: () => app.openLesson(next!.id) }, `Next lesson: ${next!.title}`),
          onward !== "lesson" && next && h("button", { "data-k": "next-lesson", onclick: () => app.openLesson(next.id) }, `Next lesson: ${next.title}`),
          h("button", { "data-k": "retry", onclick: this.#act(() => session.retry()) }, "Try again"),
          h("button", { "data-k": "lessons", onclick: () => app.openLearn() }, "All lessons"))
        : h("div", { class: "pad" },
          keypad,
          h("div", { class: "controls" },
            h("button", { "data-k": "hint", onclick: this.#act(() => session.hint()) }, "Hint"),
            session.canSwitchMode && h("button", {
              class: session.mode === "remove" && "primary", "aria-pressed": String(session.mode === "remove"), "data-k": "mode",
              onclick: this.#act(() => session.switchMode()),
            }, "Remove"),
            session.canToggleCandidates && h("button", {
              class: drill.showCandidates && "primary", "aria-pressed": String(drill.showCandidates), "data-k": "candidates",
              onclick: this.#act(() => session.toggleCandidates()),
            }, "Notes"),
            h("button", { "data-k": "retry", onclick: this.#act(() => session.retry()) }, "Restart"))),
      !drill.done && h("p", { class: "muted small learn-keys" }, "Keys: arrows move, 1 to 9 answer, H for a hint."),
    ];
  }
}

customElements.define("sudoku-learn", LearnScreen);
