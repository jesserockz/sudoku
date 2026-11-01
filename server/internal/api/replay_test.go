package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

const (
	bobToken  = "dev:bob:Bob"
	testDate  = "2026-10-26" // a Monday, in ISO week 2026-W44
	testWeek  = "2026-W44"
	flagTime  = "2026-10-25T20:00:00.000Z" // mondayMorning in UTC
	replayURL = "/api/v1/admin/results/" + testDate + "/1/"
)

// replayEnv is a server with a given number of levels per day, an admin and
// the store's file path for sabotage.
type replayEnv struct {
	srv  *httptest.Server
	st   *store.Store
	path string
}

func newReplayEnv(t *testing.T, levels int) replayEnv {
	t.Helper()
	path := filepath.Join(t.TempDir(), "replay.db")
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.ScheduleLevels(context.Background(), testWeek, "2026-W45", levels); err != nil {
		t.Fatal(err)
	}
	deps := adminConfig()
	deps.Store = st
	deps.Clock = clock.NewFake(mondayMorning)
	return replayEnv{srv: newTestServer(t, deps), st: st, path: path}
}

// sabotage runs SQL against the database behind the store's back.
func (e replayEnv) sabotage(t *testing.T, stmts ...string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+e.path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
}

func testPuzzle(t *testing.T, level, levels int) puzzle.Puzzle {
	t.Helper()
	d, err := week.ParseDate(testDate)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := puzzle.ParseWeekSeed(seed.ForWeek([]byte(testSecret), testWeek))
	if err != nil {
		t.Fatal(err)
	}
	p, err := puzzle.Generate(ws, d.Weekday(), level, levels)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// solveReplay plays p to its solution at one cell per second.
func solveReplay(p puzzle.Puzzle) (replay.Replay, int64) {
	at := func(a string, ms int64) replay.Event {
		return replay.Event{T: ms, W: 1_761_423_000_000 + ms, A: a}
	}
	ev := []replay.Event{at(replay.ActStart, 0), at(replay.ActResume, 0)}
	var ms int64
	for c := 0; c < 81; c++ {
		if p.Givens[c] != '0' {
			continue
		}
		ms += 1000
		e := at(replay.ActPlace, ms)
		cell, digit := c, int(p.Solution[c]-'0')
		e.C, e.D = &cell, &digit
		ev = append(ev, e)
	}
	ev = append(ev, at(replay.ActFinish, ms))
	return replay.Replay{Version: 1, Events: ev}, ms
}

func resultBody(level int, elapsed int64, rep any) map[string]any {
	b := with(with(validResult(), "level", level), "elapsedMs", elapsed)
	if rep != nil {
		b["replay"] = rep
	}
	return b
}

func (e replayEnv) post(t *testing.T, token string, body any, status int) {
	t.Helper()
	resp := do(t, e.srv, "POST", "/api/v1/results", token, body)
	if resp.StatusCode != status {
		t.Fatalf("POST status = %d, want %d", resp.StatusCode, status)
	}
	resp.Body.Close()
}

func (e replayEnv) postErr(t *testing.T, token string, body any, status int, code string) {
	t.Helper()
	expectError(t, do(t, e.srv, "POST", "/api/v1/results", token, body), status, code)
}

func (e replayEnv) userID(t *testing.T, token string) string {
	t.Helper()
	return decode[meResponse](t, do(t, e.srv, "GET", "/api/v1/me", token, nil)).ID
}

func (e replayEnv) list(t *testing.T) adminResultsResponse {
	t.Helper()
	resp := do(t, e.srv, "GET", "/api/v1/admin/results?date="+testDate, adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", resp.StatusCode)
	}
	return decode[adminResultsResponse](t, resp)
}

func (e replayEnv) leaderboard(t *testing.T) leaderboardResponse {
	t.Helper()
	return decode[leaderboardResponse](t, do(t, e.srv, "GET", "/api/v1/leaderboard?date="+testDate, alice, nil))
}

func TestPostResultWithValidReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)

	list := e.list(t)
	if list.Levels != 1 || len(list.Results) != 1 {
		t.Fatalf("list = %+v", list)
	}
	r := list.Results[0]
	if r.Replay != "valid" || r.ReplayError != "" || r.Flag != nil || r.DisplayName != "Alice" || r.ElapsedMs != elapsed {
		t.Errorf("result = %+v", r)
	}
	lb := e.leaderboard(t)
	if lb.Puzzles[0].Entries[0].Suspicious || lb.Total.Entries[0].Suspicious {
		t.Errorf("valid replay marked suspicious: %+v", lb)
	}
}

