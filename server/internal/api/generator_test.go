package api

import (
	"context"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/store"
)

func str(s string) *string { return &s }

func getGenerator(t *testing.T, e replayEnv) generatorResponse {
	t.Helper()
	resp := do(t, e.srv, "GET", "/api/v1/admin/generator", adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d", resp.StatusCode)
	}
	return decode[generatorResponse](t, resp)
}

func putGenerator(t *testing.T, e replayEnv, version int) generatorResponse {
	t.Helper()
	resp := do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, map[string]int{"version": version})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	return decode[generatorResponse](t, resp)
}

func weekOf(t *testing.T, e replayEnv) weekResponse {
	t.Helper()
	return decode[weekResponse](t, do(t, e.srv, "GET", "/api/v1/week", alice, nil))
}

func TestAdminGeneratorGate(t *testing.T) {
	e := newReplayEnv(t, 5)
	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/v1/admin/generator"},
		{"PUT", "/api/v1/admin/generator"},
		{"DELETE", "/api/v1/admin/generator/pending"},
	} {
		expectError(t, do(t, e.srv, rt.method, rt.path, "", nil), http.StatusUnauthorized, "unauthorized")
		expectError(t, do(t, e.srv, rt.method, rt.path, alice, map[string]int{"version": 2}), http.StatusForbidden, "forbidden")
	}
	// Nothing was scheduled by the refused requests.
	if g := getGenerator(t, e); g.Pending != nil {
		t.Errorf("pending = %+v", g.Pending)
	}
}

func TestAdminGeneratorScheduleLifecycle(t *testing.T) {
	e := newReplayEnv(t, 5) // Monday 2026-W44

	want := generatorResponse{Active: 1, Schedule: []generatorEntryJSON{{nil, 1}}}
	if g := getGenerator(t, e); !reflect.DeepEqual(g, want) {
		t.Errorf("initial = %+v, want %+v", g, want)
	}
	if w := weekOf(t, e); w.Generator != 1 || w.PendingGenerator != nil {
		t.Errorf("week = %+v", w)
	}

	// A change is pending from next week, however early in the week.
	pending := &pendingGeneratorJSON{Version: 2, FromWeek: "2026-W45"}
	g := putGenerator(t, e, 2)
	if g.Active != 1 || !reflect.DeepEqual(g.Pending, pending) || len(g.Schedule) != 1 {
		t.Errorf("after PUT 2 = %+v", g)
	}
	if w := weekOf(t, e); w.Generator != 1 || !reflect.DeepEqual(w.PendingGenerator, pending) {
		t.Errorf("week with pending = %+v", w)
	}

	// Cancel it with DELETE.
	g = decode[generatorResponse](t, do(t, e.srv, "DELETE", "/api/v1/admin/generator/pending", adminToken, nil))
	if g.Active != 1 || g.Pending != nil {
		t.Errorf("after DELETE = %+v", g)
	}
	// Cancelling with nothing pending is fine.
	if g := decode[generatorResponse](t, do(t, e.srv, "DELETE", "/api/v1/admin/generator/pending", adminToken, nil)); g.Pending != nil {
		t.Errorf("second DELETE = %+v", g)
	}

	// Choosing the active version cancels a pending change too.
	putGenerator(t, e, 2)
	if g := putGenerator(t, e, 1); g.Pending != nil || g.Active != 1 {
		t.Errorf("cancel by choosing current = %+v", g)
	}

	// Choosing again replaces the pending change.
	putGenerator(t, e, 2)
	if g := putGenerator(t, e, 2); !reflect.DeepEqual(g.Pending, pending) {
		t.Errorf("re-PUT = %+v", g)
	}

	// Next week it is active, with the history, and switching back is pending.
	e2 := e
	e2.srv = newTestServer(t, func() Deps {
		d := adminConfig()
		d.Store = e.st
		d.Clock = clock.NewFake(time.Date(2026, 11, 2, 9, 0, 0, 0, auckland))
		return d
	}())
	g = getGenerator(t, e2)
	wantActive := generatorResponse{Active: 2, Schedule: []generatorEntryJSON{{nil, 1}, {str("2026-W45"), 2}}}
	if !reflect.DeepEqual(g, wantActive) {
		t.Errorf("next week = %+v, want %+v", g, wantActive)
	}
	if w := weekOf(t, e2); w.Generator != 2 || w.PendingGenerator != nil {
		t.Errorf("next week's week = %+v", w)
	}
	g = putGenerator(t, e2, 1)
	if g.Active != 2 || g.Pending == nil || g.Pending.FromWeek != "2026-W46" || g.Pending.Version != 1 {
		t.Errorf("switch back = %+v", g)
	}
}

