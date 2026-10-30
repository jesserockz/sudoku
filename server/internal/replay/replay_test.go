package replay

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/puzzle"
)

// recorder builds replays the way the web client records them.
type recorder struct {
	ev   []Event
	t, w int64
}

func (r *recorder) add(a string, c, d int, on *bool) {
	e := Event{T: r.t, W: r.w, A: a, On: on}
	if c >= 0 {
		e.C = &c
	}
	if d >= 0 {
		e.D = &d
	}
	r.ev = append(r.ev, e)
}

// tick moves both clocks, as when the timer runs.
func (r *recorder) tick(ms int64) { r.t += ms; r.w += ms }

func (r *recorder) plain(a string)           { r.add(a, -1, -1, nil) }
func (r *recorder) cell(a string, c int)     { r.add(a, c, -1, nil) }
func (r *recorder) digit(a string, c, d int) { r.add(a, c, d, nil) }
func (r *recorder) mode(on bool)             { r.add(ActNotes, -1, -1, &on) }
func (r *recorder) move(a string, c, d int)  { r.tick(1000); r.digit(a, c, d) }
func (r *recorder) moveCell(a string, c int) { r.tick(1000); r.cell(a, c) }
func (r *recorder) movePlain(a string)       { r.tick(1000); r.plain(a) }

type fixture struct {
	r        Replay
	givens   string
	solution string
	elapsed  int64
}

// validFixture plays a real generated puzzle through every kind of action.
func validFixture(t *testing.T) fixture {
	t.Helper()
	p, err := puzzle.Generate(0x1234abcd5678ef01, 1, 1, 5)
	if err != nil {
		t.Fatal(err)
	}
	sol := func(c int) int { return int(p.Solution[c] - '0') }
	var empties []int
	for c := 0; c < 81; c++ {
		if p.Givens[c] == '0' {
			empties = append(empties, c)
		}
	}
	e0, e1, e2 := empties[0], empties[1], empties[2]
	// An empty peer of e0 that is neither e1 nor e2.
	pc := -1
	for _, q := range puzzle.Peers(e0) {
		if p.Givens[q] == '0' && q != e1 && q != e2 {
			pc = q
			break
		}
	}
	if pc < 0 {
		t.Fatal("no empty peer")
	}
	wrong := sol(e2)%9 + 1

	rec := &recorder{w: 1_761_423_000_000}
	rec.plain(ActStart)
	rec.plain(ActResume)
	rec.mode(true)
	rec.move(ActNoteAdd, e1, 1)
	rec.move(ActNoteAdd, e1, 2)
	rec.move(ActNoteRemove, e1, 2)
	rec.move(ActNoteAdd, pc, sol(e0))
	rec.move(ActPlace, e0, sol(e0))   // clears pc's note of that digit
	rec.move(ActNoteAdd, pc, sol(e0)) // legal again only if it was removed
	rec.mode(false)
	rec.tick(1000)
	rec.plain(ActHidden)
	rec.plain(ActPause)
	rec.w += 60_000
	rec.plain(ActVisible)
	rec.w += 1000
	rec.plain(ActResume)
	rec.move(ActPlace, e2, wrong)
	rec.movePlain(ActUndo)
	rec.move(ActPlace, e2, wrong)
	rec.move(ActPlace, e2, sol(e2)) // replaces a digit
	rec.moveCell(ActErase, e2)      // a digit
	rec.move(ActNoteAdd, e1, 3)
	rec.movePlain(ActUndo)
	rec.move(ActNoteAdd, e1, 3)
	rec.moveCell(ActErase, e1) // notes
	rec.movePlain(ActClear)
	// The app is closed with the timer running, then reopened: the save
	// banked 500 ms more than the last event.
	rec.t += 500
	rec.plain(ActRestore)
	rec.w += 5000
	rec.plain(ActResume)
	for _, c := range empties {
		rec.move(ActPlace, c, sol(c))
	}
	rec.plain(ActFinish)

	f := fixture{r: Replay{Version: 1, Events: rec.ev}, givens: p.Givens, solution: p.Solution, elapsed: rec.t}
	if err := Wellformed(f.r); err != nil {
		t.Fatalf("fixture not wellformed: %v", err)
	}
	return f
}

