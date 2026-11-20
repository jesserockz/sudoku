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
		MinSize  int    `json:"minSize"`
		MaxSize  int    `json:"maxSize"`
		Solution string `json:"solution"`
		Seed     string `json:"seed"`
		Cages    []Cage `json:"cages"`
	} `json:"cages"`
	Classic []struct {
		Seed        string `json:"seed"`
		Variant     int    `json:"variant"`
		Tier        int    `json:"tier"`
		MaxAttempts int    `json:"maxAttempts"`
		Givens      string `json:"givens"`
		Solution    string `json:"solution"`
		Cages       []Cage `json:"cages"`
		Attempts    int    `json:"attempts"`
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
	UntilSolvable []struct {
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
	} `json:"untilSolvable"`
	Daily []struct {
		Version    int    `json:"version"`
		WeekSeed   string `json:"weekSeed"`
		Day        int    `json:"day"`
		PuzzleSeed string `json:"puzzleSeed"`
		Variant    int    `json:"variant"`
		Tier       int    `json:"tier"`
		Givens     string `json:"givens"`
		Solution   string `json:"solution"`
		Regions    string `json:"regions"`
		Cages      []Cage `json:"cages"`
		GradeLevel int    `json:"gradeLevel"`
	} `json:"daily"`
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
	over := false
	for _, c := range loadVariantFixture(t).Cages {
		got := carveCages(grid81(c.Solution), newXoshiro(mustSeed(t, c.Seed)), CagePolicy{c.MinSize, c.MaxSize})
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(c.Cages)
		if string(gj) != string(wj) {
			t.Errorf("cages %d to %d: %s, want %s", c.MinSize, c.MaxSize, gj, wj)
		}
		l, err := NewKillerLayout(got)
		if err != nil || !l.Valid(digits(c.Solution)) {
			t.Errorf("cages %d to %d are not a valid killer layout: %v", c.MinSize, c.MaxSize, err)
		}
		// Every tier's cages have two cells or more; a singleton joins a cage whatever its size, and stays only without a neighbour to take it.
		smallest := cells
		for _, cage := range got {
			smallest = min(smallest, len(cage.Cells))
			over = over || len(cage.Cells) > c.MaxSize
		}
		if (smallest >= 2) != (c.MinSize > 1) {
			t.Errorf("cages %d to %d: smallest cage %d", c.MinSize, c.MaxSize, smallest)
		}
	}
	if !over {
		t.Error("no singleton joined a cage past its maximum size")
	}
}

func TestVariantFixtureClassic(t *testing.T) {
	for _, c := range loadVariantFixture(t).Classic {
		b := buildClassicVariant(mustSeed(t, c.Seed), c.Variant, c.Tier, c.MaxAttempts)
		if b.Givens != c.Givens || b.Solution != c.Solution || b.Grade != nil || b.Attempts != c.Attempts || len(b.Layout.Cages) != len(c.Cages) {
			t.Errorf("classic %s: got %s attempts %d", c.Seed, b.Givens, b.Attempts)
		}
	}
}

func TestVariantFixtureFallback(t *testing.T) {
	for _, c := range loadVariantFixture(t).Fallback {
		b := buildGradedVariant(mustSeed(t, c.Seed), c.Variant, c.Tier, c.MaxAttempts, false)
		if b.Givens != c.Givens || b.Solution != c.Solution || b.Grade.Level != c.GradeLevel || b.Attempts != c.Attempts {
			t.Errorf("fallback %s: got %s level %d attempts %d", c.Seed, b.Givens, b.Grade.Level, b.Attempts)
		}
		if want := fixtureLayout(t, c.Variant, c.Regions, c.Cages); b.Layout.Regions != want.Regions || len(b.Layout.Cages) != len(want.Cages) {
			t.Errorf("fallback %s: layout differs", c.Seed)
		}
	}
}

