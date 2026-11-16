package puzzle

import (
	"fmt"
	"math"
)

// Endless puzzles of the Sudoku variants (Diagonal, Jigsaw, Killer): a
// bit-exact port of web/src/generator/variants.ts (see there for the full
// description). The shared fixture testdata/variants.json pins both.

// variantDomain is "variant" in ASCII: mixed into the endless puzzle seed for
// variants other than 0.
const variantDomain uint64 = 0x76617269616e74

// jigsawDomain is "jigsaw" in ASCII: the derivation of a jigsaw puzzle's
// region layout from its puzzle seed.
const jigsawDomain uint64 = 0x6a6967736177

const (
	// MaxJigsawAttempts is the layouts tried for a jigsaw puzzle before taking
	// one of fallbackJigsaws.
	MaxJigsawAttempts = 16
	// jigsawMoves is the moves tried when reshaping the boxes into regions.
	jigsawMoves = 600
	// jigsawNodes is the node budget of the search for a jigsaw layout's
	// first solution: a layout that needs more is rejected.
	jigsawNodes = 2000
	// removalNodes is the node budget of each uniqueness check while removing
	// cells: a check over budget keeps the cell.
	removalNodes = 3000
)

// MaxAttemptsVariantGraded is the attempts of a Graded puzzle, per variant,
// before settling for the closest-to-band one.
var MaxAttemptsVariantGraded = [Variants]int{200, 200, 200, 30}

// GradedGivens is the givens each Graded tier (Easy to Diabolical) removes
// down to, per variant (0 is Bands').
var GradedGivens = [Variants][Tiers]int{
	{38, 30, 0, 0, 0},
	{38, 26, 25, 23, 24},
	{38, 25, 24, 24, 23},
	{40, 26, 10, 6, 3},
}

// CagePolicy is the cage sizes of a killer tier: each cage aims for a size
// drawn from MinSize..MaxSize.
type CagePolicy struct{ MinSize, MaxSize int }

// KillerCages is the cage sizes per tier (Easy to Diabolical), both
// generators.
var KillerCages = [Tiers]CagePolicy{{3, 4}, {3, 4}, {3, 5}, {3, 5}, {4, 5}}

// KillerGivens is the givens each Classic Killer tier removes down to.
var KillerGivens = [Tiers]int{30, 22, 14, 9, 6}

// fallbackJigsaws are the jigsaw layouts used, by puzzle seed (seed mod 4),
// only when MaxJigsawAttempts generated layouts all fail: a region index per
// cell and a solution.
var fallbackJigsaws = [4][2]string{
	{"001111222000111522000011552333444552333444522363447555663477888677777788666668888", "645379218927184635351826749184753926569218374793642581412967853238495167876531492"},
	{"000011222033011122031111222034445552034444555333644855366678885667677788667777888", "163459782512847693798213546954632871285791364376528419437986125649175238821364957"},
	{"000411222000411222000411252334411255333441885333344855666778855666777885666777788", "637258419541769238892134675356812794189347562724695381273481956415976823968523147"},
	{"000002222030222212031111115033144815633348855633444855666644855666747885777777788", "562481397379642518125836749758964123293157486946273851631598274487315962814729635"},
}

// variantPuzzleSeed is the seed of an endless variant puzzle: the standard
// seed of the generator, then the variant mixed in (variants above 0 only).
func variantPuzzleSeed(generator, variant int, endlessSeed uint64, tier int, number int64) (uint64, error) {
	var h uint64
	switch generator {
	case VersionClassic:
		h = endlessPuzzleSeed(endlessSeed, tier, number)
	case VersionGraded:
		h = endlessPuzzleSeedV2(endlessSeed, tier, number)
	default:
		return 0, fmt.Errorf("unknown generator version %d", generator)
	}
	if variant == VariantStandard {
		return h, nil
	}
	return mix(h ^ mix(variantDomain+uint64(variant))), nil
}

// neighbour is the cell next to i in direction dir (0 up, 1 right, 2 down, 3
// left), or -1 off the grid.
func neighbour(i, dir int) int {
	r := rowOf(i) + [4]int{-1, 0, 1, 0}[dir]
	c := colOf(i) + [4]int{0, 1, 0, -1}[dir]
	if r >= 0 && r < 9 && c >= 0 && c < 9 {
		return r*9 + c
	}
	return -1
}

