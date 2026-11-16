package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// migrationNumber is the number of the i-th migration in order (negative
// counts from the end, -1 being the latest).
func migrationNumber(t *testing.T, i int) int {
	t.Helper()
	names, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if i < 0 {
		i += len(names)
	}
	n, err := strconv.Atoi(strings.SplitN(names[i].Name(), "_", 2)[0])
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// buildBeforeVariants creates a database with every migration before the
// endless variants migration applied, then runs stmts.
func buildBeforeVariants(t *testing.T, stmts ...string) string {
	t.Helper()
	names, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	idx := -1
	for i, n := range names {
		if strings.HasSuffix(n.Name(), "_endless_variants.sql") {
			idx = i
		}
	}
	if idx < 1 {
		t.Fatal("no endless variants migration")
	}
	path := filepath.Join(t.TempDir(), "before-variants.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	raw.SetMaxOpenConns(1)
	for _, n := range names[:idx] {
		body, err := migrationFS.ReadFile("migrations/" + n.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", n.Name(), err)
		}
	}
	for _, q := range append(stmts, "PRAGMA user_version = "+strconv.Itoa(migrationNumber(t, idx-1))) {
		if _, err := raw.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	return path
}

// TestMigrateEndlessVariants opens a database left by the previous server
// version holding endless results of both generators, with and without
// replays and flags, and checks that the endless variants migration keeps
// them all as variant 0 and makes variant part of the key.
func TestMigrateEndlessVariants(t *testing.T) {
	ctx := context.Background()
	path := buildBeforeVariants(t,
		`INSERT INTO users (id, subject, display_name) VALUES (1, 'a', 'Alice'), (2, 'b', 'Bob')`,
		`INSERT INTO endless_results (user_id, generator, difficulty, number, elapsed_ms, completed_at, submitted_at, replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto)
			VALUES (1, 1, 3, 7, 90000, 'c1', '2026-10-26T00:00:00.000Z', 'invalid', 'boom', '2026-10-26T01:00:00.000Z', 2, 'bad', 0)`,
		`INSERT INTO endless_results (user_id, generator, difficulty, number, elapsed_ms, completed_at, submitted_at, replay_status, flagged_at, flag_reason, flag_auto)
			VALUES (2, 2, 3, 7, 80000, 'c2', '2026-10-26T00:00:01.000Z', 'missing', '2026-10-26T00:00:01.000Z', 'No replay submitted', 1)`,
		`INSERT INTO endless_results (user_id, generator, difficulty, number, elapsed_ms, completed_at, replay_status)
			VALUES (1, 2, 5, 1, 70000, 'c3', 'valid')`,
		`INSERT INTO endless_replays (user_id, generator, difficulty, number, events) VALUES (1, 1, 3, 7, '[{"t":5}]')`,
		`INSERT INTO endless_replays (user_id, generator, difficulty, number, events) VALUES (1, 2, 5, 1, '[{"t":6}]')`,
	)

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	r, err := s.AdminEndlessResult(ctx, 1, 1, 0, 3, 7)
	if err != nil || r.Generator != 1 || r.Variant != 0 || r.ElapsedMs != 90000 || r.CompletedAt != "c1" || r.SubmittedAt != "2026-10-26T00:00:00.000Z" ||
		r.ReplayStatus != "invalid" || r.ReplayError != "boom" || r.Flag == nil || r.Flag.Reason != "bad" || r.Flag.Auto || r.Flag.By == nil || r.Flag.By.ID != 2 {
		t.Errorf("migrated classic result = %+v / %+v, %v", r, r.Flag, err)
	}
	r, err = s.AdminEndlessResult(ctx, 2, 2, 0, 3, 7)
	if err != nil || r.Variant != 0 || r.ElapsedMs != 80000 || r.ReplayStatus != "missing" || r.Flag == nil || !r.Flag.Auto || r.Flag.By != nil {
		t.Errorf("migrated graded result = %+v / %+v, %v", r, r.Flag, err)
	}
	for _, c := range []struct {
		uid    int64
		gen    int
		d      int
		n      int64
		events string
	}{{1, 1, 3, 7, `[{"t":5}]`}, {1, 2, 5, 1, `[{"t":6}]`}, {2, 2, 3, 7, ""}} {
		ev, err := s.EndlessReplayEvents(ctx, c.uid, c.gen, 0, c.d, c.n)
		if err != nil || string(ev) != c.events {
			t.Errorf("migrated replay %+v = %q, %v", c, ev, err)
		}
	}
	mine, err := s.UserEndlessResults(ctx, 1)
	if want := []EndlessResult{
		{UserID: 1, Generator: 1, Variant: 0, Difficulty: 3, Number: 7, ElapsedMs: 90000, CompletedAt: "c1"},
		{UserID: 1, Generator: 2, Variant: 0, Difficulty: 5, Number: 1, ElapsedMs: 70000, CompletedAt: "c3"},
	}; err != nil || !reflect.DeepEqual(mine, want) {
		t.Errorf("migrated user results = %+v, %v", mine, err)
	}

	// The same puzzle in a variant is free, and the old key is still unique.
	if _, created, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: 1, Generator: 1, Variant: 1, Difficulty: 3, Number: 7, ElapsedMs: 6000, CompletedAt: "x", ReplayStatus: "valid", Events: "[]"}); err != nil || !created {
		t.Errorf("variant 1 insert after migration: created=%v err=%v", created, err)
	}
	if _, created, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: 1, Generator: 1, Difficulty: 3, Number: 7, ElapsedMs: 6000, CompletedAt: "x", ReplayStatus: "valid"}); err != nil || created {
		t.Errorf("variant 0 duplicate after migration: created=%v err=%v", created, err)
	}
	// Variants are 0..3.
	for _, v := range []int{-1, 4} {
		if _, _, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: 1, Generator: 1, Variant: v, Difficulty: 3, Number: 8, ElapsedMs: 6000, CompletedAt: "x", ReplayStatus: "valid"}); err == nil {
			t.Errorf("variant %d should be rejected", v)
		}
	}
	// A replay's key must match a result's, variant included.
	if _, err := s.db.Exec(`INSERT INTO endless_replays (user_id, generator, variant, difficulty, number, events) VALUES (1, 1, 2, 3, 7, '[]')`); err == nil {
		t.Error("a replay without a result of its variant should be rejected")
	}

	// The replay foreign key follows the renamed table, over the whole key.
	rows, err := s.db.Query(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('endless_replays') ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	var fk []string
	for rows.Next() {
		var table, from, to string
		if err := rows.Scan(&table, &from, &to); err != nil {
			t.Fatal(err)
		}
		fk = append(fk, table+"."+from+"="+to)
	}
	rows.Close()
	want := []string{"endless_results.user_id=user_id", "endless_results.generator=generator", "endless_results.variant=variant",
		"endless_results.difficulty=difficulty", "endless_results.number=number"}
	if !reflect.DeepEqual(fk, want) {
		t.Errorf("replay foreign key = %v, want %v", fk, want)
	}
	// The leaderboard index leads with the series, variant included.
	var cols []string
	rows, err = s.db.Query(`SELECT name FROM pragma_index_info('endless_results_by_puzzle') ORDER BY seqno`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, c)
	}
	rows.Close()
	if want := []string{"generator", "variant", "difficulty", "number", "elapsed_ms"}; !reflect.DeepEqual(cols, want) {
		t.Errorf("index columns = %v, want %v", cols, want)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'endless_results_by_submitted'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("submitted index = %d, %v", n, err)
	}
}

