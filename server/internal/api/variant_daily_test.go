package api

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

const (
	variantResultsURL = "/api/v1/variant-daily/results"
	variantBoardURL   = "/api/v1/variant-daily/leaderboard"
)

// dailyVariantOn is the variant of the day of date under the test secret.
func dailyVariantOn(t *testing.T, date string) puzzle.DailyVariant {
	t.Helper()
	d, err := week.ParseDate(date)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := puzzle.ParseWeekSeed(seed.ForWeek([]byte(testSecret), d.ISOWeek()))
	if err != nil {
		t.Fatal(err)
	}
	v, err := puzzle.GenerateDailyVariant(ws, d.Weekday())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// variantDayBody is a valid submission for date.
func variantDayBody(date string, elapsed int64, rep any) map[string]any {
	b := map[string]any{"date": date, "elapsedMs": elapsed, "completedAt": "2026-10-26T09:15:00+13:00"}
	if rep != nil {
		b["replay"] = rep
	}
	return b
}

func (e replayEnv) postVariantDay(t *testing.T, token string, body any, status int) variantDailyResultJSON {
	t.Helper()
	resp := do(t, e.srv, "POST", variantResultsURL, token, body)
	if resp.StatusCode != status {
		t.Fatalf("POST status = %d, want %d", resp.StatusCode, status)
	}
	return decode[variantDailyResultJSON](t, resp)
}

func (e replayEnv) variantBoard(t *testing.T, date string) variantDailyBoard {
	t.Helper()
	resp := do(t, e.srv, "GET", variantBoardURL+"?date="+date, alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("board status = %d", resp.StatusCode)
	}
	return decode[variantDailyBoard](t, resp)
}

func variantAdminURL(date, uid string) string {
	return "/api/v1/admin/variant-daily/results/" + date + "/" + uid
}

func TestVariantDailySubmit(t *testing.T) {
	e := newReplayEnv(t, 1)
	d := dailyVariantOn(t, testDate)
	if d.Variant < puzzle.VariantDiagonal || d.Variant >= puzzle.Variants || (d.Tier != 4 && d.Tier != 5) {
		t.Fatalf("variant %d tier %d", d.Variant, d.Tier)
	}
	rep, elapsed := solveReplay(d.Puzzle)
	want := variantDailyResultJSON{Date: testDate, Variant: d.Variant, ElapsedMs: elapsed, CompletedAt: "2026-10-26T09:15:00+13:00"}
	if got := e.postVariantDay(t, alice, variantDayBody(testDate, elapsed, rep), http.StatusCreated); got != want {
		t.Errorf("result = %+v, want %+v", got, want)
	}
	// Idempotent: the stored (first) result comes back.
	if got := e.postVariantDay(t, alice, variantDayBody(testDate, 6000, nil), http.StatusOK); got != want {
		t.Errorf("duplicate = %+v, want %+v", got, want)
	}

	// The player's own result is in /me/results, beside the classic ones, and
	// only on its date.
	mine := decode[myResultsResponse](t, do(t, e.srv, "GET", "/api/v1/me/results?date="+testDate, alice, nil))
	if mine.VariantDaily == nil || *mine.VariantDaily != want || mine.Results == nil || len(mine.Results) != 0 {
		t.Errorf("me/results = %+v / %+v", mine, mine.VariantDaily)
	}
	other := decode[myResultsResponse](t, do(t, e.srv, "GET", "/api/v1/me/results?date=2026-10-25", alice, nil))
	if other.VariantDaily != nil {
		t.Errorf("another day has %+v", other.VariantDaily)
	}
	// Nothing leaks into the classic daily results.
	if n := len(e.list(t).Results); n != 0 {
		t.Errorf("%d classic results", n)
	}

	// The replay was checked against the day's puzzle and layout.
	r := e.list(t).VariantResults
	if len(r) != 1 || r[0].Replay != "valid" || r[0].Flag != nil || r[0].Variant != d.Variant || r[0].DisplayName != "Alice" {
		t.Errorf("admin list = %+v", r)
	}
}

func TestVariantDailyColourEvents(t *testing.T) {
	e := newReplayEnv(t, 1)
	d := dailyVariantOn(t, testDate)
	rep, elapsed := solveReplay(d.Puzzle)
	cell, pen := 7, 2
	ev := append([]replay.Event{}, rep.Events[:2]...)
	ev = append(ev, replay.Event{T: 0, W: rep.Events[1].W, A: replay.ActColour, C: &cell, P: &pen})
	ev = append(ev, rep.Events[2:]...)
	e.postVariantDay(t, alice, variantDayBody(testDate, elapsed, replay.Replay{Version: 1, Events: ev}), http.StatusCreated)
	if r := e.list(t).VariantResults[0]; r.Replay != "valid" || r.Flag != nil {
		t.Errorf("result = %+v", r)
	}
}

func TestVariantDailyReplayStatuses(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(dailyVariantOn(t, testDate).Puzzle)

	// No replay: stored as missing and flagged by the server.
	e.postVariantDay(t, alice, variantDayBody(testDate, 60000, nil), http.StatusCreated)
	// A replay that does not show the claimed time fails the check.
	e.postVariantDay(t, bobToken, variantDayBody(testDate, elapsed-1000, rep), http.StatusCreated)
	// An empty replay is invalid too, and stored as an empty list.
	e.postVariantDay(t, "dev:carol:Carol", variantDayBody(testDate, 60000, replay.Replay{Version: 1, Events: []replay.Event{}}), http.StatusCreated)

	byName := map[string]adminVariantDailyJSON{}
	for _, r := range e.list(t).VariantResults {
		byName[r.DisplayName] = r
	}
	if r := byName["Alice"]; r.Replay != "missing" || r.Flag == nil || !r.Flag.Auto || r.Flag.Reason != "No replay submitted" {
		t.Errorf("alice = %+v / %+v", r, r.Flag)
	}
	if r := byName["Bob"]; r.Replay != "invalid" || !strings.Contains(r.ReplayError, "finish time") || r.Flag == nil || !r.Flag.Auto || r.Flag.Reason != "Replay check failed: "+r.ReplayError {
		t.Errorf("bob = %+v / %+v", r, r.Flag)
	}
	if r := byName["Carol"]; r.Replay != "invalid" || !strings.Contains(r.ReplayError, "no events") {
		t.Errorf("carol = %+v", r)
	}
	d := decode[adminVariantDailyReplayResponse](t, do(t, e.srv, "GET", variantAdminURL(testDate, e.userID(t, "dev:carol:Carol"))+"/replay", adminToken, nil))
	if d.Events == nil || string(d.Events) != "[]" {
		t.Errorf("events = %s", d.Events)
	}
}

func TestVariantDailyValidation(t *testing.T) {
	e := newReplayEnv(t, 1)
	base := variantDayBody(testDate, 183000, nil)
	tests := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"valid", base, http.StatusCreated, ""},
		{"min elapsed", with(base, "elapsedMs", 5000), http.StatusOK, ""},
		{"below min elapsed", with(base, "elapsedMs", 4999), http.StatusBadRequest, "invalid_result"},
		{"above max elapsed", with(base, "elapsedMs", 86400001), http.StatusBadRequest, "invalid_result"},
		{"8 days ago", with(base, "date", "2026-10-18"), http.StatusCreated, ""},
		{"9 days ago", with(base, "date", "2026-10-17"), http.StatusBadRequest, "invalid_result"},
		{"tomorrow", with(base, "date", "2026-10-27"), http.StatusBadRequest, "invalid_result"},
		{"bad date", with(base, "date", "26/10/2026"), http.StatusBadRequest, "invalid_result"},
		{"bad completedAt", with(base, "completedAt", "yesterday"), http.StatusBadRequest, "invalid_result"},
		{"missing date", with(base, "date", nil), http.StatusBadRequest, "bad_request"},
		{"missing elapsed", with(base, "elapsedMs", nil), http.StatusBadRequest, "bad_request"},
		{"missing completedAt", with(base, "completedAt", nil), http.StatusBadRequest, "bad_request"},
		{"fractional elapsed", with(base, "elapsedMs", 1.5), http.StatusBadRequest, "bad_request"},
		{"not an object", []int{1}, http.StatusBadRequest, "bad_request"},
		{"malformed replay", with(base, "replay", "replay"), http.StatusBadRequest, "invalid_result"},
		{"unknown replay action", with(base, "replay", replay.Replay{Version: 1, Events: []replay.Event{{A: "jump"}}}), http.StatusBadRequest, "invalid_result"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A fresh user per case so earlier results don't make this one a duplicate,
			// except where the case is about the duplicate.
			token := "dev:" + strings.ReplaceAll(tt.name, " ", "-") + ":X"
			if tt.name == "min elapsed" {
				token = "dev:valid:X"
			}
			resp := do(t, e.srv, "POST", variantResultsURL, token, tt.body)
			if tt.code != "" {
				expectError(t, resp, tt.status, tt.code)
				return
			}
			if resp.StatusCode != tt.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.status)
			}
			resp.Body.Close()
		})
	}
	big := with(base, "pad", strings.Repeat("a", 2<<20))
	expectError(t, do(t, e.srv, "POST", variantResultsURL, alice, big), http.StatusRequestEntityTooLarge, "too_large")
	expectError(t, do(t, e.srv, "POST", variantResultsURL, "", base), http.StatusUnauthorized, "unauthorized")
}