// connected reports whether the cells of region g are orthogonally connected.
func connected(regions *[cells]int, g int) bool {
	start := 0
	for regions[start] != g {
		start++
	}
	var seen [cells]bool
	stack := []int{start}
	seen[start] = true
	n := 0
	for len(stack) > 0 {
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n++
		for dir := range 4 {
			if w := neighbour(v, dir); w >= 0 && !seen[w] && regions[w] == g {
				seen[w] = true
				stack = append(stack, w)
			}
		}
	}
	return n == 9
}

// reshapeRegions reshapes the boxes into irregular regions with moves tries
// (see variants.ts).
func reshapeRegions(random *xoshiro, moves int) [cells]int {
	regions := boxRegions
	var list []int
	for range moves {
		a := random.nextInt(cells)
		b := neighbour(a, random.nextInt(4))
		if b < 0 || regions[b] == regions[a] {
			continue
		}
		ra, rb := regions[a], regions[b]
		list = list[:0]
		for c := range cells {
			if regions[c] != rb {
				continue
			}
			for dir := range 4 {
				if w := neighbour(c, dir); w >= 0 && w != a && regions[w] == ra {
					list = append(list, c)
					break
				}
			}
		}
		if len(list) == 0 {
			continue
		}
		c := list[random.nextInt(len(list))]
		regions[a], regions[c] = rb, ra
		if !connected(&regions, ra) || !connected(&regions, rb) {
			regions[a], regions[c] = ra, rb
		}
	}
	return regions
}

// jigsaw is a jigsaw puzzle's layout with a solution grid for it.
type jigsaw struct {
	layout   *Layout
	solution [cells]int
	attempts int
	fallback bool
}

// jigsawFor is the region layout of a jigsaw puzzle, with a solution, from
// its puzzle seed (see jigsawLayout in variants.ts).
func jigsawFor(seed uint64, maxAttempts int) jigsaw {
	base := mix(seed ^ jigsawDomain)
	for a := range maxAttempts {
		random := newXoshiro(mix(base + uint64(a)))
		// Reshaped regions always have nine cells each.
		layout, _ := NewJigsawLayout(reshapeRegions(random, jigsawMoves))
		if sol := firstSolutionIn(layout, make([]int, cells), random, jigsawNodes); sol != nil {
			return jigsaw{layout, *sol, a + 1, false}
		}
	}
	fb := fallbackJigsaws[seed%uint64(len(fallbackJigsaws))]
	var regions, solution [cells]int
	for i := range cells {
		regions[i] = int(fb[0][i] - '0')
		solution[i] = int(fb[1][i] - '0')
	}
	layout, _ := NewJigsawLayout(regions)
	return jigsaw{layout, solution, maxAttempts, true}
}

// relabel renames the digits of solution by a permutation drawn from random.
func relabel(solution [cells]int, random *xoshiro) [cells]int {
	perm := []int{1, 2, 3, 4, 5, 6, 7, 8, 9}
	random.shuffle(perm)
	for i, d := range solution {
		solution[i] = perm[d-1]
	}
	return solution
}

// carveCages makes killer cages over a solution grid (see variants.ts).
func carveCages(solution [cells]int, random *xoshiro, policy CagePolicy) []Cage {
	var cageOf [cells]int
	for i := range cageOf {
		cageOf[i] = -1
	}
	var cages [][]int
	order := make([]int, cells)
	for i := range order {
		order[i] = i
	}
	random.shuffle(order)
	touches := func(c, k int) bool {
		for dir := range 4 {
			if w := neighbour(c, dir); w >= 0 && cageOf[w] == k {
				return true
			}
		}
		return false
	}
	digits := func(k int) int {
		m := 0
		for _, c := range cages[k] {
			m |= 1 << solution[c]
		}
		return m
	}
	var options []int
	for _, s := range order {
		if cageOf[s] != -1 {
			continue
		}
		k := len(cages)
		size := policy.MinSize + random.nextInt(policy.MaxSize-policy.MinSize+1)
		cages = append(cages, []int{s})
		cageOf[s] = k
		for len(cages[k]) < size {
			used := digits(k)
			options = options[:0]
			for c := range cells {
				if cageOf[c] == -1 && used&(1<<solution[c]) == 0 && touches(c, k) {
					options = append(options, c)
				}
			}
			if len(options) == 0 {
				break
			}
			c := options[random.nextInt(len(options))]
			cages[k] = append(cages[k], c)
			cageOf[c] = k
		}
	}
	// mergeSmall joins each cage of fewer than below cells to the first
	// adjacent cage it fits into (at most limit cells together).
	mergeSmall := func(below, limit int) {
		for k := range cages {
			cage := cages[k]
			if len(cage) == 0 || len(cage) >= below {
				continue
			}
			for j := range cages {
				other := cages[j]
				if j == k || len(other) == 0 || len(other)+len(cage) > limit || digits(j)&digits(k) != 0 {
					continue
				}
				touching := false
				for _, c := range cage {
					touching = touching || touches(c, j)
				}
				if !touching {
					continue
				}
				for _, c := range cage {
					cageOf[c] = j
				}
				cages[j] = append(other, cage...)
				cages[k] = nil
				break
			}
		}
	}
	mergeSmall(policy.MinSize, policy.MaxSize)
	mergeSmall(2, cells)
	var out []Cage
	for _, cs := range cages {
		if len(cs) == 0 {
			continue
		}
		sum := 0
		for _, c := range cs {
			sum += solution[c]
		}
		out = append(out, Cage{Cells: cs, Sum: sum})
	}
	return out
}

