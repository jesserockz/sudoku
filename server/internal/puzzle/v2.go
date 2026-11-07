package puzzle

import "fmt"

// Generator v2: puzzles graded by technique instead of by clue count. A
// bit-exact port of web/src/generator/generator-v2.ts.
//
// Each attempt builds a random full grid, removes cells (see Bands for how
// far), and grades the result with the human-style grader (grader.go). The
// first attempt whose level falls in the tier's band is the puzzle. The shared
// fixture testdata/generator-v2.json pins both implementations.
//
// Daily puzzles use it for the weeks the generator schedule says so; endless
// puzzles do not use it yet.

// GeneratorV2Version is the seed-derivation version for v2 (v1 is
// GeneratorVersion = 1).
const GeneratorV2Version = 2

// MaxAttemptsV2 is the attempts before settling for the closest-to-band puzzle.
const MaxAttemptsV2 = 200

// Band is a difficulty tier of v2: the grader levels it accepts and how far
// cells are removed.
type Band struct {
	Name string
	// MinLevel and MaxLevel are the lowest and highest grader levels accepted.
	MinLevel, MaxLevel int
	// TargetGivens is the clue count to stop removing at; 0 removes until the
	// puzzle is minimal.
	TargetGivens int
}

// Bands are the five tiers (Easy to Diabolical): level 1 hidden singles, 2
// naked singles, 3 to 4 locked candidates and subsets, 5 fish and wings, 6
// colouring and chains.
var Bands = [...]Band{
	{"Easy", 1, 1, 38},
	{"Medium", 2, 2, 30},
	{"Hard", 3, 4, 0},
	{"Expert", 5, 5, 0},
	{"Diabolical", 6, 6, 0},
}

// Graded is a v2 puzzle with how it was graded and how many attempts it took.
type Graded struct {
	Puzzle Puzzle
	Grade  Grade
	// Attempts is the attempts made (all of them, when none hit the band and
	// a fallback was chosen).
	Attempts int
}

// distance is how far level, which is outside the band, is from it.
func (b Band) distance(level int) int {
	if level < b.MinLevel {
		return b.MinLevel - level
	}
	return level - b.MaxLevel
}

// puzzleSeedV2 is the seed for one v2 daily puzzle: v1's derivation with
// version 2.
func puzzleSeedV2(weekSeed uint64, dayOfWeek, level int) uint64 {
	h := mix(domain + GeneratorV2Version)
	h = mix(h ^ weekSeed)
	h = mix(h + uint64(dayOfWeek))
	h = mix(h + uint64(level))
	return h
}

// endlessPuzzleSeedV2 is the seed for one v2 endless puzzle.
func endlessPuzzleSeedV2(endlessSeed uint64, tier int, number int64) uint64 {
	h := mix(endlessDomain + GeneratorV2Version)
	h = mix(h ^ endlessSeed)
	h = mix(h + uint64(tier))
	h = mix(h + uint64(number))
	return h
}

// buildV2 builds the puzzle for a puzzle seed and a tier (1..Tiers): up to
// maxAttempts (at least 1) times, a random full grid, cells removed to the
// band's target, then graded; the first attempt whose level is in the band
// wins.
//
// If none is, the fallback is the non-stuck attempt whose level is nearest
// the band (the easier one on equal distance, then the earliest). If every
// attempt was stuck, it is the earliest.
func buildV2(seed uint64, tier, maxAttempts int) Graded {
	band := Bands[tier-1]
	random := newXoshiro(seed)
	var best Graded
	var bestGivens, bestSolution [cells]int
	bestKey := 0
	attempts := 0
	for attempts < maxAttempts {
		attempts++
		solution := randomSolution(make([]int, cells), random)
		givens := removeCells(solution, band.TargetGivens, random)
		// The grid is a valid unique puzzle with 81 values in 0..9.
		g, _ := GradeCells(givens[:])
		if g.Level >= band.MinLevel && g.Level <= band.MaxLevel {
			bestGivens, bestSolution, best.Grade = givens, solution, g
			break
		}
		// Lower is better: a stuck attempt ranks last, then nearer the band,
		// then easier.
		key := 1000
		if g.Level != StuckLevel {
			key = band.distance(g.Level)*10 + g.Level
		}
		if attempts == 1 || key < bestKey {
			bestGivens, bestSolution, best.Grade = givens, solution, g
			bestKey = key
		}
	}
	best.Puzzle = Puzzle{Givens: gridString(bestGivens), Solution: gridString(bestSolution)}
	best.Attempts = attempts
	return best
}

// GenerateV2 is Generate for v2: game level of levels on a day, with its
// grade. dayOfWeek is 1 (Monday) to 7 (Sunday).
func GenerateV2(weekSeed uint64, dayOfWeek, level, levels int) (Graded, error) {
	if dayOfWeek < 1 || dayOfWeek > 7 {
		return Graded{}, fmt.Errorf("dayOfWeek must be 1 (Monday) to 7 (Sunday): %d", dayOfWeek)
	}
	tier, err := TierFor(level, levels)
	if err != nil {
		return Graded{}, err
	}
	return buildV2(puzzleSeedV2(weekSeed, dayOfWeek, level), tier, MaxAttemptsV2), nil
}

// GenerateEndlessV2 is GenerateEndless for v2: endless puzzle number
// (1..MaxEndlessNumber) of tier difficulty (1 = Easy to 5 = Diabolical), with
// its grade.
func GenerateEndlessV2(endlessSeed uint64, difficulty int, number int64) (Graded, error) {
	if difficulty < 1 || difficulty > Tiers {
		return Graded{}, fmt.Errorf("difficulty must be 1..%d: %d", Tiers, difficulty)
	}
	if number < 1 || number > MaxEndlessNumber {
		return Graded{}, fmt.Errorf("number must be 1..%d: %d", MaxEndlessNumber, number)
	}
	return buildV2(endlessPuzzleSeedV2(endlessSeed, difficulty, number), difficulty, MaxAttemptsV2), nil
}

// Generator versions of the daily puzzles, as in the generator schedule.
const (
	// VersionClassic is v1, Generate (shown to players as "Classic").
	VersionClassic = 1
	// VersionGraded is v2, GenerateV2 (shown as "Graded").
	VersionGraded = 2
)

// GenerateVersion generates a daily puzzle with generator version 1 or 2, so
// callers don't branch on the version. Other versions are an error.
func GenerateVersion(version int, weekSeed uint64, dayOfWeek, level, levels int) (Puzzle, error) {
	switch version {
	case VersionClassic:
		return Generate(weekSeed, dayOfWeek, level, levels)
	case VersionGraded:
		g, err := GenerateV2(weekSeed, dayOfWeek, level, levels)
		return g.Puzzle, err
	}
	return Puzzle{}, fmt.Errorf("unknown generator version %d", version)
}

// GenerateEndlessVersion generates an endless puzzle with generator version 1
// or 2. Other versions are an error.
func GenerateEndlessVersion(version int, endlessSeed uint64, difficulty int, number int64) (Puzzle, error) {
	switch version {
	case VersionClassic:
		return GenerateEndless(endlessSeed, difficulty, number)
	case VersionGraded:
		g, err := GenerateEndlessV2(endlessSeed, difficulty, number)
		return g.Puzzle, err
	}
	return Puzzle{}, fmt.Errorf("unknown generator version %d", version)
}
