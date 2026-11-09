package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
)

const maxNumber = 9007199254740991

func endlessPuzzle(t *testing.T, difficulty int, number int64) puzzle.Puzzle {
	t.Helper()
	return endlessPuzzleG(t, puzzle.VersionClassic, difficulty, number)
}

// endlessPuzzleG is endlessPuzzle for generator version.
func endlessPuzzleG(t *testing.T, generator, difficulty int, number int64) puzzle.Puzzle {
	t.Helper()
	es, err := puzzle.ParseWeekSeed(seed.ForEndless([]byte(testSecret)))
	if err != nil {
		t.Fatal(err)
	}
	p, err := puzzle.GenerateEndlessVersion(generator, es, difficulty, number)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func endlessBody(difficulty int, number int64, elapsed int64, rep any) map[string]any {
	b := map[string]any{
		"difficulty":  difficulty,
		"number":      number,
		"elapsedMs":   elapsed,
		"completedAt": "2026-10-26T09:15:00+13:00",
	}
	if rep != nil {
		b["replay"] = rep
	}
	return b
}

func (e replayEnv) postEndless(t *testing.T, token string, body any, status int) {
	t.Helper()
	resp := do(t, e.srv, "POST", "/api/v1/endless/results", token, body)
	if resp.StatusCode != status {
		t.Fatalf("POST status = %d, want %d", resp.StatusCode, status)
	}
	resp.Body.Close()
}

// postSolved submits a valid replay of the endless puzzle and returns the elapsed time.
func (e replayEnv) postSolved(t *testing.T, token string, difficulty int, number int64) int64 {
	t.Helper()
	rep, elapsed := solveReplay(endlessPuzzle(t, difficulty, number))
	e.postEndless(t, token, endlessBody(difficulty, number, elapsed, rep), http.StatusCreated)
	return elapsed
}

func (e replayEnv) endlessList(t *testing.T, query string) adminEndlessResultsResponse {
	t.Helper()
	resp := do(t, e.srv, "GET", "/api/v1/admin/endless/results"+query, adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", resp.StatusCode)
	}
	return decode[adminEndlessResultsResponse](t, resp)
}

func endlessURL(difficulty int, number int64, uid string) string {
	return "/api/v1/admin/endless/results/" + strconv.Itoa(difficulty) + "/" + strconv.FormatInt(number, 10) + "/" + uid
}

func TestGetEndlessSeed(t *testing.T) {
	srv := newTestServer(t, Deps{})
	resp := do(t, srv, "GET", "/api/v1/endless", alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := decode[endlessSeedResponse](t, resp); got.Seed != "3242a2d84b0602b6" {
		t.Errorf("seed = %q", got.Seed)
	}
	expectError(t, do(t, srv, "GET", "/api/v1/endless", "", nil), http.StatusUnauthorized, "unauthorized")
}

func TestEndlessRoutesRequireAuth(t *testing.T) {
	srv := newTestServer(t, adminConfig())
	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/v1/me/endless"},
		{"POST", "/api/v1/endless/results"},
		{"GET", "/api/v1/endless/leaderboard"},
		{"GET", "/api/v1/endless/leaderboard/1/1"},
		{"GET", "/api/v1/admin/endless/results"},
		{"GET", "/api/v1/admin/endless/results/1/1/1/replay"},
		{"PUT", "/api/v1/admin/endless/results/1/1/1/flag"},
		{"DELETE", "/api/v1/admin/endless/results/1/1/1/flag"},
	} {
		expectError(t, do(t, srv, rt.method, rt.path, "", nil), http.StatusUnauthorized, "unauthorized")
		if strings.Contains(rt.path, "/admin/") {
			expectError(t, do(t, srv, rt.method, rt.path, alice, nil), http.StatusForbidden, "forbidden")
		}
	}
}

func TestPostEndlessResultCaps(t *testing.T) {
	e := newReplayEnv(t, 1)
	base := endlessBody(1, 1, 183000, nil)
	tests := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"valid", base, http.StatusCreated, ""},
		{"difficulty 5", with(base, "difficulty", 5), http.StatusCreated, ""},
		{"difficulty 0", with(base, "difficulty", 0), http.StatusBadRequest, "invalid_result"},
		{"difficulty 6", with(base, "difficulty", 6), http.StatusBadRequest, "invalid_result"},
		{"number max", with(base, "number", int64(maxNumber)), http.StatusCreated, ""},
		{"number above max", with(base, "number", int64(maxNumber)+1), http.StatusBadRequest, "invalid_result"},
		{"number 0", with(base, "number", 0), http.StatusBadRequest, "invalid_result"},
		{"number negative", with(base, "number", -4), http.StatusBadRequest, "invalid_result"},
		{"min elapsed", with(with(base, "number", 2), "elapsedMs", 5000), http.StatusCreated, ""},
		{"below min elapsed", with(base, "elapsedMs", 4999), http.StatusBadRequest, "invalid_result"},
		{"max elapsed", with(with(base, "number", 3), "elapsedMs", 86400000), http.StatusCreated, ""},
		{"above max elapsed", with(base, "elapsedMs", 86400001), http.StatusBadRequest, "invalid_result"},
		{"bad completedAt", with(base, "completedAt", "yesterday"), http.StatusBadRequest, "invalid_result"},
		{"completedAt without offset", with(base, "completedAt", "2026-10-26T09:15:00"), http.StatusBadRequest, "invalid_result"},
		{"missing difficulty", with(base, "difficulty", nil), http.StatusBadRequest, "bad_request"},
		{"missing number", with(base, "number", nil), http.StatusBadRequest, "bad_request"},
		{"missing elapsedMs", with(base, "elapsedMs", nil), http.StatusBadRequest, "bad_request"},
		{"missing completedAt", with(base, "completedAt", nil), http.StatusBadRequest, "bad_request"},
		{"fractional number", with(base, "number", 1.5), http.StatusBadRequest, "bad_request"},
		{"string difficulty", with(base, "difficulty", "1"), http.StatusBadRequest, "bad_request"},
		{"not an object", []int{1, 2}, http.StatusBadRequest, "bad_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A fresh user per case so earlier results don't make this one a duplicate.
			resp := do(t, e.srv, "POST", "/api/v1/endless/results", "dev:"+tt.name+":X", tt.body)
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
}

func TestPostEndlessResultReplayLimits(t *testing.T) {
	e := newReplayEnv(t, 1)
	for name, rep := range map[string]any{
		"wrong version": replay.Replay{Version: 2},
		"not an object": "replay",
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, endlessBody(1, 1, 60000, rep)), http.StatusBadRequest, "invalid_result")
		})
	}
	big := with(endlessBody(1, 1, 60000, nil), "pad", strings.Repeat("a", 2<<20))
	expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, big), http.StatusRequestEntityTooLarge, "too_large")
}

