package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// days parses YYYY-MM-DD dates.
func days(t *testing.T, ds ...string) []week.Date {
	t.Helper()
	out := make([]week.Date, len(ds))
	for i, s := range ds {
		d, err := week.ParseDate(s)
		if err != nil {
			t.Fatal(err)
		}
		out[i] = d
	}
	return out
}

func TestComputeStreak(t *testing.T) {
	str := func(s string) *string { return &s }
	tests := []struct {
		name  string
		today string
		dates []string
		want  streakJSON
	}{
		{"empty", "2026-11-05", nil, streakJSON{}},
		{"single day today", "2026-11-05", []string{"2026-11-05"}, streakJSON{1, 1, str("2026-11-05")}},
		{"single day yesterday", "2026-11-05", []string{"2026-11-04"}, streakJSON{1, 1, str("2026-11-04")}},
		{"gap of two days", "2026-11-05", []string{"2026-11-03"}, streakJSON{0, 1, str("2026-11-03")}},
		{"long ago", "2026-11-05", []string{"2026-10-01", "2026-10-02", "2026-10-03"}, streakJSON{0, 3, str("2026-10-03")}},
		{"run ending today", "2026-11-05", []string{"2026-11-03", "2026-11-04", "2026-11-05"}, streakJSON{3, 3, str("2026-11-05")}},
		{"run ending yesterday", "2026-11-05", []string{"2026-11-02", "2026-11-03", "2026-11-04"}, streakJSON{3, 3, str("2026-11-04")}},
		{"across a month", "2026-11-02", []string{"2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"}, streakJSON{4, 4, str("2026-11-02")}},
		{"across a year", "2026-01-03", []string{"2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"}, streakJSON{4, 4, str("2026-01-02")}},
		{"across a leap day", "2028-03-01", []string{"2028-02-28", "2028-02-29", "2028-03-01"}, streakJSON{3, 3, str("2028-03-01")}},
		{"across spring forward", "2026-09-28", []string{"2026-09-26", "2026-09-27", "2026-09-28"}, streakJSON{3, 3, str("2026-09-28")}},
		{"across fall back", "2026-04-06", []string{"2026-04-04", "2026-04-05", "2026-04-06"}, streakJSON{3, 3, str("2026-04-06")}},
		{"best beyond current", "2026-11-05", []string{
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-11-04", "2026-11-05",
		}, streakJSON{2, 5, str("2026-11-05")}},
		{"current is best", "2026-11-05", []string{"2026-10-01", "2026-10-03", "2026-11-03", "2026-11-04", "2026-11-05"}, streakJSON{3, 3, str("2026-11-05")}},
		{"gaps break runs", "2026-11-05", []string{"2026-11-01", "2026-11-03", "2026-11-05"}, streakJSON{1, 1, str("2026-11-05")}},
		{"duplicates", "2026-11-05", []string{"2026-11-04", "2026-11-04", "2026-11-05", "2026-11-05"}, streakJSON{2, 2, str("2026-11-05")}},
		{"future date", "2026-11-05", []string{"2026-11-06"}, streakJSON{0, 1, str("2026-11-06")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			today := days(t, tt.today)[0]
			if got := computeStreak(days(t, tt.dates...), today); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v (last %v), want %+v (last %v)", got, got.LastDate, tt.want, tt.want.LastDate)
			}
		})
	}
}

