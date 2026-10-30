package puzzle

import "math/bits"

// Backtracking Sudoku solver on bitmasks.
//
// Grids are 81 values with 0 for empty. Search always picks the empty cell
// with the fewest candidates (lowest index on ties) and tries digits in
// ascending order (or in an order drawn from a generator), so results are
// fully deterministic. Grids passed in must not conflict.

const (
	cells = 81
	all   = 0x1ff
)

func rowOf(i int) int { return i / 9 }
func colOf(i int) int { return i % 9 }
func boxOf(i int) int { return rowOf(i)/3*3 + colOf(i)/3 }

var peers [cells][]int

func init() {
	for i := range cells {
		for j := range cells {
			if j != i && (rowOf(j) == rowOf(i) || colOf(j) == colOf(i) || boxOf(j) == boxOf(i)) {
				peers[i] = append(peers[i], j)
			}
		}
	}
}

// Peers returns the 20 cells sharing a row, column or box with cell i,
// ascending. The slice is shared; callers must not modify it.
func Peers(i int) []int { return peers[i] }

type search struct {
	grid              [cells]int
	rows, cols, boxes [9]int
	limit, count      int
	random            *xoshiro
	first             *[cells]int
}

func newSearch(grid []int) *search {
	s := &search{}
	for i, d := range grid {
		s.grid[i] = d
		if d == 0 {
			continue
		}
		bit := 1 << (d - 1)
		s.rows[rowOf(i)] |= bit
		s.cols[colOf(i)] |= bit
		s.boxes[boxOf(i)] |= bit
	}
	return s
}

// hasUniqueSolution reports whether grid has exactly one solution.
func hasUniqueSolution(grid []int) bool {
	s := newSearch(grid)
	s.limit = 2
	s.run()
	return s.count == 1
}

// randomSolution is a complete valid grid built from grid (typically empty),
// with candidates tried in an order drawn from random.
func randomSolution(grid []int, random *xoshiro) [cells]int {
	s := newSearch(grid)
	s.limit = 1
	s.random = random
	s.run()
	return *s.first
}

func (s *search) run() { s.step() }

// step returns true when the search should stop.
func (s *search) step() bool {
	best, bestMask, bestCount := -1, 0, 10
	for i := range cells {
		if s.grid[i] != 0 {
			continue
		}
		mask := all &^ (s.rows[rowOf(i)] | s.cols[colOf(i)] | s.boxes[boxOf(i)])
		n := bits.OnesCount(uint(mask))
		if n < bestCount {
			best, bestMask, bestCount = i, mask, n
			if n <= 1 {
				break
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
	if bestCount == 0 {
		return false
	}

	digits := make([]int, 0, 9)
	for mask := bestMask; mask != 0; mask &= mask - 1 {
		digits = append(digits, bits.TrailingZeros(uint(mask))+1)
	}
	if s.random != nil {
		s.random.shuffle(digits)
	}
	for _, d := range digits {
		if s.tryDigit(best, d) {
			return true
		}
	}
	return false
}

func (s *search) tryDigit(i, d int) bool {
	bit := 1 << (d - 1)
	r, c, b := rowOf(i), colOf(i), boxOf(i)
	s.grid[i] = d
	s.rows[r] |= bit
	s.cols[c] |= bit
	s.boxes[b] |= bit
	stop := s.step()
	s.grid[i] = 0
	s.rows[r] ^= bit
	s.cols[c] ^= bit
	s.boxes[b] ^= bit
	return stop
}