func TestPostEndlessResultIdempotent(t *testing.T) {
	e := newReplayEnv(t, 1)
	resp := do(t, e.srv, "POST", "/api/v1/endless/results", alice, endlessBody(2, 7, 183000, nil))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first status = %d", resp.StatusCode)
	}
	want := endlessResultJSON{Generator: 1, Difficulty: 2, Number: 7, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00"}
	if first := decode[endlessResultJSON](t, resp); first != want {
		t.Errorf("first = %+v", first)
	}

	// A different retry: first one wins, stored result returned.
	retry := with(with(endlessBody(2, 7, 6000, nil), "completedAt", "2026-10-26T10:00:00Z"), "difficulty", 2)
	resp = do(t, e.srv, "POST", "/api/v1/endless/results", alice, retry)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate status = %d", resp.StatusCode)
	}
	if dup := decode[endlessResultJSON](t, resp); dup != want {
		t.Errorf("duplicate returned %+v, want stored %+v", dup, want)
	}

	// Another user, another number and another difficulty are independent.
	e.postEndless(t, bobToken, endlessBody(2, 7, 183000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(2, 8, 183000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(3, 7, 183000, nil), http.StatusCreated)
}

func TestPostEndlessResultReplays(t *testing.T) {
	e := newReplayEnv(t, 1)
	elapsed := e.postSolved(t, alice, 2, 7)
	e.postEndless(t, bobToken, endlessBody(2, 7, 60000, nil), http.StatusCreated)
	e.postEndless(t, "dev:carol:Carol", endlessBody(2, 7, 61000, json.RawMessage("null")), http.StatusCreated)
	// Claim a faster time than the replay shows.
	rep, replayElapsed := solveReplay(endlessPuzzle(t, 2, 7))
	e.postEndless(t, "dev:dave:Dave", endlessBody(2, 7, replayElapsed-1000, rep), http.StatusCreated)
	// A replay of a different puzzle does not solve this one.
	other, otherElapsed := solveReplay(endlessPuzzle(t, 2, 8))
	e.postEndless(t, "dev:erin:Erin", endlessBody(2, 7, otherElapsed, other), http.StatusCreated)
	// An empty replay is stored as invalid, with an empty event list.
	e.postEndless(t, "dev:fay:Fay", endlessBody(2, 7, 70000, replay.Replay{Version: 1, Events: []replay.Event{}}), http.StatusCreated)

	day := "2026-10-26"
	e.sabotage(t, "UPDATE endless_results SET submitted_at = '2026-10-26T01:00:00.000Z'")
	list := e.endlessList(t, "?date="+day)
	if len(list.Results) != 6 {
		t.Fatalf("results = %d", len(list.Results))
	}
	by := map[string]adminEndlessResultJSON{}
	for _, r := range list.Results {
		by[r.DisplayName] = r
	}
	if r := by["Alice"]; r.Replay != "valid" || r.ReplayError != "" || r.Flag != nil || r.ElapsedMs != elapsed || r.Difficulty != 2 || r.Number != 7 {
		t.Errorf("Alice = %+v", r)
	}
	for _, name := range []string{"Bob", "Carol"} {
		r := by[name]
		if r.Replay != "missing" || r.Flag == nil || !r.Flag.Auto || r.Flag.FlaggedBy != nil || r.Flag.Reason != "No replay submitted" {
			t.Errorf("%s = %+v / %+v", name, r, r.Flag)
		}
	}
	for _, name := range []string{"Dave", "Erin", "Fay"} {
		r := by[name]
		if r.Replay != "invalid" || r.ReplayError == "" || r.Flag == nil || !r.Flag.Auto || r.Flag.Reason != "Replay check failed: "+r.ReplayError {
			t.Errorf("%s = %+v / %+v", name, r, r.Flag)
		}
	}

	// Automatic flags are not public.
	resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard/2/7", alice, nil)
	for _, en := range decode[endlessPuzzleBoard](t, resp).Entries {
		if en.Suspicious {
			t.Errorf("automatically flagged result public: %+v", en)
		}
	}

	// The failed replays are still stored, to be watched back.
	if d := e.endlessDetail(t, 2, 7, e.userID(t, "dev:fay:Fay")); d.Events == nil || len(d.Events) != 0 {
		t.Errorf("empty replay events = %v", d.Events)
	}
	if d := e.endlessDetail(t, 2, 7, e.userID(t, "dev:dave:Dave")); len(d.Events) == 0 {
		t.Error("invalid replay not stored")
	}

	// A duplicate changes nothing.
	good, goodElapsed := solveReplay(endlessPuzzle(t, 2, 7))
	e.postEndless(t, "dev:dave:Dave", endlessBody(2, 7, goodElapsed, good), http.StatusOK)
	if d := e.endlessDetail(t, 2, 7, e.userID(t, "dev:dave:Dave")); d.Replay != "invalid" || d.Flag == nil {
		t.Errorf("duplicate changed the result: %+v", d.adminEndlessResultJSON)
	}
}

func TestGetMyEndless(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, endlessBody(3, 2, 70000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 10, 80000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 2, 90000, nil), http.StatusCreated)
	e.postEndless(t, bobToken, endlessBody(1, 2, 60000, nil), http.StatusCreated)

	resp := do(t, e.srv, "GET", "/api/v1/me/endless", alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	at := "2026-10-26T09:15:00+13:00"
	want := myEndlessResponse{Results: []endlessResultJSON{
		{1, 1, 2, 90000, at}, {1, 1, 10, 80000, at}, {1, 3, 2, 70000, at},
	}}
	if got := decode[myEndlessResponse](t, resp); !reflect.DeepEqual(got, want) {
		t.Errorf("results = %+v", got)
	}

	// No results gives an empty array, not null.
	raw := decode[map[string]any](t, do(t, e.srv, "GET", "/api/v1/me/endless", "dev:zed:Zed", nil))
	if res, ok := raw["results"].([]any); !ok || len(res) != 0 {
		t.Errorf("empty results = %#v", raw["results"])
	}
}

func TestEndlessLeaderboard(t *testing.T) {
	e := newReplayEnv(t, 1)
	post := func(token string, difficulty int, number int64) {
		e.postEndless(t, token, endlessBody(difficulty, number, 60000, nil), http.StatusCreated)
	}
	// Easy: Alice 3 (highest 14), Bob 1, Carol 1, Dave 1 (so Bob, Carol and Dave tie).
	for _, n := range []int64{1, 2, 14} {
		post(alice, 1, n)
	}
	post(bobToken, 1, 5)
	post("dev:carol:Carol", 1, 6)
	post("dev:dave:Dave", 1, 1)
	// Hard: Bob 2.
	post(bobToken, 3, 1)
	post(bobToken, 3, 2)
	// An admin confirming one of Carol's flags marks her suspicious in Easy.
	do(t, e.srv, "PUT", endlessURL(1, 6, e.userID(t, "dev:carol:Carol"))+"/flag", adminToken, nil)

	resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard", alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	lb := decode[endlessLeaderboardResponse](t, resp)
	if len(lb.Difficulties) != 5 {
		t.Fatalf("difficulties = %d", len(lb.Difficulties))
	}
	for i, d := range lb.Difficulties {
		if d.Difficulty != i+1 || d.Players == nil {
			t.Errorf("difficulty %d = %+v", i+1, d)
		}
	}
	id := func(token string) string { return e.userID(t, token) }
	wantEasy := []progressEntry{
		{1, id(alice), "Alice", 3, 14, false},
		{2, id(bobToken), "Bob", 1, 5, false},
		{2, id("dev:carol:Carol"), "Carol", 1, 6, true},
		{2, id("dev:dave:Dave"), "Dave", 1, 1, false},
	}
	if got := lb.Difficulties[0].Players; !reflect.DeepEqual(got, wantEasy) {
		t.Errorf("easy = %+v\nwant %+v", got, wantEasy)
	}
	wantHard := []progressEntry{{1, id(bobToken), "Bob", 2, 2, false}}
	if got := lb.Difficulties[2].Players; !reflect.DeepEqual(got, wantHard) {
		t.Errorf("hard = %+v", got)
	}
	for _, i := range []int{1, 3, 4} {
		if len(lb.Difficulties[i].Players) != 0 {
			t.Errorf("difficulty %d should be empty: %+v", i+1, lb.Difficulties[i])
		}
	}
}

func TestEndlessPuzzleLeaderboard(t *testing.T) {
	e := newReplayEnv(t, 1)
	for token, ms := range map[string]int64{alice: 183000, bobToken: 150000, "dev:carol:Carol": 183000, "dev:dave:Dave": 200000} {
		e.postEndless(t, token, endlessBody(4, maxNumber, ms, nil), http.StatusCreated)
	}
	do(t, e.srv, "PUT", endlessURL(4, maxNumber, e.userID(t, alice))+"/flag", adminToken, nil)
	e.postEndless(t, alice, endlessBody(4, 1, 5000, nil), http.StatusCreated)

	resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard/4/"+strconv.Itoa(maxNumber), alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	board := decode[endlessPuzzleBoard](t, resp)
	if board.Difficulty != 4 || board.Number != maxNumber {
		t.Errorf("board = %+v", board)
	}
	var got []puzzleEntry
	for _, en := range board.Entries {
		en.UserID = ""
		got = append(got, en)
	}
	want := []puzzleEntry{
		{1, "", "Bob", 150000, false},
		{2, "", "Alice", 183000, true},
		{2, "", "Carol", 183000, false},
		{4, "", "Dave", 200000, false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("entries = %+v\nwant %+v", got, want)
	}

	// A puzzle nobody solved has an empty board, not null.
	raw := decode[map[string]any](t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard/2/3", alice, nil))
	if en, ok := raw["entries"].([]any); !ok || len(en) != 0 {
		t.Errorf("empty entries = %#v", raw["entries"])
	}

	for _, path := range []string{
		"/api/v1/endless/leaderboard/0/1", "/api/v1/endless/leaderboard/6/1", "/api/v1/endless/leaderboard/x/1",
		"/api/v1/endless/leaderboard/1/0", "/api/v1/endless/leaderboard/1/-1", "/api/v1/endless/leaderboard/1/x",
		"/api/v1/endless/leaderboard/1/9007199254740992",
	} {
		expectError(t, do(t, e.srv, "GET", path, alice, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestAdminEndlessResultsList(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, endlessBody(2, 1, 70000, nil), http.StatusCreated)
	e.postEndless(t, bobToken, endlessBody(1, 5, 80000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 5, 80000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 4, 90000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 3, 90000, nil), http.StatusCreated)
	e.postEndless(t, alice, endlessBody(1, 6, 90000, nil), http.StatusCreated)
	// The game day is midnight to midnight in Auckland (UTC+13 in October).
	e.sabotage(t,
		"UPDATE endless_results SET submitted_at = '2026-10-26T01:00:00.000Z' WHERE number IN (1, 5)",
		"UPDATE endless_results SET submitted_at = '2026-10-25T10:59:59.999Z' WHERE number = 3",
		"UPDATE endless_results SET submitted_at = '2026-10-25T11:00:00.000Z' WHERE number = 4",
		"UPDATE endless_results SET submitted_at = '2026-10-26T11:00:00.000Z' WHERE number = 6")

	type key struct {
		name   string
		d      int
		number int64
	}
	keys := func(l adminEndlessResultsResponse) []key {
		var out []key
		for _, r := range l.Results {
			out = append(out, key{r.DisplayName, r.Difficulty, r.Number})
		}
		return out
	}
	// The default is today's game date.
	for _, q := range []string{"", "?date=2026-10-26"} {
		list := e.endlessList(t, q)
		if list.Date != "2026-10-26" {
			t.Errorf("date = %q", list.Date)
		}
		want := []key{{"Alice", 1, 4}, {"Alice", 1, 5}, {"Bob", 1, 5}, {"Alice", 2, 1}}
		if got := keys(list); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: results = %v, want %v", q, got, want)
		}
	}
	if got := keys(e.endlessList(t, "?date=2026-10-25")); !reflect.DeepEqual(got, []key{{"Alice", 1, 3}}) {
		t.Errorf("previous day = %v", got)
	}
	if got := keys(e.endlessList(t, "?date=2026-10-27")); !reflect.DeepEqual(got, []key{{"Alice", 1, 6}}) {
		t.Errorf("next day = %v", got)
	}
	empty := decode[map[string]any](t, do(t, e.srv, "GET", "/api/v1/admin/endless/results?date=2026-01-01", adminToken, nil))
	if res, ok := empty["results"].([]any); !ok || len(res) != 0 {
		t.Errorf("empty results = %#v", empty["results"])
	}
	expectError(t, do(t, e.srv, "GET", "/api/v1/admin/endless/results?date=bad", adminToken, nil), http.StatusBadRequest, "bad_request")
}

type endlessDetail struct {
	adminEndlessResultJSON
	Givens string            `json:"givens"`
	Events []json.RawMessage `json:"events"`
}

func (e replayEnv) endlessDetail(t *testing.T, difficulty int, number int64, uid string) endlessDetail {
	t.Helper()
	return e.endlessDetailG(t, 1, difficulty, number, uid)
}

func (e replayEnv) endlessDetailG(t *testing.T, generator, difficulty int, number int64, uid string) endlessDetail {
	t.Helper()
	resp := do(t, e.srv, "GET", endlessURL(difficulty, number, uid)+"/replay?generator="+strconv.Itoa(generator), adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", resp.StatusCode)
	}
	return decode[endlessDetail](t, resp)
}

func TestAdminEndlessReplay(t *testing.T) {
	e := newReplayEnv(t, 1)
	p := endlessPuzzle(t, 4, 12)
	rep, elapsed := solveReplay(p)
	e.postEndless(t, alice, endlessBody(4, 12, elapsed, rep), http.StatusCreated)
	e.postEndless(t, bobToken, endlessBody(4, 12, 60000, nil), http.StatusCreated)

	uid := e.userID(t, alice)
	raw := decode[map[string]json.RawMessage](t, do(t, e.srv, "GET", endlessURL(4, 12, uid)+"/replay", adminToken, nil))
	if _, has := raw["solution"]; has || strings.Contains(string(raw["givens"]), p.Solution) {
		t.Error("the solution leaked")
	}
	for _, k := range []string{"difficulty", "number", "givens", "events", "userId", "replay", "flag", "replayError", "submittedAt"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing %q", k)
		}
	}

	d := e.endlessDetail(t, 4, 12, uid)
	if d.Difficulty != 4 || d.Number != 12 || d.Givens != p.Givens || d.Replay != "valid" || d.DisplayName != "Alice" {
		t.Errorf("detail = %+v", d.adminEndlessResultJSON)
	}
	if len(d.Events) != len(rep.Events) {
		t.Fatalf("events = %d, want %d", len(d.Events), len(rep.Events))
	}
	want, _ := json.Marshal(rep.Events[2])
	if string(d.Events[2]) != string(want) {
		t.Errorf("event 2 = %s, want %s", d.Events[2], want)
	}

	// No replay: events is an empty array.
	if nr := e.endlessDetail(t, 4, 12, e.userID(t, bobToken)); nr.Events == nil || len(nr.Events) != 0 || nr.Replay != "missing" {
		t.Errorf("missing replay detail = %+v", nr)
	}
}

func TestAdminEndlessParams(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, endlessBody(1, 1, 60000, nil), http.StatusCreated)
	uid := e.userID(t, alice)
	base := "/api/v1/admin/endless/results/"
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		suffix := "/flag"
		if method == "GET" {
			suffix = "/replay"
		}
		for _, path := range []string{
			base + "0/1/" + uid + suffix,
			base + "6/1/" + uid + suffix,
			base + "x/1/" + uid + suffix,
			base + "1/0/" + uid + suffix,
			base + "1/x/" + uid + suffix,
			base + "1/9007199254740992/" + uid + suffix,
			base + "1/1/x" + suffix,
			base + "1/1/0" + suffix,
			base + "1/1/-3" + suffix,
		} {
			expectError(t, do(t, e.srv, method, path, adminToken, nil), http.StatusBadRequest, "bad_request")
		}
		for _, path := range []string{
			base + "1/1/99" + suffix,
			base + "1/2/" + uid + suffix,
			base + "2/1/" + uid + suffix,
		} {
			expectError(t, do(t, e.srv, method, path, adminToken, nil), http.StatusNotFound, "not_found")
		}
	}
}

func TestAdminEndlessFlagAndUnflag(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postSolved(t, alice, 1, 1)
	uid := e.userID(t, alice)
	path := endlessURL(1, 1, uid) + "/flag"
	annID := e.userID(t, adminToken)
	put := func(body any) *http.Response { return do(t, e.srv, "PUT", path, adminToken, body) }

	// Flag with a reason: trimmed, with the calling admin and the clock's time.
	resp := put(map[string]string{"reason": "  Way faster than usual \n"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	item := decode[adminEndlessResultJSON](t, resp)
	f := item.Flag
	if f == nil || f.Reason != "Way faster than usual" || f.Auto || f.FlaggedAt != flagTime ||
		f.FlaggedBy == nil || f.FlaggedBy.UserID != annID || f.FlaggedBy.DisplayName != "Ann" {
		t.Fatalf("flag = %+v", f)
	}
	if item.Replay != "valid" || item.UserID != uid || item.Difficulty != 1 || item.Number != 1 {
		t.Errorf("item = %+v", item)
	}
	board := decode[endlessPuzzleBoard](t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard/1/1", alice, nil))
	if !board.Entries[0].Suspicious {
		t.Error("flagged result not suspicious on the puzzle board")
	}
	lb := decode[endlessLeaderboardResponse](t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard", alice, nil))
	if !lb.Difficulties[0].Players[0].Suspicious {
		t.Error("flagged result not suspicious on the progress board")
	}

	// The reason is optional (empty body, or {}); 500 characters is the limit.
	if f := decode[adminEndlessResultJSON](t, put(nil)).Flag; f == nil || f.Reason != "" || f.Auto {
		t.Errorf("empty-body flag = %+v", f)
	}
	if f := decode[adminEndlessResultJSON](t, put(map[string]string{})).Flag; f == nil || f.Reason != "" {
		t.Errorf("empty-object flag = %+v", f)
	}
	if r := put(map[string]string{"reason": strings.Repeat("é", 500)}); r.StatusCode != http.StatusOK {
		t.Errorf("500 char reason status = %d", r.StatusCode)
	}
	expectError(t, put(map[string]string{"reason": strings.Repeat("é", 501)}), http.StatusBadRequest, "bad_request")
	expectError(t, put(map[string]int{"reason": 5}), http.StatusBadRequest, "bad_request")

	// Unflag.
	resp = do(t, e.srv, "DELETE", path, adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE status = %d", resp.StatusCode)
	}
	if item := decode[adminEndlessResultJSON](t, resp); item.Flag != nil {
		t.Errorf("still flagged: %+v", item.Flag)
	}
	board = decode[endlessPuzzleBoard](t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard/1/1", alice, nil))
	if board.Entries[0].Suspicious {
		t.Error("unflagged result still suspicious")
	}
	// Unflagging an unflagged result is fine too.
	if resp := do(t, e.srv, "DELETE", path, adminToken, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("second DELETE status = %d", resp.StatusCode)
	}
}

func TestAdminEndlessAutomaticFlag(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, endlessBody(1, 1, 60000, nil), http.StatusCreated)
	uid := e.userID(t, alice)
	// An admin flag replaces (and confirms) an automatic one.
	resp := do(t, e.srv, "PUT", endlessURL(1, 1, uid)+"/flag", adminToken, map[string]string{"reason": "seen"})
	if f := decode[adminEndlessResultJSON](t, resp).Flag; f == nil || f.Auto || f.FlaggedBy == nil {
		t.Errorf("flag = %+v", f)
	}
	// Removing an automatic flag works too.
	e.postEndless(t, bobToken, endlessBody(1, 1, 60000, nil), http.StatusCreated)
	resp = do(t, e.srv, "DELETE", endlessURL(1, 1, e.userID(t, bobToken))+"/flag", adminToken, nil)
	if item := decode[adminEndlessResultJSON](t, resp); item.Flag != nil || item.Replay != "missing" {
		t.Errorf("item = %+v", item)
	}
}

func TestEndlessStoreFailures(t *testing.T) {
	setup := func(t *testing.T) (replayEnv, string) {
		e := newReplayEnv(t, 1)
		e.postSolved(t, alice, 1, 1)
		return e, e.userID(t, alice)
	}
	tests := []struct {
		name   string
		method string
		path   func(uid string) string
		token  string
		body   func(t *testing.T) any
		break_ string
	}{
		{"me", "GET", func(string) string { return "/api/v1/me/endless" }, alice, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"progress", "GET", func(string) string { return "/api/v1/endless/leaderboard" }, alice, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"puzzle board", "GET", func(string) string { return "/api/v1/endless/leaderboard/1/1" }, alice, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"list", "GET", func(string) string { return "/api/v1/admin/endless/results" }, adminToken, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"replay result", "GET", func(uid string) string { return endlessURL(1, 1, uid) + "/replay" }, adminToken, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"replay events", "GET", func(uid string) string { return endlessURL(1, 1, uid) + "/replay" }, adminToken, nil, "ALTER TABLE endless_replays RENAME TO gone"},
		{"flag", "PUT", func(uid string) string { return endlessURL(1, 1, uid) + "/flag" }, adminToken, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"unflag", "DELETE", func(uid string) string { return endlessURL(1, 1, uid) + "/flag" }, adminToken, nil, "ALTER TABLE endless_results RENAME TO gone"},
		{"post", "POST", func(string) string { return "/api/v1/endless/results" }, bobToken,
			func(t *testing.T) any {
				rep, el := solveReplay(endlessPuzzle(t, 1, 1))
				return endlessBody(1, 1, el, rep)
			},
			"ALTER TABLE endless_replays RENAME TO gone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, uid := setup(t)
			e.sabotage(t, tt.break_)
			var body any
			if tt.body != nil {
				body = tt.body(t)
			}
			expectError(t, do(t, e.srv, tt.method, tt.path(uid), tt.token, body), http.StatusInternalServerError, "internal")
		})
	}
}

// A failed insert stores nothing: the result and its replay share a transaction.
func TestPostEndlessResultStoreFailureStoresNothing(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.sabotage(t, "ALTER TABLE endless_replays RENAME TO gone")
	rep, elapsed := solveReplay(endlessPuzzle(t, 1, 1))
	expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, endlessBody(1, 1, elapsed, rep)), http.StatusInternalServerError, "internal")
	e.sabotage(t, "ALTER TABLE gone RENAME TO endless_replays")
	if n := len(decode[myEndlessResponse](t, do(t, e.srv, "GET", "/api/v1/me/endless", alice, nil)).Results); n != 0 {
		t.Errorf("%d results stored after a failed insert", n)
	}
}

func TestEndlessSeriesSubmitAndRead(t *testing.T) {
	e := newReplayEnv(t, 1)
	c, g := endlessPuzzleG(t, 1, 2, 7), endlessPuzzleG(t, 2, 2, 7)
	if c.Givens == g.Givens {
		t.Fatal("the series gave the same puzzle")
	}
	gBody := func(elapsed int64, rep any) map[string]any {
		return with(endlessBody(2, 7, elapsed, rep), "generator", 2)
	}

	// A graded replay validates against the graded puzzle, and echoes the series.
	rep, elapsed := solveReplay(g)
	resp := do(t, e.srv, "POST", "/api/v1/endless/results", alice, gBody(elapsed, rep))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := decode[endlessResultJSON](t, resp); got.Generator != 2 || got.ElapsedMs != elapsed {
		t.Errorf("graded result = %+v", got)
	}
	// The same number in Classic (generator missing, or 1) is a separate result,
	// and the graded replay does not solve it.
	e.postEndless(t, alice, endlessBody(2, 7, elapsed, rep), http.StatusCreated)
	e.postEndless(t, bobToken, with(endlessBody(2, 7, 60000, nil), "generator", 1), http.StatusCreated)
	// Idempotent per series.
	resp = do(t, e.srv, "POST", "/api/v1/endless/results", alice, gBody(1000000, nil))
	if resp.StatusCode != http.StatusOK || decode[endlessResultJSON](t, resp).Generator != 2 {
		t.Errorf("graded duplicate status = %d", resp.StatusCode)
	}
	e.postEndless(t, bobToken, gBody(40000, nil), http.StatusCreated)

	e.sabotage(t, "UPDATE endless_results SET submitted_at = '2026-10-26T01:00:00.000Z'")
	type row struct {
		gen    int
		name   string
		replay string
	}
	var got []row
	for _, r := range e.endlessList(t, "").Results {
		got = append(got, row{r.Generator, r.DisplayName, r.Replay})
	}
	want := []row{{1, "Alice", "invalid"}, {1, "Bob", "missing"}, {2, "Bob", "missing"}, {2, "Alice", "valid"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("list = %v\nwant %v", got, want)
	}

	// Replays and flags address a series with ?generator= (default 1).
	uid := e.userID(t, alice)
	if d := e.endlessDetailG(t, 2, 2, 7, uid); d.Generator != 2 || d.Givens != g.Givens || d.Replay != "valid" || len(d.Events) == 0 {
		t.Errorf("graded detail = %+v", d.adminEndlessResultJSON)
	}
	if d := e.endlessDetail(t, 2, 7, uid); d.Generator != 1 || d.Givens != c.Givens || d.Replay != "invalid" {
		t.Errorf("classic detail = %+v", d.adminEndlessResultJSON)
	}
	flag := endlessURL(2, 7, uid) + "/flag?generator=2"
	if item := decode[adminEndlessResultJSON](t, do(t, e.srv, "PUT", flag, adminToken, nil)); item.Generator != 2 || item.Flag == nil {
		t.Errorf("flagged = %+v", item)
	}
	if item := e.endlessDetail(t, 2, 7, uid); item.Flag == nil || !item.Flag.Auto {
		t.Errorf("the classic result's flag changed: %+v", item.Flag)
	}
	if item := decode[adminEndlessResultJSON](t, do(t, e.srv, "DELETE", flag, adminToken, nil)); item.Generator != 2 || item.Flag != nil {
		t.Errorf("unflagged = %+v", item)
	}
	expectError(t, do(t, e.srv, "GET", endlessURL(3, 7, uid)+"/replay?generator=2", adminToken, nil), http.StatusNotFound, "not_found")

	// What a user has played, in both series.
	mine := decode[myEndlessResponse](t, do(t, e.srv, "GET", "/api/v1/me/endless", alice, nil)).Results
	if len(mine) != 2 || mine[0].Generator != 1 || mine[1].Generator != 2 || mine[1].ElapsedMs != elapsed {
		t.Errorf("me = %+v", mine)
	}

	// Boards are per series; with no ?generator= it is the current week's (Classic here).
	board := func(path string) endlessPuzzleBoard {
		t.Helper()
		resp := do(t, e.srv, "GET", path, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", path, resp.StatusCode)
		}
		return decode[endlessPuzzleBoard](t, resp)
	}
	if b := board("/api/v1/endless/leaderboard/2/7"); b.Generator != 1 || len(b.Entries) != 2 || b.Entries[0].DisplayName != "Alice" {
		t.Errorf("default board = %+v", b)
	}
	if b := board("/api/v1/endless/leaderboard/2/7?generator=2"); b.Generator != 2 || len(b.Entries) != 2 || b.Entries[0].DisplayName != "Bob" {
		t.Errorf("graded board = %+v", b)
	}
	lb := func(q string) endlessLeaderboardResponse {
		return decode[endlessLeaderboardResponse](t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard"+q, alice, nil))
	}
	if l := lb(""); l.Generator != 1 || len(l.Difficulties[1].Players) != 2 {
		t.Errorf("default leaderboard = %+v", l)
	}
	if l := lb("?generator=2"); l.Generator != 2 || len(l.Difficulties[1].Players) != 2 || len(l.Difficulties[0].Players) != 0 {
		t.Errorf("graded leaderboard = %+v", l)
	}
	enableGenerators(t, e, 2)
	if l := lb(""); l.Generator != 2 {
		t.Errorf("default leaderboard with only Graded enabled = generator %d", l.Generator)
	}
	if b := board("/api/v1/endless/leaderboard/2/7"); b.Generator != 2 {
		t.Errorf("default board with only Graded enabled = generator %d", b.Generator)
	}
	if b := board("/api/v1/endless/leaderboard/2/7?generator=1"); b.Generator != 1 {
		t.Errorf("classic board with only Graded enabled = generator %d", b.Generator)
	}
	// Any series is accepted whatever is enabled, so queued results still land.
	e.postEndless(t, "dev:carol:Carol", endlessBody(1, 1, 60000, nil), http.StatusCreated)
}

func TestEndlessGeneratorValidation(t *testing.T) {
	e := newReplayEnv(t, 1)
	for _, g := range []any{0, 3, -1, 99} {
		expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, with(endlessBody(1, 1, 60000, nil), "generator", g)), http.StatusBadRequest, "invalid_result")
	}
	expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, with(endlessBody(1, 1, 60000, nil), "generator", "x")), http.StatusBadRequest, "bad_request")
	e.postEndless(t, alice, with(endlessBody(1, 1, 60000, nil), "generator", nil), http.StatusCreated)

	uid := e.userID(t, alice)
	for _, q := range []string{"?generator=3", "?generator=0", "?generator=x", "?generator=1.5"} {
		for _, path := range []string{
			"/api/v1/endless/leaderboard", "/api/v1/endless/leaderboard/1/1",
		} {
			expectError(t, do(t, e.srv, "GET", path+q, alice, nil), http.StatusBadRequest, "bad_request")
		}
		expectError(t, do(t, e.srv, "GET", endlessURL(1, 1, uid)+"/replay"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "PUT", endlessURL(1, 1, uid)+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "DELETE", endlessURL(1, 1, uid)+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestEndlessGeneratorNeedsTheSettings(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.sabotage(t, "ALTER TABLE generator_settings RENAME TO gone")
	expectError(t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard", alice, nil), http.StatusInternalServerError, "internal")
	expectError(t, do(t, e.srv, "GET", "/api/v1/endless/leaderboard/1/1", alice, nil), http.StatusInternalServerError, "internal")
	// An explicit series does not need it.
	if resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard?generator=2", alice, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

func TestStatsEndlessPerGenerator(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, endlessBody(1, 1, 60000, nil), http.StatusCreated)
	e.postEndless(t, alice, with(endlessBody(1, 4, 30000, nil), "generator", 2), http.StatusCreated)
	e.postEndless(t, alice, with(endlessBody(1, 5, 50000, nil), "generator", 2), http.StatusCreated)
	get := func(q string) statsResponse {
		return decode[statsResponse](t, do(t, e.srv, "GET", "/api/v1/me/stats"+q, alice, nil))
	}
	if s := get(""); s.Generator != 1 || s.Endless[0].Completed != 1 || s.Endless[0].Highest != 1 {
		t.Errorf("default = %+v", s.Endless[0])
	}
	if s := get("?generator=2"); s.Generator != 2 || s.Endless[0].Completed != 2 || s.Endless[0].Highest != 5 || *s.Endless[0].BestMs != 30000 {
		t.Errorf("graded = %+v", s.Endless[0])
	}
}
