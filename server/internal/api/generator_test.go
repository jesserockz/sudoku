package api

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/store"
)

func getGenerator(t *testing.T, e replayEnv) generatorResponse {
	t.Helper()
	resp := do(t, e.srv, "GET", "/api/v1/admin/generator", adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d", resp.StatusCode)
	}
	return decode[generatorResponse](t, resp)
}

func putGenerator(t *testing.T, e replayEnv, enabled ...int) generatorResponse {
	t.Helper()
	resp := do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, map[string][]int{"enabled": enabled})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	return decode[generatorResponse](t, resp)
}

// enableGenerators sets the enabled generators behind the API's back.
func enableGenerators(t *testing.T, e replayEnv, enabled ...int) {
	t.Helper()
	if err := e.st.SetEnabledGenerators(context.Background(), enabled); err != nil {
		t.Fatal(err)
	}
}

func weekOf(t *testing.T, e replayEnv) weekResponse {
	t.Helper()
	return decode[weekResponse](t, do(t, e.srv, "GET", "/api/v1/week", alice, nil))
}

func TestAdminGeneratorGate(t *testing.T) {
	e := newReplayEnv(t, 5)
	for _, method := range []string{"GET", "PUT"} {
		expectError(t, do(t, e.srv, method, "/api/v1/admin/generator", "", nil), http.StatusUnauthorized, "unauthorized")
		expectError(t, do(t, e.srv, method, "/api/v1/admin/generator", alice, map[string][]int{"enabled": {2}}), http.StatusForbidden, "forbidden")
	}
	// Nothing was changed by the refused requests.
	if g := getGenerator(t, e); !reflect.DeepEqual(g.Enabled, []int{1}) {
		t.Errorf("enabled = %v", g.Enabled)
	}
	// The pending-change route is gone.
	expectError(t, do(t, e.srv, "DELETE", "/api/v1/admin/generator/pending", adminToken, nil), http.StatusNotFound, "not_found")
}

