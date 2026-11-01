// Package replay validates game replays (docs/API.md, "Replays"): the
// shape of a submitted replay and whether it plays out, on the day's puzzle,
// to the claimed solve time.
package replay

import (
	"errors"
	"fmt"

	"github.com/jesserockz/sudoku/server/internal/puzzle"
)

// Limits and tolerances from docs/API.md.
const (
	Version   = 1
	MaxEvents = 10_000
	// wallSlackMs is how much shorter than the claimed time the wall clock
	// may be.
	wallSlackMs = 2000
	// resumeSlackMs is how far a resume may move t past the event before it.
	// Older clients stamped a resume a few ms late; moving the timer forward
	// only lengthens the claimed time, so it gives a cheater nothing.
	resumeSlackMs = 1000
	cells         = 81
)

// Action names.
const (
	ActStart      = "start"
	ActPlace      = "place"
	ActErase      = "erase"
	ActNoteAdd    = "noteAdd"
	ActNoteRemove = "noteRemove"
	ActUndo       = "undo"
	ActClear      = "clear"
	ActNotes      = "notes"
	ActPause      = "pause"
	ActResume     = "resume"
	ActHidden     = "hidden"
	ActVisible    = "visible"
	ActRestore    = "restore"
	ActFinish     = "finish"
)

// Replay is a game's full record.
type Replay struct {
	Version int     `json:"version"`
	Events  []Event `json:"events"`
}

// Event is one recorded action. T is the game timer and W the wall clock, both
// in milliseconds; C, D and On are set only for the actions that use them.
type Event struct {
	T  int64  `json:"t"`
	W  int64  `json:"w"`
	A  string `json:"a"`
	C  *int   `json:"c,omitempty"`
	D  *int   `json:"d,omitempty"`
	On *bool  `json:"on,omitempty"`
}

// fields says which of c, d and on an action carries.
type fields struct{ c, d, on bool }

var actionFields = map[string]fields{
	ActStart:      {},
	ActPlace:      {c: true, d: true},
	ActErase:      {c: true},
	ActNoteAdd:    {c: true, d: true},
	ActNoteRemove: {c: true, d: true},
	ActUndo:       {},
	ActClear:      {},
	ActNotes:      {on: true},
	ActPause:      {},
	ActResume:     {},
	ActHidden:     {},
	ActVisible:    {},
	ActRestore:    {},
	ActFinish:     {},
}

// Wellformed checks the shape of r without looking at the puzzle: the
// version, the event count, and each event's action and fields.
func Wellformed(r Replay) error {
	if r.Version != Version {
		return fmt.Errorf("replay version must be %d", Version)
	}
	if len(r.Events) > MaxEvents {
		return fmt.Errorf("replay has more than %d events", MaxEvents)
	}
	for i, e := range r.Events {
		if err := wellformedEvent(e); err != nil {
			return fmt.Errorf("replay event %d: %w", i, err)
		}
	}
	return nil
}

func wellformedEvent(e Event) error {
	f, ok := actionFields[e.A]
	if !ok {
		return fmt.Errorf("unknown action %q", e.A)
	}
	if e.T < 0 || e.W < 0 {
		return errors.New("t and w must not be negative")
	}
	if f.c != (e.C != nil) || f.d != (e.D != nil) || f.on != (e.On != nil) {
		return fmt.Errorf("wrong fields for action %q", e.A)
	}
	if e.C != nil && (*e.C < 0 || *e.C >= cells) {
		return errors.New("c must be 0..80")
	}
	if e.D != nil && (*e.D < 1 || *e.D > 9) {
		return errors.New("d must be 1..9")
	}
	return nil
}

// snapshot is the undoable part of the board.
type snapshot struct {
	grid  [cells]byte // 0 = empty, else 1..9 (givens included)
	notes [cells]uint16
}

// Check replays r on the puzzle and returns nil when it passes every check in
// docs/API.md ("Replay checks"), else the first failure as a reason fit for an
// admin to read. r must already be Wellformed. givens and solution are the
// puzzle's 81-digit strings.
func Check(r Replay, givens, solution string, elapsedMs int64) error {
	ev := r.Events
	if err := checkShape(ev); err != nil {
		return err
	}
	if err := checkTimer(ev); err != nil {
		return err
	}
	wallMs, err := checkMoves(ev, givens, solution)
	if err != nil {
		return err
	}
	last := ev[len(ev)-1]
	if last.T != elapsedMs {
		return fmt.Errorf("the finish time is %s but %s was submitted", seconds(last.T), seconds(elapsedMs))
	}
	if wallMs < elapsedMs-wallSlackMs {
		return fmt.Errorf("the wall clock ran %s while the timer ran %s", seconds(wallMs), seconds(elapsedMs))
	}
	return nil
}

// seconds formats ms as whole seconds, rounded.
func seconds(ms int64) string { return fmt.Sprintf("%d s", (ms+500)/1000) }

