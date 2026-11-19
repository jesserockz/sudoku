package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestInsertVariantDailyResult(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	first := VariantDailyResult{
		UserID: alice.ID, Date: "2026-10-26", Variant: 3, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00",
		ReplayStatus: "valid", Events: `[{"a":"start"}]`,
	}
	got, created, err := s.InsertVariantDailyResult(ctx, first)
	if err != nil || !created || got.ElapsedMs != 183000 || got.Variant != 3 {
		t.Fatalf("insert = %+v, %v, %v", got, created, err)
	}
	// A second result for the date returns the first, unchanged, with its replay and flag left alone.
	dup := first
	dup.ElapsedMs, dup.Variant, dup.Events, dup.AutoFlag = 9000, 1, `[]`, "later"
	got, created, err = s.InsertVariantDailyResult(ctx, dup)
	if err != nil || created || got.ElapsedMs != 183000 || got.Variant != 3 || got.CompletedAt != first.CompletedAt {
		t.Fatalf("duplicate = %+v, %v, %v", got, created, err)
	}
	events, err := s.VariantDailyReplayEvents(ctx, alice.ID, "2026-10-26")
	if err != nil || string(events) != `[{"a":"start"}]` {
		t.Errorf("events = %s, %v", events, err)
	}
	// Another date is another result; with no events nothing is stored for the replay.
	other := VariantDailyResult{UserID: alice.ID, Date: "2026-10-27", Variant: 1, ElapsedMs: 7000, CompletedAt: "x", ReplayStatus: "missing", AutoFlag: "No replay submitted"}
	if _, created, err := s.InsertVariantDailyResult(ctx, other); err != nil || !created {
		t.Fatalf("second date = %v, %v", created, err)
	}
	if events, err := s.VariantDailyReplayEvents(ctx, alice.ID, "2026-10-27"); err != nil || events != nil {
		t.Errorf("events of a result without replay = %s, %v", events, err)
	}
	if _, err := s.VariantDailyReplayEvents(ctx, alice.ID, "2026-10-28"); err != nil {
		t.Errorf("events of nothing: %v", err)
	}
	// An automatic flag is set on insert, as for the other kinds of result.
	r, err := s.AdminVariantDailyResult(ctx, alice.ID, "2026-10-27")
	if err != nil || r.Flag == nil || !r.Flag.Auto || r.Flag.Reason != "No replay submitted" || r.Flag.By != nil || r.ReplayStatus != "missing" {
		t.Errorf("admin result = %+v / %+v, %v", r, r.Flag, err)
	}
}

