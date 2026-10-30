package puzzle

import (
	"slices"
	"testing"
)

func TestSplitMix64(t *testing.T) {
	sm := splitMix64{state: 1234567}
	want := []int64{6457827717110365317, 3203168211198807973, -8629252141511181193}
	for i, w := range want {
		if got := int64(sm.next()); got != w {
			t.Errorf("next #%d = %d, want %d", i, got, w)
		}
	}
}

func TestXoshiro(t *testing.T) {
	x := newXoshiro(42)
	want := []int64{1546998764402558742, 6990951692964543102, -5902157311460992607, -1389169964527427423}
	for i, w := range want {
		if got := int64(x.nextU64()); got != w {
			t.Errorf("nextU64 #%d = %d, want %d", i, got, w)
		}
	}

	y := newXoshiro(42)
	wantInts := []int{6, 2, 6, 1, 8, 7, 2, 6}
	for i, w := range wantInts {
		if got := y.nextInt(9); got != w {
			t.Errorf("nextInt #%d = %d, want %d", i, got, w)
		}
	}
	if got := y.nextInt(1); got != 0 {
		t.Errorf("nextInt(1) = %d, want 0", got)
	}
}

func TestNextIntRejection(t *testing.T) {
	// A huge bound makes the rejected tail large, so rejection is hit.
	x := newXoshiro(7)
	bound := 3<<30 + 1
	for range 200 {
		if got := x.nextInt(bound); got < 0 || got >= bound {
			t.Fatalf("nextInt(%d) = %d out of range", bound, got)
		}
	}
}

func TestShuffleIsPermutation(t *testing.T) {
	a := []int{0, 1, 2, 3, 4, 5, 6, 7, 8}
	newXoshiro(1).shuffle(a)
	sorted := slices.Clone(a)
	slices.Sort(sorted)
	if !slices.Equal(sorted, []int{0, 1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Errorf("shuffle lost elements: %v", a)
	}
}

func TestParseWeekSeed(t *testing.T) {
	tests := []struct {
		in      string
		want    uint64
		wantErr bool
	}{
		{"9f2c4a1b7e30d5c8", 0x9f2c4a1b7e30d5c8, false},
		{"9F2C4A1B7E30D5C8", 0x9f2c4a1b7e30d5c8, false},
		{"0000000000000000", 0, false},
		{"ffffffffffffffff", ^uint64(0), false},
		{"123", 0, true},
		{"", 0, true},
		{"00000000000000000", 0, true},
		{"zzzzzzzzzzzzzzzz", 0, true},
		{"000000000000000g", 0, true},
		{"000000000000000G", 0, true},
		{"/000000000000000", 0, true},
		{":000000000000000", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseWeekSeed(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %x, want %x", got, tt.want)
			}
		})
	}
}

func TestPuzzleSeedPinned(t *testing.T) {
	if GeneratorVersion != 1 {
		t.Fatalf("GeneratorVersion = %d, want 1", GeneratorVersion)
	}
	seed, err := ParseWeekSeed("9f2c4a1b7e30d5c8")
	if err != nil {
		t.Fatal(err)
	}
	if got := int64(puzzleSeed(seed, 1, 1)); got != 4473328950258826066 {
		t.Errorf("puzzleSeed = %d, want 4473328950258826066", got)
	}
}

// Golden puzzles: what guarantees everyone (and every app version) generates the same puzzles.
// Don't update these unless the change is deliberate, and bump GeneratorVersion when it is.
func TestGenerateGoldens(t *testing.T) {
	tests := []struct {
		seed     string
		day, lvl int
		givens   string
		solution string
	}{
		{"9f2c4a1b7e30d5c8", 1, 1,
			"020091683006050000817600520080405071002080946470069000700918000100006754203000090",
			"524791683936852417817643529689435271352187946471269835745918362198326754263574198"},
		{"9f2c4a1b7e30d5c8", 1, 2,
			"630897020480650700025031000010005000800019003002068104260004300004003008007006040",
			"631897425489652731725431986913245867846719253572368194268574319154923678397186542"},
		{"9f2c4a1b7e30d5c8", 1, 3,
			"090054010504000007000830090050009000000020309930760004068203070109070800300180000",
			"793654218584912637216837495851349726647521389932768154468293571129475863375186942"},
		{"9f2c4a1b7e30d5c8", 1, 4,
			"007008903001000082020004710309000000100206000800090306003000600204000079010000500",
			"457128963631579482928364715369785241145236897872491356593817624284653179716942538"},
		{"9f2c4a1b7e30d5c8", 1, 5,
			"000004010600000009801057002005600000930000805000000400700040006004000020302080000",
			"593264718627813549841957632415678293936421875278395461759142386184536927362789154"},
		{"0000000000000000", 7, 5,
			"000300001504009600000000080020917050005000000000850030406705020000000004030020000",
			"289376541514289673367541289823917456975463812641852937496735128752198364138624795"},
		{"ffffffffffffffff", 4, 3,
			"700300000259108006000024800000000100017002003823610007000780630061050000370060000",
			"784396215259178346136524879495837162617942583823615497542789631961453728378261954"},
		{"0123456789abcdef", 3, 1,
			"003000061000010732028003005260807000480060000307021680030006408015030296946002570",
			"573249861694518732128673945261897354489365127357421689732956418815734296946182573"},
		{"8000000000000000", 6, 4,
			"001000009637000000800657301003000000500008006900500487060705000070094008000000090",
			"251843679637921854894657321783469512542178936916532487169785243375294168428316795"},
	}
	for _, tt := range tests {
		seed, err := ParseWeekSeed(tt.seed)
		if err != nil {
			t.Fatal(err)
		}
		p, err := Generate(seed, tt.day, tt.lvl, 5)
		if err != nil {
			t.Fatalf("%s day %d level %d: %v", tt.seed, tt.day, tt.lvl, err)
		}
		if p.Givens != tt.givens {
			t.Errorf("givens for %s day %d level %d = %s, want %s", tt.seed, tt.day, tt.lvl, p.Givens, tt.givens)
		}
		if p.Solution != tt.solution {
			t.Errorf("solution for %s day %d level %d = %s, want %s", tt.seed, tt.day, tt.lvl, p.Solution, tt.solution)
		}
	}
}

