package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
)

// endlessVariantPuzzle is endless puzzle number of tier difficulty in the
// series of generator and variant.
func endlessVariantPuzzle(t *testing.T, generator, variant, difficulty int, number int64) puzzle.VariantPuzzle {
	t.Helper()
	es, err := puzzle.ParseWeekSeed(seed.ForEndless([]byte(testSecret)))
	if err != nil {
		t.Fatal(err)
	}
	p, err := puzzle.GenerateEndlessVariant(generator, variant, es, difficulty, number)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// variantBody is endlessBody in a generator and variant's series.
func variantBody(generator, variant, difficulty int, number int64, elapsed int64, rep any) map[string]any {
	return with(with(endlessBody(difficulty, number, elapsed, rep), "generator", generator), "variant", variant)
}

// variantDetail is an admin endless replay with its layout.
type variantDetail struct {
	endlessDetail
	Layout *layoutJSON `json:"layout"`
}

func (e replayEnv) variantDetail(t *testing.T, generator, variant, difficulty int, number int64, uid string) variantDetail {
	t.Helper()
	q := "/replay?generator=" + strconv.Itoa(generator) + "&variant=" + strconv.Itoa(variant)
	resp := do(t, e.srv, "GET", endlessURL(difficulty, number, uid)+q, adminToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", resp.StatusCode)
	}
	return decode[variantDetail](t, resp)
}

func TestEndlessVariantSubmit(t *testing.T) {
	e := newReplayEnv(t, 1)
	for v := puzzle.VariantDiagonal; v < puzzle.Variants; v++ {
		for _, gen := range []int{puzzle.VersionClassic, puzzle.VersionGraded} {
			p := endlessVariantPuzzle(t, gen, v, 2, 7)
			if std := endlessPuzzleG(t, gen, 2, 7); p.Givens == std.Givens {
				t.Fatalf("variant %d gave the standard puzzle", v)
			}
			// A replay of the variant's puzzle is valid in its own series and
			// echoes the variant.
			rep, elapsed := solveReplay(p.Puzzle)
			resp := do(t, e.srv, "POST", "/api/v1/endless/results", alice, variantBody(gen, v, 2, 7, elapsed, rep))
			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("variant %d gen %d status = %d", v, gen, resp.StatusCode)
			}
			want := endlessResultJSON{Generator: gen, Variant: v, Difficulty: 2, Number: 7, ElapsedMs: elapsed, CompletedAt: "2026-10-26T09:15:00+13:00"}
			if got := decode[endlessResultJSON](t, resp); got != want {
				t.Errorf("result = %+v, want %+v", got, want)
			}
			// Idempotent per variant: the stored result comes back.
			resp = do(t, e.srv, "POST", "/api/v1/endless/results", alice, variantBody(gen, v, 2, 7, 6000, nil))
			if got := decode[endlessResultJSON](t, resp); resp.StatusCode != http.StatusOK || got != want {
				t.Errorf("duplicate = %d %+v", resp.StatusCode, got)
			}
			uid := e.userID(t, alice)
			d := e.variantDetail(t, gen, v, 2, 7, uid)
			if d.Variant != v || d.Generator != gen || d.Replay != "valid" || d.Givens != p.Givens {
				t.Errorf("detail = %+v", d.adminEndlessResultJSON)
			}
			// The layout is the puzzle's.
			wantLayout := &layoutJSON{Regions: p.Layout.Regions, Diagonals: p.Layout.Diagonals, Cages: append([]puzzle.Cage{}, p.Layout.Cages...)}
			if !reflect.DeepEqual(d.Layout, wantLayout) {
				t.Errorf("layout = %+v, want %+v", d.Layout, wantLayout)
			}
			// Bob's replay of the variant puzzle submitted as the standard
			// puzzle fails the check.
			e.postEndless(t, bobToken, with(endlessBody(2, int64(7+v*2+gen), elapsed, rep), "generator", gen), http.StatusCreated)
		}
	}

	// Each variant's layout tells the client how to draw it.
	uid := e.userID(t, alice)
	raw := func(v int) map[string]json.RawMessage {
		t.Helper()
		q := "/replay?variant=" + strconv.Itoa(v)
		return decode[map[string]json.RawMessage](t, do(t, e.srv, "GET", endlessURL(2, 7, uid)+q, adminToken, nil))
	}
	for v, check := range map[int]func(l layoutJSON) bool{
		puzzle.VariantDiagonal: func(l layoutJSON) bool {
			return l.Diagonals && l.Cages != nil && len(l.Cages) == 0 && l.Regions[80] == 8
		},
		puzzle.VariantJigsaw: func(l layoutJSON) bool {
			return !l.Diagonals && len(l.Cages) == 0 && l.Regions != puzzle.StandardLayout().Regions
		},
		puzzle.VariantKiller: func(l layoutJSON) bool {
			return !l.Diagonals && len(l.Cages) > 0 && l.Regions == puzzle.StandardLayout().Regions
		},
	} {
		r := raw(v)
		var l layoutJSON
		if err := json.Unmarshal(r["layout"], &l); err != nil || !check(l) {
			t.Errorf("variant %d layout = %s, %v", v, r["layout"], err)
		}
		if string(r["variant"]) != strconv.Itoa(v) {
			t.Errorf("variant %d detail variant = %s", v, r["variant"])
		}
	}

	// Bob's standard results all failed the check.
	bobUID := e.userID(t, bobToken)
	for _, r := range e.endlessList(t, "").Results {
		if r.UserID == bobUID && (r.Variant != 0 || r.Replay != "invalid") {
			t.Errorf("bob = %+v", r)
		}
	}
}