// index returns the position of the nth (0-based) event with action a.
func (f fixture) index(t *testing.T, a string, nth int) int {
	t.Helper()
	for i, e := range f.r.Events {
		if e.A == a {
			if nth == 0 {
				return i
			}
			nth--
		}
	}
	t.Fatalf("no %s event #%d", a, nth)
	return -1
}

func ptr[T any](v T) *T { return &v }

func TestCheckValid(t *testing.T) {
	f := validFixture(t)
	if err := Check(f.r, f.givens, f.solution, f.elapsed); err != nil {
		t.Fatal(err)
	}
}

func TestCheckWallSlack(t *testing.T) {
	f := validFixture(t)
	n := len(f.r.Events)
	// A long last stretch (both clocks +100 s), so there is room to take
	// wall time back out of it.
	long := slices.Clone(f.r.Events)
	long[n-2].T += 100_000
	long[n-2].W += 100_000
	long[n-1].T += 100_000
	long[n-1].W += 100_000
	elapsed := f.elapsed + 100_000
	wall, err := checkMoves(long, f.givens, f.solution)
	if err != nil {
		t.Fatal(err)
	}
	// Losing wall time until it is exactly 2000 ms short is fine, one more
	// millisecond is not.
	exact := wall - (elapsed - 2000)
	for _, tc := range []struct {
		lost int64
		ok   bool
	}{{exact, true}, {exact + 1, false}} {
		cut := slices.Clone(long)
		cut[n-2].W -= tc.lost
		cut[n-1].W -= tc.lost
		err := Check(Replay{Version: 1, Events: cut}, f.givens, f.solution, elapsed)
		if (err == nil) != tc.ok {
			t.Errorf("lost %d ms: err = %v", tc.lost, err)
		}
	}
}