func TestPostResultWithoutReplayIsFlagged(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.post(t, alice, resultBody(1, 40000, nil), http.StatusCreated)
	e.post(t, bobToken, resultBody(1, 45000, json.RawMessage("null")), http.StatusCreated)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.post(t, "dev:carol:Carol", resultBody(1, elapsed, rep), http.StatusCreated)

	list := e.list(t)
	for _, r := range list.Results[:2] {
		if r.Replay != "missing" || r.Flag == nil || !r.Flag.Auto || r.Flag.FlaggedBy != nil || r.Flag.Reason != "No replay submitted" {
			t.Errorf("%s = %+v / %+v", r.DisplayName, r, r.Flag)
		}
		if r.Flag.FlaggedAt != r.SubmittedAt {
			t.Errorf("flaggedAt %q != submittedAt %q", r.Flag.FlaggedAt, r.SubmittedAt)
		}
	}

	lb := e.leaderboard(t)
	got := map[string]bool{}
	for _, en := range lb.Puzzles[0].Entries {
		got[en.DisplayName] = en.Suspicious
	}
	if !reflectEqual(got, map[string]bool{"Alice": false, "Bob": false, "Carol": false}) {
		t.Errorf("puzzle suspicious = %v", got)
	}
	got = map[string]bool{}
	for _, en := range lb.Total.Entries {
		got[en.DisplayName] = en.Suspicious
	}
	if !reflectEqual(got, map[string]bool{"Alice": false, "Bob": false, "Carol": false}) {
		t.Errorf("total suspicious = %v", got)
	}

	// An admin confirming Alice's automatic flag makes it public.
	do(t, e.srv, "PUT", replayURL+e.userID(t, alice)+"/flag", adminToken, map[string]string{"reason": "No replay submitted"})
	lb = e.leaderboard(t)
	got = map[string]bool{}
	for _, en := range lb.Puzzles[0].Entries {
		got[en.DisplayName] = en.Suspicious
	}
	if !reflectEqual(got, map[string]bool{"Alice": true, "Bob": false, "Carol": false}) {
		t.Errorf("puzzle suspicious after confirming = %v", got)
	}
	// A flagged result stays listed and ranked.
	if lb.Puzzles[0].Entries[0].DisplayName != "Alice" || lb.Puzzles[0].Entries[0].Rank != 1 {
		t.Errorf("entries = %+v", lb.Puzzles[0].Entries)
	}
}

func reflectEqual[T comparable](a, b map[string]T) bool {
	return len(a) == len(b) && func() bool {
		for k, v := range a {
			if w, ok := b[k]; !ok || w != v {
				return false
			}
		}
		return true
	}()
}

func TestTotalIsSuspiciousWhenAnyLevelIs(t *testing.T) {
	e := newReplayEnv(t, 2)
	// Level 1 with a valid replay, level 2 without one.
	rep, elapsed := solveReplay(testPuzzle(t, 1, 2))
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
	e.post(t, alice, resultBody(2, 60000, nil), http.StatusCreated)
	do(t, e.srv, "PUT", "/api/v1/admin/results/"+testDate+"/2/"+e.userID(t, alice)+"/flag", adminToken, map[string]string{"reason": "No replay submitted"})
	lb := e.leaderboard(t)
	if lb.Puzzles[0].Entries[0].Suspicious || !lb.Puzzles[1].Entries[0].Suspicious || !lb.Total.Entries[0].Suspicious {
		t.Errorf("leaderboard = %+v", lb)
	}
}

func TestPostResultWithInvalidReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	// Claim a faster time than the replay shows.
	e.post(t, alice, resultBody(1, elapsed-1000, rep), http.StatusCreated)

	r := e.list(t).Results[0]
	if r.Replay != "invalid" || !strings.Contains(r.ReplayError, "finish time") {
		t.Errorf("result = %+v", r)
	}
	if r.Flag == nil || !r.Flag.Auto || r.Flag.Reason != "Replay check failed: "+r.ReplayError {
		t.Errorf("flag = %+v", r.Flag)
	}
	if e.leaderboard(t).Puzzles[0].Entries[0].Suspicious {
		t.Error("automatically flagged result public on the leaderboard")
	}
	// It is still stored, to be watched back.
	d := e.replayDetail(t, e.userID(t, alice))
	if len(d.Events) == 0 {
		t.Error("no events stored")
	}

	// A duplicate submission changes nothing.
	good, goodElapsed := solveReplay(testPuzzle(t, 1, 1))
	e.post(t, alice, resultBody(1, goodElapsed, good), http.StatusOK)
	if r := e.list(t).Results[0]; r.Replay != "invalid" || r.Flag == nil {
		t.Errorf("duplicate changed the result: %+v", r)
	}
}

