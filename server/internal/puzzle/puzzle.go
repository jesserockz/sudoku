// Package puzzle is a bit-exact port of the web client's deterministic puzzle
// generator (web/src/generator), so the server can regenerate a day's puzzle
// and validate replays.
//
// Any change here that alters output changes everyone's puzzles. The golden
// tests catch that; if a change is intentional, bump GeneratorVersion and the
// goldens, in step with the web generator.
package puzzle

import (
	"fmt"
	"strconv"
)

// GeneratorVersion must be bumped on any output-changing edit to the generator.
const GeneratorVersion = 1

// MaxLevels is the most games per day the server allows.
const MaxLevels = 10

// maxAttempts is the attempts before settling for the closest-to-target puzzle.
const maxAttempts = 8

// domain is "sudoku" in ASCII; separates this seed derivation from any other
// use of the week seed.
const domain uint64 = 0x7375646f6b75

type difficulty struct {
	name         string
	targetGivens int
}

// difficulties are the five tiers, easiest first.
var difficulties = [...]difficulty{
	{"Easy", 40},
	{"Medium", 36},
	{"Hard", 32},
	{"Expert", 28},
	{"Diabolical", 24},
}

// Puzzle is a generated puzzle as 81-character strings ('0' = empty).
type Puzzle struct {
	Givens, Solution string
}

// ParseWeekSeed parses the weekly seed: exactly 16 hex characters.
func ParseWeekSeed(hex string) (uint64, error) {
	if len(hex) != 16 {
		return 0, fmt.Errorf("week seed must be 16 hex characters: %q", hex)
	}
	for i := 0; i < len(hex); i++ {
		c := hex[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return 0, fmt.Errorf("week seed must be 16 hex characters: %q", hex)
		}
	}
	// Cannot fail: 16 validated hex digits fit in 64 bits.
	v, _ := strconv.ParseUint(hex, 16, 64)
	return v, nil
}

func checkLevels(levels int) error {
	if levels < 1 || levels > MaxLevels {
		return fmt.Errorf("levels must be 1..%d: %d", MaxLevels, levels)
	}
	return nil
}

// DifficultyFor is the tier of game level (1..levels) on a day with levels
// games. Games are spread evenly across the five tiers, easiest first: game i
// (0-based) of n gets tier round(i*4/(n-1)), halves rounding up, in exact
// integer arithmetic. One game is Hard.
func DifficultyFor(level, levels int) (name string, targetGivens int, err error) {
	d, err := tier(level, levels)
	if err != nil {
		return "", 0, err
	}
	return d.name, d.targetGivens, nil
}

func tier(level, levels int) (difficulty, error) {
	if err := checkLevels(levels); err != nil {
		return difficulty{}, err
	}
	if level < 1 || level > levels {
		return difficulty{}, fmt.Errorf("level must be 1..%d: %d", levels, level)
	}
	if levels == 1 {
		return difficulties[2], nil
	}
	i := level - 1
	last := len(difficulties) - 1
	return difficulties[(2*i*last+(levels-1))/(2*(levels-1))], nil
}

// puzzleSeed is the seed for one puzzle: every input passes through a full
// SplitMix64 mix.
func puzzleSeed(weekSeed uint64, dayOfWeek, level int) uint64 {
	h := mix(domain + GeneratorVersion)
	h = mix(h ^ weekSeed)
	h = mix(h + uint64(dayOfWeek))
	h = mix(h + uint64(level))
	return h
}

// Generate is deterministic puzzle generation: a pure function of
// (weekSeed, dayOfWeek, level, levels) giving bit-identical puzzles to the web
// generator.
//
//  1. Derive a puzzle seed from the version, week seed, day and game number
//     with SplitMix64, and seed xoshiro256** from it.
//  2. Build a full grid by backtracking search, trying candidates in random order.
//  3. Visit the cells in a random order, removing each one only if the puzzle
//     still has a unique solution, until the tier's target given count is hit.
//  4. If a pass ends above target, start again from a fresh grid, up to 8
//     times, and keep the attempt with the fewest givens (earliest on ties).
//
// dayOfWeek is 1 (Monday) to 7 (Sunday).
func Generate(weekSeed uint64, dayOfWeek, level, levels int) (Puzzle, error) {
	if dayOfWeek < 1 || dayOfWeek > 7 {
		return Puzzle{}, fmt.Errorf("dayOfWeek must be 1 (Monday) to 7 (Sunday): %d", dayOfWeek)
	}
	d, err := tier(level, levels)
	if err != nil {
		return Puzzle{}, err
	}
	random := newXoshiro(puzzleSeed(weekSeed, dayOfWeek, level))

	var bestGivens, bestSolution [cells]int
	bestCount := -1
	for attempt := 0; attempt < maxAttempts; attempt++ {
		solution := randomSolution(make([]int, cells), random)
		givens := removeCells(solution, d.targetGivens, random)
		count := 0
		for _, v := range givens {
			if v != 0 {
				count++
			}
		}
		if bestCount < 0 || count < bestCount {
			bestGivens, bestSolution, bestCount = givens, solution, count
		}
		if count <= d.targetGivens {
			break
		}
	}
	return Puzzle{Givens: gridString(bestGivens), Solution: gridString(bestSolution)}, nil
}

func gridString(g [cells]int) string {
	b := make([]byte, cells)
	for i, v := range g {
		b[i] = byte('0' + v)
	}
	return string(b)
}

func removeCells(solution [cells]int, target int, random *xoshiro) [cells]int {
	grid := solution
	order := make([]int, cells)
	for i := range order {
		order[i] = i
	}
	random.shuffle(order)
	count := cells
	for _, i := range order {
		if count <= target {
			break
		}
		digit := grid[i]
		grid[i] = 0
		if hasUniqueSolution(grid[:]) {
			count--
		} else {
			grid[i] = digit
		}
	}
	return grid
}