func TestAdminGeneratorValidation(t *testing.T) {
	e := newReplayEnv(t, 5)
	for name, body := range map[string]any{
		"zero":     map[string]int{"version": 0},
		"three":    map[string]int{"version": 3},
		"negative": map[string]int{"version": -1},
		"missing":  map[string]string{},
		"string":   map[string]string{"version": "2"},
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, body), http.StatusBadRequest, "bad_request")
		})
	}
	expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, nil), http.StatusBadRequest, "bad_request")
	if g := getGenerator(t, e); g.Pending != nil {
		t.Errorf("a refused request scheduled %+v", g.Pending)
	}
}

func TestGeneratorStoreFailures(t *testing.T) {
	for name, call := range map[string]func(e replayEnv) *http.Response{
		"GET": func(e replayEnv) *http.Response {
			return do(t, e.srv, "GET", "/api/v1/admin/generator", adminToken, nil)
		},
		"PUT": func(e replayEnv) *http.Response {
			return do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, map[string]int{"version": 2})
		},
		"DELETE": func(e replayEnv) *http.Response {
			return do(t, e.srv, "DELETE", "/api/v1/admin/generator/pending", adminToken, nil)
		},
		"week":  func(e replayEnv) *http.Response { return do(t, e.srv, "GET", "/api/v1/week", alice, nil) },
		"stats": func(e replayEnv) *http.Response { return do(t, e.srv, "GET", "/api/v1/me/stats", alice, nil) },
	} {
		t.Run(name, func(t *testing.T) {
			e := newReplayEnv(t, 5)
			e.sabotage(t, "ALTER TABLE generator_schedule RENAME TO gone")
			expectError(t, call(e), http.StatusInternalServerError, "internal")
		})
	}

	// The schedule can be read but not written.
	t.Run("PUT write", func(t *testing.T) {
		e := newReplayEnv(t, 5)
		e.sabotage(t, "CREATE TRIGGER no_write BEFORE INSERT ON generator_schedule BEGIN SELECT RAISE(ABORT, 'no'); END")
		expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, map[string]int{"version": 2}), http.StatusInternalServerError, "internal")
	})
	t.Run("DELETE write", func(t *testing.T) {
		e := newReplayEnv(t, 5)
		putGenerator(t, e, 2) // so there is a row to delete
		e.sabotage(t, "CREATE TRIGGER no_write BEFORE DELETE ON generator_schedule BEGIN SELECT RAISE(ABORT, 'no'); END")
		expectError(t, do(t, e.srv, "DELETE", "/api/v1/admin/generator/pending", adminToken, nil), http.StatusInternalServerError, "internal")
	})
}

// makeWeekGraded makes the test week (2026-W44) use generator 2, as if it had
// been scheduled the week before.
func makeWeekGraded(t *testing.T, e replayEnv) {
	t.Helper()
	if _, err := e.st.ScheduleGenerator(context.Background(), "2026-W43", testWeek, 2); err != nil {
		t.Fatal(err)
	}
}

func TestGradedWeekReplayValidates(t *testing.T) {
	e := newReplayEnv(t, 1)
	makeWeekGraded(t, e)
	if w := weekOf(t, e); w.Generator != 2 || w.PendingGenerator != nil {
		t.Fatalf("week = %+v", w)
	}

	v1, v2 := testPuzzleV(t, 1, 1, 1), testPuzzleV(t, 2, 1, 1)
	if v1.Givens == v2.Givens {
		t.Fatal("the generators gave the same puzzle")
	}
	rep, elapsed := solveReplay(v2)
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
	if r := e.list(t).Results[0]; r.Replay != "valid" || r.Flag != nil {
		t.Errorf("graded replay on a graded week = %+v", r)
	}
	// Watching it back shows the graded puzzle.
	if d := e.replayDetail(t, e.userID(t, alice)); d.Givens != v2.Givens {
		t.Errorf("givens = %s, want the graded puzzle %s", d.Givens, v2.Givens)
	}

	// The classic puzzle's replay does not fit a graded week.
	bad, badElapsed := solveReplay(v1)
	e.post(t, bobToken, resultBody(1, badElapsed, bad), http.StatusCreated)
	var bobs *adminResultJSON
	for _, r := range e.list(t).Results {
		if r.DisplayName == "Bob" {
			bobs = &r
		}
	}
	if bobs == nil || bobs.Replay != "invalid" || bobs.Flag == nil || !bobs.Flag.Auto {
		t.Errorf("classic replay on a graded week = %+v", bobs)
	}
}

func TestClassicWeekRejectsGradedReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(testPuzzleV(t, 2, 1, 1))
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
	if r := e.list(t).Results[0]; r.Replay != "invalid" {
		t.Errorf("graded replay on a classic week = %+v", r)
	}
}

func TestPuzzleForUnknownVersion(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.sabotage(t, "UPDATE generator_schedule SET version = 9")
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.postErr(t, alice, resultBody(1, elapsed, rep), http.StatusInternalServerError, "internal")
}

func TestStatsFilterByGenerator(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	// W43 and W44 are classic, W45 graded (today is in W45), W46 classic again.
	for _, w := range [][3]any{{"2026-W44", "2026-W45", 2}, {"2026-W45", "2026-W46", 1}} {
		if _, err := st.ScheduleGenerator(ctx, w[0].(string), w[1].(string), w[2].(int)); err != nil {
			t.Fatal(err)
		}
	}
	clk := clock.NewFake(time.Date(2026, 11, 3, 9, 0, 0, 0, auckland)) // Tuesday, W45
	srv := newTestServer(t, Deps{Store: st, Clock: clk})
	u, err := st.UpsertUser(ctx, "dev:alice", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	for date, ms := range map[string]int64{
		"2026-10-26": 100000, // W44 classic
		"2026-10-27": 110000, // W44 classic
		"2026-11-02": 50000,  // W45 graded
		"2026-11-03": 60000,  // W45 graded
		"2026-11-10": 70000,  // W46 classic
	} {
		if _, _, err := st.InsertResult(ctx, store.Result{UserID: u.ID, Date: date, Level: 1, ElapsedMs: ms, CompletedAt: "x"}); err != nil {
			t.Fatal(err)
		}
	}

	get := func(query string) statsResponse {
		t.Helper()
		resp := do(t, srv, "GET", "/api/v1/me/stats"+query, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", query, resp.StatusCode)
		}
		return decode[statsResponse](t, resp)
	}
	// Defaults to the active (graded) version; the streak spans both.
	def := get("")
	if def.Generator != 2 || def.Daily[0].Completed != 2 || *def.Daily[0].BestMs != 50000 {
		t.Errorf("default = generator %d, %+v", def.Generator, def.Daily[0])
	}
	classic := get("?generator=1")
	if classic.Generator != 1 || classic.Daily[0].Completed != 3 || *classic.Daily[0].BestMs != 70000 {
		t.Errorf("classic = generator %d, %+v", classic.Generator, classic.Daily[0])
	}
	if !reflect.DeepEqual(classic.Streak, def.Streak) || def.Streak.Best != 2 {
		t.Errorf("streak differs by generator: %+v vs %+v", classic.Streak, def.Streak)
	}
	if g := get("?generator=2"); !reflect.DeepEqual(g, def) {
		t.Errorf("generator=2 differs from the default")
	}

	for _, q := range []string{"?generator=3", "?generator=0", "?generator=x", "?generator=1.5"} {
		expectError(t, do(t, srv, "GET", "/api/v1/me/stats"+q, alice, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestPuzzleForNeedsTheGeneratorSchedule(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.post(t, alice, resultBody(1, 60000, nil), http.StatusCreated)
	e.sabotage(t, "ALTER TABLE generator_schedule RENAME TO gone")
	e.postErr(t, bobToken, resultBody(1, elapsed, rep), http.StatusInternalServerError, "internal")
	expectError(t, do(t, e.srv, "GET", replayURL+e.userID(t, alice)+"/replay", adminToken, nil), http.StatusInternalServerError, "internal")
}