func TestUserVariantDailyResultAndDates(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	put := func(date string, auto string) {
		t.Helper()
		if _, _, err := s.InsertVariantDailyResult(ctx, VariantDailyResult{UserID: alice.ID, Date: date, Variant: 2, ElapsedMs: 8000, CompletedAt: "c", ReplayStatus: "valid", AutoFlag: auto}); err != nil {
			t.Fatal(err)
		}
	}
	if r, err := s.UserVariantDailyResult(ctx, alice.ID, "2026-10-26"); err != nil || r != nil {
		t.Errorf("no result = %+v, %v", r, err)
	}
	put("2026-10-27", "")
	put("2026-10-26", "auto")
	r, err := s.UserVariantDailyResult(ctx, alice.ID, "2026-10-26")
	if err != nil || r == nil || r.Variant != 2 || r.ElapsedMs != 8000 || r.CompletedAt != "c" || r.Date != "2026-10-26" || r.UserID != alice.ID {
		t.Errorf("result = %+v, %v", r, err)
	}
	// The server's own flag does not count against a streak; an admin's does.
	if err := s.FlagVariantDailyResult(ctx, alice.ID, "2026-10-27", alice.ID, "why", time.Date(2026, 10, 27, 1, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	dates, err := s.UserVariantDailyDates(ctx, alice.ID)
	if want := []VariantDailyDate{{"2026-10-26", false}, {"2026-10-27", true}}; err != nil || !reflect.DeepEqual(dates, want) {
		t.Errorf("dates = %+v, %v", dates, err)
	}
	if dates, err := s.UserVariantDailyDates(ctx, alice.ID+1); err != nil || len(dates) != 0 {
		t.Errorf("nobody's dates = %+v, %v", dates, err)
	}
}

func TestVariantDailyResultsAreRankedByTime(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	bob, _ := s.UpsertUser(ctx, "bob", "Bob")
	carol, _ := s.UpsertUser(ctx, "carol", "Carol")
	for _, r := range []VariantDailyResult{
		{UserID: carol.ID, Date: "2026-10-26", Variant: 1, ElapsedMs: 5000, ReplayStatus: "valid"},
		{UserID: bob.ID, Date: "2026-10-26", Variant: 1, ElapsedMs: 9000, ReplayStatus: "valid"},
		{UserID: alice.ID, Date: "2026-10-26", Variant: 1, ElapsedMs: 9000, ReplayStatus: "valid", AutoFlag: "auto"},
		{UserID: alice.ID, Date: "2026-10-27", Variant: 2, ElapsedMs: 1000, ReplayStatus: "valid"},
	} {
		r.CompletedAt = "c"
		if _, _, err := s.InsertVariantDailyResult(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.FlagVariantDailyResult(ctx, carol.ID, "2026-10-26", alice.ID, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := s.VariantDailyResults(ctx, "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		name string
		ms   int64
		flag bool
	}
	var rows []row
	for _, r := range got {
		rows = append(rows, row{r.DisplayName, r.ElapsedMs, r.Flagged})
	}
	// Ties break by name; an admin flag shows, the server's own does not.
	if want := []row{{"Carol", 5000, true}, {"Alice", 9000, false}, {"Bob", 9000, false}}; !reflect.DeepEqual(rows, want) {
		t.Errorf("results = %+v, want %+v", rows, want)
	}
	if none, err := s.VariantDailyResults(ctx, "2026-01-01"); err != nil || none == nil || len(none) != 0 {
		t.Errorf("empty day = %v, %v", none, err)
	}
	admin, err := s.AdminVariantDailyResults(ctx, "2026-10-26")
	if err != nil || len(admin) != 3 || admin[0].DisplayName != "Carol" || admin[0].Flag == nil || admin[0].Flag.By == nil || admin[0].Flag.By.DisplayName != "Alice" {
		t.Errorf("admin results = %+v, %v", admin, err)
	}
}

func TestVariantDailyFlagging(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	if _, _, err := s.InsertVariantDailyResult(ctx, VariantDailyResult{UserID: alice.ID, Date: "2026-10-26", Variant: 1, ElapsedMs: 5000, CompletedAt: "c", ReplayStatus: "valid"}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 26, 2, 3, 4, 5_000_000, time.UTC)
	if err := s.FlagVariantDailyResult(ctx, alice.ID, "2026-10-26", alice.ID, "odd", at); err != nil {
		t.Fatal(err)
	}
	r, err := s.AdminVariantDailyResult(ctx, alice.ID, "2026-10-26")
	if err != nil || r.Flag == nil || r.Flag.Reason != "odd" || r.Flag.Auto || r.Flag.At != "2026-10-26T02:03:04.005Z" || r.Flag.By == nil || r.Flag.By.ID != alice.ID {
		t.Fatalf("flagged = %+v / %+v, %v", r, r.Flag, err)
	}
	if err := s.UnflagVariantDailyResult(ctx, alice.ID, "2026-10-26"); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminVariantDailyResult(ctx, alice.ID, "2026-10-26"); r.Flag != nil {
		t.Errorf("flag after unflag = %+v", r.Flag)
	}
	// Unflagging an unflagged result is fine; a missing one is not found.
	if err := s.UnflagVariantDailyResult(ctx, alice.ID, "2026-10-26"); err != nil {
		t.Errorf("second unflag: %v", err)
	}
	if err := s.FlagVariantDailyResult(ctx, alice.ID, "2026-01-01", alice.ID, "", at); !errors.Is(err, ErrNotFound) {
		t.Errorf("flag of nothing = %v", err)
	}
	if err := s.UnflagVariantDailyResult(ctx, alice.ID, "2026-01-01"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unflag of nothing = %v", err)
	}
	if _, err := s.AdminVariantDailyResult(ctx, alice.ID, "2026-01-01"); !errors.Is(err, ErrNotFound) {
		t.Errorf("admin result of nothing = %v", err)
	}
}

func TestCountingDatesIncludeTheVariantOfTheDay(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	bob, _ := s.UpsertUser(ctx, "bob", "Bob")
	carol, _ := s.UpsertUser(ctx, "carol", "Carol")
	if _, _, err := s.InsertResult(ctx, Result{Generator: 1, UserID: alice.ID, Date: "2026-10-25", Level: 1, ElapsedMs: 6000, CompletedAt: "x"}); err != nil {
		t.Fatal(err)
	}
	put := func(uid int64, date string) {
		t.Helper()
		if _, _, err := s.InsertVariantDailyResult(ctx, VariantDailyResult{UserID: uid, Date: date, Variant: 1, ElapsedMs: 6000, CompletedAt: "x", ReplayStatus: "valid"}); err != nil {
			t.Fatal(err)
		}
	}
	// Alice: a classic day and a variant of the day. Bob: variant days only, one flagged by an admin. Carol: nothing on the day.
	put(alice.ID, "2026-10-26")
	put(bob.ID, "2026-10-25")
	put(bob.ID, "2026-10-26")
	put(carol.ID, "2026-10-24")
	if err := s.FlagVariantDailyResult(ctx, bob.ID, "2026-10-25", alice.ID, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	dates, err := s.CountingDates(ctx, "2026-10-26")
	want := map[int64][]string{alice.ID: {"2026-10-25", "2026-10-26"}, bob.ID: {"2026-10-26"}}
	if err != nil || !reflect.DeepEqual(dates, want) {
		t.Errorf("CountingDates = %v, %v, want %v", dates, err, want)
	}
}

func TestVariantDailyQueriesFailOnClosedStore(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	s.Close()
	checks := map[string]error{
		"Insert":      func() error { _, _, err := s.InsertVariantDailyResult(ctx, VariantDailyResult{}); return err }(),
		"User":        func() error { _, err := s.UserVariantDailyResult(ctx, 1, "d"); return err }(),
		"Dates":       func() error { _, err := s.UserVariantDailyDates(ctx, 1); return err }(),
		"Results":     func() error { _, err := s.VariantDailyResults(ctx, "d"); return err }(),
		"AdminList":   func() error { _, err := s.AdminVariantDailyResults(ctx, "d"); return err }(),
		"AdminResult": func() error { _, err := s.AdminVariantDailyResult(ctx, 1, "d"); return err }(),
		"Replay":      func() error { _, err := s.VariantDailyReplayEvents(ctx, 1, "d"); return err }(),
		"Flag":        s.FlagVariantDailyResult(ctx, 1, "d", 1, "", time.Now()),
		"Unflag":      s.UnflagVariantDailyResult(ctx, 1, "d"),
	}
	for name, err := range checks {
		if err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Rows that don't fit the Go types (possible only with a table that is not
// STRICT) fail the queries' scans rather than yielding garbage.
func TestVariantDailyQueriesFailOnUnscannableRows(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	for _, q := range []string{
		`DROP TABLE daily_variant_replays`,
		`DROP TABLE daily_variant_results`,
		`CREATE TABLE daily_variant_results (user_id, date, variant, elapsed_ms, completed_at, submitted_at, replay_status, replay_error, flagged_at, flag_reason, flag_auto, flagged_by)`,
		`INSERT INTO daily_variant_results VALUES (1, '2026-10-26', 1, 'fast', 'c', 's', 'valid', '', NULL, '', 0, NULL)`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	checks := map[string]error{
		"User":        func() error { _, err := s.UserVariantDailyResult(ctx, alice.ID, "2026-10-26"); return err }(),
		"Results":     func() error { _, err := s.VariantDailyResults(ctx, "2026-10-26"); return err }(),
		"AdminList":   func() error { _, err := s.AdminVariantDailyResults(ctx, "2026-10-26"); return err }(),
		"AdminResult": func() error { _, err := s.AdminVariantDailyResult(ctx, alice.ID, "2026-10-26"); return err }(),
	}
	for name, err := range checks {
		if err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A missing date makes the dates query fail to scan.
	if _, err := s.db.ExecContext(ctx, `UPDATE daily_variant_results SET date = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UserVariantDailyDates(ctx, 1); err == nil {
		t.Error("Dates: no error")
	}
}

// A failing insert, here into a missing table, returns its error.
func TestInsertVariantDailyResultFails(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE daily_variant_results RENAME TO gone`); err != nil {
		t.Fatal(err)
	}
	r := VariantDailyResult{UserID: alice.ID, Date: "2026-10-26", Variant: 1, ElapsedMs: 9000, CompletedAt: "c", ReplayStatus: "missing"}
	if _, _, err := s.InsertVariantDailyResult(ctx, r); err == nil {
		t.Error("insert into a missing table succeeded")
	}
}