// checkShape is check 1: start first at t = 0, finish last, neither elsewhere.
func checkShape(ev []Event) error {
	if len(ev) == 0 {
		return errors.New("the replay has no events")
	}
	if ev[0].A != ActStart || ev[0].T != 0 {
		return errors.New("the replay does not begin with start at t = 0")
	}
	if ev[len(ev)-1].A != ActFinish {
		return errors.New("the replay does not end with finish")
	}
	for i, e := range ev {
		if (e.A == ActStart && i != 0) || (e.A == ActFinish && i != len(ev)-1) {
			return fmt.Errorf("%s appears in the middle of the replay (event %d)", e.A, i)
		}
	}
	return nil
}

// checkTimer is check 2: t never decreases and holds still while the timer is
// stopped, except across a restore and a resume, which may land up to
// resumeSlackMs later.
func checkTimer(ev []Event) error {
	stopped := true
	for i := 1; i < len(ev); i++ {
		e, prev := ev[i], ev[i-1]
		switch {
		case e.T < prev.T:
			return fmt.Errorf("the timer went backwards at event %d", i)
		case stopped && e.A != ActRestore && e.T != prev.T && (e.A != ActResume || e.T-prev.T > resumeSlackMs):
			return fmt.Errorf("the timer moved while stopped at event %d", i)
		}
		switch e.A {
		case ActResume:
			stopped = false
		case ActPause, ActRestore:
			stopped = true
		}
	}
	return nil
}

// checkMoves covers checks 3 and 4 and also returns the wall-clock time spent
// with the timer running, for check 5.
func checkMoves(ev []Event, givensStr, solutionStr string) (wallMs int64, err error) {
	var cur snapshot
	var givens, solution [cells]byte
	for i := 0; i < cells; i++ {
		givens[i] = givensStr[i] - '0'
		solution[i] = solutionStr[i] - '0'
	}
	cur.grid = givens
	var history []snapshot
	running, solved := false, false
	var solvedT int64

	// The finish event is handled after the loop.
	for i := 1; i < len(ev)-1; i++ {
		e := ev[i]
		if running {
			wallMs += max(0, e.W-ev[i-1].W)
		}
		if solved {
			return 0, fmt.Errorf("event %d (%s) comes after the puzzle was solved", i, e.A)
		}
		fail := func(why string) (int64, error) {
			return 0, fmt.Errorf("event %d (%s): %s", i, e.A, why)
		}
		switch e.A {
		case ActNotes, ActHidden, ActVisible:
			continue
		case ActResume:
			if running {
				return fail("the timer is already running")
			}
			running = true
			continue
		case ActPause:
			if !running {
				return fail("the timer is not running")
			}
			running = false
			continue
		case ActRestore:
			running = false
			history = nil
			continue
		}

		// The rest are moves.
		if !running {
			return fail("the timer is stopped")
		}
		before := cur
		changed := true
		switch e.A {
		case ActPlace:
			c, d := *e.C, byte(*e.D)
			if givens[c] != 0 {
				return fail("that cell is a given")
			}
			if cur.grid[c] == d {
				return fail("that digit is already there")
			}
			cur.grid[c] = d
			cur.notes[c] = 0
			for _, p := range puzzle.Peers(c) {
				cur.notes[p] &^= 1 << (d - 1)
			}
		case ActErase:
			c := *e.C
			switch {
			case givens[c] != 0:
				return fail("that cell is a given")
			case cur.grid[c] != 0:
				cur.grid[c] = 0
			case cur.notes[c] != 0:
				cur.notes[c] = 0
			default:
				return fail("there is nothing to erase")
			}
		case ActNoteAdd, ActNoteRemove:
			c, bit := *e.C, uint16(1)<<(*e.D-1)
			if cur.grid[c] != 0 {
				return fail("the cell is not empty")
			}
			has := cur.notes[c]&bit != 0
			if has == (e.A == ActNoteAdd) {
				if has {
					return fail("that note is already there")
				}
				return fail("that note is not there")
			}
			cur.notes[c] ^= bit
		case ActUndo:
			if len(history) == 0 {
				return fail("there is nothing to undo")
			}
			cur = history[len(history)-1]
			history = history[:len(history)-1]
			changed = false
		case ActClear:
			if cur == (snapshot{grid: givens}) {
				return fail("there is nothing to clear")
			}
			cur = snapshot{grid: givens}
		default:
			// Wellformed rules out unknown actions; start and finish are
			// caught by checkShape.
			return fail("unexpected action")
		}
		if changed {
			history = append(history, before)
		}
		if e.A == ActPlace && cur.grid == solution {
			solved, solvedT = true, e.T
			running = false
			history = nil
		}
	}

	if !solved {
		return 0, errors.New("the final grid is not the puzzle's solution")
	}
	if last := ev[len(ev)-1]; last.T != solvedT {
		return 0, errors.New("the timer moved after the puzzle was solved")
	}
	return wallMs, nil
}
