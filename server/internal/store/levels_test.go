package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func levelsAt(t *testing.T, s *Store, week string) int {
	t.Helper()
	n, err := s.LevelsForWeek(context.Background(), week)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func schedule(t *testing.T, s *Store, this, next string, levels int) string {
	t.Helper()
	eff, err := s.ScheduleLevels(context.Background(), this, next, levels)
	if err != nil {
		t.Fatal(err)
	}
	return eff
}

func TestLevelsDefaultToFive(t *testing.T) {
	s, _ := openTemp(t)
	if n := levelsAt(t, s, "2026-W44"); n != 5 {
		t.Errorf("levels = %d, want the seeded 5", n)
	}
}

func TestScheduleLevelsBeforeAnyPlayIsImmediate(t *testing.T) {
	s, _ := openTemp(t)
	if eff := schedule(t, s, "2026-W44", "2026-W45", 3); eff != firstWeek {
		t.Errorf("effective = %s", eff)
	}
	for _, w := range []string{"2020-W01", "2026-W44", "2026-W45"} {
		if n := levelsAt(t, s, w); n != 3 {
			t.Errorf("%s: levels = %d, want 3", w, n)
		}
	}
}

func TestScheduleLevelsAfterPlayStartsNextWeek(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	u, _ := s.UpsertUser(ctx, "alice", "Alice")
	if _, _, err := s.InsertResult(ctx, Result{UserID: u.ID, Date: "2026-10-26", Level: 1, ElapsedMs: 6000, CompletedAt: "x"}); err != nil {
		t.Fatal(err)
	}

	// Same as current: nothing scheduled.
	if eff := schedule(t, s, "2026-W44", "2026-W45", 5); eff != "2026-W44" {
		t.Errorf("unchanged effective = %s", eff)
	}
	if n := levelsAt(t, s, "2026-W45"); n != 5 {
		t.Errorf("W45 = %d", n)
	}

	// A change waits for next week.
	if eff := schedule(t, s, "2026-W44", "2026-W45", 7); eff != "2026-W45" {
		t.Errorf("changed effective = %s", eff)
	}
	if a, b, c := levelsAt(t, s, "2026-W43"), levelsAt(t, s, "2026-W44"), levelsAt(t, s, "2026-W45"); a != 5 || b != 5 || c != 7 {
		t.Errorf("W43..W45 = %d %d %d, want 5 5 7", a, b, c)
	}

	// Changing again in the same week replaces the pending change.
	schedule(t, s, "2026-W44", "2026-W45", 3)
	if n := levelsAt(t, s, "2026-W45"); n != 3 {
		t.Errorf("replaced W45 = %d", n)
	}

	// Going back to the current count cancels it.
	schedule(t, s, "2026-W44", "2026-W45", 5)
	if n := levelsAt(t, s, "2026-W45"); n != 5 {
		t.Errorf("cancelled W45 = %d", n)
	}

	// Next week the server restarts with 3: applies from W46, W45 stays 5.
	schedule(t, s, "2026-W45", "2026-W46", 3)
	if b, c := levelsAt(t, s, "2026-W45"), levelsAt(t, s, "2026-W46"); b != 5 || c != 3 {
		t.Errorf("W45 W46 = %d %d", b, c)
	}
	// And across a year boundary the later schedule still applies.
	if n := levelsAt(t, s, "2027-W01"); n != 3 {
		t.Errorf("2027-W01 = %d", n)
	}
}

func TestResultsAcceptLevelsAboveFive(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	u, _ := s.UpsertUser(ctx, "alice", "Alice")
	if _, _, err := s.InsertResult(ctx, Result{UserID: u.ID, Date: "2026-10-26", Level: 8, ElapsedMs: 6000, CompletedAt: "x"}); err != nil {
		t.Errorf("level 8 rejected by schema: %v", err)
	}
	if _, _, err := s.InsertResult(ctx, Result{UserID: u.ID, Date: "2026-10-26", Level: 0, ElapsedMs: 6000, CompletedAt: "x"}); err == nil {
		t.Error("level 0 should still be rejected")
	}
}

func TestMigrationKeepsExistingResults(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v1.db")

	// Build a version-1 database by hand, as an older server would have left it.
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	v1, err := migrationFS.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		string(v1),
		`PRAGMA user_version = 1`,
		`INSERT INTO users (subject, display_name) VALUES ('alice', 'Alice')`,
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at) VALUES (1, '2026-10-26', 2, 90000, '2026-10-26T09:00:00+13:00')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	res, err := s.UserResults(ctx, 1, "2026-10-26")
	if err != nil || len(res) != 1 || res[0].Level != 2 || res[0].ElapsedMs != 90000 {
		t.Errorf("results after migration = %+v, %v", res, err)
	}
	if n := levelsAt(t, s, "2026-W44"); n != 5 {
		t.Errorf("levels after migration = %d", n)
	}
	// Played already, so a new count waits a week.
	if eff := schedule(t, s, "2026-W44", "2026-W45", 4); eff != "2026-W45" {
		t.Errorf("effective = %s", eff)
	}
}
