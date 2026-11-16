package puzzle

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"testing"
)

// variantFixture is testdata/variants.json, shared with the web tests
// (web/test/variants.test.ts); the TypeScript engine is the reference.
type variantFixture struct {
	Techniques       []string `json:"techniques"`
	KillerTechniques []string `json:"killerTechniques"`
	Puzzles          []struct {
		Generator  int    `json:"generator"`
		Variant    int    `json:"variant"`
		Seed       string `json:"seed"`
		Tier       int    `json:"tier"`
		Number     int64  `json:"number"`
		PuzzleSeed string `json:"puzzleSeed"`
		Givens     string `json:"givens"`
		Solution   string `json:"solution"`
		Regions    string `json:"regions"`
		Cages      []Cage `json:"cages"`
		GradeLevel int    `json:"gradeLevel"`
	} `json:"puzzles"`
	Jigsaws []struct {
		Seed        string `json:"seed"`
		MaxAttempts int    `json:"maxAttempts"`
		Regions     string `json:"regions"`
		Solution    string `json:"solution"`
		Attempts    int    `json:"attempts"`
		Fallback    bool   `json:"fallback"`
	} `json:"jigsaws"`
	Cages []struct {
		Tier     int    `json:"tier"`
		Solution string `json:"solution"`
		Seed     string `json:"seed"`
		Cages    []Cage `json:"cages"`
	} `json:"cages"`
	Classic []struct {
		Seed     string `json:"seed"`
		Variant  int    `json:"variant"`
		Tier     int    `json:"tier"`
		Givens   string `json:"givens"`
		Solution string `json:"solution"`
		Cages    []Cage `json:"cages"`
		Attempts int    `json:"attempts"`
	} `json:"classic"`
	Fallback []struct {
		Seed        string `json:"seed"`
		Variant     int    `json:"variant"`
		Tier        int    `json:"tier"`
		MaxAttempts int    `json:"maxAttempts"`
		Givens      string `json:"givens"`
		Solution    string `json:"solution"`
		Regions     string `json:"regions"`
		Cages       []Cage `json:"cages"`
		GradeLevel  int    `json:"gradeLevel"`
		Attempts    int    `json:"attempts"`
	} `json:"fallback"`
	Solver []struct {
		Variant   int    `json:"variant"`
		Regions   string `json:"regions"`
		Cages     []Cage `json:"cages"`
		Givens    string `json:"givens"`
		NodeLimit int    `json:"nodeLimit"`
		Count     int    `json:"count"`
	} `json:"solver"`
	Grader []struct {
		Variant int    `json:"variant"`
		Regions string `json:"regions"`
		Cages   []Cage `json:"cages"`
		Givens  string `json:"givens"`
		Solved  bool   `json:"solved"`
		Level   int    `json:"level"`
		Steps   int    `json:"steps"`
		Counts  []int  `json:"counts"`
	} `json:"grader"`
}

