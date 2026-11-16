package puzzle

import (
	"fmt"
	"math/bits"
)

// A backtracking solver for any Layout: a port of
// web/src/generator/layout-solver.ts (see there for the full description).
// Standard puzzles keep using solver.go.
//
// A cell's candidates are the digits missing from all its units, narrowed in a
// cage to the digits that can be part of a set of distinct digits filling the
// cage to its sum. Search branches on whichever has the fewest options: an
// empty cell's candidates, or the places of a digit a unit is missing. Every
// search has a node budget; a search over it stops and reports Aborted.

// Aborted is the result of a search that ran out of its node budget.
const Aborted = -1

// MaxSearchNodes is the default node budget of a uniqueness check.
const MaxSearchNodes = 200_000

// combos[(n*46+sum)*512+avail] is the union of every set of n distinct digits
// drawn from the mask avail that adds up to sum (0..45), n 0..9.
var combos = func() *[10 * 46 * 512]uint16 {
	var t [10 * 46 * 512]uint16
	for set := range 512 {
		n, sum := 0, 0
		for d := range 9 {
			if set&(1<<d) != 0 {
				n++
				sum += d + 1
			}
		}
		for avail := set; avail < 512; avail = (avail + 1) | set {
			t[(n*46+sum)*512+avail] |= uint16(set)
		}
	}
	return &t
}()

type layoutSearch struct {
	grid, cand, unitCand           [cells]int
	units                          [][9]int
	unitsOf                        [cells][]int
	used                           []int
	cageOf                         *[cells]int
	cages                          [][]int
	cageUsed, cageRest, cageEmpty  []int
	limit, nodeLimit, nodes, count int
	aborted                        bool
	random                         *xoshiro
	first                          *[cells]int
}

// newLayoutSearch is a search over a copy of grid, or nil if the givens
// already break a rule (a repeat, or a cage they cannot complete to its sum).
func newLayoutSearch(l *Layout, grid []int) (*layoutSearch, error) {
	if len(grid) != cells {
		return nil, fmt.Errorf("expected %d cells, got %d", cells, len(grid))
	}
	s := &layoutSearch{units: l.units, used: make([]int, len(l.units)), cageOf: &l.cageOf}
	for u := range l.units {
		for _, c := range l.units[u] {
			s.unitsOf[c] = append(s.unitsOf[c], u)
		}
	}
	for _, cage := range l.Cages {
		s.cages = append(s.cages, cage.Cells)
		s.cageUsed = append(s.cageUsed, 0)
		s.cageRest = append(s.cageRest, cage.Sum)
		s.cageEmpty = append(s.cageEmpty, len(cage.Cells))
	}
	for i, d := range grid {
		if d == 0 {
			continue
		}
		if d < 1 || d > 9 {
			return nil, fmt.Errorf("cell value out of range at %d: %d", i, d)
		}
		if s.mask(i)&(1<<(d-1)) == 0 {
			return nil, nil
		}
		s.set(i, d)
	}
	return s, nil
}

// cageDigits is the digits that can go in a cage with empty empty cells, rest
// left to add and the digits of used placed.
func cageDigits(empty, rest, used int) int {
	if rest < 0 || rest > 45 {
		return 0
	}
	return int(combos[(empty*46+rest)*512+all&^used])
}

// mask is the digits the rules leave for empty cell i.
func (s *layoutSearch) mask(i int) int {
	taken := 0
	for _, u := range s.unitsOf[i] {
		taken |= s.used[u]
	}
	mask := all &^ taken
	if k := s.cageOf[i]; k >= 0 {
		mask &= cageDigits(s.cageEmpty[k], s.cageRest[k], s.cageUsed[k]) &^ s.cageUsed[k]
	}
	return mask
}

func (s *layoutSearch) set(i, d int) {
	bit := 1 << (d - 1)
	s.grid[i] = d
	for _, u := range s.unitsOf[i] {
		s.used[u] |= bit
	}
	if k := s.cageOf[i]; k >= 0 {
		s.cageUsed[k] |= bit
		s.cageRest[k] -= d
		s.cageEmpty[k]--
	}
}

func (s *layoutSearch) clear(i, d int) {
	bit := 1 << (d - 1)
	s.grid[i] = 0
	for _, u := range s.unitsOf[i] {
		s.used[u] ^= bit
	}
	if k := s.cageOf[i]; k >= 0 {
		s.cageUsed[k] ^= bit
		s.cageRest[k] += d
		s.cageEmpty[k]++
	}
}