// TestEndlessVariantReplayUsesLayout submits a Diagonal replay whose place
// clears a note from a cell that is a peer only through the diagonal: the
// note can be added again, which is valid only under the variant's layout.
func TestEndlessVariantReplayUsesLayout(t *testing.T) {
	e := newReplayEnv(t, 1)
	p := endlessVariantPuzzle(t, puzzle.VersionClassic, puzzle.VariantDiagonal, 1, 3)
	x, y := -1, -1
	for i := 0; i < 9 && y < 0; i++ {
		c := i * 10
		switch {
		case p.Givens[c] != '0':
		case x < 0:
			x = c
		case c/27 != x/27:
			y = c
		}
	}
	if y < 0 {
		t.Fatal("no two empty diagonal cells in different boxes")
	}
	d := int(p.Solution[y] - '0')
	var ms int64
	ev := []replay.Event{{T: 0, W: 1_761_423_000_000, A: replay.ActStart}, {T: 0, W: 1_761_423_000_000, A: replay.ActResume}}
	add := func(a string, c, digit int) {
		ms += 1000
		ev = append(ev, replay.Event{T: ms, W: 1_761_423_000_000 + ms, A: a, C: &c, D: &digit})
	}
	add(replay.ActNoteAdd, x, d)
	add(replay.ActPlace, y, d)
	add(replay.ActNoteAdd, x, d)
	for c := 0; c < 81; c++ {
		if p.Givens[c] == '0' && c != y {
			add(replay.ActPlace, c, int(p.Solution[c]-'0'))
		}
	}
	ev = append(ev, replay.Event{T: ms, W: 1_761_423_000_000 + ms, A: replay.ActFinish})
	rep := replay.Replay{Version: 1, Events: ev}
	e.postEndless(t, alice, variantBody(1, puzzle.VariantDiagonal, 1, 3, ms, rep), http.StatusCreated)
	if d := e.variantDetail(t, 1, puzzle.VariantDiagonal, 1, 3, e.userID(t, alice)); d.Replay != "valid" {
		t.Errorf("replay = %s: %s", d.Replay, d.ReplayError)
	}
}