func loadVariantFixture(t *testing.T) variantFixture {
	t.Helper()
	data, err := os.ReadFile("../../../testdata/variants.json")
	if err != nil {
		t.Fatal(err)
	}
	var f variantFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func grid81(s string) [cells]int {
	var g [cells]int
	copy(g[:], digits(s))
	return g
}

func mustSeed(t *testing.T, hex string) uint64 {
	t.Helper()
	v, err := ParseWeekSeed(hex)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// fixtureLayout is the layout a fixture case describes.
func fixtureLayout(t *testing.T, variant int, regions string, cages []Cage) *Layout {
	t.Helper()
	switch variant {
	case VariantDiagonal:
		return DiagonalLayout()
	case VariantJigsaw:
		l, err := NewJigsawLayout(grid81(regions))
		if err != nil {
			t.Fatal(err)
		}
		return l
	case VariantKiller:
		l, err := NewKillerLayout(cages)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	return StandardLayout()
}

func regionString(l *Layout) string {
	b := make([]byte, cells)
	for i, g := range l.Regions {
		b[i] = byte('0' + g)
	}
	return string(b)
}

func names(ts []Technique) []string {
	var out []string
	for _, t := range ts {
		out = append(out, t.Name)
	}
	return out
}

func TestVariantFixtureTechniques(t *testing.T) {
	f := loadVariantFixture(t)
	if !slices.Equal(f.Techniques, names(Techniques[:])) || !slices.Equal(f.KillerTechniques, names(KillerTechniques)) {
		t.Errorf("fixture techniques %v / %v, grader has %v / %v", f.Techniques, f.KillerTechniques, names(Techniques[:]), names(KillerTechniques))
	}
	if !slices.Equal(names(TechniquesFor(DiagonalLayout())), f.Techniques) {
		t.Error("diagonal grids use the standard techniques")
	}
}

func TestVariantFixturePuzzles(t *testing.T) {
	seen := map[[3]int]bool{}
	for _, c := range loadVariantFixture(t).Puzzles {
		at := fmt.Sprintf("g%d v%d %s tier %d #%d", c.Generator, c.Variant, c.Seed, c.Tier, c.Number)
		seed := mustSeed(t, c.Seed)
		ps, err := variantPuzzleSeed(c.Generator, c.Variant, seed, c.Tier, c.Number)
		if err != nil || ps != mustSeed(t, c.PuzzleSeed) {
			t.Errorf("%s: puzzle seed %x, %v", at, ps, err)
		}
		p, err := GenerateEndlessVariant(c.Generator, c.Variant, seed, c.Tier, c.Number)
		if err != nil {
			t.Fatal(err)
		}
		if p.Givens != c.Givens || p.Solution != c.Solution {
			t.Errorf("%s: got %s / %s, want %s / %s", at, p.Givens, p.Solution, c.Givens, c.Solution)
		}
		want := fixtureLayout(t, c.Variant, c.Regions, c.Cages)
		if p.Layout.Variant != c.Variant || p.Layout.Regions != want.Regions || p.Layout.Diagonals != want.Diagonals || !slices.EqualFunc(p.Layout.Cages, want.Cages, func(a, b Cage) bool { return a.Sum == b.Sum && slices.Equal(a.Cells, b.Cells) }) {
			t.Errorf("%s: layout %s %v, want %s %v", at, regionString(p.Layout), p.Layout.Cages, c.Regions, c.Cages)
		}
		sol := digits(c.Solution)
		if !p.Layout.Valid(sol) || slices.Contains(sol, 0) {
			t.Errorf("%s: solution breaks the rules", at)
		}
		givens := digits(c.Givens)
		for i, d := range givens {
			if d != 0 && d != sol[i] {
				t.Errorf("%s: given %d differs from the solution", at, i)
			}
		}
		if c.Generator == VersionGraded {
			if g, _ := GradeLayout(givens, p.Layout); g.Level != c.GradeLevel {
				t.Errorf("%s: grade %d, want %d", at, g.Level, c.GradeLevel)
			}
		}
		if c.Variant == VariantStandard {
			std, _ := GenerateEndlessVersion(c.Generator, seed, c.Tier, c.Number)
			if std != p.Puzzle || p.Layout != StandardLayout() {
				t.Errorf("%s: variant 0 is not the standard series", at)
			}
		}
		seen[[3]int{c.Generator, c.Variant, c.Tier}] = true
	}
	if len(seen) != 2*Variants*Tiers {
		t.Errorf("fixture covers %d generator/variant/tier combinations", len(seen))
	}
}

func TestVariantFixtureJigsaws(t *testing.T) {
	fallbacks := 0
	for _, c := range loadVariantFixture(t).Jigsaws {
		j := jigsawFor(mustSeed(t, c.Seed), c.MaxAttempts)
		if regionString(j.layout) != c.Regions || gridString(j.solution) != c.Solution || j.attempts != c.Attempts || j.fallback != c.Fallback {
			t.Errorf("jigsaw %s: got %s %s %d %v", c.Seed, regionString(j.layout), gridString(j.solution), j.attempts, j.fallback)
		}
		if !j.layout.Valid(j.solution[:]) {
			t.Errorf("jigsaw %s: solution breaks the rules", c.Seed)
		}
		for g := range 9 {
			if !connected(&j.layout.Regions, g) {
				t.Errorf("jigsaw %s: region %d is not connected", c.Seed, g)
			}
		}
		if c.Fallback {
			fallbacks++
		}
	}
	if fallbacks != len(fallbackJigsaws) {
		t.Errorf("fixture has %d fallbacks", fallbacks)
	}
}

func TestVariantFixtureCages(t *testing.T) {
	for _, c := range loadVariantFixture(t).Cages {
		got := carveCages(grid81(c.Solution), newXoshiro(mustSeed(t, c.Seed)), KillerCages[c.Tier-1])
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(c.Cages)
		if string(gj) != string(wj) {
			t.Errorf("tier %d: cages %s, want %s", c.Tier, gj, wj)
		}
		l, err := NewKillerLayout(got)
		if err != nil || !l.Valid(digits(c.Solution)) {
			t.Errorf("tier %d: cages are not a valid killer layout: %v", c.Tier, err)
		}
		for _, cage := range got {
			if len(cage.Cells) > KillerCages[c.Tier-1].MaxSize {
				t.Errorf("tier %d: cage of %d cells", c.Tier, len(cage.Cells))
			}
		}
	}
}

func TestVariantFixtureClassic(t *testing.T) {
	for _, c := range loadVariantFixture(t).Classic {
		b := buildClassicVariant(mustSeed(t, c.Seed), c.Variant, c.Tier)
		if b.Givens != c.Givens || b.Solution != c.Solution || b.Grade != nil || b.Attempts != c.Attempts || len(b.Layout.Cages) != len(c.Cages) {
			t.Errorf("classic %s: got %s attempts %d", c.Seed, b.Givens, b.Attempts)
		}
	}
}

func TestVariantFixtureFallback(t *testing.T) {
	for _, c := range loadVariantFixture(t).Fallback {
		b := buildGradedVariant(mustSeed(t, c.Seed), c.Variant, c.Tier, c.MaxAttempts)
		if b.Givens != c.Givens || b.Solution != c.Solution || b.Grade.Level != c.GradeLevel || b.Attempts != c.Attempts {
			t.Errorf("fallback %s: got %s level %d attempts %d", c.Seed, b.Givens, b.Grade.Level, b.Attempts)
		}
		if want := fixtureLayout(t, c.Variant, c.Regions, c.Cages); b.Layout.Regions != want.Regions || len(b.Layout.Cages) != len(want.Cages) {
			t.Errorf("fallback %s: layout differs", c.Seed)
		}
	}
}

func TestVariantFixtureSolver(t *testing.T) {
	for _, c := range loadVariantFixture(t).Solver {
		l := fixtureLayout(t, c.Variant, c.Regions, c.Cages)
		if n, err := CountSolutionsIn(l, digits(c.Givens), 2, c.NodeLimit); err != nil || n != c.Count {
			t.Errorf("v%d %s (budget %d): %d solutions, want %d (%v)", c.Variant, c.Givens, c.NodeLimit, n, c.Count, err)
		}
	}
}

func TestVariantFixtureGrader(t *testing.T) {
	used := map[int]map[int]bool{}
	for _, c := range loadVariantFixture(t).Grader {
		l := fixtureLayout(t, c.Variant, c.Regions, c.Cages)
		g, err := GradeLayout(digits(c.Givens), l)
		if err != nil {
			t.Fatal(err)
		}
		if g.Solved != c.Solved || g.Level != c.Level || g.Steps != c.Steps || !slices.Equal(g.Counts, c.Counts) {
			t.Errorf("v%d %s: got %+v, want level %d steps %d counts %v", c.Variant, c.Givens, g, c.Level, c.Steps, c.Counts)
		}
		if used[c.Variant] == nil {
			used[c.Variant] = map[int]bool{}
		}
		for tq, n := range g.Counts {
			if n > 0 {
				used[c.Variant][tq] = true
			}
		}
	}
	for _, id := range []int{2, 5, 6, 13} { // the killer techniques' indices in KillerTechniques
		if !used[VariantKiller][id] {
			t.Errorf("fixture never uses %s", KillerTechniques[id].Name)
		}
	}
}

func TestGenerateEndlessVariantArguments(t *testing.T) {
	for _, tc := range []struct {
		generator, variant, tier int
		number                   int64
	}{
		{1, -1, 1, 1}, {1, 4, 1, 1}, {3, 0, 1, 1}, {1, 1, 0, 1}, {1, 1, 6, 1}, {1, 1, 1, 0}, {1, 1, 1, MaxEndlessNumber + 1}, {3, 1, 1, 1},
	} {
		if _, err := GenerateEndlessVariant(tc.generator, tc.variant, 1, tc.tier, tc.number); err == nil {
			t.Errorf("%+v: no error", tc)
		}
	}
	if _, err := variantPuzzleSeed(0, 1, 1, 1, 1); err == nil {
		t.Error("unknown generator accepted")
	}
}

func TestVariantNames(t *testing.T) {
	got := []string{VariantName(0), VariantName(1), VariantName(2), VariantName(3), VariantName(9)}
	if !slices.Equal(got, []string{"Standard", "Diagonal", "Jigsaw", "Killer", "Variant 9"}) {
		t.Errorf("names %v", got)
	}
}

func TestLayouts(t *testing.T) {
	if len(StandardLayout().Units()) != 27 || len(DiagonalLayout().Units()) != 29 {
		t.Fatal("unit counts")
	}
	if got := DiagonalLayout().Units()[27]; got != [9]int{0, 10, 20, 30, 40, 50, 60, 70, 80} {
		t.Errorf("main diagonal %v", got)
	}
	if got := DiagonalLayout().Units()[28]; got != [9]int{8, 16, 24, 32, 40, 48, 56, 64, 72} {
		t.Errorf("anti-diagonal %v", got)
	}
	if !slices.Equal(StandardLayout().LayoutPeers(0), Peers(0)) || len(DiagonalLayout().LayoutPeers(40)) != 32 || StandardLayout().CageOf(0) != -1 {
		t.Error("peers")
	}
	var bad [cells]int
	bad[0] = 9
	if _, err := NewJigsawLayout(bad); err == nil {
		t.Error("region 9 accepted")
	}
	bad[0] = 1
	if _, err := NewJigsawLayout(bad); err == nil {
		t.Error("uneven regions accepted")
	}
	whole := make([]int, cells)
	for i := range whole {
		whole[i] = i
	}
	for _, cages := range [][]Cage{
		{{Cells: nil, Sum: 0}},
		{{Cells: []int{81}, Sum: 1}},
		{{Cells: []int{0, 0}, Sum: 1}},
		{{Cells: []int{0}, Sum: 1}},
	} {
		if _, err := NewKillerLayout(cages); err == nil {
			t.Errorf("cages %v accepted", cages)
		}
	}
	k, err := NewKillerLayout([]Cage{{Cells: whole[9:], Sum: 360}, {Cells: []int{8, 7, 6, 5, 4, 3, 2, 1, 0}, Sum: 45}})
	if err != nil || k.Cages[0].Cells[0] != 0 || k.CageOf(80) != 1 {
		t.Fatalf("killer layout %v %v", k, err)
	}
	full := digits("123456789456789123789123456214365897365897214897214365531642978642978531978531642")
	if !StandardLayout().Valid(full) || DiagonalLayout().Valid(full) {
		t.Error("validity of a standard grid")
	}
	row := slices.Clone(full)
	row[1] = 1
	cage, _ := NewKillerLayout([]Cage{{Cells: []int{0, 9}, Sum: 3}, {Cells: whole[1:9], Sum: 44}, {Cells: whole[10:], Sum: 0}})
	if StandardLayout().Valid(row) || cage.Valid(full) {
		t.Error("broken grids pass")
	}
	apart, _ := NewKillerLayout([]Cage{{Cells: []int{0, 13}, Sum: 3}, {Cells: slices.Concat(whole[1:13], whole[14:]), Sum: 402}})
	part := make([]int, cells)
	part[0], part[13] = 1, 1
	if apart.Valid(part) {
		t.Error("repeat in a cage passes")
	}
	part[13] = 2
	if !apart.Valid(part) {
		t.Error("a partial grid fails")
	}
}

func TestLayoutSolverEdges(t *testing.T) {
	empty := make([]int, cells)
	if _, err := CountSolutionsIn(DiagonalLayout(), empty, 0, 10); err == nil {
		t.Error("limit 0 accepted")
	}
	if _, err := CountSolutionsIn(DiagonalLayout(), empty[:80], 1, 10); err == nil {
		t.Error("80 cells accepted")
	}
	bad := make([]int, cells)
	bad[0] = 10
	if _, err := CountSolutionsIn(DiagonalLayout(), bad, 1, 10); err == nil {
		t.Error("value 10 accepted")
	}
	clash := make([]int, cells)
	clash[0], clash[10] = 5, 5 // the same diagonal
	if n, err := CountSolutionsIn(DiagonalLayout(), clash, 1, 10); n != 0 || err != nil {
		t.Errorf("clash: %d %v", n, err)
	}
	if firstSolutionIn(DiagonalLayout(), clash, nil, 10) != nil {
		t.Error("clash solved")
	}
	whole := make([]int, cells)
	for i := range whole {
		whole[i] = i
	}
	over, _ := NewKillerLayout([]Cage{{Cells: []int{0, 1}, Sum: 3}, {Cells: whole[2:], Sum: 402}})
	g := make([]int, cells)
	g[0] = 5
	if n, _ := CountSolutionsIn(over, g, 1, 100); n != 0 {
		t.Error("a given over its cage's sum")
	}
	if cageDigits(1, -1, 0) != 0 || cageDigits(1, 46, 0) != 0 || cageDigits(2, 3, 0) != 3 {
		t.Error("cageDigits")
	}
	// A standard layout searched by the layout solver agrees with solver.go.
	sol := randomSolution(empty, newXoshiro(5))
	puz := removeCells(sol, 30, newXoshiro(6))
	if n, _ := CountSolutionsIn(StandardLayout(), puz[:], 2, math.MaxInt); n != 1 {
		t.Error("standard puzzle not unique under the layout solver")
	}
}

func TestGradeLayoutErrors(t *testing.T) {
	if _, err := GradeLayout(make([]int, 80), DiagonalLayout()); err == nil {
		t.Error("80 cells accepted")
	}
	if _, err := GradeCells(make([]int, 80)); err == nil {
		t.Error("80 cells accepted")
	}
}

// Every grader step under a variant layout places a true digit and never
// removes a true candidate.
func TestVariantGraderIsSound(t *testing.T) {
	random := newXoshiro(4711)
	for n := range 60 {
		variant := 1 + n%3
		tier := 1 + n%5
		next := attempts(variant, uint64(n), tier, random)
		a := next()
		givens := removeCellsIn(a.layout, a.solution, GradedGivens[variant][tier-1], random, removalNodes)
		g, _ := newGrader(givens[:], a.layout)
		for g.step() >= 0 {
			for i := range cells {
				if g.grid[i] != 0 && g.grid[i] != a.solution[i] || g.grid[i] == 0 && g.cand[i]&(1<<(a.solution[i]-1)) == 0 {
					t.Fatalf("variant %d attempt %d: wrong step at cell %d", variant, n, i)
				}
			}
		}
	}
}