func TestCheckFailures(t *testing.T) {
	f := validFixture(t)
	empty := -1
	for c := 0; c < 81; c++ {
		if f.givens[c] == '0' {
			empty = c
			break
		}
	}
	given := strings.IndexFunc(f.givens, func(r rune) bool { return r != '0' })
	lastPlace := len(f.r.Events) - 2

	// insertAfterResume adds an event right after the final resume, where the
	// timer runs and the board is back to the givens; it takes the clocks of
	// the resume.
	insertAfterResume := func(ev []Event, extra ...Event) []Event {
		i := slices.IndexFunc(ev, func(e Event) bool { return e.A == ActRestore }) + 1
		for k := range extra {
			extra[k].T, extra[k].W = ev[i].T, ev[i].W
		}
		return slices.Insert(ev, i+1, extra...)
	}

	tests := []struct {
		name    string
		mutate  func(ev []Event) []Event
		elapsed int64 // 0 = the fixture's
		want    string
	}{
		{"no events", func(ev []Event) []Event { return nil }, 0, "no events"},
		{"first not start", func(ev []Event) []Event { ev[0].A = ActResume; return ev }, 0, "begin with start"},
		{"start not at zero", func(ev []Event) []Event { ev[0].T = 5; return ev }, 0, "begin with start"},
		{"last not finish", func(ev []Event) []Event { return ev[:len(ev)-1] }, 0, "end with finish"},
		{"second start", func(ev []Event) []Event { ev[3].A = ActStart; ev[3].On = nil; return ev }, 0, "start appears in the middle"},
		{"early finish", func(ev []Event) []Event { ev[3].A = ActFinish; ev[3].On = nil; return ev }, 0, "finish appears in the middle"},
		{"timer backwards", func(ev []Event) []Event { ev[5].T = ev[4].T - 1; return ev }, 0, "went backwards"},
		{"timer moves while stopped", func(ev []Event) []Event { ev[1].T = 7; return ev }, 0, "moved while stopped"},
		{"timer moves while paused", func(ev []Event) []Event {
			i := slices.IndexFunc(ev, func(e Event) bool { return e.A == ActPause })
			ev[i+1].T += 100
			return ev
		}, 0, "moved while stopped"},
		{"resume while running", func(ev []Event) []Event { return slices.Insert(ev, 3, Event{T: 0, W: ev[1].W, A: ActResume}) }, 0, "already running"},
		{"pause while stopped", func(ev []Event) []Event {
			i := slices.IndexFunc(ev, func(e Event) bool { return e.A == ActPause })
			return slices.Insert(ev, i+1, Event{T: ev[i].T, W: ev[i].W, A: ActPause})
		}, 0, "not running"},
		{"move before resume", func(ev []Event) []Event {
			return slices.Insert(ev, 1, Event{A: ActPlace, C: ptr(empty), D: ptr(1), W: ev[0].W})
		}, 0, "timer is stopped"},
		{"place on a given", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActPlace, C: ptr(given), D: ptr(1)})
		}, 0, "a given"},
		{"place the same digit", func(ev []Event) []Event {
			dup := ev[lastPlace-1]
			return slices.Insert(ev, lastPlace, dup)
		}, 0, "already there"},
		{"erase a given", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActErase, C: ptr(given)})
		}, 0, "a given"},
		{"erase nothing", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActErase, C: ptr(empty)})
		}, 0, "nothing to erase"},
		{"note on a filled cell", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActNoteAdd, C: ptr(given), D: ptr(1)})
		}, 0, "not empty"},
		{"note already there", func(ev []Event) []Event {
			return insertAfterResume(ev,
				Event{A: ActNoteAdd, C: ptr(empty), D: ptr(4)}, Event{A: ActNoteAdd, C: ptr(empty), D: ptr(4)})
		}, 0, "already there"},
		{"note not there", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActNoteRemove, C: ptr(empty), D: ptr(4)})
		}, 0, "not there"},
		{"undo with no history", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActUndo})
		}, 0, "nothing to undo"},
		{"clear a clean board", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: ActClear})
		}, 0, "nothing to clear"},
		{"unknown action", func(ev []Event) []Event {
			return insertAfterResume(ev, Event{A: "teleport"})
		}, 0, "unexpected action"},
		{"event after solved", func(ev []Event) []Event {
			n := len(ev)
			return slices.Insert(ev, n-1, Event{A: ActHidden, T: ev[n-1].T, W: ev[n-1].W})
		}, 0, "after the puzzle was solved"},
		{"not solved", func(ev []Event) []Event {
			n := len(ev)
			return append(ev[:n-2], ev[n-1])
		}, 0, "not the puzzle's solution"},
		{"timer moves after solving", func(ev []Event) []Event {
			ev[len(ev)-1].T += 3000
			return ev
		}, 0, "moved after the puzzle was solved"},
		{"finish time differs from submitted", func(ev []Event) []Event { return ev }, 0, "but"},
		{"wall clock too short", func(ev []Event) []Event {
			for i := range ev {
				ev[i].W = 0
			}
			return ev
		}, 0, "wall clock ran 0 s while the timer ran"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := Replay{Version: 1, Events: slices.Clone(f.r.Events)}
			r.Events = tt.mutate(r.Events)
			elapsed := f.elapsed
			if tt.name == "finish time differs from submitted" {
				elapsed++
			}
			err := Check(r, f.givens, f.solution, elapsed)
			if err == nil {
				t.Fatal("check passed")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want it to contain %q", err, tt.want)
			}
		})
	}
}

func TestCheckWrongSolution(t *testing.T) {
	// Fill the board with a different grid: the last placement does not
	// complete the real solution.
	f := validFixture(t)
	other := f.solution
	// Swap two digits of the solution so no placement matches it fully.
	b := []byte(other)
	for i := 1; i < 81; i++ {
		if b[i] != b[0] {
			b[0], b[i] = b[i], b[0]
			break
		}
	}
	err := Check(f.r, f.givens, string(b), f.elapsed)
	if err == nil || !strings.Contains(err.Error(), "not the puzzle's solution") {
		t.Errorf("err = %v", err)
	}
}