// CageEmptyMin is the cells every Killer cage must keep empty for the player.
const CageEmptyMin = 2

// cagesPlayable reports whether every cage of a Killer layout has at least
// CageEmptyMin cells empty in grid (always true for other layouts).
func cagesPlayable(l *Layout, grid [cells]int) bool {
	for _, cage := range l.Cages {
		empty := 0
		for _, c := range cage.Cells {
			if grid[c] == 0 {
				empty++
			}
		}
		if empty < CageEmptyMin {
			return false
		}
	}
	return true
}

// removeCellsIn is removeCells under a layout: cells in an order drawn from
// random, each removed if the puzzle stays provably unique (within nodeLimit
// search steps), down to target givens. Under a Killer layout the first
// CageEmptyMin cells of every cage in that order are tried first and
// whatever the target (so the grid can end below it): see cagesPlayable.
func removeCellsIn(l *Layout, solution [cells]int, target int, random *xoshiro, nodeLimit int) [cells]int {
	grid := solution
	order := make([]int, cells)
	for i := range order {
		order[i] = i
	}
	random.shuffle(order)
	var forced [cells]bool
	if l.Variant == VariantKiller {
		seen := make([]int, len(l.Cages))
		var first, rest []int
		for _, i := range order {
			if k := l.CageOf(i); seen[k] < CageEmptyMin {
				seen[k]++
				forced[i] = true
				first = append(first, i)
			} else {
				rest = append(rest, i)
			}
		}
		order = append(first, rest...)
	}
	count := cells
	for _, i := range order {
		if count <= target && !forced[i] {
			break
		}
		digit := grid[i]
		grid[i] = 0
		if hasUniqueSolutionIn(l, grid[:], nodeLimit) {
			count--
		} else {
			grid[i] = digit
		}
	}
	return grid
}

// unplayableKey is added to the distance key of an attempt that is not
// playable, so it ranks after every playable one.
const unplayableKey = 100000

// attempt is one attempt's full grid and layout.
type attempt struct {
	layout   *Layout
	solution [cells]int
}

// attempts makes each attempt's grid and layout for a variant puzzle.
func attempts(variant int, seed uint64, tier int, random *xoshiro) func() attempt {
	switch variant {
	case VariantDiagonal:
		return func() attempt {
			return attempt{diagonalLayout, *firstSolutionIn(diagonalLayout, make([]int, cells), random, math.MaxInt)}
		}
	case VariantJigsaw:
		j := jigsawFor(seed, MaxJigsawAttempts)
		return func() attempt { return attempt{j.layout, relabel(j.solution, random)} }
	}
	return func() attempt {
		solution := randomSolution(make([]int, cells), random)
		// Carved cages cover every cell once.
		layout, _ := NewKillerLayout(carveCages(solution, random, KillerCages[tier-1]))
		return attempt{layout, solution}
	}
}

// VariantBuild is a built variant puzzle with its layout, its grade (Graded
// only) and the attempts it took.
type VariantBuild struct {
	Puzzle
	Layout *Layout
	// Grade is nil for Classic.
	Grade    *LayoutGrade
	Attempts int
}

func givenCount(g [cells]int) int {
	n := 0
	for _, v := range g {
		if v != 0 {
			n++
		}
	}
	return n
}