func TestEndlessVariantsAreSeparate(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	bob, _ := s.UpsertUser(ctx, "b", "Bob")
	ins := func(uid int64, variant int, ms int64, events string) {
		t.Helper()
		r, created, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: uid, Generator: 1, Variant: variant, Difficulty: 2, Number: 3, ElapsedMs: ms,
			CompletedAt: "c", ReplayStatus: "valid", Events: events})
		if err != nil || !created || r.Variant != variant {
			t.Fatalf("insert variant %d: %+v created=%v err=%v", variant, r, created, err)
		}
	}
	// The same user, generator, tier and number in each variant are separate results.
	ins(alice.ID, 3, 50000, `[{"t":3}]`)
	ins(alice.ID, 0, 40000, `[{"t":0}]`)
	ins(alice.ID, 1, 45000, "")
	ins(bob.ID, 3, 30000, "")

	// A duplicate in a variant returns that variant's result.
	dup, created, err := s.InsertEndlessResult(ctx, EndlessResult{UserID: alice.ID, Generator: 1, Variant: 3, Difficulty: 2, Number: 3, ElapsedMs: 1, CompletedAt: "d", ReplayStatus: "valid"})
	if want := (EndlessResult{UserID: alice.ID, Generator: 1, Variant: 3, Difficulty: 2, Number: 3, ElapsedMs: 50000, CompletedAt: "c"}); err != nil || created || dup != want {
		t.Errorf("dup = %+v created=%v err=%v", dup, created, err)
	}

	mine, err := s.UserEndlessResults(ctx, alice.ID)
	var variants []int
	for _, r := range mine {
		variants = append(variants, r.Variant)
	}
	if err != nil || !reflect.DeepEqual(variants, []int{0, 1, 3}) {
		t.Errorf("user results variants = %v, %v", variants, err)
	}
	for v, want := range map[int][]int64{0: {40000}, 1: {45000}, 2: nil, 3: {30000, 50000}} {
		times, err := s.EndlessPuzzleResults(ctx, 1, v, 2, 3)
		var got []int64
		for _, r := range times {
			got = append(got, r.ElapsedMs)
		}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("puzzle results variant %d = %v, %v; want %v", v, got, err, want)
		}
	}
	for v, want := range map[int]int{0: 1, 1: 1, 2: 0, 3: 2} {
		if prog, err := s.EndlessProgressAll(ctx, 1, v); err != nil || len(prog) != want {
			t.Errorf("progress variant %d = %+v, %v", v, prog, err)
		}
	}
	for v, want := range map[int]string{0: `[{"t":0}]`, 1: "", 3: `[{"t":3}]`} {
		if ev, err := s.EndlessReplayEvents(ctx, alice.ID, 1, v, 2, 3); err != nil || string(ev) != want {
			t.Errorf("events variant %d = %q, %v", v, ev, err)
		}
	}
	all, err := s.AdminEndlessResultsBetween(ctx, time.Now().AddDate(0, 0, -1), time.Now().AddDate(0, 0, 1))
	var order []string
	for _, r := range all {
		order = append(order, strconv.Itoa(r.Variant)+r.DisplayName)
	}
	if want := []string{"0Alice", "1Alice", "3Bob", "3Alice"}; err != nil || !reflect.DeepEqual(order, want) {
		t.Errorf("admin order = %v, %v; want %v", order, err, want)
	}

	// Flags address one variant only.
	if err := s.FlagEndlessResult(ctx, alice.ID, 1, 3, 2, 3, bob.ID, "x", time.Now()); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminEndlessResult(ctx, alice.ID, 1, 3, 2, 3); r.Flag == nil || r.Variant != 3 {
		t.Errorf("variant 3 result = %+v", r)
	}
	if r, _ := s.AdminEndlessResult(ctx, alice.ID, 1, 0, 2, 3); r.Flag != nil || r.Variant != 0 {
		t.Errorf("variant 0 result = %+v", r)
	}
	if err := s.UnflagEndlessResult(ctx, alice.ID, 1, 3, 2, 3); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminEndlessResult(ctx, alice.ID, 1, 3, 2, 3); r.Flag != nil {
		t.Errorf("still flagged: %+v", r.Flag)
	}
	for name, err := range map[string]error{
		"result": func() error { _, err := s.AdminEndlessResult(ctx, alice.ID, 1, 2, 2, 3); return err }(),
		"flag":   s.FlagEndlessResult(ctx, alice.ID, 1, 2, 2, 3, bob.ID, "", time.Now()),
		"unflag": s.UnflagEndlessResult(ctx, bob.ID, 1, 0, 2, 3),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s of a missing variant: %v", name, err)
		}
	}
}