// TestVariantFixtureUntilSolvable checks the builds that go on past maxAttempts
// because the first attempt is stuck or unplayable, and that without the option
// they settle for that attempt.
func TestVariantFixtureUntilSolvable(t *testing.T) {
	f := loadVariantFixture(t)
	if len(f.UntilSolvable) == 0 {
		t.Fatal("no untilSolvable fixture cases")
	}
	for _, c := range f.UntilSolvable {
		seed := mustSeed(t, c.Seed)
		b := buildGradedVariant(seed, c.Variant, c.Tier, c.MaxAttempts, true)
		if b.Givens != c.Givens || b.Solution != c.Solution || b.Grade.Level != c.GradeLevel || b.Attempts != c.Attempts {
			t.Errorf("untilSolvable %s: got %s level %d attempts %d", c.Seed, b.Givens, b.Grade.Level, b.Attempts)
		}
		if want := fixtureLayout(t, c.Variant, c.Regions, c.Cages); b.Layout.Regions != want.Regions || len(b.Layout.Cages) != len(want.Cages) {
			t.Errorf("untilSolvable %s: layout differs", c.Seed)
		}
		if c.Attempts <= c.MaxAttempts || b.Grade.Level == StuckLevel || !cagesPlayable(b.Layout, grid81(b.Givens)) {
			t.Errorf("untilSolvable %s: attempts %d, stuck or unplayable", c.Seed, c.Attempts)
		}
		plain := buildGradedVariant(seed, c.Variant, c.Tier, c.MaxAttempts, false)
		if plain.Attempts != c.MaxAttempts || (plain.Grade.Level != StuckLevel && cagesPlayable(plain.Layout, grid81(plain.Givens))) {
			t.Errorf("untilSolvable %s: plain build is not the stuck or unplayable first attempt", c.Seed)
		}
	}
}

// TestVariantFixtureUnplayable checks the builds whose every attempt leaves a Killer cage short of empty cells: they still return one.
func TestVariantFixtureUnplayable(t *testing.T) {
	f := loadVariantFixture(t)
	n := 0
	for _, c := range f.Classic {
		if c.Variant == VariantKiller && c.MaxAttempts == 3 {
			n++
			if c.Attempts != 3 || cagesPlayable(fixtureLayout(t, c.Variant, "", c.Cages), grid81(c.Givens)) {
				t.Errorf("classic %s: attempts %d, or playable", c.Seed, c.Attempts)
			}
		}
	}
	for _, c := range f.Fallback {
		if c.Variant == VariantKiller && c.MaxAttempts == 3 {
			n++
			if c.Attempts != 3 || cagesPlayable(fixtureLayout(t, c.Variant, "", c.Cages), grid81(c.Givens)) {
				t.Errorf("fallback %s: attempts %d, or playable", c.Seed, c.Attempts)
			}
		}
	}
	if n != 4 {
		t.Errorf("%d unplayable fixture builds, want 4", n)
	}
}

func TestKillerCagesKeepTwoEmptyCells(t *testing.T) {
	for _, generator := range []int{VersionClassic, VersionGraded} {
		for tier := 1; tier <= Tiers; tier++ {
			for number := int64(1); number <= 4; number++ {
				p, err := GenerateEndlessVariant(generator, VariantKiller, 99, tier, number)
				if err != nil {
					t.Fatal(err)
				}
				givens := grid81(p.Givens)
				if !cagesPlayable(p.Layout, givens) {
					t.Errorf("generator %d tier %d #%d: a cage has fewer than %d empty cells", generator, tier, number, CageEmptyMin)
				}
				for _, cage := range p.Layout.Cages {
					if len(cage.Cells) < 2 {
						t.Errorf("generator %d tier %d #%d: cage of %d cell", generator, tier, number, len(cage.Cells))
					}
				}
				if !hasUniqueSolutionIn(p.Layout, givens[:], math.MaxInt) {
					t.Errorf("generator %d tier %d #%d: not unique", generator, tier, number)
				}
			}
		}
	}
}

func TestCagesPlayable(t *testing.T) {
	random := newXoshiro(8)
	sol := randomSolution(make([]int, cells), random)
	layout, _ := NewKillerLayout(carveCages(sol, newXoshiro(9), KillerCages[0]))
	if !cagesPlayable(layout, [cells]int{}) || cagesPlayable(layout, sol) || !cagesPlayable(standardLayout, sol) {
		t.Error("empty grid, full grid or standard layout wrong")
	}
	grid := [cells]int{}
	for _, cage := range layout.Cages {
		for _, c := range cage.Cells[2:] {
			grid[c] = sol[c]
		}
	}
	if !cagesPlayable(layout, grid) {
		t.Error("two empty cells per cage is playable")
	}
	c := layout.Cages[0].Cells[1]
	grid[c] = sol[c]
	if cagesPlayable(layout, grid) {
		t.Error("one empty cell in a cage is not playable")
	}
}

