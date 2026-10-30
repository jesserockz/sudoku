package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestMigrateFromBeforeReplays creates a database as it was before replays existed (schema version
// 2) holding one user and one result, then opens it with the current code.
func TestMigrateFromBeforeReplays(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"migrations/0001_init.sql", "migrations/0002_level_schedule.sql"} {
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec(string(body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		`INSERT INTO users (id, subject, display_name) VALUES (1, 'a', 'Alice')`,
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at) VALUES (1, '2026-10-26', 1, 100000, 'x')`,
		`PRAGMA user_version = 2`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	got, err := s.AdminDayResults(ctx, "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ReplayStatus != "none" || got[0].ReplayError != "" || got[0].Flag != nil {
		t.Errorf("old result = %+v", got)
	}
	day, err := s.DayResults(ctx, "2026-10-26")
	if err != nil || len(day) != 1 || day[0].Flagged {
		t.Errorf("day results = %+v, %v", day, err)
	}
	if ev, err := s.ReplayEvents(ctx, 1, "2026-10-26", 1); err != nil || ev != nil {
		t.Errorf("events = %q, %v", ev, err)
	}
}

func TestInsertResultReplayAndFlags(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")
	const date = "2026-10-26"

	ins := func(r Result) {
		t.Helper()
		if _, created, err := s.InsertResult(ctx, r); err != nil || !created {
			t.Fatalf("insert %+v: created=%v err=%v", r, created, err)
		}
	}
	base := func(u int64, level int) Result {
		return Result{UserID: u, Date: date, Level: level, ElapsedMs: 100000, CompletedAt: "c"}
	}
	valid := base(alice.ID, 1)
	valid.ReplayStatus, valid.Events = "valid", `[{"t":0}]`
	ins(valid)
	invalid := base(alice.ID, 2)
	invalid.ReplayStatus, invalid.ReplayError, invalid.Events, invalid.AutoFlag = "invalid", "boom", `[]`, "Replay check failed: boom"
	ins(invalid)
	missing := base(bob.ID, 1)
	missing.ReplayStatus, missing.AutoFlag = "missing", "No replay submitted"
	ins(missing)
	ins(base(bob.ID, 2)) // no replay info at all: NULL status

	rows, err := s.AdminDayResults(ctx, date)
	if err != nil {
		t.Fatal(err)
	}
	type brief struct {
		Name, Status, Err string
		Level             int
		Flag              *Flag
	}
	var got []brief
	for _, r := range rows {
		if r.Flag != nil {
			if r.SubmittedAt != r.Flag.At {
				t.Errorf("auto flag time %q != submitted %q", r.Flag.At, r.SubmittedAt)
			}
			f := *r.Flag
			f.At = ""
			r.Flag = &f
		}
		got = append(got, brief{r.DisplayName, r.ReplayStatus, r.ReplayError, r.Level, r.Flag})
	}
	want := []brief{
		{"Alice", "valid", "", 1, nil},
		{"Bob", "missing", "", 1, &Flag{Reason: "No replay submitted", Auto: true}},
		{"Alice", "invalid", "boom", 2, &Flag{Reason: "Replay check failed: boom", Auto: true}},
		{"Bob", "none", "", 2, nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("admin results:\n got %+v\nwant %+v", got, want)
	}

	day, _ := s.DayResults(ctx, date)
	var flagged []bool
	for _, d := range day {
		flagged = append(flagged, d.Flagged)
	}
	if !reflect.DeepEqual(flagged, []bool{false, true, true, false}) {
		t.Errorf("flagged = %v", flagged)
	}

	ev, err := s.ReplayEvents(ctx, alice.ID, date, 1)
	if err != nil || string(ev) != `[{"t":0}]` {
		t.Errorf("events = %q, %v", ev, err)
	}
	if ev, err := s.ReplayEvents(ctx, bob.ID, date, 1); err != nil || ev != nil {
		t.Errorf("missing replay events = %q, %v", ev, err)
	}

	// A duplicate changes nothing, replay and flag included.
	dup := base(alice.ID, 1)
	dup.ReplayStatus, dup.Events, dup.AutoFlag = "invalid", `[{"t":9}]`, "nope"
	if r, created, err := s.InsertResult(ctx, dup); err != nil || created || r.ElapsedMs != 100000 {
		t.Fatalf("duplicate: %+v %v %v", r, created, err)
	}
	if ev, _ := s.ReplayEvents(ctx, alice.ID, date, 1); string(ev) != `[{"t":0}]` {
		t.Errorf("duplicate replaced events: %q", ev)
	}
	if r, _ := s.AdminResult(ctx, alice.ID, date, 1); r.ReplayStatus != "valid" || r.Flag != nil {
		t.Errorf("duplicate changed result: %+v", r)
	}
}

func TestFlagAndUnflag(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	admin, _ := s.UpsertUser(ctx, "ann", "Ann")
	const date = "2026-10-26"
	if _, _, err := s.InsertResult(ctx, Result{UserID: alice.ID, Date: date, Level: 1, ElapsedMs: 9000, CompletedAt: "c",
		ReplayStatus: "missing", AutoFlag: "No replay submitted"}); err != nil {
		t.Fatal(err)
	}

	at := time.Date(2026, 10, 26, 9, 15, 0, 123_000_000, time.FixedZone("NZDT", 13*3600))
	if err := s.FlagResult(ctx, alice.ID, date, 1, admin.ID, "too fast", at); err != nil {
		t.Fatal(err)
	}
	r, err := s.AdminResult(ctx, alice.ID, date, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := &Flag{Reason: "too fast", By: &FlagUser{ID: admin.ID, DisplayName: "Ann"}, At: "2026-10-25T20:15:00.123Z"}
	if !reflect.DeepEqual(r.Flag, want) {
		t.Errorf("flag = %+v, want %+v", r.Flag, want)
	}

	if err := s.UnflagResult(ctx, alice.ID, date, 1); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminResult(ctx, alice.ID, date, 1); r.Flag != nil {
		t.Errorf("still flagged: %+v", r.Flag)
	}
	// Unflagging an unflagged result is fine.
	if err := s.UnflagResult(ctx, alice.ID, date, 1); err != nil {
		t.Fatal(err)
	}

	for name, err := range map[string]error{
		"flag":   s.FlagResult(ctx, alice.ID, date, 2, admin.ID, "x", at),
		"unflag": s.UnflagResult(ctx, 99, date, 1),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s of a missing result: %v", name, err)
		}
	}
	if _, err := s.AdminResult(ctx, alice.ID, date, 2); !errors.Is(err, ErrNotFound) {
		t.Errorf("AdminResult of a missing result: %v", err)
	}
}

func TestAdminQueriesFailOnClosedStore(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	s.Close()
	at := time.Now()
	checks := map[string]error{
		"AdminDayResults": func() error { _, err := s.AdminDayResults(ctx, "d"); return err }(),
		"AdminResult":     func() error { _, err := s.AdminResult(ctx, 1, "d", 1); return err }(),
		"ReplayEvents":    func() error { _, err := s.ReplayEvents(ctx, 1, "d", 1); return err }(),
		"FlagResult":      s.FlagResult(ctx, 1, "d", 1, 1, "", at),
		"UnflagResult":    s.UnflagResult(ctx, 1, "d", 1),
	}
	for name, err := range checks {
		if err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := s.DayResults(ctx, "d"); err == nil || !strings.Contains(err.Error(), "day results") {
		t.Errorf("DayResults: %v", err)
	}
}