// Every level of a day: solution matches givens, givens are unique, and games
// sharing a tier differ.
func TestGenerateDay(t *testing.T) {
	seed, err := ParseWeekSeed("9f2c4a1b7e30d5c8")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for level := 1; level <= 10; level++ {
		p, err := Generate(seed, 1, level, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Givens) != 81 || len(p.Solution) != 81 {
			t.Fatalf("level %d: bad lengths", level)
		}
		seen[p.Givens] = true
		grid := make([]int, 81)
		for i := range grid {
			grid[i] = int(p.Givens[i] - '0')
			if grid[i] != 0 && p.Givens[i] != p.Solution[i] {
				t.Fatalf("level %d: given %d differs from solution", level, i)
			}
		}
		if !hasUniqueSolution(grid) {
			t.Errorf("level %d: not uniquely solvable", level)
		}
	}
	if len(seen) != 10 {
		t.Errorf("got %d distinct puzzles, want 10", len(seen))
	}
}

// A grid with no solution and an inconsistent empty cell exercise the solver's dead ends.
func TestHasUniqueSolutionEdges(t *testing.T) {
	// Empty grid has many solutions.
	if hasUniqueSolution(make([]int, 81)) {
		t.Error("empty grid reported unique")
	}
	// Row 0 holds 1..8, and 9 is blocked in column 8 by a 9 below: cell 8 has no candidates.
	grid := make([]int, 81)
	for i := range 8 {
		grid[i] = i + 1
	}
	grid[17] = 9
	if hasUniqueSolution(grid) {
		t.Error("unsolvable grid reported unique")
	}
}

func TestDifficultyFor(t *testing.T) {
	names := func(n int) []string {
		var out []string
		for l := 1; l <= n; l++ {
			name, _, err := DifficultyFor(l, n)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, name)
		}
		return out
	}
	tests := []struct {
		levels int
		want   []string
	}{
		{1, []string{"Hard"}},
		{3, []string{"Easy", "Hard", "Diabolical"}},
		{5, []string{"Easy", "Medium", "Hard", "Expert", "Diabolical"}},
		{7, []string{"Easy", "Medium", "Medium", "Hard", "Expert", "Expert", "Diabolical"}},
		{10, []string{"Easy", "Easy", "Medium", "Medium", "Hard", "Hard", "Expert", "Expert", "Diabolical", "Diabolical"}},
	}
	for _, tt := range tests {
		if got := names(tt.levels); !slices.Equal(got, tt.want) {
			t.Errorf("levels %d: got %v, want %v", tt.levels, got, tt.want)
		}
	}

	targets := map[string]int{"Easy": 40, "Medium": 36, "Hard": 32, "Expert": 28, "Diabolical": 24}
	for l := 1; l <= 5; l++ {
		n, g, _ := DifficultyFor(l, 5)
		if targets[n] != g {
			t.Errorf("%s target = %d, want %d", n, g, targets[n])
		}
	}
}

func TestArgumentErrors(t *testing.T) {
	tests := []struct {
		name               string
		day, level, levels int
	}{
		{"day zero", 0, 1, 5},
		{"day eight", 8, 1, 5},
		{"levels zero", 1, 1, 0},
		{"levels too many", 1, 1, MaxLevels + 1},
		{"level zero", 1, 0, 5},
		{"level above levels", 1, 6, 5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Generate(1, tt.day, tt.level, tt.levels); err == nil {
				t.Error("Generate: expected error")
			}
			if tt.day == 1 {
				if _, _, err := DifficultyFor(tt.level, tt.levels); err == nil {
					t.Error("DifficultyFor: expected error")
				}
			}
		})
	}
}

func TestPeers(t *testing.T) {
	for i := range 81 {
		p := Peers(i)
		if len(p) != 20 {
			t.Fatalf("cell %d: %d peers, want 20", i, len(p))
		}
		if !slices.IsSorted(p) || slices.Contains(p, i) {
			t.Errorf("cell %d: peers unsorted or contain self: %v", i, p)
		}
	}
	want := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 27, 36, 45, 54, 63, 72}
	if got := Peers(0); !slices.Equal(got, want) {
		t.Errorf("Peers(0) = %v, want %v", got, want)
	}
}