func TestRemoveCellsInForcesTwoEmptyCellsPerKillerCage(t *testing.T) {
	sol := randomSolution(make([]int, cells), newXoshiro(21))
	layout, _ := NewKillerLayout(carveCages(sol, newXoshiro(22), KillerCages[2]))
	grid := removeCellsIn(layout, sol, cells, newXoshiro(23), removalNodes)
	empty := 0
	for _, v := range grid {
		if v == 0 {
			empty++
		}
	}
	if !cagesPlayable(layout, grid) || empty != len(layout.Cages)*CageEmptyMin {
		t.Errorf("%d empty cells for %d cages", empty, len(layout.Cages))
	}
	dsol := *firstSolutionIn(diagonalLayout, make([]int, cells), newXoshiro(1), math.MaxInt)
	if g := removeCellsIn(diagonalLayout, dsol, cells, newXoshiro(23), removalNodes); g != dsol {
		t.Error("a diagonal layout removed cells past its target")
	}
	if stuck := removeCellsIn(layout, sol, cells, newXoshiro(23), 0); stuck != sol || cagesPlayable(layout, stuck) {
		t.Error("with no search budget no removal is provable")
	}
	some := removeCellsIn(layout, sol, 40, newXoshiro(23), removalNodes)
	if givenCount(some) > 40 || !cagesPlayable(layout, some) {
		t.Errorf("%d givens", givenCount(some))
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

func TestVariantFixtureDaily(t *testing.T) {
	variants, tiers, versions := map[int]bool{}, map[int]bool{}, map[int]bool{}
	f := loadVariantFixture(t)
	if len(f.Daily) < 28 {
		t.Fatalf("%d daily fixture cases", len(f.Daily))
	}
	for _, c := range f.Daily {
		at := fmt.Sprintf("%s day %d v%d", c.WeekSeed, c.Day, c.Version)
		seed := mustSeed(t, c.WeekSeed)
		variant, tier, ps := dailyVariantRound(seed, c.Day, c.Version)
		if variant != c.Variant || tier != c.Tier || ps != mustSeed(t, c.PuzzleSeed) {
			t.Errorf("%s: round %d/%d/%x", at, variant, tier, ps)
		}
		if v := DailyVariantOf(seed, c.Day); v != c.Variant {
			t.Errorf("%s: DailyVariantOf = %d", at, v)
		}
		d, err := GenerateDailyVariant(seed, c.Day, c.Version)
		if err != nil {
			t.Fatal(err)
		}
		if d.Variant != c.Variant || d.Tier != c.Tier || d.Givens != c.Givens || d.Solution != c.Solution {
			t.Errorf("%s: got v%d tier %d %s / %s", at, d.Variant, d.Tier, d.Givens, d.Solution)
		}
		want := fixtureLayout(t, c.Variant, c.Regions, c.Cages)
		if d.Layout.Variant != c.Variant || d.Layout.Regions != want.Regions || d.Layout.Diagonals != want.Diagonals || !slices.EqualFunc(d.Layout.Cages, want.Cages, func(a, b Cage) bool { return a.Sum == b.Sum && slices.Equal(a.Cells, b.Cells) }) {
			t.Errorf("%s: layout differs", at)
		}
		givens := digits(c.Givens)
		if g, _ := GradeLayout(givens, d.Layout); g.Level != c.GradeLevel {
			t.Errorf("%s: grade %d, want %d", at, g.Level, c.GradeLevel)
		}
		if !d.Layout.Valid(digits(c.Solution)) || !cagesPlayable(d.Layout, grid81(c.Givens)) {
			t.Errorf("%s: invalid or unplayable", at)
		}
		variants[d.Variant], tiers[d.Tier] = true, true
		versions[c.Version] = true
	}
	if len(variants) != 3 || len(tiers) != 3 || variants[VariantStandard] || !versions[1] || !versions[2] {
		t.Errorf("fixture covers variants %v tiers %v versions %v", variants, tiers, versions)
	}
}

func TestGenerateDailyVariantDay(t *testing.T) {
	for _, day := range []int{0, 8, -1} {
		if _, err := GenerateDailyVariant(1, day, 1); err == nil {
			t.Errorf("day %d accepted", day)
		}
	}
	for _, version := range []int{0, 3, -1} {
		if _, err := GenerateDailyVariant(1, 1, version); err == nil {
			t.Errorf("version %d accepted", version)
		}
	}
}

func TestDailyVariantVersion(t *testing.T) {
	for date, want := range map[string]int{"2026-11-19": 1, "2026-11-20": 2, "2025-01-01": 1, "2026-12-01": 2} {
		if got := DailyVariantVersion(date); got != want || DailyVariantVersion(DailyVariantCutoff) != 2 {
			t.Errorf("DailyVariantVersion(%s) = %d, want %d", date, got, want)
		}
	}
}

// TestDailyVariantVersionTiers checks that version 2 is one tier easier but draws the same variant and seed.
func TestDailyVariantVersionTiers(t *testing.T) {
	for day := 1; day <= 7; day++ {
		v1, t1, s1 := dailyVariantRound(7, day, 1)
		v2, t2, s2 := dailyVariantRound(7, day, 2)
		if v1 != v2 || s1 != s2 || t1 != t2+1 || (t1 != 4 && t1 != 5) {
			t.Errorf("day %d: v1 %d/%d/%x, v2 %d/%d/%x", day, v1, t1, s1, v2, t2, s2)
		}
	}
}
