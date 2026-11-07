package store

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func generatorAt(t *testing.T, s *Store, week string) int {
	t.Helper()
	v, err := s.GeneratorForWeek(context.Background(), week)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func scheduleGenerator(t *testing.T, s *Store, this, next string, version int) string {
	t.Helper()
	eff, err := s.ScheduleGenerator(context.Background(), this, next, version)
	if err != nil {
		t.Fatal(err)
	}
	return eff
}

func TestGeneratorDefaultsToOne(t *testing.T) {
	s, _ := openTemp(t)
	for _, w := range []string{"2020-W01", "2026-W44", "2030-W10"} {
		if v := generatorAt(t, s, w); v != 1 {
			t.Errorf("%s: generator = %d, want the seeded 1", w, v)
		}
	}
}

func TestScheduleGeneratorIsAlwaysPending(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)

	// Nobody has played, yet the change still waits for next week.
	if eff := scheduleGenerator(t, s, "2026-W44", "2026-W45", 2); eff != "2026-W45" {
		t.Errorf("effective = %s, want next week", eff)
	}
	if a, b := generatorAt(t, s, "2026-W44"), generatorAt(t, s, "2026-W45"); a != 1 || b != 2 {
		t.Errorf("W44 W45 = %d %d, want 1 2", a, b)
	}

	// Choosing the version already in effect cancels the pending change.
	if eff := scheduleGenerator(t, s, "2026-W44", "2026-W45", 1); eff != "2026-W44" {
		t.Errorf("cancel effective = %s, want this week", eff)
	}
	if v := generatorAt(t, s, "2026-W45"); v != 1 {
		t.Errorf("W45 after cancel = %d", v)
	}
	// Cancelling with nothing pending changes nothing.
	scheduleGenerator(t, s, "2026-W44", "2026-W45", 1)

	// A pending change is replaced by a later choice.
	scheduleGenerator(t, s, "2026-W44", "2026-W45", 2)
	scheduleGenerator(t, s, "2026-W44", "2026-W45", 2)
	sc, err := s.GeneratorSchedule(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := GeneratorSchedule{{FirstWeek, 1}, {"2026-W45", 2}}
	if !reflect.DeepEqual(sc, want) {
		t.Errorf("schedule = %+v, want %+v", sc, want)
	}

	// Next week it is in effect; switching back is pending again and the
	// weeks already played keep their version.
	if eff := scheduleGenerator(t, s, "2026-W45", "2026-W46", 1); eff != "2026-W46" {
		t.Errorf("switch back effective = %s", eff)
	}
	if a, b, c := generatorAt(t, s, "2026-W44"), generatorAt(t, s, "2026-W45"), generatorAt(t, s, "2026-W46"); a != 1 || b != 2 || c != 1 {
		t.Errorf("W44..W46 = %d %d %d, want 1 2 1", a, b, c)
	}
	// Across a year boundary the latest entry still applies.
	if v := generatorAt(t, s, "2027-W01"); v != 1 {
		t.Errorf("2027-W01 = %d", v)
	}
}

func TestGeneratorScheduleVersionFor(t *testing.T) {
	sc := GeneratorSchedule{{FirstWeek, 1}, {"2026-W45", 2}, {"2026-W47", 1}}
	for week, want := range map[string]int{"2020-W01": 1, "2026-W44": 1, "2026-W45": 2, "2026-W46": 2, "2026-W47": 1, "2027-W01": 1} {
		if got := sc.VersionFor(week); got != want {
			t.Errorf("%s: version = %d, want %d", week, got, want)
		}
	}
	if got := (GeneratorSchedule{}).VersionFor("2026-W44"); got != 0 {
		t.Errorf("empty schedule = %d, want 0", got)
	}
}

func TestGeneratorSchedulePending(t *testing.T) {
	sc := GeneratorSchedule{{FirstWeek, 1}, {"2026-W45", 2}}
	if got := sc.Pending("2026-W44"); got == nil || *got != (GeneratorEntry{"2026-W45", 2}) {
		t.Errorf("pending = %+v", got)
	}
	if got := sc.Pending("2026-W45"); got != nil {
		t.Errorf("in effect is not pending: %+v", got)
	}
	if got := (GeneratorSchedule{}).Pending("2026-W44"); got != nil {
		t.Errorf("empty = %+v", got)
	}
}

func TestGeneratorQueriesFailOnClosedStore(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	s.Close()
	_, e1 := s.GeneratorForWeek(ctx, "2026-W44")
	_, e2 := s.GeneratorSchedule(ctx)
	_, e3 := s.ScheduleGenerator(ctx, "2026-W44", "2026-W45", 2)
	for name, err := range map[string]error{"GeneratorForWeek": e1, "GeneratorSchedule": e2, "ScheduleGenerator": e3} {
		if err == nil || !strings.Contains(err.Error(), "generator") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestGeneratorScheduleScanFailure(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	// A NULL version cannot be scanned into an int.
	if _, err := s.db.Exec(`DROP TABLE generator_schedule`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TABLE generator_schedule (effective_week TEXT, version INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO generator_schedule VALUES ('0000-W00', NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GeneratorSchedule(ctx); err == nil || !strings.Contains(err.Error(), "generator schedule") {
		t.Errorf("err = %v", err)
	}
}

func TestScheduleGeneratorWithoutBaseRow(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	if _, err := s.db.Exec(`DELETE FROM generator_schedule`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ScheduleGenerator(ctx, "2026-W44", "2026-W45", 2); err == nil {
		t.Error("expected an error with no current version")
	}
}

func TestScheduleGeneratorStatementFailures(t *testing.T) {
	ctx := context.Background()
	// The schema refuses version 0, so the insert fails.
	s, _ := openTemp(t)
	if _, err := s.ScheduleGenerator(ctx, "2026-W44", "2026-W45", 0); err == nil {
		t.Error("expected the insert to fail")
	}
	// Without the table the first statement fails.
	if _, err := s.db.Exec(`DROP TABLE generator_schedule`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ScheduleGenerator(ctx, "2026-W44", "2026-W45", 2); err == nil {
		t.Error("expected the delete to fail")
	}
}
