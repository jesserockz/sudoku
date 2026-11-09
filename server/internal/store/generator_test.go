package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func enabledOf(t *testing.T, s *Store) []int {
	t.Helper()
	got, err := s.EnabledGenerators(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestEnabledGeneratorsDefaultsToClassic(t *testing.T) {
	s, _ := openTemp(t)
	if got := enabledOf(t, s); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("enabled = %v, want [1]", got)
	}
}

func TestSetEnabledGenerators(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	for _, c := range []struct {
		set, want []int
	}{
		{[]int{2}, []int{2}},
		{[]int{1, 2}, []int{1, 2}},
		{[]int{2, 1, 2}, []int{1, 2}},
		{[]int{1}, []int{1}},
	} {
		if err := s.SetEnabledGenerators(ctx, c.set); err != nil {
			t.Fatalf("set %v: %v", c.set, err)
		}
		if got := enabledOf(t, s); !reflect.DeepEqual(got, c.want) {
			t.Errorf("set %v: enabled = %v, want %v", c.set, got, c.want)
		}
	}
	// Enabling none breaks the table's check and changes nothing.
	for _, none := range [][]int{nil, {3}} {
		if err := s.SetEnabledGenerators(ctx, none); err == nil || !strings.Contains(err.Error(), "set enabled generators") {
			t.Errorf("set %v: err = %v", none, err)
		}
	}
	if got := enabledOf(t, s); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("after refused sets: enabled = %v", got)
	}

	// Without the settings row (never the case after migrating), setting
	// creates it.
	if _, err := s.db.Exec(`DELETE FROM generator_settings`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabledGenerators(ctx, []int{2}); err != nil {
		t.Fatal(err)
	}
	if got := enabledOf(t, s); !reflect.DeepEqual(got, []int{2}) {
		t.Errorf("recreated row: enabled = %v", got)
	}
}

func TestEnabledGeneratorsFailures(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	if _, err := s.db.Exec(`DELETE FROM generator_settings`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnabledGenerators(ctx); err == nil || !strings.Contains(err.Error(), "enabled generators") {
		t.Errorf("missing row: err = %v", err)
	}
	s.Close()
	if _, err := s.EnabledGenerators(ctx); err == nil {
		t.Error("closed store: EnabledGenerators succeeded")
	}
}

func TestDailyGeneratorsAreSeparate(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "a", "Alice")
	admin, _ := s.UpsertUser(ctx, "z", "Zed")
	const date = "2026-10-26"
	insert := func(gen int, ms int64, events string) (Result, bool) {
		t.Helper()
		r, created, err := s.InsertResult(ctx, Result{Generator: gen, UserID: alice.ID, Date: date, Level: 1, ElapsedMs: ms,
			CompletedAt: "c", ReplayStatus: "valid", Events: events})
		if err != nil {
			t.Fatal(err)
		}
		return r, created
	}
	// The same game in each generator is a separate result.
	if _, created := insert(2, 50000, `[{"t":2}]`); !created {
		t.Error("graded result not created")
	}
	if _, created := insert(1, 70000, `[{"t":1}]`); !created {
		t.Error("classic result not created")
	}
	if r, created := insert(2, 1000, ""); created || r.Generator != 2 || r.ElapsedMs != 50000 {
		t.Errorf("graded duplicate = %+v created=%v", r, created)
	}

	mine, err := s.UserResults(ctx, alice.ID, date)
	if err != nil || len(mine) != 2 || mine[0].Generator != 1 || mine[0].ElapsedMs != 70000 || mine[1].Generator != 2 || mine[1].ElapsedMs != 50000 {
		t.Errorf("user results = %+v, %v", mine, err)
	}
	for gen, ms := range map[int]int64{1: 70000, 2: 50000} {
		day, err := s.DayResults(ctx, gen, date)
		if err != nil || len(day) != 1 || day[0].ElapsedMs != ms {
			t.Errorf("day results of %d = %+v, %v", gen, day, err)
		}
		ev, err := s.ReplayEvents(ctx, alice.ID, gen, date, 1)
		if want := fmt.Sprintf(`[{"t":%d}]`, gen); err != nil || string(ev) != want {
			t.Errorf("replay of %d = %s, %v", gen, ev, err)
		}
	}
	admins, err := s.AdminDayResults(ctx, date)
	if err != nil || len(admins) != 2 || admins[0].Generator != 1 || admins[1].Generator != 2 {
		t.Errorf("admin day results = %+v, %v", admins, err)
	}

	// Flagging one leaves the other alone.
	if err := s.FlagResult(ctx, alice.ID, 2, date, 1, admin.ID, "bad", time.Now()); err != nil {
		t.Fatal(err)
	}
	if r, err := s.AdminResult(ctx, alice.ID, 2, date, 1); err != nil || r.Generator != 2 || r.Flag == nil {
		t.Errorf("flagged graded = %+v, %v", r, err)
	}
	if r, err := s.AdminResult(ctx, alice.ID, 1, date, 1); err != nil || r.Generator != 1 || r.Flag != nil {
		t.Errorf("classic after flagging graded = %+v, %v", r, err)
	}
	if err := s.UnflagResult(ctx, alice.ID, 1, date, 1); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.AdminResult(ctx, alice.ID, 2, date, 1); r.Flag == nil {
		t.Error("unflagging classic unflagged graded")
	}

	daily, err := s.UserDailyResults(ctx, alice.ID)
	if err != nil || len(daily) != 2 || daily[0].Generator != 1 || daily[1].Generator != 2 || !daily[1].AdminFlagged {
		t.Errorf("user daily results = %+v, %v", daily, err)
	}
	// The classic result still counts the day towards a streak.
	if dates, err := s.CountingDates(ctx, date); err != nil || !reflect.DeepEqual(dates[alice.ID], []string{date}) {
		t.Errorf("counting dates = %v, %v", dates, err)
	}
}

// buildV6 creates a database as the previous server version (schema 6) left
// it, then runs stmts against it.
func buildV6(t *testing.T, stmts ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "v6.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	raw.SetMaxOpenConns(1)
	names, _ := migrationFS.ReadDir("migrations")
	for _, n := range names[:6] {
		body, err := migrationFS.ReadFile("migrations/" + n.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec(string(body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range append(stmts, `PRAGMA user_version = 6`) {
		if _, err := raw.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	return path
}

// TestMigrateEnabledGenerators opens a schema 6 database whose schedule
// switched to Graded in 2026-W45 and back to Classic in 2026-W53 (the week of
// 2027-01-01), with results and replays either side of each switch, and
// checks that every result keeps its columns and gets its week's generator.
func TestMigrateEnabledGenerators(t *testing.T) {
	ctx := context.Background()
	path := buildV6(t,
		`INSERT INTO generator_schedule (effective_week, version) VALUES ('2026-W45', 2), ('2026-W53', 1)`,
		`INSERT INTO users (id, subject, display_name) VALUES (1, 'a', 'Alice'), (2, 'b', 'Bob')`,
		// W44: classic. Flagged by Bob, with a replay.
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at, submitted_at, replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto)
			VALUES (1, '2026-11-01', 1, 90000, 'c1', '2026-11-01T00:00:00.000Z', 'invalid', 'boom', '2026-11-01T01:00:00.000Z', 2, 'bad', 0)`,
		`INSERT INTO replays (user_id, date, level, events) VALUES (1, '2026-11-01', 1, '[{"t":1}]')`,
		// W45: graded, with a replay; a result from before replays (NULL status).
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at, replay_status, flagged_at, flag_reason, flag_auto)
			VALUES (1, '2026-11-02', 2, 80000, 'c2', 'missing', '2026-11-02T00:00:00.000Z', 'No replay submitted', 1)`,
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at) VALUES (2, '2026-11-02', 1, 70000, 'c3')`,
		`INSERT INTO replays (user_id, date, level, events) VALUES (2, '2026-11-02', 1, '[{"t":2}]')`,
		// W52 (a Sunday): still graded. W53, in calendar 2027: classic again.
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at) VALUES (1, '2026-12-27', 1, 60000, 'c4')`,
		`INSERT INTO results (user_id, date, level, elapsed_ms, completed_at) VALUES (1, '2027-01-01', 1, 50000, 'c5')`,
	)

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	r, err := s.AdminResult(ctx, 1, 1, "2026-11-01", 1)
	if err != nil || r.Generator != 1 || r.ElapsedMs != 90000 || r.CompletedAt != "c1" || r.SubmittedAt != "2026-11-01T00:00:00.000Z" ||
		r.ReplayStatus != "invalid" || r.ReplayError != "boom" || r.Flag == nil || r.Flag.Reason != "bad" || r.Flag.Auto ||
		r.Flag.At != "2026-11-01T01:00:00.000Z" || r.Flag.By == nil || r.Flag.By.ID != 2 {
		t.Errorf("W44 result = %+v, %v", r, err)
	}
	if ev, err := s.ReplayEvents(ctx, 1, 1, "2026-11-01", 1); err != nil || string(ev) != `[{"t":1}]` {
		t.Errorf("W44 replay = %q, %v", ev, err)
	}
	r, err = s.AdminResult(ctx, 1, 2, "2026-11-02", 2)
	if err != nil || r.Generator != 2 || r.ElapsedMs != 80000 || r.ReplayStatus != "missing" || r.Flag == nil || !r.Flag.Auto {
		t.Errorf("W45 result = %+v, %v", r, err)
	}
	r, err = s.AdminResult(ctx, 2, 2, "2026-11-02", 1)
	if err != nil || r.ReplayStatus != "none" || r.Flag != nil {
		t.Errorf("W45 result without replay info = %+v, %v", r, err)
	}
	if ev, err := s.ReplayEvents(ctx, 2, 2, "2026-11-02", 1); err != nil || string(ev) != `[{"t":2}]` {
		t.Errorf("W45 replay = %q, %v", ev, err)
	}
	for date, gen := range map[string]int{"2026-12-27": 2, "2027-01-01": 1} {
		mine, err := s.UserResults(ctx, 1, date)
		if err != nil || len(mine) != 1 || mine[0].Generator != gen {
			t.Errorf("%s: results = %+v, %v; want generator %d", date, mine, err, gen)
		}
	}
	// Nothing was lost or put under the wrong generator.
	var total, wrong int
	if err := s.db.QueryRow(`SELECT COUNT(*), SUM(generator <> CASE WHEN date BETWEEN '2026-11-02' AND '2026-12-27' THEN 2 ELSE 1 END) FROM results`).Scan(&total, &wrong); err != nil || total != 5 || wrong != 0 {
		t.Errorf("results = %d, wrong generator = %d, %v", total, wrong, err)
	}

	// The new key: the same game in the other generator is free, the old one
	// is still unique.
	if _, created, err := s.InsertResult(ctx, Result{Generator: 2, UserID: 1, Date: "2026-11-01", Level: 1, ElapsedMs: 6000, CompletedAt: "x", Events: "[]"}); err != nil || !created {
		t.Errorf("graded insert after migration: created=%v err=%v", created, err)
	}
	if _, created, err := s.InsertResult(ctx, Result{Generator: 1, UserID: 1, Date: "2026-11-01", Level: 1, ElapsedMs: 6000, CompletedAt: "x"}); err != nil || created {
		t.Errorf("classic duplicate after migration: created=%v err=%v", created, err)
	}
	// The replay foreign key follows the renamed table, the index is rebuilt
	// and the schedule is gone.
	var fk string
	if err := s.db.QueryRow(`SELECT "table" FROM pragma_foreign_key_list('replays')`).Scan(&fk); err != nil || fk != "results" {
		t.Errorf("replay foreign key references %q, %v", fk, err)
	}
	var cols []string
	rows, err := s.db.Query(`SELECT name FROM pragma_index_info('results_by_date') ORDER BY seqno`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var c string
		rows.Scan(&c)
		cols = append(cols, c)
	}
	rows.Close()
	if want := []string{"generator", "date", "level", "elapsed_ms"}; !reflect.DeepEqual(cols, want) {
		t.Errorf("results_by_date = %v, want %v", cols, want)
	}
	var tables int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('generator_schedule', 'results_new', 'replays_new')`).Scan(&tables); err != nil || tables != 0 {
		t.Errorf("left-over tables = %d, %v", tables, err)
	}
	// Seeded from the schedule as of now.
	want := []int{2}
	if y, w := time.Now().UTC().ISOWeek(); fmt.Sprintf("%04d-W%02d", y, w) >= "2026-W53" {
		want = []int{1}
	}
	if got := enabledOf(t, s); !reflect.DeepEqual(got, want) {
		t.Errorf("enabled = %v, want %v", got, want)
	}
}

// TestMigrateSeedsEnabledGenerators checks the enabled generator seeded from
// the schedule: the one in effect now, never a pending change.
func TestMigrateSeedsEnabledGenerators(t *testing.T) {
	for name, c := range map[string]struct {
		stmts []string
		want  []int
	}{
		"never changed":  {nil, []int{1}},
		"graded now":     {[]string{`INSERT INTO generator_schedule VALUES ('2020-W01', 2)`}, []int{2}},
		"graded pending": {[]string{`INSERT INTO generator_schedule VALUES ('9999-W01', 2)`}, []int{1}},
		"classic again, graded pending": {[]string{
			`INSERT INTO generator_schedule VALUES ('2020-W01', 2), ('2021-W01', 1), ('9999-W01', 2)`,
		}, []int{1}},
		"no schedule": {[]string{`DELETE FROM generator_schedule`}, []int{1}},
	} {
		t.Run(name, func(t *testing.T) {
			s, err := Open(context.Background(), buildV6(t, c.stmts...))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if got := enabledOf(t, s); !reflect.DeepEqual(got, c.want) {
				t.Errorf("enabled = %v, want %v", got, c.want)
			}
		})
	}
}