func TestCheckRestoreWhileStopped(t *testing.T) {
	// restore after a pause, moving the timer forward, is fine.
	f := validFixture(t)
	i := f.index(t, ActRestore, 0)
	ev := slices.Clone(f.r.Events)
	ev = slices.Insert(ev, i, Event{T: ev[i-1].T, W: ev[i-1].W, A: ActPause})
	if err := Check(Replay{Version: 1, Events: ev}, f.givens, f.solution, f.elapsed); err != nil {
		t.Fatal(err)
	}
}

func TestWellformed(t *testing.T) {
	ok := Replay{Version: 1, Events: []Event{
		{A: ActStart}, {A: ActNotes, On: ptr(false)}, {A: ActPlace, C: ptr(80), D: ptr(9)}, {A: ActErase, C: ptr(0)}, {A: ActFinish},
	}}
	if err := Wellformed(ok); err != nil {
		t.Fatal(err)
	}
	if err := Wellformed(Replay{Version: 1}); err != nil {
		t.Errorf("empty replay: %v", err)
	}
	tooMany := Replay{Version: 1, Events: make([]Event, MaxEvents+1)}
	for i := range tooMany.Events {
		tooMany.Events[i] = Event{A: ActHidden}
	}
	if err := Wellformed(Replay{Version: 1, Events: tooMany.Events[:MaxEvents]}); err != nil {
		t.Errorf("exactly the maximum: %v", err)
	}

	tests := []struct {
		name string
		r    Replay
		want string
	}{
		{"version", Replay{Version: 2}, "version"},
		{"too many", tooMany, "more than"},
		{"unknown action", Replay{Version: 1, Events: []Event{{A: "jump"}}}, "unknown action"},
		{"no action", Replay{Version: 1, Events: []Event{{}}}, "unknown action"},
		{"negative t", Replay{Version: 1, Events: []Event{{A: ActStart, T: -1}}}, "negative"},
		{"negative w", Replay{Version: 1, Events: []Event{{A: ActStart, W: -1}}}, "negative"},
		{"place without cell", Replay{Version: 1, Events: []Event{{A: ActPlace, D: ptr(1)}}}, "wrong fields"},
		{"place without digit", Replay{Version: 1, Events: []Event{{A: ActPlace, C: ptr(1)}}}, "wrong fields"},
		{"erase with digit", Replay{Version: 1, Events: []Event{{A: ActErase, C: ptr(1), D: ptr(1)}}}, "wrong fields"},
		{"notes without on", Replay{Version: 1, Events: []Event{{A: ActNotes}}}, "wrong fields"},
		{"undo with on", Replay{Version: 1, Events: []Event{{A: ActUndo, On: ptr(true)}}}, "wrong fields"},
		{"pause with cell", Replay{Version: 1, Events: []Event{{A: ActPause, C: ptr(1)}}}, "wrong fields"},
		{"cell too high", Replay{Version: 1, Events: []Event{{A: ActErase, C: ptr(81)}}}, "c must be"},
		{"cell negative", Replay{Version: 1, Events: []Event{{A: ActErase, C: ptr(-1)}}}, "c must be"},
		{"digit 0", Replay{Version: 1, Events: []Event{{A: ActPlace, C: ptr(1), D: ptr(0)}}}, "d must be"},
		{"digit 10", Replay{Version: 1, Events: []Event{{A: ActNoteAdd, C: ptr(1), D: ptr(10)}}}, "d must be"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Wellformed(tt.r)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want it to contain %q", err, tt.want)
			}
		})
	}
}

func TestJSONRoundTrip(t *testing.T) {
	in := `{"version":1,"events":[{"t":0,"w":5,"a":"start"},{"t":0,"w":5,"a":"notes","on":false},{"t":1,"w":6,"a":"place","c":0,"d":3}]}`
	var r Replay
	if err := json.Unmarshal([]byte(in), &r); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Errorf("round trip = %s", out)
	}
}
