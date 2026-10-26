package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/store"
)

// levelsServer runs New directly so the test can call SyncLevels, as main
// does at startup, against a store that outlives each "restart".
func levelsServer(t *testing.T, st *store.Store, clk clock.Clock, levels int) *httptest.Server {
	t.Helper()
	cfg := testConfig()
	cfg.Levels = levels
	s := New(Deps{Config: cfg, Clock: clk, Store: st, Verifier: auth.Dev{}})
	if _, err := s.SyncLevels(context.Background()); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func weekLevels(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	return decode[weekResponse](t, do(t, srv, "GET", "/api/v1/week", alice, nil)).Levels
}

func TestConfiguredLevelsBeforeAnyPlay(t *testing.T) {
	// Fresh database: nobody has played, so 3 levels apply straight away.
	srv := levelsServer(t, newTestStore(t), clock.NewFake(mondayMorning), 3)
	if n := weekLevels(t, srv); n != 3 {
		t.Fatalf("levels = %d, want 3", n)
	}

	expectError(t, do(t, srv, "POST", "/api/v1/results", alice, with(validResult(), "level", 4)), http.StatusBadRequest, "invalid_result")
	for level := 1; level <= 3; level++ {
		resp := do(t, srv, "POST", "/api/v1/results", alice, with(validResult(), "level", level))
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("level %d status = %d", level, resp.StatusCode)
		}
		resp.Body.Close()
	}

	lb := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard", alice, nil))
	if len(lb.Puzzles) != 3 {
		t.Errorf("puzzles = %d, want 3", len(lb.Puzzles))
	}
	// All three done is a full day.
	if len(lb.Total.Entries) != 1 {
		t.Errorf("total = %+v", lb.Total.Entries)
	}
}

func TestLevelChangeWaitsForNextWeek(t *testing.T) {
	st := newTestStore(t)
	clk := clock.NewFake(mondayMorning) // Mon 2026-10-26, 2026-W44

	srv := levelsServer(t, st, clk, 5)
	resp := do(t, srv, "POST", "/api/v1/results", alice, with(validResult(), "level", 5))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Restart mid-week with 7 levels: this week stays at 5.
	clk.Set(mondayMorning.AddDate(0, 0, 3))
	srv = levelsServer(t, st, clk, 7)
	if n := weekLevels(t, srv); n != 5 {
		t.Errorf("rest of this week = %d, want 5", n)
	}
	expectError(t, do(t, srv, "POST", "/api/v1/results", alice, with(with(validResult(), "date", "2026-10-29"), "level", 6)),
		http.StatusBadRequest, "invalid_result")

	// Next Monday (Auckland midnight) the new count applies, with no restart.
	clk.Set(time.Date(2026, 11, 2, 0, 0, 0, 0, auckland))
	if n := weekLevels(t, srv); n != 7 {
		t.Errorf("next week = %d, want 7", n)
	}
	resp = do(t, srv, "POST", "/api/v1/results", alice, with(with(validResult(), "date", "2026-11-02"), "level", 7))
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("level 7 next week status = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Last week's boards keep last week's count, and late results for it are
	// still checked against 5.
	old := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard?date=2026-10-26", alice, nil))
	cur := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard", alice, nil))
	if len(old.Puzzles) != 5 || len(cur.Puzzles) != 7 {
		t.Errorf("puzzles last/this week = %d/%d, want 5/7", len(old.Puzzles), len(cur.Puzzles))
	}
	expectError(t, do(t, srv, "POST", "/api/v1/results", alice, with(with(validResult(), "date", "2026-10-27"), "level", 6)),
		http.StatusBadRequest, "invalid_result")
}

func TestSyncLevelsReportsEffectiveWeek(t *testing.T) {
	st := newTestStore(t)
	clk := clock.NewFake(mondayMorning)
	cfg := testConfig()
	sync := func(levels int) string {
		t.Helper()
		cfg.Levels = levels
		eff, err := New(Deps{Config: cfg, Clock: clk, Store: st, Verifier: auth.Dev{}}).SyncLevels(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return eff
	}
	if eff := sync(4); eff != "2026-W44" {
		t.Errorf("before play = %s, want now", eff)
	}
	u, _ := st.UpsertUser(context.Background(), "x", "X")
	st.InsertResult(context.Background(), store.Result{UserID: u.ID, Date: "2026-10-26", Level: 1, ElapsedMs: 6000, CompletedAt: "x"})
	if eff := sync(4); eff != "2026-W44" {
		t.Errorf("unchanged = %s", eff)
	}
	if eff := sync(6); eff != "2026-W45" {
		t.Errorf("changed = %s, want next week", eff)
	}
}