// buildClassicVariant is a Classic variant puzzle from a puzzle seed and tier
// (1..Tiers): up to maxAttempts (at least 1) attempts, each a full grid (and
// layout) with cells removed down to the tier's target; the first playable one (every
// Killer cage keeps CageEmptyMin empty cells) to reach it, or else the
// playable one with the fewest givens (the earliest on ties), wins. Attempts
// that are not playable are only taken when none is.
func buildClassicVariant(seed uint64, variant, tier, maxAttempts int) VariantBuild {
	random := newXoshiro(seed)
	next := attempts(variant, seed, tier, random)
	target := difficulties[tier-1].targetGivens
	if variant == VariantKiller {
		target = KillerGivens[tier-1]
	}
	var best attempt
	var bestGivens [cells]int
	bestCount, n := -1, 0
	bestPlayable := false
	for n < maxAttempts {
		n++
		a := next()
		givens := removeCellsIn(a.layout, a.solution, target, random, removalNodes)
		count := givenCount(givens)
		playable := cagesPlayable(a.layout, givens)
		if bestCount < 0 || (playable && !bestPlayable) || (playable == bestPlayable && count < bestCount) {
			best, bestGivens, bestCount, bestPlayable = a, givens, count, playable
		}
		if playable && count <= target {
			break
		}
	}
	return VariantBuild{Puzzle{gridString(bestGivens), gridString(best.solution)}, best.layout, nil, n}
}

// buildGradedVariant is a Graded variant puzzle from a puzzle seed and tier
// (1..Tiers): generator v2's build under the variant, up to maxAttempts (at
// least 1) attempts with cells removed to GradedGivens, graded under the
// layout. The first in the band wins, else the non-stuck attempt nearest the
// band (the easier on equal distance, then the earliest), else the earliest.
// Attempts that are not playable rank after every playable one.
func buildGradedVariant(seed uint64, variant, tier, maxAttempts int) VariantBuild {
	band := Bands[tier-1]
	random := newXoshiro(seed)
	next := attempts(variant, seed, tier, random)
	var best attempt
	var bestGivens [cells]int
	var bestGrade LayoutGrade
	bestKey, n := 0, 0
	for n < maxAttempts {
		n++
		a := next()
		givens := removeCellsIn(a.layout, a.solution, GradedGivens[variant][tier-1], random, removalNodes)
		// The grid is a valid puzzle with 81 values in 0..9.
		g, _ := GradeLayout(givens[:], a.layout)
		playable := cagesPlayable(a.layout, givens)
		if playable && g.Level >= band.MinLevel && g.Level <= band.MaxLevel {
			best, bestGivens, bestGrade = a, givens, g
			break
		}
		key := 1000
		if g.Level != StuckLevel {
			key = band.distance(g.Level)*10 + g.Level
		}
		if !playable {
			key += unplayableKey
		}
		if n == 1 || key < bestKey {
			best, bestGivens, bestGrade, bestKey = a, givens, g, key
		}
	}
	return VariantBuild{Puzzle{gridString(bestGivens), gridString(best.solution)}, best.layout, &bestGrade, n}
}

// VariantPuzzle is an endless puzzle of a variant with its layout.
type VariantPuzzle struct {
	Puzzle
	Layout *Layout
}

// GenerateEndlessVariant is endless puzzle number (1..MaxEndlessNumber) of
// tier difficulty (1..Tiers) in variant (0..Variants-1) with generator
// version 1 (Classic) or 2 (Graded). Variant 0 is GenerateEndlessVersion's
// puzzle, unchanged, with the standard layout.
func GenerateEndlessVariant(generator, variant int, endlessSeed uint64, difficulty int, number int64) (VariantPuzzle, error) {
	if variant < 0 || variant >= Variants {
		return VariantPuzzle{}, fmt.Errorf("unknown variant %d", variant)
	}
	if variant == VariantStandard {
		p, err := GenerateEndlessVersion(generator, endlessSeed, difficulty, number)
		if err != nil {
			return VariantPuzzle{}, err
		}
		return VariantPuzzle{p, standardLayout}, nil
	}
	if difficulty < 1 || difficulty > Tiers {
		return VariantPuzzle{}, fmt.Errorf("difficulty must be 1..%d: %d", Tiers, difficulty)
	}
	if number < 1 || number > MaxEndlessNumber {
		return VariantPuzzle{}, fmt.Errorf("number must be 1..%d: %d", MaxEndlessNumber, number)
	}
	seed, err := variantPuzzleSeed(generator, variant, endlessSeed, difficulty, number)
	if err != nil {
		return VariantPuzzle{}, err
	}
	var b VariantBuild
	if generator == VersionClassic {
		b = buildClassicVariant(seed, variant, difficulty, maxAttempts)
	} else {
		b = buildGradedVariant(seed, variant, difficulty, MaxAttemptsVariantGraded[variant])
	}
	return VariantPuzzle{b.Puzzle, b.Layout}, nil
}