func TestPostResultEmptyReplayIsInvalid(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.post(t, alice, resultBody(1, 60000, replay.Replay{Version: 1, Events: []replay.Event{}}), http.StatusCreated)
	r := e.list(t).Results[0]
	if r.Replay != "invalid" || !strings.Contains(r.ReplayError, "no events") {
		t.Errorf("result = %+v", r)
	}
	if d := e.replayDetail(t, e.userID(t, alice)); d.Events == nil || len(d.Events) != 0 {
		t.Errorf("events = %v", d.Events)
	}
}

func TestPostResultReplayLimits(t *testing.T) {
	e := newReplayEnv(t, 1)

	hidden := make([]replay.Event, replay.MaxEvents+1)
	for i := range hidden {
		hidden[i] = replay.Event{A: replay.ActHidden}
	}
	cell := 3
	tests := []struct {
		name string
		rep  any
	}{
		{"too many events", replay.Replay{Version: 1, Events: hidden}},
		{"wrong version", replay.Replay{Version: 2}},
		{"unknown action", replay.Replay{Version: 1, Events: []replay.Event{{A: "jump"}}}},
		{"stray field", replay.Replay{Version: 1, Events: []replay.Event{{A: replay.ActUndo, C: &cell}}}},
		{"not an object", "replay"},
		{"fractional time", json.RawMessage(`{"version":1,"events":[{"t":1.5,"w":0,"a":"start"}]}`)},
		{"unknown field", json.RawMessage(`{"version":1,"events":[],"extra":1}`)},
		{"unknown event field", json.RawMessage(`{"version":1,"events":[{"t":0,"w":0,"a":"start","x":1}]}`)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e.postErr(t, alice, resultBody(1, 60000, tt.rep), http.StatusBadRequest, "invalid_result")
		})
	}
	// Exactly the maximum is accepted.
	e.post(t, alice, resultBody(1, 60000, replay.Replay{Version: 1, Events: hidden[:replay.MaxEvents]}), http.StatusCreated)
}

func TestPostResultTooLarge(t *testing.T) {
	e := newReplayEnv(t, 1)
	big := with(validResult(), "pad", strings.Repeat("a", 2<<20))
	e.postErr(t, alice, big, http.StatusRequestEntityTooLarge, "too_large")
	// Other routes keep their small cap (and answer 400 as before).
	expectError(t, do(t, e.srv, "PUT", replayURL+"1/flag", adminToken, map[string]string{"reason": strings.Repeat("a", 100_000)}),
		http.StatusBadRequest, "bad_request")
}

func TestReplayCheckNeedsAPuzzle(t *testing.T) {
	// An absurd level count makes the puzzle impossible to generate.
	e := newReplayEnv(t, puzzle.MaxLevels+1)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.postErr(t, alice, resultBody(1, elapsed, rep), http.StatusInternalServerError, "internal")

	// Without a replay there is no puzzle to build, but watching it back needs one.
	e.post(t, alice, resultBody(1, 60000, nil), http.StatusCreated)
	expectError(t, do(t, e.srv, "GET", replayURL+e.userID(t, alice)+"/replay", adminToken, nil), http.StatusInternalServerError, "internal")
}

func TestAdminResultsGate(t *testing.T) {
	routes := []struct{ method, path string }{
		{"GET", "/api/v1/admin/results"},
		{"GET", replayURL + "1/replay"},
		{"PUT", replayURL + "1/flag"},
		{"DELETE", replayURL + "1/flag"},
	}
	e := newReplayEnv(t, 1)
	for _, rt := range routes {
		expectError(t, do(t, e.srv, rt.method, rt.path, "", nil), http.StatusUnauthorized, "unauthorized")
		expectError(t, do(t, e.srv, rt.method, rt.path, alice, nil), http.StatusForbidden, "forbidden")
	}
	// Without an [admin] config nobody gets in.
	none := newTestServer(t, Deps{})
	for _, rt := range routes {
		expectError(t, do(t, none, rt.method, rt.path, adminToken, nil), http.StatusForbidden, "forbidden")
	}
}