func TestStreakOn(t *testing.T) {
	tests := []struct {
		name  string
		day   string
		dates []string
		want  int
	}{
		{"none", "2026-11-05", nil, 0},
		{"only that day", "2026-11-05", []string{"2026-11-05"}, 1},
		{"run ending on it", "2026-11-05", []string{"2026-11-01", "2026-11-04", "2026-11-05"}, 2},
		{"not played that day", "2026-11-05", []string{"2026-11-03", "2026-11-04"}, 0},
		{"duplicates", "2026-11-05", []string{"2026-11-05", "2026-11-05"}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := streakOn(days(t, tt.dates...), days(t, tt.day)[0]); got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

func TestMeanMs(t *testing.T) {
	for _, tt := range []struct{ total, n, want int64 }{
		{10, 1, 10}, {10, 4, 3}, {11, 4, 3}, {3, 2, 2}, {5, 3, 2}, {4, 3, 1}, {140250 * 3, 3, 140250},
	} {
		if got := meanMs(tt.total, tt.n); got != tt.want {
			t.Errorf("meanMs(%d, %d) = %d, want %d", tt.total, tt.n, got, tt.want)
		}
	}
}

func TestBuildStatsTiersFollowEachWeeksLevelCount(t *testing.T) {
	// W44 has five games a day, W45 three (Easy, Hard, Diabolical).
	schedule := store.Schedule{{EffectiveWeek: "0000-W00", Levels: 5}, {EffectiveWeek: "2026-W45", Levels: 3}}
	results := []store.UserDailyResult{
		{Date: "2026-10-26", Level: 1, ElapsedMs: 1000},
		{Date: "2026-10-26", Level: 2, ElapsedMs: 2000},
		{Date: "2026-10-26", Level: 3, ElapsedMs: 3000},
		{Date: "2026-10-26", Level: 4, ElapsedMs: 4000},
		{Date: "2026-10-26", Level: 5, ElapsedMs: 5000},
		{Date: "2026-11-02", Level: 1, ElapsedMs: 3000},
		{Date: "2026-11-02", Level: 2, ElapsedMs: 5000, AdminFlagged: true},
		{Date: "2026-11-02", Level: 3, ElapsedMs: 7000},
		{Date: "2026-11-02", Level: 4, ElapsedMs: 9000}, // beyond the week's three games
	}
	got := buildStats(days(t, "2026-11-02")[0], results, schedule, v1Only, 1, nil)

	completed := make([]int, 5)
	for i, d := range got.Daily {
		completed[i] = d.Completed
		if d.Difficulty != i+1 {
			t.Errorf("daily[%d].difficulty = %d", i, d.Difficulty)
		}
	}
	// Tier 1: W44 L1 and W45 L1. Tier 2: W44 L2. Tier 3: W44 L3 and W45 L2.
	// Tier 4: W44 L4. Tier 5: W44 L5 and W45 L3.
	if want := []int{2, 1, 2, 1, 2}; !reflect.DeepEqual(completed, want) {
		t.Errorf("completed = %v, want %v", completed, want)
	}
	t3 := got.Daily[2]
	if *t3.BestMs != 3000 || *t3.AverageMs != 4000 {
		t.Errorf("tier 3 best/average = %d/%d", *t3.BestMs, *t3.AverageMs)
	}
	wantRecent := []recentJSON{{"2026-10-26", 3, 3000}, {"2026-11-02", 2, 5000}}
	if !reflect.DeepEqual(t3.Recent, wantRecent) {
		t.Errorf("tier 3 recent = %+v, want %+v", t3.Recent, wantRecent)
	}
	// The admin-flagged result still counts as played, but not for the
	// streak, and the over-range one is ignored entirely.
	if got.Streak.Best != 1 || got.Streak.Current != 1 || *got.Streak.LastDate != "2026-11-02" {
		t.Errorf("streak = %+v", got.Streak)
	}
}

func TestBuildStatsRecentKeepsLatestTwenty(t *testing.T) {
	schedule := store.Schedule{{EffectiveWeek: "0000-W00", Levels: 5}}
	var results []store.UserDailyResult
	start := days(t, "2026-09-01")[0]
	for i := 0; i < 25; i++ {
		results = append(results, store.UserDailyResult{Date: start.AddDays(i).String(), Level: 1, ElapsedMs: int64(1000 + i)})
	}
	d := buildStats(start.AddDays(24), results, schedule, v1Only, 1, nil).Daily[0]
	if d.Completed != 25 || len(d.Recent) != 20 {
		t.Fatalf("completed %d, recent %d", d.Completed, len(d.Recent))
	}
	if d.Recent[0].Date != "2026-09-06" || d.Recent[19].Date != "2026-09-25" {
		t.Errorf("recent runs %s .. %s", d.Recent[0].Date, d.Recent[19].Date)
	}
	if *d.BestMs != 1000 || *d.AverageMs != 1012 {
		t.Errorf("best/average = %d/%d", *d.BestMs, *d.AverageMs)
	}
}

func TestBuildStatsEmpty(t *testing.T) {
	got := buildStats(days(t, "2026-11-05")[0], nil, store.Schedule{{EffectiveWeek: "0000-W00", Levels: 5}}, v1Only, 1, nil)
	if got.Streak.LastDate != nil || got.Streak.Current != 0 || got.Streak.Best != 0 {
		t.Errorf("streak = %+v", got.Streak)
	}
	if len(got.Daily) != 5 || len(got.Endless) != 5 {
		t.Fatalf("daily %d, endless %d", len(got.Daily), len(got.Endless))
	}
	for i := range got.Daily {
		d, e := got.Daily[i], got.Endless[i]
		if d.Completed != 0 || d.BestMs != nil || d.AverageMs != nil || d.Recent == nil || len(d.Recent) != 0 {
			t.Errorf("daily[%d] = %+v", i, d)
		}
		if e.Difficulty != i+1 || e.Completed != 0 || e.Highest != 0 || e.BestMs != nil || e.AverageMs != nil {
			t.Errorf("endless[%d] = %+v", i, e)
		}
	}
}

func TestMyStatsEndToEnd(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	srv := newTestServer(t, Deps{Store: st, Clock: clock.NewFake(mondayMorning)})
	user := func(sub, name string) int64 {
		u, err := st.UpsertUser(ctx, sub, name)
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	admin := user("dev:admin", "Admin")
	a, b, c := user("dev:alice", "Alice"), user("dev:bob", "Bob"), user("dev:carol", "Carol")
	put := func(uid int64, date string, level int, ms int64, auto string) {
		t.Helper()
		if _, _, err := st.InsertResult(ctx, store.Result{UserID: uid, Date: date, Level: level, ElapsedMs: ms, CompletedAt: "x", AutoFlag: auto}); err != nil {
			t.Fatal(err)
		}
	}
	// Alice: a five day run long ago, then 24th (auto-flagged, still counts),
	// 25th and 26th.
	for d := 10; d <= 14; d++ {
		put(a, fmt.Sprintf("2026-10-%02d", d), 1, 100000, "")
	}
	put(a, "2026-10-24", 1, 150000, "No replay submitted")
	put(a, "2026-10-25", 1, 200000, "")
	put(a, "2026-10-26", 1, 250000, "")
	put(a, "2026-10-26", 3, 90000, "")
	put(a, "2026-10-26", 5, 60000, "")
	// Bob: the 25th is admin-flagged so does not count; only today does.
	put(b, "2026-10-25", 1, 70000, "")
	put(b, "2026-10-26", 2, 80000, "")
	if err := st.FlagResult(ctx, b, "2026-10-25", 1, admin, "bad", time.Now()); err != nil {
		t.Fatal(err)
	}
	// Carol played yesterday only.
	put(c, "2026-10-25", 4, 99000, "")

	for _, r := range []store.EndlessResult{
		{UserID: a, Generator: 1, Difficulty: 2, Number: 3, ElapsedMs: 120000},
		{UserID: a, Generator: 1, Difficulty: 2, Number: 12, ElapsedMs: 181000},
		{UserID: a, Generator: 1, Difficulty: 2, Number: 5, ElapsedMs: 100000, AutoFlag: "No replay submitted"},
		// Another series is not in the Classic stats.
		{UserID: a, Generator: 2, Difficulty: 2, Number: 1, ElapsedMs: 5000},
	} {
		r.CompletedAt, r.ReplayStatus = "x", "missing"
		if _, _, err := st.InsertEndlessResult(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	get := func(token string) statsResponse {
		t.Helper()
		resp := do(t, srv, "GET", "/api/v1/me/stats", token, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		return decode[statsResponse](t, resp)
	}

	ga := get(alice)
	if ga.Today != "2026-10-26" {
		t.Errorf("today = %s", ga.Today)
	}
	if s := ga.Streak; s.Current != 3 || s.Best != 5 || s.LastDate == nil || *s.LastDate != "2026-10-26" {
		t.Errorf("alice streak = %+v", s)
	}
	completed := []int{}
	for _, d := range ga.Daily {
		completed = append(completed, d.Completed)
	}
	if want := []int{8, 0, 1, 0, 1}; !reflect.DeepEqual(completed, want) {
		t.Errorf("alice completed = %v, want %v", completed, want)
	}
	d1 := ga.Daily[0]
	if *d1.BestMs != 100000 || *d1.AverageMs != 137500 || len(d1.Recent) != 8 {
		t.Errorf("alice tier 1 = %+v", d1)
	}
	if d1.Recent[0].Date != "2026-10-10" || d1.Recent[7] != (recentJSON{"2026-10-26", 1, 250000}) {
		t.Errorf("alice tier 1 recent = %+v", d1.Recent)
	}
	if want := (endlessStatJSON{2, 3, 12, ptr(int64(100000)), ptr(int64(133667))}); !reflect.DeepEqual(ga.Endless[1], want) {
		t.Errorf("alice endless 2 = %+v, want %+v", ga.Endless[1], want)
	}
	if e := ga.Endless[0]; e.Completed != 0 || e.BestMs != nil {
		t.Errorf("alice endless 1 = %+v", e)
	}

	// An admin flag keeps the day off the streak but the result in the record.
	gb := get("dev:bob:Bob")
	if s := gb.Streak; s.Current != 1 || s.Best != 1 || *s.LastDate != "2026-10-26" {
		t.Errorf("bob streak = %+v", s)
	}
	if gb.Daily[0].Completed != 1 || gb.Daily[1].Completed != 1 {
		t.Errorf("bob daily = %+v", gb.Daily)
	}

	// Yesterday keeps the streak alive while today is still to play.
	if s := get("dev:carol:Carol").Streak; s.Current != 1 || s.Best != 1 || *s.LastDate != "2026-10-25" {
		t.Errorf("carol streak = %+v", s)
	}

	// A newcomer gets zeros and the fixed shape.
	body := decode[json.RawMessage](t, do(t, srv, "GET", "/api/v1/me/stats", "dev:eve:Eve", nil))
	if !strings.HasPrefix(string(body), `{"generator":1,"today":"2026-10-26","streak":{"current":0,"best":0,"lastDate":null},"daily":[{"difficulty":1,"completed":0,"bestMs":null,"averageMs":null,"recent":[]}`) ||
		!strings.HasSuffix(string(body), `{"difficulty":5,"completed":0,"highest":0,"bestMs":null,"averageMs":null}]}`) {
		t.Errorf("empty body = %s", body)
	}

	expectError(t, do(t, srv, "GET", "/api/v1/me/stats", "", nil), http.StatusUnauthorized, "unauthorized")

	// The leaderboard shows each player's streak as of the board's date.
	streaks := func(query string) map[string]int {
		t.Helper()
		lb := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard"+query, alice, nil))
		out := map[string]int{}
		for _, p := range lb.Players {
			out[p.DisplayName] = p.Streak
		}
		return out
	}
	if got, want := streaks(""), map[string]int{"Alice": 3, "Bob": 1}; !reflect.DeepEqual(got, want) {
		t.Errorf("today's streaks = %v, want %v", got, want)
	}
	// On the 25th Alice had two days; Bob's only result that day is flagged.
	if got, want := streaks("?date=2026-10-25"), map[string]int{"Alice": 2, "Bob": 0, "Carol": 1}; !reflect.DeepEqual(got, want) {
		t.Errorf("yesterday's streaks = %v, want %v", got, want)
	}
	if got := streaks("?date=2026-10-14"); !reflect.DeepEqual(got, map[string]int{"Alice": 5}) {
		t.Errorf("old streaks = %v", got)
	}
}

func TestMyStatsStoreFailures(t *testing.T) {
	for _, table := range []string{"results", "level_schedule", "endless_results"} {
		t.Run(table, func(t *testing.T) {
			e := newReplayEnv(t, 5)
			e.sabotage(t, "ALTER TABLE "+table+" RENAME TO gone")
			expectError(t, do(t, e.srv, "GET", "/api/v1/me/stats", alice, nil), http.StatusInternalServerError, "internal")
		})
	}
}

func TestLeaderboardStoreFailures(t *testing.T) {
	// The streaks are fetched first and touch only results; the board itself
	// also needs each result's level.
	for name, stmt := range map[string]string{
		"streaks": "ALTER TABLE results RENAME TO gone",
		"board":   "ALTER TABLE results RENAME COLUMN level TO lvl",
	} {
		t.Run(name, func(t *testing.T) {
			e := newReplayEnv(t, 5)
			e.sabotage(t, stmt)
			expectError(t, do(t, e.srv, "GET", "/api/v1/leaderboard", alice, nil), http.StatusInternalServerError, "internal")
		})
	}
}

// v1Only is a generator schedule that never leaves v1.
var v1Only = store.GeneratorSchedule{{EffectiveWeek: "0000-W00", Version: 1}}
