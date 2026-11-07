package store

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestScheduleLevelsFor(t *testing.T) {
	sc := Schedule{{FirstWeek, 5}, {"2026-W10", 7}, {"2026-W20", 3}}
	for week, want := range map[string]int{
		"2025-W52": 5, "2026-W09": 5, "2026-W10": 7, "2026-W19": 7, "2026-W20": 3, "2027-W01": 3,
	} {
		if got := sc.LevelsFor(week); got != want {
			t.Errorf("LevelsFor(%s) = %d, want %d", week, got, want)
		}
	}
	if got := (Schedule{}).LevelsFor("2026-W10"); got != 0 {
		t.Errorf("empty schedule = %d, want 0", got)
	}
}

func TestLevelSchedule(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	got, err := s.LevelSchedule(ctx)
	if err != nil || !reflect.DeepEqual(got, Schedule{{FirstWeek, 5}}) {
		t.Fatalf("seeded schedule = %v, %v", got, err)
	}
	u, _ := s.UpsertUser(ctx, "alice", "Alice")
	if _, _, err := s.InsertResult(ctx, Result{UserID: u.ID, Date: "2026-10-26", Level: 1, ElapsedMs: 6000, CompletedAt: "x"}); err != nil {
		t.Fatal(err)
	}
	schedule(t, s, "2026-W44", "2026-W45", 7)
	got, err = s.LevelSchedule(ctx)
	if err != nil || !reflect.DeepEqual(got, Schedule{{FirstWeek, 5}, {"2026-W45", 7}}) {
		t.Fatalf("schedule = %v, %v", got, err)
	}
	if n := got.LevelsFor("2026-W44"); n != 5 {
		t.Errorf("W44 = %d", n)
	}
	if n := got.LevelsFor("2026-W45"); n != 7 {
		t.Errorf("W45 = %d", n)
	}
}

func TestUserDailyResultsAndCountingDates(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	bob, _ := s.UpsertUser(ctx, "bob", "Bob")
	admin, _ := s.UpsertUser(ctx, "admin", "Admin")
	put := func(uid int64, date string, level int, ms int64, auto string) {
		t.Helper()
		if _, _, err := s.InsertResult(ctx, Result{UserID: uid, Date: date, Level: level, ElapsedMs: ms, CompletedAt: "x", AutoFlag: auto}); err != nil {
			t.Fatal(err)
		}
	}
	put(alice.ID, "2026-10-26", 2, 2000, "")
	put(alice.ID, "2026-10-26", 1, 1000, "")
	put(alice.ID, "2026-10-25", 1, 3000, "No replay submitted") // auto flag only
	put(alice.ID, "2026-10-24", 1, 4000, "")                    // admin flagged below
	put(alice.ID, "2026-10-27", 1, 5000, "")                    // after the cutoff
	put(bob.ID, "2026-10-26", 1, 6000, "")
	if err := s.FlagResult(ctx, alice.ID, "2026-10-24", 1, admin.ID, "bad", time.Now()); err != nil {
		t.Fatal(err)
	}

	got, err := s.UserDailyResults(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []UserDailyResult{
		{"2026-10-24", 1, 4000, true},
		{"2026-10-25", 1, 3000, false},
		{"2026-10-26", 1, 1000, false},
		{"2026-10-26", 2, 2000, false},
		{"2026-10-27", 1, 5000, false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("UserDailyResults = %+v\nwant %+v", got, want)
	}
	if none, err := s.UserDailyResults(ctx, admin.ID); err != nil || len(none) != 0 {
		t.Errorf("no results = %v, %v", none, err)
	}

	dates, err := s.CountingDates(ctx, "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	wantDates := map[int64][]string{alice.ID: {"2026-10-25", "2026-10-26"}, bob.ID: {"2026-10-26"}}
	if !reflect.DeepEqual(dates, wantDates) {
		t.Errorf("CountingDates = %v, want %v", dates, wantDates)
	}
	if none, err := s.CountingDates(ctx, "2026-10-20"); err != nil || len(none) != 0 {
		t.Errorf("no players that day = %v, %v", none, err)
	}
}

func TestUserEndlessStats(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	bob, _ := s.UpsertUser(ctx, "bob", "Bob")
	var putGen func(uid int64, generator, difficulty int, number, ms int64)
	put := func(uid int64, difficulty int, number, ms int64) {
		t.Helper()
		putGen(uid, 1, difficulty, number, ms)
	}
	putGen = func(uid int64, generator, difficulty int, number, ms int64) {
		t.Helper()
		r := EndlessResult{UserID: uid, Generator: generator, Difficulty: difficulty, Number: number, ElapsedMs: ms, CompletedAt: "x", ReplayStatus: "missing", AutoFlag: "No replay submitted"}
		if _, _, err := s.InsertEndlessResult(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	put(alice.ID, 3, 1, 9000)
	put(alice.ID, 1, 2, 5000)
	put(alice.ID, 1, 9, 7000)
	put(bob.ID, 1, 40, 1000)
	putGen(alice.ID, 2, 1, 1, 4000)
	putGen(alice.ID, 2, 1, 2, 6000)

	got, err := s.UserEndlessStats(ctx, alice.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := []EndlessStat{{1, 2, 9, 5000, 12000}, {3, 1, 1, 9000, 9000}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("UserEndlessStats = %+v, want %+v", got, want)
	}
	// Each series has its own stats.
	got, err = s.UserEndlessStats(ctx, alice.ID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if want := []EndlessStat{{1, 2, 2, 4000, 10000}}; !reflect.DeepEqual(got, want) {
		t.Errorf("UserEndlessStats(2) = %+v, want %+v", got, want)
	}
}

func TestStatsQueriesFailOnClosedStore(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	s.Close()
	checks := map[string]error{
		"LevelSchedule":    func() error { _, err := s.LevelSchedule(ctx); return err }(),
		"UserDailyResults": func() error { _, err := s.UserDailyResults(ctx, 1); return err }(),
		"CountingDates":    func() error { _, err := s.CountingDates(ctx, "d"); return err }(),
		"UserEndlessStats": func() error { _, err := s.UserEndlessStats(ctx, 1, 1); return err }(),
	}
	for name, err := range checks {
		if err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// Rows that don't fit the Go types (possible only with a table that is not
// STRICT) fail the queries' scans rather than yielding garbage.
func TestStatsQueriesFailOnUnscannableRows(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	for _, q := range []string{
		`DROP TABLE level_schedule`,
		`CREATE TABLE level_schedule (effective_week, levels)`,
		`INSERT INTO level_schedule VALUES ('0000-W00', 'many')`,
		`DROP TABLE results`,
		`CREATE TABLE results (user_id, date, level, elapsed_ms, flagged_at, flag_auto)`,
		`INSERT INTO results VALUES (1, '2026-10-26', 'one', 1000, NULL, 0)`,
		`INSERT INTO results VALUES ('someone', '2026-10-26', 1, 1000, NULL, 0)`,
		`DROP TABLE endless_results`,
		`CREATE TABLE endless_results (user_id, difficulty, number, elapsed_ms)`,
		`INSERT INTO endless_results VALUES (1, 1, 1, 'fast')`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	checks := map[string]error{
		"LevelSchedule":    func() error { _, err := s.LevelSchedule(ctx); return err }(),
		"UserDailyResults": func() error { _, err := s.UserDailyResults(ctx, 1); return err }(),
		"UserEndlessStats": func() error { _, err := s.UserEndlessStats(ctx, 1, 1); return err }(),
		"CountingDates":    func() error { _, err := s.CountingDates(ctx, "2026-10-26"); return err }(),
	}
	for name, err := range checks {
		if err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
