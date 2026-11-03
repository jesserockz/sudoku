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

func TestInsertEndlessResultIdempotent(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	u, _ := s.UpsertUser(ctx, "alice", "Alice")

	first := EndlessResult{UserID: u.ID, Difficulty: 3, Number: 7, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00", ReplayStatus: "valid"}
	got, created, err := s.InsertEndlessResult(ctx, first)
	if err != nil || !created || got != first {
		t.Fatalf("first insert: %+v %v %v", got, created, err)
	}

	dup := first
	dup.ElapsedMs = 1000
	dup.CompletedAt = "2026-10-26T10:00:00+13:00"
	dup.AutoFlag = "nope"
	got, created, err = s.InsertEndlessResult(ctx, dup)
	if err != nil || created {
		t.Fatalf("dup insert: created=%v err=%v", created, err)
	}
	want := EndlessResult{UserID: u.ID, Difficulty: 3, Number: 7, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00"}
	if got != want {
		t.Errorf("dup returned %+v, want stored %+v", got, want)
	}
	if r, _ := s.AdminEndlessResult(ctx, u.ID, 3, 7); r.Flag != nil {
		t.Errorf("duplicate flagged the result: %+v", r.Flag)
	}

	diffNumber, diffTier := first, first
	diffNumber.Number = 8
	diffTier.Difficulty = 4
	for _, r := range []EndlessResult{diffNumber, diffTier} {
		if _, created, _ := s.InsertEndlessResult(ctx, r); !created {
			t.Errorf("%+v should be created", r)
		}
	}

	// The schema's checks reject what the API never sends.
	for name, bad := range map[string]EndlessResult{
		"unknown user":   {UserID: 42, Difficulty: 1, Number: 1, ElapsedMs: 1, CompletedAt: "x", ReplayStatus: "valid"},
		"difficulty 0":   {UserID: u.ID, Difficulty: 0, Number: 1, ElapsedMs: 1, CompletedAt: "x", ReplayStatus: "valid"},
		"difficulty 6":   {UserID: u.ID, Difficulty: 6, Number: 1, ElapsedMs: 1, CompletedAt: "x", ReplayStatus: "valid"},
		"number 0":       {UserID: u.ID, Difficulty: 1, Number: 0, ElapsedMs: 1, CompletedAt: "x", ReplayStatus: "valid"},
		"no replay info": {UserID: u.ID, Difficulty: 1, Number: 1, ElapsedMs: 1, CompletedAt: "x"},
	} {
		if _, _, err := s.InsertEndlessResult(ctx, bad); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestEndlessReplayAndFlags(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")

	ins := func(r EndlessResult) {
		t.Helper()
		if _, created, err := s.InsertEndlessResult(ctx, r); err != nil || !created {
			t.Fatalf("insert %+v: created=%v err=%v", r, created, err)
		}
	}
	valid := EndlessResult{UserID: alice.ID, Difficulty: 1, Number: 1, ElapsedMs: 100000, CompletedAt: "c", ReplayStatus: "valid", Events: `[{"t":0}]`}
	ins(valid)
	invalid := EndlessResult{UserID: alice.ID, Difficulty: 1, Number: 2, ElapsedMs: 100000, CompletedAt: "c",
		ReplayStatus: "invalid", ReplayError: "boom", Events: `[]`, AutoFlag: "Replay check failed: boom"}
	ins(invalid)
	ins(EndlessResult{UserID: bob.ID, Difficulty: 1, Number: 1, ElapsedMs: 90000, CompletedAt: "c", ReplayStatus: "missing", AutoFlag: "No replay submitted"})

	r, err := s.AdminEndlessResult(ctx, alice.ID, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if r.ReplayStatus != "invalid" || r.ReplayError != "boom" || r.DisplayName != "Alice" || r.SubmittedAt == "" {
		t.Errorf("result = %+v", r)
	}
	if want := (&Flag{Reason: "Replay check failed: boom", Auto: true, At: r.SubmittedAt}); !reflect.DeepEqual(r.Flag, want) {
		t.Errorf("flag = %+v, want %+v", r.Flag, want)
	}

	ev, err := s.EndlessReplayEvents(ctx, alice.ID, 1, 1)
	if err != nil || string(ev) != `[{"t":0}]` {
		t.Errorf("events = %q, %v", ev, err)
	}
	if ev, err := s.EndlessReplayEvents(ctx, bob.ID, 1, 1); err != nil || ev != nil {
		t.Errorf("missing replay events = %q, %v", ev, err)
	}

	// Automatic flags stay out of the public boards until an admin confirms one.
	flagged := func() []bool {
		t.Helper()
		rows, err := s.EndlessPuzzleResults(ctx, 1, 1)
		if err != nil {
			t.Fatal(err)
		}
		var out []bool
		for _, r := range rows {
			out = append(out, r.Flagged)
		}
		return out
	}
	if got := flagged(); !reflect.DeepEqual(got, []bool{false, false}) {
		t.Errorf("flagged with only automatic flags = %v", got)
	}
	at := time.Date(2026, 10, 26, 9, 15, 0, 123_000_000, time.FixedZone("NZDT", 13*3600))
	if err := s.FlagEndlessResult(ctx, bob.ID, 1, 1, alice.ID, "confirmed", at); err != nil {
		t.Fatal(err)
	}
	if got := flagged(); !reflect.DeepEqual(got, []bool{true, false}) {
		t.Errorf("flagged after an admin flag = %v", got)
	}
	r, _ = s.AdminEndlessResult(ctx, bob.ID, 1, 1)
	want := &Flag{Reason: "confirmed", By: &FlagUser{ID: alice.ID, DisplayName: "Alice"}, At: "2026-10-25T20:15:00.123Z"}
	if !reflect.DeepEqual(r.Flag, want) {
		t.Errorf("flag = %+v, want %+v", r.Flag, want)
	}

	if err := s.UnflagEndlessResult(ctx, bob.ID, 1, 1); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminEndlessResult(ctx, bob.ID, 1, 1); r.Flag != nil {
		t.Errorf("still flagged: %+v", r.Flag)
	}
	// Unflagging an unflagged result is fine.
	if err := s.UnflagEndlessResult(ctx, bob.ID, 1, 1); err != nil {
		t.Fatal(err)
	}

	for name, err := range map[string]error{
		"flag":   s.FlagEndlessResult(ctx, alice.ID, 1, 3, bob.ID, "x", at),
		"unflag": s.UnflagEndlessResult(ctx, 99, 1, 1),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s of a missing result: %v", name, err)
		}
	}
	if _, err := s.AdminEndlessResult(ctx, alice.ID, 2, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("AdminEndlessResult of a missing result: %v", err)
	}
}

func TestEndlessUserAndPuzzleResults(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")
	for _, r := range []EndlessResult{
		{UserID: alice.ID, Difficulty: 2, Number: 1, ElapsedMs: 70000},
		{UserID: alice.ID, Difficulty: 1, Number: 10, ElapsedMs: 80000},
		{UserID: alice.ID, Difficulty: 1, Number: 2, ElapsedMs: 90000},
		{UserID: bob.ID, Difficulty: 1, Number: 2, ElapsedMs: 60000},
	} {
		r.CompletedAt, r.ReplayStatus = "c", "valid"
		if _, _, err := s.InsertEndlessResult(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	mine, err := s.UserEndlessResults(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	var keys [][2]int64
	for _, r := range mine {
		if r.UserID != alice.ID || r.CompletedAt != "c" {
			t.Errorf("result = %+v", r)
		}
		keys = append(keys, [2]int64{int64(r.Difficulty), r.Number})
	}
	if want := [][2]int64{{1, 2}, {1, 10}, {2, 1}}; !reflect.DeepEqual(keys, want) {
		t.Errorf("order = %v, want %v", keys, want)
	}
	if none, err := s.UserEndlessResults(ctx, 99); err != nil || none == nil || len(none) != 0 {
		t.Errorf("no results = %#v, %v", none, err)
	}

	times, err := s.EndlessPuzzleResults(ctx, 1, 2)
	if err != nil || len(times) != 2 || times[0].DisplayName != "Bob" || times[0].ElapsedMs != 60000 || times[1].UserID != alice.ID {
		t.Errorf("puzzle results = %+v, %v", times, err)
	}
	if none, err := s.EndlessPuzzleResults(ctx, 1, 3); err != nil || none == nil || len(none) != 0 {
		t.Errorf("empty puzzle = %#v, %v", none, err)
	}

	if err := s.FlagEndlessResult(ctx, alice.ID, 1, 10, bob.ID, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	prog, err := s.EndlessProgressAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []EndlessProgress{
		{Difficulty: 1, UserID: alice.ID, DisplayName: "Alice", Completed: 2, Highest: 10, Flagged: true},
		{Difficulty: 1, UserID: bob.ID, DisplayName: "Bob", Completed: 1, Highest: 2},
		{Difficulty: 2, UserID: alice.ID, DisplayName: "Alice", Completed: 1, Highest: 1},
	}
	if !reflect.DeepEqual(prog, want) {
		t.Errorf("progress = %+v\nwant %+v", prog, want)
	}
}

func TestAdminEndlessResultsBetween(t *testing.T) {
	ctx := context.Background()
	s, path := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")
	for i, r := range []EndlessResult{
		{UserID: alice.ID, Difficulty: 2, Number: 1, ElapsedMs: 70000},
		{UserID: bob.ID, Difficulty: 1, Number: 5, ElapsedMs: 80000},
		{UserID: alice.ID, Difficulty: 1, Number: 5, ElapsedMs: 80000},
		{UserID: alice.ID, Difficulty: 1, Number: 4, ElapsedMs: 90000},
	} {
		r.CompletedAt, r.ReplayStatus = "c", "valid"
		if _, _, err := s.InsertEndlessResult(ctx, r); err != nil {
			t.Fatal(i, err)
		}
	}
	// Move the submission times about: the last one falls outside the range.
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`UPDATE endless_results SET submitted_at = '2026-10-26T00:00:00.000Z'`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`UPDATE endless_results SET submitted_at = '2026-10-27T00:00:00.000Z' WHERE number = 4`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	from := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	got, err := s.AdminEndlessResultsBetween(ctx, from, from.AddDate(0, 0, 1).In(time.FixedZone("x", 3600)))
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, r := range got {
		order = append(order, r.DisplayName+"/"+string(rune('0'+r.Difficulty))+"/"+string(rune('0'+r.Number)))
	}
	if want := []string{"Alice/1/5", "Bob/1/5", "Alice/2/1"}; !reflect.DeepEqual(order, want) {
		t.Errorf("order = %v, want %v", order, want)
	}
	// The end is exclusive, the start inclusive.
	if got, _ := s.AdminEndlessResultsBetween(ctx, from.Add(time.Millisecond), from.AddDate(0, 0, 1)); len(got) != 0 {
		t.Errorf("start should be inclusive: %+v", got)
	}
	if got, _ := s.AdminEndlessResultsBetween(ctx, from.AddDate(0, 0, -1), from); len(got) != 0 {
		t.Errorf("end should be exclusive: %+v", got)
	}
}

func TestEndlessQueriesFailOnClosedStore(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	s.Close()
	at := time.Now()
	_, _, insertErr := s.InsertEndlessResult(ctx, EndlessResult{})
	checks := map[string]error{
		"InsertEndlessResult":        insertErr,
		"UserEndlessResults":         func() error { _, err := s.UserEndlessResults(ctx, 1); return err }(),
		"EndlessPuzzleResults":       func() error { _, err := s.EndlessPuzzleResults(ctx, 1, 1); return err }(),
		"EndlessProgressAll":         func() error { _, err := s.EndlessProgressAll(ctx); return err }(),
		"AdminEndlessResultsBetween": func() error { _, err := s.AdminEndlessResultsBetween(ctx, at, at); return err }(),
		"AdminEndlessResult":         func() error { _, err := s.AdminEndlessResult(ctx, 1, 1, 1); return err }(),
		"EndlessReplayEvents":        func() error { _, err := s.EndlessReplayEvents(ctx, 1, 1, 1); return err }(),
		"FlagEndlessResult":          s.FlagEndlessResult(ctx, 1, 1, 1, 1, "", at),
		"UnflagEndlessResult":        s.UnflagEndlessResult(ctx, 1, 1, 1),
	}
	for name, err := range checks {
		if err == nil || errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), "endless") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

// TestMigrateKeepsDailyResultsForEndless opens a database left by the previous
// server version (schema 3) holding a daily result, a replay and a flag, and
// checks that migrating adds the endless tables and leaves the dailies alone.
func TestMigrateKeepsDailyResultsForEndless(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v3.db")
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"migrations/0001_init.sql", "migrations/0002_level_schedule.sql", "migrations/0003_replays.sql"} {
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
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at, replay_status, flagged_at, flag_reason, flag_auto)
			VALUES (1, '2026-10-26', 2, 90000, 'x', 'missing', '2026-10-26T00:00:00.000Z', 'No replay submitted', 1)`,
		`INSERT INTO replays (user_id, date, level, events) VALUES (1, '2026-10-26', 2, '[]')`,
		`PRAGMA user_version = 3`,
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
	if err != nil || len(got) != 1 || got[0].Level != 2 || got[0].ElapsedMs != 90000 || got[0].ReplayStatus != "missing" ||
		got[0].Flag == nil || !got[0].Flag.Auto {
		t.Errorf("daily results after migration = %+v, %v", got, err)
	}
	if ev, err := s.ReplayEvents(ctx, 1, "2026-10-26", 2); err != nil || string(ev) != "[]" {
		t.Errorf("daily replay after migration = %q, %v", ev, err)
	}
	// The endless tables exist and start empty.
	if mine, err := s.UserEndlessResults(ctx, 1); err != nil || len(mine) != 0 {
		t.Errorf("endless results after migration = %+v, %v", mine, err)
	}
	if _, created, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: 1, Difficulty: 1, Number: 1, ElapsedMs: 6000, CompletedAt: "x", ReplayStatus: "valid", Events: "[]"}); err != nil || !created {
		t.Errorf("endless insert after migration: created=%v err=%v", created, err)
	}
}

// TestEndlessQueriesFailOnBadRows replaces the strict table with a loose copy
// holding NULLs where numbers are expected, so every row scan fails.
func TestEndlessQueriesFailOnBadRows(t *testing.T) {
	ctx := context.Background()
	s, path := openTemp(t)
	u, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")
	for _, id := range []int64{u.ID, bob.ID} {
		if _, _, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: id, Difficulty: 1, Number: 1, ElapsedMs: 6000, CompletedAt: "c", ReplayStatus: "valid"}); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE loose AS SELECT * FROM endless_results`,
		`UPDATE loose SET elapsed_ms = NULL WHERE user_id = 1`,
		`UPDATE loose SET number = NULL WHERE user_id = 2`,
		`DROP TABLE endless_results`,
		`ALTER TABLE loose RENAME TO endless_results`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()

	now := time.Now()
	checks := map[string]error{
		"UserEndlessResults":   func() error { _, err := s.UserEndlessResults(ctx, u.ID); return err }(),
		"EndlessPuzzleResults": func() error { _, err := s.EndlessPuzzleResults(ctx, 1, 1); return err }(),
		"EndlessProgressAll":   func() error { _, err := s.EndlessProgressAll(ctx); return err }(),
		"AdminEndlessResultsBetween": func() error {
			_, err := s.AdminEndlessResultsBetween(ctx, now.AddDate(-1, 0, 0), now.AddDate(1, 0, 0))
			return err
		}(),
	}
	for name, err := range checks {
		if err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