func TestAdminResultsList(t *testing.T) {
	e := newReplayEnv(t, 2)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 2))
	e.post(t, alice, resultBody(2, 90000, nil), http.StatusCreated)
	e.post(t, bobToken, resultBody(1, elapsed, rep), http.StatusCreated)
	e.post(t, alice, resultBody(1, elapsed+500, rep), http.StatusCreated)
	e.post(t, alice, with(resultBody(1, 70000, nil), "date", "2026-10-25"), http.StatusCreated)

	got := e.list(t)
	if got.Date != testDate || got.Levels != 2 || len(got.Results) != 3 {
		t.Fatalf("list = %+v", got)
	}
	var order []string
	for _, r := range got.Results {
		order = append(order, r.DisplayName+":"+string(rune('0'+r.Level)))
	}
	if !slices.Equal(order, []string{"Bob:1", "Alice:1", "Alice:2"}) {
		t.Errorf("order = %v", order)
	}
	first := got.Results[0]
	if first.UserID != e.userID(t, bobToken) || first.CompletedAt != "2026-10-26T09:15:00+13:00" || first.SubmittedAt == "" {
		t.Errorf("first = %+v", first)
	}

	// Raw JSON: flag is null, not absent, when unflagged; replayError is a string.
	resp := do(t, e.srv, "GET", "/api/v1/admin/results?date="+testDate, adminToken, nil)
	raw := decode[map[string]any](t, resp)
	r0 := raw["results"].([]any)[0].(map[string]any)
	if v, ok := r0["flag"]; !ok || v != nil {
		t.Errorf("flag = %#v", v)
	}

	// The date defaults to today and may be any past day.
	if def := decode[adminResultsResponse](t, do(t, e.srv, "GET", "/api/v1/admin/results", adminToken, nil)); def.Date != testDate || len(def.Results) != 3 {
		t.Errorf("default list = %+v", def)
	}
	past := decode[adminResultsResponse](t, do(t, e.srv, "GET", "/api/v1/admin/results?date=2026-10-25", adminToken, nil))
	if len(past.Results) != 1 || past.Results[0].Replay != "missing" {
		t.Errorf("past = %+v", past)
	}
	empty := decode[map[string]any](t, do(t, e.srv, "GET", "/api/v1/admin/results?date=2026-01-01", adminToken, nil))
	if res, ok := empty["results"].([]any); !ok || len(res) != 0 {
		t.Errorf("empty results = %#v", empty["results"])
	}
	expectError(t, do(t, e.srv, "GET", "/api/v1/admin/results?date=nope", adminToken, nil), http.StatusBadRequest, "bad_request")
}

type replayDetail struct {
	adminResultJSON
	Date   string            `json:"date"`
	Levels int               `json:"levels"`
	Givens string            `json:"givens"`
	Events []json.RawMessage `json:"events"`
}

func (e replayEnv) replayDetail(t *testing.T, uid string) replayDetail {
	t.Helper()
	resp := do(t, e.srv, "GET", replayURL+uid+"/replay", adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", resp.StatusCode)
	}
	return decode[replayDetail](t, resp)
}

func TestAdminReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	p := testPuzzle(t, 1, 1)
	rep, elapsed := solveReplay(p)
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
	e.post(t, bobToken, resultBody(1, 60000, nil), http.StatusCreated)

	uid := e.userID(t, alice)
	resp := do(t, e.srv, "GET", replayURL+uid+"/replay", adminToken, nil)
	var body strings.Builder
	var raw map[string]json.RawMessage
	dec := decode[map[string]json.RawMessage](t, resp)
	raw = dec
	for k := range raw {
		body.WriteString(k + " ")
	}
	if _, has := raw["solution"]; has || strings.Contains(string(raw["givens"]), p.Solution) {
		t.Error("the solution leaked")
	}
	for _, k := range []string{"date", "levels", "givens", "events", "userId", "replay", "flag", "replayError"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing %q in %s", k, body.String())
		}
	}

	d := e.replayDetail(t, uid)
	if d.Date != testDate || d.Levels != 1 || d.Givens != p.Givens || d.Replay != "valid" || d.DisplayName != "Alice" {
		t.Errorf("detail = %+v", d.adminResultJSON)
	}
	if len(d.Events) != len(rep.Events) {
		t.Fatalf("events = %d, want %d", len(d.Events), len(rep.Events))
	}
	want, _ := json.Marshal(rep.Events[2])
	if string(d.Events[2]) != string(want) {
		t.Errorf("event 2 = %s, want %s", d.Events[2], want)
	}

	// No replay: events is an empty array.
	if nr := e.replayDetail(t, e.userID(t, bobToken)); nr.Events == nil || len(nr.Events) != 0 || nr.Replay != "missing" {
		t.Errorf("missing replay detail = %+v", nr)
	}
}