// refineCage narrows the candidates of cage k's empty cells: digit d stays in
// cell i if it is not in the cage yet and the cage's other empty cells can
// take distinct digits, not in the cage and not d, from their own candidates
// (by units) that add up to the rest of the sum.
func (s *layoutSearch) refineCage(k int) {
	empty := s.cageEmpty[k]
	if empty == 0 {
		return
	}
	rest := s.cageRest[k]
	free := all &^ s.cageUsed[k]
	for _, i := range s.cages[k] {
		if s.grid[i] != 0 {
			continue
		}
		others := 0
		for _, j := range s.cages[k] {
			if j != i && s.grid[j] == 0 {
				others |= s.unitCand[j]
			}
		}
		allowed := 0
		for m := s.unitCand[i] & free; m != 0; m &= m - 1 {
			bit := m & -m
			left := rest - (bits.TrailingZeros(uint(bit)) + 1)
			if empty == 1 && left == 0 || empty > 1 && left >= 0 && left <= 45 && combos[((empty-1)*46+left)*512+others&free&^bit] != 0 {
				allowed |= bit
			}
		}
		s.cand[i] = allowed
	}
}

// step returns true when the search should stop. It branches on the empty
// cell with the fewest candidates (lowest index on ties), unless some unit
// has a missing digit with fewer places (units in order, digits 1..9, first
// strictly fewer wins), which then branches on those places, ascending.
func (s *layoutSearch) step() bool {
	s.nodes++
	if s.nodes > s.nodeLimit {
		s.aborted = true
		return true
	}
	for i := range cells {
		if s.grid[i] != 0 {
			continue
		}
		taken := 0
		for _, u := range s.unitsOf[i] {
			taken |= s.used[u]
		}
		s.unitCand[i] = all &^ taken
		s.cand[i] = s.unitCand[i]
	}
	for k := range s.cages {
		s.refineCage(k)
	}
	best, bestCount := -1, 10
	for i := range cells {
		if s.grid[i] != 0 {
			continue
		}
		if n := bits.OnesCount(uint(s.cand[i])); n < bestCount {
			best, bestCount = i, n
			if n == 0 {
				return false
			}
		}
	}
	if best < 0 {
		s.count++
		if s.first == nil {
			g := s.grid
			s.first = &g
		}
		return s.count >= s.limit
	}
	unit, unitDigit := -1, 0
	if bestCount > 1 {
		for u := 0; u < len(s.units) && bestCount > 1; u++ {
			for m := all &^ s.used[u]; m != 0; m &= m - 1 {
				bit := m & -m
				n := 0
				for _, c := range s.units[u] {
					if s.grid[c] == 0 && s.cand[c]&bit != 0 {
						n++
					}
				}
				if n == 0 {
					return false
				}
				if n < bestCount {
					unit, unitDigit, bestCount = u, bit, n
				}
			}
		}
	}
	options := make([]int, 0, 9)
	if unit < 0 {
		for mask := s.cand[best]; mask != 0; mask &= mask - 1 {
			options = append(options, bits.TrailingZeros(uint(mask))+1)
		}
	} else {
		for _, c := range s.units[unit] {
			if s.grid[c] == 0 && s.cand[c]&unitDigit != 0 {
				options = append(options, c)
			}
		}
	}
	if s.random != nil {
		s.random.shuffle(options)
	}
	d0 := bits.Len(uint(unitDigit))
	for _, o := range options {
		i, d := best, o
		if unit >= 0 {
			i, d = o, d0
		}
		s.set(i, d)
		stop := s.step()
		s.clear(i, d)
		if stop {
			return true
		}
	}
	return false
}

// CountSolutionsIn counts the solutions of grid under l, up to limit (at
// least 1); Aborted if the search needs more than nodeLimit steps.
func CountSolutionsIn(l *Layout, grid []int, limit, nodeLimit int) (int, error) {
	if limit < 1 {
		return 0, fmt.Errorf("limit must be at least 1")
	}
	s, err := newLayoutSearch(l, grid)
	if s == nil {
		return 0, err
	}
	s.limit, s.nodeLimit = limit, nodeLimit
	s.step()
	if s.aborted {
		return Aborted, nil
	}
	return s.count, nil
}

// hasUniqueSolutionIn reports whether grid (valid, 81 values) has exactly one
// solution under l, proved within nodeLimit steps.
func hasUniqueSolutionIn(l *Layout, grid []int, nodeLimit int) bool {
	n, _ := CountSolutionsIn(l, grid, 2, nodeLimit)
	return n == 1
}

// firstSolutionIn is the first solution of grid (valid, 81 values) under l in
// search order, with candidates in an order drawn from random when it is not
// nil; nil if there is none within nodeLimit steps.
func firstSolutionIn(l *Layout, grid []int, random *xoshiro, nodeLimit int) *[cells]int {
	s, _ := newLayoutSearch(l, grid)
	if s == nil {
		return nil
	}
	s.limit, s.random, s.nodeLimit = 1, random, nodeLimit
	s.step()
	return s.first
}
