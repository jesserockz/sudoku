package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/store"
)

func TestBuildLeaderboard(t *testing.T) {
	const alice, bob, carol, dave = 1, 2, 3, 4
	rows := []store.DayResult{
		// Level 1: the API.md example, ties share rank 2, next is 4.
		{UserID: carol, DisplayName: "Carol", Level: 1, ElapsedMs: 183000},
		{UserID: alice, DisplayName: "Alice", Level: 1, ElapsedMs: 183000},
		{UserID: dave, DisplayName: "Dave", Level: 1, ElapsedMs: 200000},
		{UserID: bob, DisplayName: "Bob", Level: 1, ElapsedMs: 150000},
		// Bob and Carol complete all five with equal totals; Alice stops at 3.
		{UserID: bob, DisplayName: "Bob", Level: 2, ElapsedMs: 200000},
		{UserID: carol, DisplayName: "Carol", Level: 2, ElapsedMs: 167000},
		{UserID: alice, DisplayName: "Alice", Level: 2, ElapsedMs: 100000},
		{UserID: bob, DisplayName: "Bob", Level: 3, ElapsedMs: 300000},
		{UserID: carol, DisplayName: "Carol", Level: 3, ElapsedMs: 300000},
		{UserID: alice, DisplayName: "Alice", Level: 3, ElapsedMs: 90000},
		{UserID: bob, DisplayName: "Bob", Level: 4, ElapsedMs: 400000},
		{UserID: carol, DisplayName: "Carol", Level: 4, ElapsedMs: 400000},
		{UserID: bob, DisplayName: "Bob", Level: 5, ElapsedMs: 500000},
		{UserID: carol, DisplayName: "Carol", Level: 5, ElapsedMs: 500000},
	}
	got := buildLeaderboard(rows)

	wantL1 := []puzzleEntry{
		{1, "2", "Bob", 150000},
		{2, "1", "Alice", 183000},
		{2, "3", "Carol", 183000},
		{4, "4", "Dave", 200000},
	}
	if len(got.Puzzles) != 5 {
		t.Fatalf("puzzles = %d", len(got.Puzzles))
	}
	for i, p := range got.Puzzles {
		if p.Level != i+1 {
			t.Errorf("puzzles[%d].level = %d", i, p.Level)
		}
	}
	if !reflect.DeepEqual(got.Puzzles[0].Entries, wantL1) {
		t.Errorf("level 1 = %+v\nwant %+v", got.Puzzles[0].Entries, wantL1)
	}
	wantL3 := []puzzleEntry{{1, "1", "Alice", 90000}, {2, "2", "Bob", 300000}, {2, "3", "Carol", 300000}}
	if !reflect.DeepEqual(got.Puzzles[2].Entries, wantL3) {
		t.Errorf("level 3 = %+v", got.Puzzles[2].Entries)
	}

	// Bob: 150+200+300+400+500 = 1550s; Carol: 183+167+300+400+500 = 1550s.
	wantTotal := []totalEntry{{1, "2", "Bob", 1550000}, {1, "3", "Carol", 1550000}}
	if !reflect.DeepEqual(got.Total.Entries, wantTotal) {
		t.Errorf("total = %+v\nwant %+v", got.Total.Entries, wantTotal)
	}

	wantPlayers := []playerJSON{
		{"1", "Alice", []int{1, 2, 3}},
		{"2", "Bob", []int{1, 2, 3, 4, 5}},
		{"3", "Carol", []int{1, 2, 3, 4, 5}},
		{"4", "Dave", []int{1}},
	}
	if !reflect.DeepEqual(got.Players, wantPlayers) {
		t.Errorf("players = %+v", got.Players)
	}
}

func TestRankCompetition(t *testing.T) {
	items := []scored{{1, "a", 5}, {2, "b", 5}, {3, "c", 5}, {4, "d", 6}, {5, "e", 7}, {6, "f", 7}, {7, "g", 8}}
	if got, want := rank(items), []int{1, 1, 1, 4, 5, 5, 7}; !reflect.DeepEqual(got, want) {
		t.Errorf("ranks = %v, want %v", got, want)
	}
	if got := rank(nil); len(got) != 0 {
		t.Errorf("empty ranks = %v", got)
	}
}

func TestLeaderboardEmptyDayShape(t *testing.T) {
	srv := newTestServer(t, Deps{Clock: clock.NewFake(mondayMorning)})
	resp := do(t, srv, "GET", "/api/v1/leaderboard", alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	raw := decode[json.RawMessage](t, resp)
	want := `{"date":"2026-10-26","puzzles":[{"level":1,"entries":[]},{"level":2,"entries":[]},{"level":3,"entries":[]},{"level":4,"entries":[]},{"level":5,"entries":[]}],"total":{"entries":[]},"players":[]}`
	if string(raw) != want {
		t.Errorf("body = %s\nwant %s", raw, want)
	}
}

func TestLeaderboardEndToEnd(t *testing.T) {
	srv := newTestServer(t, Deps{Clock: clock.NewFake(mondayMorning)})
	submit := func(token, date string, level int, ms int64) {
		t.Helper()
		body := with(with(with(validResult(), "level", level), "elapsedMs", ms), "date", date)
		resp := do(t, srv, "POST", "/api/v1/results", token, body)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("submit status = %d", resp.StatusCode)
		}
		resp.Body.Close()
	}
	for level := 1; level <= 5; level++ {
		submit("dev:bob:Bob", "2026-10-26", level, 60000)
	}
	submit(alice, "2026-10-26", 1, 50000)
	submit(alice, "2026-10-25", 2, 50000) // other day: must not appear

	me := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", alice, nil))

	lb := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard", alice, nil))
	if lb.Date != "2026-10-26" {
		t.Errorf("date = %s", lb.Date)
	}
	l1 := lb.Puzzles[0].Entries
	if len(l1) != 2 || l1[0].UserID != me.ID || l1[0].Rank != 1 || l1[1].DisplayName != "Bob" || l1[1].Rank != 2 {
		t.Errorf("level 1 = %+v", l1)
	}
	if len(lb.Puzzles[1].Entries) != 1 {
		t.Errorf("level 2 should only have Bob: %+v", lb.Puzzles[1].Entries)
	}
	if len(lb.Total.Entries) != 1 || lb.Total.Entries[0].DisplayName != "Bob" || lb.Total.Entries[0].TotalMs != 300000 {
		t.Errorf("total = %+v", lb.Total.Entries)
	}
	if len(lb.Players) != 2 || !reflect.DeepEqual(lb.Players[0].CompletedLevels, []int{1}) {
		t.Errorf("players = %+v", lb.Players)
	}

	sunday := decode[leaderboardResponse](t, do(t, srv, "GET", "/api/v1/leaderboard?date=2026-10-25", alice, nil))
	if len(sunday.Puzzles[1].Entries) != 1 || len(sunday.Players) != 1 {
		t.Errorf("sunday = %+v", sunday)
	}

	expectError(t, do(t, srv, "GET", "/api/v1/leaderboard?date=nope", alice, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, srv, "GET", "/api/v1/leaderboard", "", nil), http.StatusUnauthorized, "unauthorized")
}
