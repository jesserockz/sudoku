package puzzle

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"
)

// fixture is testdata/generator-v2.json, shared with the web tests
// (web/test/generator-v2.test.ts); the TypeScript generator is the reference.
type fixture struct {
	Techniques []string `json:"techniques"`
	Daily      []struct {
		WeekSeed   string `json:"weekSeed"`
		Day        int    `json:"day"`
		Level      int    `json:"level"`
		Levels     int    `json:"levels"`
		Givens     string `json:"givens"`
		Solution   string `json:"solution"`
		GradeLevel int    `json:"gradeLevel"`
		Attempts   int    `json:"attempts"`
	} `json:"daily"`
	Endless []struct {
		Seed       string `json:"seed"`
		Tier       int    `json:"tier"`
		Number     int64  `json:"number"`
		Givens     string `json:"givens"`
		Solution   string `json:"solution"`
		GradeLevel int    `json:"gradeLevel"`
		Attempts   int    `json:"attempts"`
	} `json:"endless"`
	Fallback []struct {
		Seed        string `json:"seed"`
		Tier        int    `json:"tier"`
		MaxAttempts int    `json:"maxAttempts"`
		Givens      string `json:"givens"`
		Solution    string `json:"solution"`
		GradeLevel  int    `json:"gradeLevel"`
		Attempts    int    `json:"attempts"`
		Trace       []int  `json:"trace"`
	} `json:"fallback"`
	Grader []struct {
		Givens string `json:"givens"`
		Solved bool   `json:"solved"`
		Level  int    `json:"level"`
		Steps  int    `json:"steps"`
		Counts []int  `json:"counts"`
	} `json:"grader"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	data, err := os.ReadFile("../../../testdata/generator-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func digits(s string) []int {
	g := make([]int, len(s))
	for i := range s {
		g[i] = int(s[i] - '0')
	}
	return g
}

func TestFixtureTechniques(t *testing.T) {
	var names []string
	for _, tq := range Techniques {
		names = append(names, tq.Name)
	}
	if !slices.Equal(loadFixture(t).Techniques, names) {
		t.Errorf("fixture techniques %v, grader has %v", loadFixture(t).Techniques, names)
	}
}

func TestFixtureGrader(t *testing.T) {
	levels := map[int]bool{}
	used := map[int]bool{}
	for _, c := range loadFixture(t).Grader {
		g, err := GradeCells(digits(c.Givens))
		if err != nil {
			t.Fatal(err)
		}
		if g.Solved != c.Solved || g.Level != c.Level || g.Steps != c.Steps || !slices.Equal(g.Counts[:], c.Counts) {
			t.Errorf("%s: got %+v, want solved=%v level=%d steps=%d counts=%v", c.Givens, g, c.Solved, c.Level, c.Steps, c.Counts)
		}
		sum := 0
		for tq, n := range g.Counts {
			sum += n
			if n > 0 {
				used[tq] = true
			}
		}
		if sum != g.Steps {
			t.Errorf("counts sum %d != steps %d", sum, g.Steps)
		}
		levels[g.Level] = true
	}
	if len(levels) != 8 {
		t.Errorf("fixture covers levels %v, want 0..7", levels)
	}
	if len(used) != len(Techniques) {
		t.Errorf("fixture exercises %d techniques, want %d", len(used), len(Techniques))
	}
}

func TestFixtureDaily(t *testing.T) {
	for _, c := range loadFixture(t).Daily {
		at := fmt.Sprintf("%s day %d game %d/%d", c.WeekSeed, c.Day, c.Level, c.Levels)
		seed, err := ParseWeekSeed(c.WeekSeed)
		if err != nil {
			t.Fatal(err)
		}
		r, err := GenerateV2(seed, c.Day, c.Level, c.Levels)
		if err != nil {
			t.Fatal(err)
		}
		if r.Puzzle.Givens != c.Givens || r.Puzzle.Solution != c.Solution || r.Grade.Level != c.GradeLevel || r.Attempts != c.Attempts {
			t.Errorf("%s: got level %d attempts %d givens %s, want level %d attempts %d givens %s", at, r.Grade.Level, r.Attempts, r.Puzzle.Givens, c.GradeLevel, c.Attempts, c.Givens)
		}
		if g, _ := GradeCells(digits(c.Givens)); g != r.Grade {
			t.Errorf("%s: regrading gives %+v, generator gave %+v", at, g, r.Grade)
		}
	}
}

func TestFixtureEndless(t *testing.T) {
	tiers := map[int]bool{}
	for _, c := range loadFixture(t).Endless {
		tiers[c.Tier] = true
		at := fmt.Sprintf("%s tier %d #%d", c.Seed, c.Tier, c.Number)
		seed, err := ParseWeekSeed(c.Seed)
		if err != nil {
			t.Fatal(err)
		}
		r, err := GenerateEndlessV2(seed, c.Tier, c.Number)
		if err != nil {
			t.Fatal(err)
		}
		if r.Puzzle.Givens != c.Givens || r.Puzzle.Solution != c.Solution || r.Grade.Level != c.GradeLevel || r.Attempts != c.Attempts {
			t.Errorf("%s: got level %d attempts %d givens %s, want level %d attempts %d givens %s", at, r.Grade.Level, r.Attempts, r.Puzzle.Givens, c.GradeLevel, c.Attempts, c.Givens)
		}
	}
	if len(tiers) != Tiers {
		t.Errorf("fixture covers tiers %v, want all %d", tiers, Tiers)
	}
}

func TestFixtureFallback(t *testing.T) {
	f := loadFixture(t)
	allStuck := false
	for _, c := range f.Fallback {
		seed, err := ParseWeekSeed(c.Seed)
		if err != nil {
			t.Fatal(err)
		}
		r := buildV2(seed, c.Tier, c.MaxAttempts)
		if r.Puzzle.Givens != c.Givens || r.Puzzle.Solution != c.Solution || r.Grade.Level != c.GradeLevel || r.Attempts != c.Attempts {
			t.Errorf("%s: got level %d attempts %d, want level %d attempts %d", c.Seed, r.Grade.Level, r.Attempts, c.GradeLevel, c.Attempts)
		}
		band := Bands[c.Tier-1]
		hit := slices.ContainsFunc(c.Trace, func(l int) bool { return l >= band.MinLevel && l <= band.MaxLevel })
		if got := r.Grade.Level >= band.MinLevel && r.Grade.Level <= band.MaxLevel; got != hit {
			t.Errorf("%s: in band = %v, trace %v says %v", c.Seed, got, c.Trace, hit)
		}
		if !slices.ContainsFunc(c.Trace, func(l int) bool { return l != StuckLevel }) {
			allStuck = true
		}
	}
	if !allStuck {
		t.Error("fixture has no all-stuck fallback")
	}
}

func TestGeneratedPuzzlesAreGradedInBand(t *testing.T) {
	for tier := 1; tier <= Tiers; tier++ {
		for n := int64(1); n <= 4; n++ {
			r, err := GenerateEndlessV2(0x1234, tier, n)
			if err != nil {
				t.Fatal(err)
			}
			givens, solution := digits(r.Puzzle.Givens), digits(r.Puzzle.Solution)
			for i, d := range givens {
				if d != 0 && d != solution[i] {
					t.Fatalf("given %d disagrees with the solution", i)
				}
			}
			if !hasUniqueSolution(givens) {
				t.Errorf("tier %d #%d is not unique", tier, n)
			}
			band := Bands[tier-1]
			if !r.Grade.Solved || r.Attempts >= MaxAttemptsV2 || r.Grade.Level < band.MinLevel || r.Grade.Level > band.MaxLevel {
				t.Errorf("%s #%d: grade %+v after %d attempts", band.Name, n, r.Grade, r.Attempts)
			}
		}
	}
}

func TestV2SeedsAreSeparateFromV1(t *testing.T) {
	if GeneratorV2Version != 2 || GeneratorVersion != 1 {
		t.Fatal("versions changed")
	}
	const seed = 0x9f2c4a1b7e30d5c8
	if puzzleSeedV2(seed, 1, 1) == puzzleSeed(seed, 1, 1) || endlessPuzzleSeedV2(seed, 1, 1) == endlessPuzzleSeed(seed, 1, 1) {
		t.Error("v2 seeds equal v1 seeds")
	}
	if puzzleSeedV2(seed, 1, 1) == puzzleSeedV2(seed, 1, 2) {
		t.Error("levels share a seed")
	}
}

func TestV2ArgumentErrors(t *testing.T) {
	const seed = 0x9f2c4a1b7e30d5c8
	for _, c := range [][3]int{{0, 1, 5}, {8, 1, 5}, {1, 1, 11}, {1, 6, 5}} {
		if _, err := GenerateV2(seed, c[0], c[1], c[2]); err == nil {
			t.Errorf("GenerateV2(day %d, level %d, levels %d) did not fail", c[0], c[1], c[2])
		}
	}
	for _, tier := range []int{0, 6} {
		if _, err := GenerateEndlessV2(seed, tier, 1); err == nil {
			t.Errorf("tier %d did not fail", tier)
		}
	}
	for _, n := range []int64{0, -1, MaxEndlessNumber + 1} {
		if _, err := GenerateEndlessV2(seed, 1, n); err == nil {
			t.Errorf("number %d did not fail", n)
		}
	}
	if r, err := GenerateV2(seed, 1, 1, 1); err != nil || Bands[2].Name != "Hard" || r.Grade.Level < 3 {
		t.Errorf("a single game is Hard: %v %+v", err, r.Grade)
	}
}

func TestBands(t *testing.T) {
	want := []Band{{"Easy", 1, 1, 38}, {"Medium", 2, 2, 30}, {"Hard", 3, 4, 0}, {"Expert", 5, 5, 0}, {"Diabolical", 6, 6, 0}}
	if !slices.Equal(Bands[:], want) {
		t.Errorf("bands = %v", Bands)
	}
	for i, d := range difficulties {
		if Bands[i].Name != d.name {
			t.Errorf("band %d is %s, tier is %s", i, Bands[i].Name, d.name)
		}
	}
}

func TestGradeCellsErrors(t *testing.T) {
	if _, err := GradeCells(make([]int, 80)); err == nil {
		t.Error("80 cells did not fail")
	}
	bad := make([]int, cells)
	bad[5] = 10
	if _, err := GradeCells(bad); err == nil {
		t.Error("value 10 did not fail")
	}
	bad[5] = -1
	if _, err := GradeCells(bad); err == nil {
		t.Error("value -1 did not fail")
	}
}

func TestGradeEmptyAndComplete(t *testing.T) {
	g, err := GradeCells(make([]int, cells))
	if err != nil || g.Solved || g.Level != StuckLevel || g.Steps != 0 {
		t.Errorf("empty grid: %+v %v", g, err)
	}
	full := randomSolution(make([]int, cells), newXoshiro(5))
	g, err = GradeCells(full[:])
	if err != nil || !g.Solved || g.Level != 0 || g.Steps != 0 {
		t.Errorf("complete grid: %+v %v", g, err)
	}
}

func TestGraderNeverRemovesATrueCandidate(t *testing.T) {
	random := newXoshiro(31337)
	used := map[int]bool{}
	targets := []int{38, 30, 0, 0, 0}
	for n := range 250 {
		solution := randomSolution(make([]int, cells), random)
		givens := removeCells(solution, targets[n%5], random)
		g, err := newGrader(givens[:])
		if err != nil {
			t.Fatal(err)
		}
		for {
			tq := g.step()
			if tq < 0 {
				break
			}
			used[tq] = true
			for i := range cells {
				if g.grid[i] != 0 {
					if g.grid[i] != solution[i] {
						t.Fatalf("wrong placement at %d", i)
					}
				} else if g.cand[i]&(1<<(solution[i]-1)) == 0 {
					t.Fatalf("true candidate removed at %d by %s", i, Techniques[tq].Name)
				}
			}
		}
	}
	if len(used) < 12 {
		t.Errorf("only %d techniques exercised", len(used))
	}
}

func TestGenerateVersionDispatches(t *testing.T) {
	const seed = 0x9f2c4a1b7e30d5c8
	v1, err := Generate(seed, 2, 3, 5)
	if err != nil {
		t.Fatal(err)
	}
	g2, err := GenerateV2(seed, 2, 3, 5)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := GenerateVersion(VersionClassic, seed, 2, 3, 5); err != nil || got != v1 {
		t.Errorf("classic = %+v, %v", got, err)
	}
	if got, err := GenerateVersion(VersionGraded, seed, 2, 3, 5); err != nil || got != g2.Puzzle {
		t.Errorf("graded = %+v, %v", got, err)
	}
	if v1 == g2.Puzzle {
		t.Error("the two generators gave the same puzzle")
	}
	for _, v := range []int{0, 3, -1} {
		if _, err := GenerateVersion(v, seed, 2, 3, 5); err == nil {
			t.Errorf("version %d accepted", v)
		}
	}
	// Argument errors come through from either generator.
	for _, v := range []int{VersionClassic, VersionGraded} {
		if _, err := GenerateVersion(v, seed, 8, 1, 5); err == nil {
			t.Errorf("version %d accepted day 8", v)
		}
	}
}

func TestGenerateEndlessVersion(t *testing.T) {
	const es = 0x0123456789abcdef
	c, err := GenerateEndlessVersion(VersionClassic, es, 2, 3)
	want, _ := GenerateEndless(es, 2, 3)
	if err != nil || c != want {
		t.Errorf("classic = %+v, %v", c, err)
	}
	g, err := GenerateEndlessVersion(VersionGraded, es, 2, 3)
	wantG, _ := GenerateEndlessV2(es, 2, 3)
	if err != nil || g != wantG.Puzzle || g == c {
		t.Errorf("graded = %+v, %v", g, err)
	}
	if _, err := GenerateEndlessVersion(VersionGraded, es, 0, 3); err == nil {
		t.Error("expected an error for a bad difficulty")
	}
	if _, err := GenerateEndlessVersion(9, es, 2, 3); err == nil {
		t.Error("expected an error for an unknown version")
	}
}