func TestEndlessVariantValidation(t *testing.T) {
	e := newReplayEnv(t, 1)
	for _, v := range []any{-1, 4, 99} {
		expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, with(endlessBody(1, 1, 60000, nil), "variant", v)), http.StatusBadRequest, "invalid_result")
	}
	for _, v := range []any{"1", 1.5} {
		expectError(t, do(t, e.srv, "POST", "/api/v1/endless/results", alice, with(endlessBody(1, 1, 60000, nil), "variant", v)), http.StatusBadRequest, "bad_request")
	}
	// A missing or null variant is 0.
	resp := do(t, e.srv, "POST", "/api/v1/endless/results", alice, with(endlessBody(1, 1, 60000, nil), "variant", nil))
	if got := decode[endlessResultJSON](t, resp); resp.StatusCode != http.StatusCreated || got.Variant != 0 {
		t.Errorf("null variant = %d %+v", resp.StatusCode, got)
	}

	uid := e.userID(t, alice)
	for _, q := range []string{"?variant=4", "?variant=-1", "?variant=x", "?variant=1.5"} {
		for _, path := range []string{"/api/v1/endless/leaderboard", "/api/v1/endless/leaderboard/1/1"} {
			expectError(t, do(t, e.srv, "GET", path+q, alice, nil), http.StatusBadRequest, "bad_request")
		}
		expectError(t, do(t, e.srv, "GET", endlessURL(1, 1, uid)+"/replay"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "PUT", endlessURL(1, 1, uid)+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
		expectError(t, do(t, e.srv, "DELETE", endlessURL(1, 1, uid)+"/flag"+q, adminToken, nil), http.StatusBadRequest, "bad_request")
	}
	resp = do(t, e.srv, "GET", "/api/v1/endless/leaderboard?variant=9", alice, nil)
	if body := decode[map[string]any](t, resp); body["error"].(map[string]any)["message"] != "variant must be 0..3" {
		t.Errorf("message = %v", body)
	}
	// Another variant's result is not found.
	expectError(t, do(t, e.srv, "GET", endlessURL(1, 1, uid)+"/replay?variant=1", adminToken, nil), http.StatusNotFound, "not_found")
}

func TestEndlessVariantReads(t *testing.T) {
	e := newReplayEnv(t, 1)
	e.postEndless(t, alice, variantBody(1, 3, 2, 5, 70000, nil), http.StatusCreated)
	e.postEndless(t, alice, variantBody(1, 0, 2, 5, 80000, nil), http.StatusCreated)
	e.postEndless(t, alice, variantBody(1, 1, 2, 5, 90000, nil), http.StatusCreated)
	e.postEndless(t, alice, variantBody(2, 1, 1, 1, 60000, nil), http.StatusCreated)
	e.postEndless(t, bobToken, variantBody(1, 3, 2, 5, 65000, nil), http.StatusCreated)
	e.postEndless(t, bobToken, variantBody(1, 3, 2, 6, 66000, nil), http.StatusCreated)

	// Mine: ordered by generator, variant, difficulty, number.
	type key struct{ gen, variant, difficulty int }
	var got []key
	for _, r := range decode[myEndlessResponse](t, do(t, e.srv, "GET", "/api/v1/me/endless", alice, nil)).Results {
		got = append(got, key{r.Generator, r.Variant, r.Difficulty})
	}
	if want := []key{{1, 0, 2}, {1, 1, 2}, {1, 3, 2}, {2, 1, 1}}; !reflect.DeepEqual(got, want) {
		t.Errorf("mine = %v, want %v", got, want)
	}

	// Progress leaderboard per variant, echoed; no ?variant= is variant 0.
	lb := func(q string) endlessLeaderboardResponse {
		t.Helper()
		resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard"+q, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", q, resp.StatusCode)
		}
		return decode[endlessLeaderboardResponse](t, resp)
	}
	if l := lb(""); l.Variant != 0 || len(l.Difficulties[1].Players) != 1 || l.Difficulties[1].Players[0].Completed != 1 {
		t.Errorf("standard leaderboard = %+v", l)
	}
	if l := lb("?variant=3"); l.Variant != 3 || l.Generator != 1 || len(l.Difficulties[1].Players) != 2 || l.Difficulties[1].Players[0].DisplayName != "Bob" || l.Difficulties[1].Players[0].Completed != 2 {
		t.Errorf("killer leaderboard = %+v", l)
	}
	if l := lb("?variant=2"); l.Variant != 2 || len(l.Difficulties[1].Players) != 0 {
		t.Errorf("jigsaw leaderboard = %+v", l)
	}
	if l := lb("?generator=2&variant=1"); l.Variant != 1 || l.Generator != 2 || len(l.Difficulties[0].Players) != 1 {
		t.Errorf("graded diagonal leaderboard = %+v", l)
	}

	// Per-puzzle board per variant, echoed.
	board := func(q string) endlessPuzzleBoard {
		t.Helper()
		resp := do(t, e.srv, "GET", "/api/v1/endless/leaderboard/2/5"+q, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", q, resp.StatusCode)
		}
		return decode[endlessPuzzleBoard](t, resp)
	}
	if b := board(""); b.Variant != 0 || len(b.Entries) != 1 || b.Entries[0].ElapsedMs != 80000 {
		t.Errorf("standard board = %+v", b)
	}
	if b := board("?variant=3"); b.Variant != 3 || len(b.Entries) != 2 || b.Entries[0].ElapsedMs != 65000 || b.Entries[1].ElapsedMs != 70000 {
		t.Errorf("killer board = %+v", b)
	}

	// Admin list items carry the variant, ordered generator, variant, difficulty, number, time.
	e.sabotage(t, "UPDATE endless_results SET submitted_at = '2026-10-26T01:00:00.000Z'")
	type item struct {
		gen, variant int
		number       int64
		name         string
	}
	var items []item
	for _, r := range e.endlessList(t, "").Results {
		items = append(items, item{r.Generator, r.Variant, r.Number, r.DisplayName})
	}
	want := []item{{1, 0, 5, "Alice"}, {1, 1, 5, "Alice"}, {1, 3, 5, "Bob"}, {1, 3, 5, "Alice"}, {1, 3, 6, "Bob"}, {2, 1, 1, "Alice"}}
	if !reflect.DeepEqual(items, want) {
		t.Errorf("list = %v\nwant %v", items, want)
	}

	// Flags address one variant with ?variant=; the default is 0.
	uid := e.userID(t, alice)
	flag := endlessURL(2, 5, uid) + "/flag?variant=3"
	if it := decode[adminEndlessResultJSON](t, do(t, e.srv, "PUT", flag, adminToken, nil)); it.Variant != 3 || it.Flag == nil || it.Flag.Auto {
		t.Errorf("flagged = %+v", it)
	}
	if it := e.endlessDetail(t, 2, 5, uid); it.Variant != 0 || it.Flag == nil || !it.Flag.Auto {
		t.Errorf("the standard result's flag changed: %+v / %+v", it.adminEndlessResultJSON, it.Flag)
	}
	if b := board("?variant=3"); !b.Entries[1].Suspicious || b.Entries[0].Suspicious {
		t.Errorf("killer board after flag = %+v", b)
	}
	if it := decode[adminEndlessResultJSON](t, do(t, e.srv, "DELETE", flag, adminToken, nil)); it.Variant != 3 || it.Flag != nil {
		t.Errorf("unflagged = %+v", it)
	}

	// A standard result's replay has no layout.
	raw := decode[map[string]json.RawMessage](t, do(t, e.srv, "GET", endlessURL(2, 5, uid)+"/replay", adminToken, nil))
	if _, has := raw["layout"]; has || string(raw["variant"]) != "0" {
		t.Errorf("standard replay: layout %s, variant %s", raw["layout"], raw["variant"])
	}
}