func TestVariantDailyBoard(t *testing.T) {
	e := newReplayEnv(t, 1)
	// An empty day still names its variant, with no entries (not null).
	empty := decode[map[string]any](t, do(t, e.srv, "GET", variantBoardURL+"?date="+testDate, alice, nil))
	if entries, ok := empty["entries"].([]any); !ok || len(entries) != 0 || int(empty["variant"].(float64)) != dailyVariantOn(t, testDate).Variant || empty["date"] != testDate {
		t.Errorf("empty board = %+v", empty)
	}

	// Alice and Bob tie, Carol is slower, Dave's result is flagged by an admin; ranks are shared like the other boards.
	e.postVariantDay(t, alice, variantDayBody(testDate, 90000, nil), http.StatusCreated)
	e.postVariantDay(t, bobToken, variantDayBody(testDate, 90000, nil), http.StatusCreated)
	e.postVariantDay(t, "dev:carol:Carol", variantDayBody(testDate, 120000, nil), http.StatusCreated)
	e.postVariantDay(t, "dev:dave:Dave", variantDayBody(testDate, 60000, nil), http.StatusCreated)
	daveID := e.userID(t, "dev:dave:Dave")
	if resp := do(t, e.srv, "PUT", variantAdminURL(testDate, daveID)+"/flag", adminToken, map[string]string{"reason": "hmm"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("flag status = %d", resp.StatusCode)
	}

	// Alice played the day before, so she is on a two day streak.
	aliceID, err := strconv.ParseInt(e.userID(t, alice), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.st.InsertResult(t.Context(), store.Result{UserID: aliceID, Generator: 1, Date: "2026-10-25", Level: 1, ElapsedMs: 70000, CompletedAt: "2026-10-25T09:00:00+13:00"}); err != nil {
		t.Fatal(err)
	}

	board := e.variantBoard(t, testDate)
	type row struct {
		rank   int
		name   string
		ms     int64
		sus    bool
		streak int
	}
	var got []row
	for _, en := range board.Entries {
		got = append(got, row{en.Rank, en.DisplayName, en.ElapsedMs, en.Suspicious, en.Streak})
	}
	want := []row{{1, "Dave", 60000, true, 0}, {2, "Alice", 90000, false, 2}, {2, "Bob", 90000, false, 1}, {4, "Carol", 120000, false, 1}}
	if len(got) != len(want) {
		t.Fatalf("board = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if board.Variant != dailyVariantOn(t, testDate).Variant || board.Date != testDate {
		t.Errorf("board = %+v", board)
	}

	// Never part of the classic Total, and the classic boards are unchanged.
	classic := e.leaderboard(t)
	if len(classic.Total.Entries) != 0 || len(classic.Puzzles[0].Entries) != 0 {
		t.Errorf("classic board = %+v", classic)
	}

	// The date defaults to today, and a bad one is refused.
	today := decode[variantDailyBoard](t, do(t, e.srv, "GET", variantBoardURL, alice, nil))
	if today.Date != testDate || len(today.Entries) != 4 {
		t.Errorf("default board = %+v", today)
	}
	expectError(t, do(t, e.srv, "GET", variantBoardURL+"?date=nope", alice, nil), http.StatusBadRequest, "bad_request")
}

func TestVariantDailyCountsTowardsTheStreak(t *testing.T) {
	e := newReplayEnv(t, 1)
	uid := e.userID(t, alice)
	// Yesterday's classic result and today's variant of the day make two days.
	id, err := strconv.ParseInt(uid, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.st.InsertResult(t.Context(), store.Result{UserID: id, Generator: 1, Date: "2026-10-25", Level: 1, ElapsedMs: 70000, CompletedAt: "2026-10-25T09:00:00+13:00"}); err != nil {
		t.Fatal(err)
	}
	streak := func() streakJSON {
		t.Helper()
		return decode[statsResponse](t, do(t, e.srv, "GET", "/api/v1/me/stats", alice, nil)).Streak
	}
	if s := streak(); s.Current != 1 {
		t.Fatalf("streak before = %+v", s)
	}
	e.postVariantDay(t, alice, variantDayBody(testDate, 90000, nil), http.StatusCreated)
	if s := streak(); s.Current != 2 || s.Best != 2 || s.LastDate == nil || *s.LastDate != testDate {
		t.Errorf("streak with the variant of the day = %+v", s)
	}
	// An admin flag takes it out again; the server's own flag (no replay) did not.
	if resp := do(t, e.srv, "PUT", variantAdminURL(testDate, uid)+"/flag", adminToken, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("flag status = %d", resp.StatusCode)
	}
	if s := streak(); s.Current != 1 {
		t.Errorf("streak with it flagged = %+v", s)
	}

	// A day with only the variant of the day still counts for a player with no classic results.
	e.postVariantDay(t, bobToken, variantDayBody(testDate, 90000, nil), http.StatusCreated)
	if s := decode[statsResponse](t, do(t, e.srv, "GET", "/api/v1/me/stats", bobToken, nil)).Streak; s.Current != 1 || s.Best != 1 {
		t.Errorf("bob's streak = %+v", s)
	}
}

func TestVariantDailyAdmin(t *testing.T) {
	e := newReplayEnv(t, 1)
	d := dailyVariantOn(t, testDate)
	rep, elapsed := solveReplay(d.Puzzle)
	e.postVariantDay(t, alice, variantDayBody(testDate, elapsed, rep), http.StatusCreated)
	uid := e.userID(t, alice)

	// Players cannot reach the admin routes.
	expectError(t, do(t, e.srv, "GET", variantAdminURL(testDate, uid)+"/replay", alice, nil), http.StatusForbidden, "forbidden")
	expectError(t, do(t, e.srv, "PUT", variantAdminURL(testDate, uid)+"/flag", alice, nil), http.StatusForbidden, "forbidden")
	expectError(t, do(t, e.srv, "DELETE", variantAdminURL(testDate, uid)+"/flag", alice, nil), http.StatusForbidden, "forbidden")

	resp := do(t, e.srv, "GET", variantAdminURL(testDate, uid)+"/replay", adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", resp.StatusCode)
	}
	detail := decode[adminVariantDailyReplayResponse](t, resp)
	if detail.Replay != "valid" || detail.Variant != d.Variant || detail.Date != testDate || detail.Givens != d.Givens || len(detail.Events) == 0 {
		t.Errorf("detail = %+v", detail.adminVariantDailyJSON)
	}
	// The layout is the puzzle's (nil for a layout-less variant would still decode).
	if want := toLayoutJSON(d.Layout); detail.Layout == nil || detail.Layout.Diagonals != want.Diagonals || len(detail.Layout.Cages) != len(want.Cages) || detail.Layout.Regions != want.Regions {
		t.Errorf("layout = %+v, want %+v", detail.Layout, want)
	}
	if strings.Contains(string(detail.Events), d.Solution) {
		t.Error("the replay detail leaks the solution")
	}

	// Flag, replace and unflag, as for the other results.
	flagged := decode[adminVariantDailyJSON](t, do(t, e.srv, "PUT", variantAdminURL(testDate, uid)+"/flag", adminToken, map[string]string{"reason": "  odd "}))
	if flagged.Flag == nil || flagged.Flag.Reason != "odd" || flagged.Flag.Auto || flagged.Flag.FlaggedBy == nil || flagged.Flag.FlaggedBy.DisplayName == "" {
		t.Errorf("flag = %+v", flagged.Flag)
	}
	if e.variantBoard(t, testDate).Entries[0].Suspicious != true {
		t.Error("an admin flag is shown on the board")
	}
	unflagged := decode[adminVariantDailyJSON](t, do(t, e.srv, "DELETE", variantAdminURL(testDate, uid)+"/flag", adminToken, nil))
	if unflagged.Flag != nil {
		t.Errorf("flag after unflag = %+v", unflagged.Flag)
	}
	// The reason is optional, and limited to 500 characters.
	if resp := do(t, e.srv, "PUT", variantAdminURL(testDate, uid)+"/flag", adminToken, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("flag without a body = %d", resp.StatusCode)
	}
	expectError(t, do(t, e.srv, "PUT", variantAdminURL(testDate, uid)+"/flag", adminToken, map[string]string{"reason": strings.Repeat("a", 501)}), http.StatusBadRequest, "bad_request")

	// Bad paths and missing results.
	expectError(t, do(t, e.srv, "GET", variantAdminURL("nope", uid)+"/replay", adminToken, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, e.srv, "GET", variantAdminURL(testDate, "x")+"/replay", adminToken, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, e.srv, "GET", variantAdminURL(testDate, "0")+"/replay", adminToken, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, e.srv, "GET", variantAdminURL(testDate, "999")+"/replay", adminToken, nil), http.StatusNotFound, "not_found")
	expectError(t, do(t, e.srv, "PUT", variantAdminURL(testDate, "999")+"/flag", adminToken, nil), http.StatusNotFound, "not_found")
	expectError(t, do(t, e.srv, "DELETE", variantAdminURL(testDate, "999")+"/flag", adminToken, nil), http.StatusNotFound, "not_found")
}

func TestVariantDailyStoreFailures(t *testing.T) {
	setup := func(t *testing.T) (replayEnv, string) {
		e := newReplayEnv(t, 1)
		rep, elapsed := solveReplay(dailyVariantOn(t, testDate).Puzzle)
		e.postVariantDay(t, alice, variantDayBody(testDate, elapsed, rep), http.StatusCreated)
		return e, e.userID(t, alice)
	}
	rename := "ALTER TABLE daily_variant_results RENAME TO gone"
	tests := []struct {
		name   string
		method string
		path   func(uid string) string
		token  string
		break_ string
	}{
		{"post", "POST", func(string) string { return variantResultsURL }, "dev:erin:Erin", rename},
		{"post replay", "POST", func(string) string { return variantResultsURL }, "dev:erin:Erin", "ALTER TABLE daily_variant_replays RENAME TO gone"},
		{"me results", "GET", func(string) string { return "/api/v1/me/results?date=" + testDate }, alice, rename},
		{"board results", "GET", func(string) string { return variantBoardURL + "?date=" + testDate }, alice, "ALTER TABLE daily_variant_results RENAME COLUMN variant TO gone"},
		{"board streaks", "GET", func(string) string { return variantBoardURL + "?date=" + testDate }, alice, "ALTER TABLE results RENAME TO gone"},
		{"stats", "GET", func(string) string { return "/api/v1/me/stats" }, alice, rename},
		{"admin list", "GET", func(string) string { return "/api/v1/admin/results?date=" + testDate }, adminToken, rename},
		{"admin replay result", "GET", func(uid string) string { return variantAdminURL(testDate, uid) + "/replay" }, adminToken, rename},
		{"admin replay events", "GET", func(uid string) string { return variantAdminURL(testDate, uid) + "/replay" }, adminToken, "ALTER TABLE daily_variant_replays RENAME TO gone"},
		{"flag", "PUT", func(uid string) string { return variantAdminURL(testDate, uid) + "/flag" }, adminToken, rename},
		{"unflag", "DELETE", func(uid string) string { return variantAdminURL(testDate, uid) + "/flag" }, adminToken, rename},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, uid := setup(t)
			e.sabotage(t, tt.break_)
			var body any
			if tt.method == "POST" {
				rep, elapsed := solveReplay(dailyVariantOn(t, testDate).Puzzle)
				body = variantDayBody(testDate, elapsed, rep)
			}
			expectError(t, do(t, e.srv, tt.method, tt.path(uid), tt.token, body), http.StatusInternalServerError, "internal")
		})
	}
}

func TestVariantDailyCache(t *testing.T) {
	old := variantDailyCacheSize
	variantDailyCacheSize = 2
	t.Cleanup(func() { variantDailyCacheSize = old })
	deps := adminConfig()
	deps.Store = newTestStore(t)
	s := New(deps)
	dates := []string{"2026-10-26", "2026-10-27", "2026-10-28"}
	var days []week.Date
	for _, d := range dates {
		day, err := week.ParseDate(d)
		if err != nil {
			t.Fatal(err)
		}
		days = append(days, day)
	}
	first := s.variantDailyFor(days[0])
	if again := s.variantDailyFor(days[0]); again.Givens != first.Givens || again.Variant != first.Variant {
		t.Error("the cached puzzle differs")
	}
	s.variantDailyFor(days[1])
	s.variantDailyFor(days[2])
	// Past its bound the oldest date is dropped.
	if _, ok := s.variantDaily.get(dates[0]); ok {
		t.Error("the oldest puzzle is still cached")
	}
	for _, d := range dates[1:] {
		if _, ok := s.variantDaily.get(d); !ok {
			t.Errorf("%s was dropped", d)
		}
	}
	// A date added twice (two requests generated it at once) is kept once.
	s.variantDaily.put(dates[2], first)
	if len(s.variantDaily.order) != 2 {
		t.Errorf("order = %v", s.variantDaily.order)
	}
	if got, _ := s.variantDaily.get(dates[2]); got.Givens == first.Givens {
		t.Error("the second put replaced the first")
	}
	if s.variantDailyOf(days[0]) != first.Variant {
		t.Error("variantDailyOf disagrees with the puzzle")
	}
}

// A result submitted without a replay shows an empty event list to admins,
// and the flag routes refuse malformed keys.
func TestVariantDailyAdminWithoutReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postVariantDay(t, alice, variantDayBody(testDate, 6000, nil), http.StatusCreated)
	uid := e.userID(t, alice)
	got := decode[adminVariantDailyReplayResponse](t, do(t, e.srv, "GET", variantAdminURL(testDate, uid)+"/replay", adminToken, nil))
	if string(got.Events) != "[]" {
		t.Errorf("events = %s, want []", got.Events)
	}
	expectError(t, do(t, e.srv, "PUT", variantAdminURL(testDate, "x")+"/flag", adminToken, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, e.srv, "DELETE", variantAdminURL(testDate, "x")+"/flag", adminToken, nil), http.StatusBadRequest, "bad_request")
}