func TestAdminGeneratorAppliesImmediately(t *testing.T) {
	e := newReplayEnv(t, 5)

	if g := getGenerator(t, e); !reflect.DeepEqual(g, generatorResponse{Enabled: []int{1}}) {
		t.Errorf("initial = %+v", g)
	}
	w := weekOf(t, e)
	if !reflect.DeepEqual(w.Generators, []int{1}) || w.Generator != 1 || w.PendingGenerator != nil {
		t.Errorf("initial week = %+v", w)
	}
	// Older clients still find a null pendingGenerator.
	resp := do(t, e.srv, "GET", "/api/v1/week", alice, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"pendingGenerator":null`) || !strings.Contains(string(body), `"generators":[1]`) {
		t.Errorf("week body = %s", body)
	}

	for _, c := range []struct {
		put, want []int
	}{
		{[]int{2}, []int{2}},
		{[]int{2, 1}, []int{1, 2}},
		{[]int{1, 1}, []int{1}}, // duplicates collapse
		{[]int{2, 2, 1}, []int{1, 2}},
	} {
		if g := putGenerator(t, e, c.put...); !reflect.DeepEqual(g.Enabled, c.want) {
			t.Errorf("PUT %v = %v, want %v", c.put, g.Enabled, c.want)
		}
		if g := getGenerator(t, e); !reflect.DeepEqual(g.Enabled, c.want) {
			t.Errorf("GET after PUT %v = %v", c.put, g.Enabled)
		}
		if w := weekOf(t, e); !reflect.DeepEqual(w.Generators, c.want) || w.Generator != c.want[0] || w.PendingGenerator != nil {
			t.Errorf("week after PUT %v = %+v", c.put, w)
		}
	}
}

func TestAdminGeneratorValidation(t *testing.T) {
	e := newReplayEnv(t, 5)
	putGenerator(t, e, 1, 2)
	for name, body := range map[string]any{
		"zero":        map[string][]int{"enabled": {0}},
		"three":       map[string][]int{"enabled": {3}},
		"one bad":     map[string][]int{"enabled": {1, 3}},
		"negative":    map[string][]int{"enabled": {-1}},
		"empty":       map[string][]int{"enabled": {}},
		"null":        map[string]any{"enabled": nil},
		"missing":     map[string]string{},
		"not a list":  map[string]int{"enabled": 2},
		"strings":     map[string][]string{"enabled": {"1"}},
		"old version": map[string]int{"version": 2},
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, body), http.StatusBadRequest, "bad_request")
		})
	}
	expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, nil), http.StatusBadRequest, "bad_request")
	if g := getGenerator(t, e); !reflect.DeepEqual(g.Enabled, []int{1, 2}) {
		t.Errorf("a refused request changed it to %v", g.Enabled)
	}
}

func TestGeneratorStoreFailures(t *testing.T) {
	for name, call := range map[string]func(e replayEnv) *http.Response{
		"GET": func(e replayEnv) *http.Response {
			return do(t, e.srv, "GET", "/api/v1/admin/generator", adminToken, nil)
		},
		"PUT": func(e replayEnv) *http.Response {
			return do(t, e.srv, "PUT", "/api/v1/admin/generator", adminToken, map[string][]int{"enabled": {2}})
		},
		"week":        func(e replayEnv) *http.Response { return do(t, e.srv, "GET", "/api/v1/week", alice, nil) },
		"stats":       func(e replayEnv) *http.Response { return do(t, e.srv, "GET", "/api/v1/me/stats", alice, nil) },
		"leaderboard": func(e replayEnv) *http.Response { return do(t, e.srv, "GET", "/api/v1/leaderboard", alice, nil) },
		"submit": func(e replayEnv) *http.Response {
			return do(t, e.srv, "POST", "/api/v1/results", alice, resultBody(1, 60000, nil))
		},
	} {
		t.Run(name, func(t *testing.T) {
			e := newReplayEnv(t, 5)
			e.sabotage(t, "ALTER TABLE generator_settings RENAME TO gone")
			expectError(t, call(e), http.StatusInternalServerError, "internal")
		})
	}

	// Naming the generator does not need the settings.
	e := newReplayEnv(t, 1)
	e.sabotage(t, "ALTER TABLE generator_settings RENAME TO gone")
	e.post(t, alice, with(resultBody(1, 60000, nil), "generator", 2), http.StatusCreated)
	for _, path := range []string{"/api/v1/me/stats?generator=2", "/api/v1/leaderboard?generator=2"} {
		if resp := do(t, e.srv, "GET", path, alice, nil); resp.StatusCode != http.StatusOK {
			t.Errorf("%s status = %d", path, resp.StatusCode)
		}
	}
}

func TestGradedDailyResult(t *testing.T) {
	e := newReplayEnv(t, 1)
	putGenerator(t, e, 1, 2)
	v1, v2 := testPuzzleV(t, 1, 1, 1), testPuzzleV(t, 2, 1, 1)
	if v1.Givens == v2.Givens {
		t.Fatal("the generators gave the same puzzle")
	}
	rep1, el1 := solveReplay(v1)
	rep2, el2 := solveReplay(v2)

	// Alice plays both; the graded game is checked against the graded puzzle.
	resp := do(t, e.srv, "POST", "/api/v1/results", alice, with(resultBody(1, el2, rep2), "generator", 2))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("graded status = %d", resp.StatusCode)
	}
	if r := decode[resultJSON](t, resp); r.Generator != 2 || r.ElapsedMs != el2 {
		t.Errorf("graded result = %+v", r)
	}
	// Without a generator it is the default (first enabled), Classic.
	resp = do(t, e.srv, "POST", "/api/v1/results", alice, resultBody(1, el1, rep1))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("classic status = %d", resp.StatusCode)
	}
	if r := decode[resultJSON](t, resp); r.Generator != 1 {
		t.Errorf("default result = %+v", r)
	}
	// Idempotent per generator.
	resp = do(t, e.srv, "POST", "/api/v1/results", alice, with(resultBody(1, 99000, nil), "generator", 2))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate status = %d", resp.StatusCode)
	}
	if r := decode[resultJSON](t, resp); r.Generator != 2 || r.ElapsedMs != el2 {
		t.Errorf("duplicate = %+v", r)
	}
	// Bob's classic replay does not fit the graded puzzle.
	rep1b, el1b := solveReplay(v1)
	e.post(t, bobToken, with(resultBody(1, el1b, rep1b), "generator", 2), http.StatusCreated)

	mine := decode[myResultsResponse](t, do(t, e.srv, "GET", "/api/v1/me/results?date="+testDate, alice, nil))
	if len(mine.Results) != 2 || mine.Results[0].Generator != 1 || mine.Results[1].Generator != 2 {
		t.Errorf("my results = %+v", mine)
	}

	list := e.list(t).Results
	got := map[string]string{}
	for _, r := range list {
		got[r.DisplayName+string(rune('0'+r.Generator))] = r.Replay
	}
	if want := map[string]string{"Alice1": "valid", "Alice2": "valid", "Bob2": "invalid"}; !reflectEqual(got, want) {
		t.Errorf("admin list = %v, want %v", got, want)
	}
	if list[0].Generator != 1 {
		t.Errorf("admin list not ordered by generator: %+v", list)
	}

	// The admin per-result routes take ?generator=, default 1.
	aliceID, bobID := e.userID(t, alice), e.userID(t, bobToken)
	if d := e.replayDetail(t, aliceID); d.Generator != 1 || d.Givens != v1.Givens {
		t.Errorf("default detail = generator %d, givens %s", d.Generator, d.Givens)
	}
	resp = do(t, e.srv, "GET", replayURL+aliceID+"/replay?generator=2", adminToken, nil)
	if d := decode[replayDetail](t, resp); d.Generator != 2 || d.Givens != v2.Givens || d.ElapsedMs != el2 {
		t.Errorf("graded detail = generator %d, givens %s", d.Generator, d.Givens)
	}
	expectError(t, do(t, e.srv, "GET", replayURL+bobID+"/replay", adminToken, nil), http.StatusNotFound, "not_found")
	resp = do(t, e.srv, "PUT", replayURL+aliceID+"/flag?generator=2", adminToken, map[string]string{"reason": "hmm"})
	if r := decode[adminResultJSON](t, resp); r.Generator != 2 || r.Flag == nil || r.Flag.Reason != "hmm" {
		t.Errorf("flagged = %+v", r)
	}
	if d := e.replayDetail(t, aliceID); d.Flag != nil {
		t.Errorf("flagging graded flagged classic: %+v", d.Flag)
	}
	resp = do(t, e.srv, "DELETE", replayURL+aliceID+"/flag?generator=2", adminToken, nil)
	if r := decode[adminResultJSON](t, resp); r.Generator != 2 || r.Flag != nil {
		t.Errorf("unflagged = %+v", r)
	}
	for _, q := range []string{"?generator=3", "?generator=0", "?generator=x"} {
		expectError(t, do(t, e.srv, "GET", replayURL+aliceID+"/replay"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "PUT", replayURL+aliceID+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "DELETE", replayURL+aliceID+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestDailyDefaultGeneratorIsFirstEnabled(t *testing.T) {
	e := newReplayEnv(t, 1)
	putGenerator(t, e, 2)
	rep, elapsed := solveReplay(testPuzzleV(t, 2, 1, 1))
	resp := do(t, e.srv, "POST", "/api/v1/results", alice, resultBody(1, elapsed, rep))
	if r := decode[resultJSON](t, resp); resp.StatusCode != http.StatusCreated || r.Generator != 2 {
		t.Errorf("status %d, result %+v", resp.StatusCode, r)
	}
	if r := e.list(t).Results[0]; r.Generator != 2 || r.Replay != "valid" {
		t.Errorf("stored = %+v", r)
	}
}

func TestDailyMidGameRule(t *testing.T) {
	// A game of a generator the admin has since disabled is still accepted.
	e := newReplayEnv(t, 1)
	putGenerator(t, e, 2)
	rep, elapsed := solveReplay(testPuzzleV(t, 1, 1, 1))
	e.post(t, alice, with(resultBody(1, elapsed, rep), "generator", 1), http.StatusCreated)
	if r := e.list(t).Results[0]; r.Generator != 1 || r.Replay != "valid" {
		t.Errorf("classic while graded only = %+v", r)
	}
	// Unknown generators are not.
	for _, g := range []any{0, 3, -1} {
		e.postErr(t, bobToken, with(resultBody(1, 60000, nil), "generator", g), http.StatusBadRequest, "invalid_result")
	}
	e.postErr(t, bobToken, with(resultBody(1, 60000, nil), "generator", "2"), http.StatusBadRequest, "bad_request")
}

func TestLeaderboardPerGenerator(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	clk := clock.NewFake(time.Date(2026, 10, 27, 9, 0, 0, 0, auckland)) // Tuesday
	srv := newTestServer(t, Deps{Store: st, Clock: clk})
	a, _ := st.UpsertUser(ctx, "dev:alice", "Alice")
	b, _ := st.UpsertUser(ctx, "dev:bob", "Bob")
	for _, r := range []store.Result{
		{Generator: 2, UserID: a.ID, Date: "2026-10-26", Level: 1, ElapsedMs: 10000}, // yesterday, graded
		{Generator: 1, UserID: a.ID, Date: "2026-10-27", Level: 1, ElapsedMs: 30000},
		{Generator: 2, UserID: b.ID, Date: "2026-10-27", Level: 1, ElapsedMs: 20000},
	} {
		r.CompletedAt = "x"
		if _, _, err := st.InsertResult(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	get := func(q string) leaderboardResponse {
		t.Helper()
		resp := do(t, srv, "GET", "/api/v1/leaderboard"+q, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", q, resp.StatusCode)
		}
		return decode[leaderboardResponse](t, resp)
	}
	// Default: Classic, the only one enabled. Alice's streak counts the
	// graded game yesterday.
	lb := get("")
	if lb.Generator != 1 || len(lb.Players) != 1 || lb.Players[0].DisplayName != "Alice" || lb.Players[0].Streak != 2 ||
		len(lb.Puzzles[0].Entries) != 1 || lb.Puzzles[0].Entries[0].ElapsedMs != 30000 {
		t.Errorf("classic board = %+v", lb)
	}
	lb = get("?generator=2")
	if lb.Generator != 2 || len(lb.Players) != 1 || lb.Players[0].DisplayName != "Bob" || lb.Puzzles[0].Entries[0].ElapsedMs != 20000 {
		t.Errorf("graded board = %+v", lb)
	}
	if err := st.SetEnabledGenerators(ctx, []int{2}); err != nil {
		t.Fatal(err)
	}
	if lb := get(""); lb.Generator != 2 || lb.Players[0].DisplayName != "Bob" {
		t.Errorf("default with graded only = %+v", lb)
	}
	if lb := get("?date=2026-10-26&generator=1"); lb.Generator != 1 || len(lb.Players) != 0 {
		t.Errorf("classic yesterday = %+v", lb)
	}
	for _, q := range []string{"?generator=3", "?generator=0", "?generator=x"} {
		expectError(t, do(t, srv, "GET", "/api/v1/leaderboard"+q, alice, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestStatsFilterByGenerator(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	clk := clock.NewFake(time.Date(2026, 11, 3, 9, 0, 0, 0, auckland)) // Tuesday, W45
	srv := newTestServer(t, Deps{Store: st, Clock: clk})
	u, err := st.UpsertUser(ctx, "dev:alice", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []store.Result{
		{Generator: 1, Date: "2026-10-26", ElapsedMs: 100000},
		{Generator: 1, Date: "2026-10-27", ElapsedMs: 110000},
		{Generator: 2, Date: "2026-10-27", ElapsedMs: 40000}, // both on one day
		{Generator: 2, Date: "2026-11-02", ElapsedMs: 50000},
		{Generator: 2, Date: "2026-11-03", ElapsedMs: 60000},
	} {
		r.UserID, r.Level, r.CompletedAt = u.ID, 1, "x"
		if _, _, err := st.InsertResult(ctx, r); err != nil {
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
	// Defaults to the first enabled (Classic); the streak spans both.
	def := get("")
	if def.Generator != 1 || def.Daily[0].Completed != 2 || *def.Daily[0].BestMs != 100000 {
		t.Errorf("default = generator %d, %+v", def.Generator, def.Daily[0])
	}
	graded := get("?generator=2")
	if graded.Generator != 2 || graded.Daily[0].Completed != 3 || *graded.Daily[0].BestMs != 40000 {
		t.Errorf("graded = generator %d, %+v", graded.Generator, graded.Daily[0])
	}
	if !reflect.DeepEqual(graded.Streak, def.Streak) || def.Streak.Best != 2 || def.Streak.Current != 2 {
		t.Errorf("streak differs by generator: %+v vs %+v", graded.Streak, def.Streak)
	}
	if err := st.SetEnabledGenerators(ctx, []int{2}); err != nil {
		t.Fatal(err)
	}
	if g := get(""); !reflect.DeepEqual(g, graded) {
		t.Errorf("default with graded only differs from generator=2")
	}

	for _, q := range []string{"?generator=3", "?generator=0", "?generator=x", "?generator=1.5"} {
		expectError(t, do(t, srv, "GET", "/api/v1/me/stats"+q, alice, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestAdminReplayPuzzleFailure(t *testing.T) {
	// A result beyond its week's level count (the count shrank behind the
	// server's back) has no puzzle to show.
	e := newReplayEnv(t, 5)
	e.post(t, alice, with(resultBody(3, 60000, nil), "generator", 2), http.StatusCreated)
	e.sabotage(t, "UPDATE level_schedule SET levels = 1")
	expectError(t, do(t, e.srv, "GET", "/api/v1/admin/results/"+testDate+"/3/"+e.userID(t, alice)+"/replay?generator=2", adminToken, nil),
		http.StatusInternalServerError, "internal")
}