func TestAdminReplayAndFlagParams(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.post(t, alice, resultBody(1, 60000, nil), http.StatusCreated)
	uid := e.userID(t, alice)
	base := "/api/v1/admin/results/"
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		suffix := "/flag"
		if method == "GET" {
			suffix = "/replay"
		}
		for name, path := range map[string]string{
			"bad date":      base + "2026-13-01/1/" + uid + suffix,
			"level text":    base + testDate + "/x/" + uid + suffix,
			"level zero":    base + testDate + "/0/" + uid + suffix,
			"user text":     base + testDate + "/1/x" + suffix,
			"user zero":     base + testDate + "/1/0" + suffix,
			"user negative": base + testDate + "/1/-3" + suffix,
		} {
			expectError(t, do(t, e.srv, method, path, adminToken, nil), http.StatusBadRequest, "bad_request")
			_ = name
		}
		for name, path := range map[string]string{
			"unknown user":  base + testDate + "/1/99" + suffix,
			"unknown level": base + testDate + "/2/" + uid + suffix,
			"unknown date":  base + "2026-10-25/1/" + uid + suffix,
		} {
			expectError(t, do(t, e.srv, method, path, adminToken, nil), http.StatusNotFound, "not_found")
			_ = name
		}
	}
}

func TestAdminFlagAndUnflag(t *testing.T) {
	e := newReplayEnv(t, 1)
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
	uid := e.userID(t, alice)
	path := replayURL + uid + "/flag"
	annID := e.userID(t, adminToken)

	put := func(body any) *http.Response { return do(t, e.srv, "PUT", path, adminToken, body) }

	// Flag with a reason: trimmed, with the calling admin and the clock's time.
	resp := put(map[string]string{"reason": "  Way faster than usual \n"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	item := decode[adminResultJSON](t, resp)
	f := item.Flag
	if f == nil || f.Reason != "Way faster than usual" || f.Auto || f.FlaggedAt != flagTime ||
		f.FlaggedBy == nil || f.FlaggedBy.UserID != annID || f.FlaggedBy.DisplayName != "Ann" {
		t.Errorf("flag = %+v / %+v", f, f.FlaggedBy)
	}
	if item.Replay != "valid" || item.UserID != uid {
		t.Errorf("item = %+v", item)
	}
	if lb := e.leaderboard(t); !lb.Puzzles[0].Entries[0].Suspicious || !lb.Total.Entries[0].Suspicious {
		t.Error("flagged result not suspicious on the leaderboard")
	}
	if got := e.list(t).Results[0].Flag; got == nil || got.FlaggedBy == nil || got.FlaggedBy.DisplayName != "Ann" {
		t.Errorf("listed flag = %+v", got)
	}

	// Flagging again replaces the flag; the reason is optional (empty body, or {}).
	resp = do(t, e.srv, "PUT", path, adminToken, nil)
	if f := decode[adminResultJSON](t, resp).Flag; f == nil || f.Reason != "" || f.Auto {
		t.Errorf("empty-body flag = %+v", f)
	}
	if f := decode[adminResultJSON](t, put(map[string]string{})).Flag; f == nil || f.Reason != "" {
		t.Errorf("empty-object flag = %+v", f)
	}

	// 500 characters is the limit, counted as characters not bytes.
	if r := put(map[string]string{"reason": strings.Repeat("é", 500)}); r.StatusCode != http.StatusOK {
		t.Errorf("500 char reason status = %d", r.StatusCode)
	}
	expectError(t, put(map[string]string{"reason": strings.Repeat("é", 501)}), http.StatusBadRequest, "bad_request")
	// Trimming happens before the length check.
	if r := put(map[string]string{"reason": " " + strings.Repeat("a", 500) + " "}); r.StatusCode != http.StatusOK {
		t.Errorf("padded 500 char reason status = %d", r.StatusCode)
	}
	expectError(t, do(t, e.srv, "PUT", path, adminToken, map[string]int{"reason": 5}), http.StatusBadRequest, "bad_request")

	// Unflag.
	resp = do(t, e.srv, "DELETE", path, adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE status = %d", resp.StatusCode)
	}
	if item := decode[adminResultJSON](t, resp); item.Flag != nil {
		t.Errorf("still flagged: %+v", item.Flag)
	}
	if lb := e.leaderboard(t); lb.Puzzles[0].Entries[0].Suspicious {
		t.Error("unflagged result still suspicious")
	}
	// Unflagging an unflagged result is fine too.
	if resp := do(t, e.srv, "DELETE", path, adminToken, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("second DELETE status = %d", resp.StatusCode)
	}
}

func TestAdminUnflagsAutomaticFlag(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.post(t, alice, resultBody(1, 60000, nil), http.StatusCreated)
	resp := do(t, e.srv, "DELETE", replayURL+e.userID(t, alice)+"/flag", adminToken, nil)
	item := decode[adminResultJSON](t, resp)
	if item.Flag != nil || item.Replay != "missing" {
		t.Errorf("item = %+v", item)
	}
	// An admin flag replaces an automatic one.
	resp = do(t, e.srv, "PUT", replayURL+e.userID(t, alice)+"/flag", adminToken, map[string]string{"reason": "seen"})
	if f := decode[adminResultJSON](t, resp).Flag; f == nil || f.Auto || f.FlaggedBy == nil {
		t.Errorf("flag = %+v", f)
	}
}

func TestAdminResultsStoreFailures(t *testing.T) {
	setup := func(t *testing.T) (replayEnv, string) {
		e := newReplayEnv(t, 1)
		rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
		e.post(t, alice, resultBody(1, elapsed, rep), http.StatusCreated)
		return e, e.userID(t, alice)
	}
	tests := []struct {
		name   string
		method string
		path   func(uid string) string
		break_ string
	}{
		{"list levels", "GET", func(string) string { return "/api/v1/admin/results" }, "ALTER TABLE level_schedule RENAME TO gone"},
		{"list results", "GET", func(string) string { return "/api/v1/admin/results" }, "ALTER TABLE results RENAME TO gone"},
		{"replay result", "GET", func(uid string) string { return replayURL + uid + "/replay" }, "ALTER TABLE results RENAME TO gone"},
		{"replay events", "GET", func(uid string) string { return replayURL + uid + "/replay" }, "ALTER TABLE replays RENAME TO gone"},
		{"replay levels", "GET", func(uid string) string { return replayURL + uid + "/replay" }, "ALTER TABLE level_schedule RENAME TO gone"},
		{"flag", "PUT", func(uid string) string { return replayURL + uid + "/flag" }, "ALTER TABLE results RENAME TO gone"},
		{"unflag", "DELETE", func(uid string) string { return replayURL + uid + "/flag" }, "ALTER TABLE results RENAME TO gone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, uid := setup(t)
			e.sabotage(t, tt.break_)
			expectError(t, do(t, e.srv, tt.method, tt.path(uid), adminToken, nil), http.StatusInternalServerError, "internal")
		})
	}
}

func TestPostResultStoreFailure(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.sabotage(t, "ALTER TABLE replays RENAME TO gone")
	rep, elapsed := solveReplay(testPuzzle(t, 1, 1))
	e.postErr(t, alice, resultBody(1, elapsed, rep), http.StatusInternalServerError, "internal")
	// Nothing was stored: the insert and the replay share a transaction.
	e.sabotage(t, "ALTER TABLE gone RENAME TO replays")
	if n := len(e.list(t).Results); n != 0 {
		t.Errorf("%d results stored after a failed insert", n)
	}
}

func TestResultsFromBeforeReplays(t *testing.T) {
	e := newReplayEnv(t, 1)
	uid := e.userID(t, alice)
	// A row as the previous schema version stored it: no replay columns.
	e.sabotage(t, `INSERT INTO results (user_id, date, level, elapsed_ms, completed_at)
		VALUES (`+uid+`, '`+testDate+`', 1, 123000, '2026-10-26T09:15:00+13:00')`)

	r := e.list(t).Results[0]
	if r.Replay != "none" || r.Flag != nil || r.ReplayError != "" {
		t.Errorf("result = %+v", r)
	}
	if e.leaderboard(t).Puzzles[0].Entries[0].Suspicious {
		t.Error("an old result is suspicious")
	}
	if d := e.replayDetail(t, uid); d.Replay != "none" || d.Events == nil || len(d.Events) != 0 {
		t.Errorf("detail = %+v", d)
	}
}
