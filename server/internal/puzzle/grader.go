package puzzle

import (
	"fmt"
	"math/bits"
	"slices"
)

// A deterministic, human-style technique grader: a line-for-line port of the
// web client's web/src/generator/grader.ts (see there for the full
// description). The shared fixture testdata/generator-v2.json pins both.
//
// It solves a puzzle one step at a time. Candidates are 9-bit masks per cell
// (bit d-1 set when digit d is still possible). Each step tries the
// techniques in the order of techniques, applies only the first instance
// found, then starts again from the first technique. A technique applies only
// if it places a digit or removes at least one candidate.
//
// Scan orders: units are numbered 0..8 rows, 9..17 columns, 18..26 boxes; the
// cells of a unit and the peers of a cell ascend by cell index; digits are
// scanned 1..9 (bit 0..8) and cells 0..80; choosing k of a list enumerates
// combinations in lexicographic order of list position.
//
// The grid must be a valid puzzle (a solution exists).

// Technique is one grading step kind and the level it belongs to (1 hidden
// single .. 6 simple colouring and XY-chain).
type Technique struct {
	Name  string
	Level int
}

// Techniques are the techniques in the order they are tried. The index is the
// technique's id in Grade.Counts.
var Techniques = [...]Technique{
	{"hiddenSingle", 1},
	{"nakedSingle", 2},
	{"pointing", 3},
	{"claiming", 3},
	{"nakedPair", 4},
	{"hiddenPair", 4},
	{"nakedTriple", 4},
	{"hiddenTriple", 4},
	{"nakedQuad", 4},
	{"hiddenQuad", 4},
	{"xWing", 5},
	{"swordfish", 5},
	{"xyWing", 5},
	{"xyzWing", 5},
	{"simpleColouring", 6},
	{"xyChain", 6},
}

// StuckLevel is the level reported for a puzzle the grader cannot finish.
const StuckLevel = 7

// MaxChain is the most cells in an XY-chain.
const MaxChain = 8

// Grade is the result of grading a grid.
type Grade struct {
	Solved bool
	// Level is the hardest level used; StuckLevel if not solved, 0 if the grid
	// was already complete.
	Level int
	// Steps is the number of steps (placements or eliminations) taken.
	Steps int
	// Counts is the steps taken per technique, indexed like Techniques.
	Counts [len(Techniques)]int
}

var (
	units  [27][9]int
	member [27][cells]bool
	sees   [cells][cells]bool
)

func init() {
	for i := range 9 {
		for k := range 9 {
			units[i][k] = i*9 + k
			units[9+i][k] = k*9 + i
			units[18+i][k] = (i/3*3+k/3)*9 + i%3*3 + k%3
		}
	}
	for u := range units {
		for _, c := range units[u] {
			member[u][c] = true
		}
	}
	// Not built from peers: init order across files is by file name, so peers
	// (solver.go) is not ready yet.
	for a := range cells {
		for b := range cells {
			sees[a][b] = a != b && (rowOf(a) == rowOf(b) || colOf(a) == colOf(b) || boxOf(a) == boxOf(b))
		}
	}
}

func popcount(x int) int { return bits.OnesCount(uint(x)) }

// lowBit is the index (0..8) of the lowest set bit of a non-zero mask.
func lowBit(x int) int { return bits.TrailingZeros(uint(x)) }

// one reports whether exactly one bit of x is set.
func one(x int) bool { return x != 0 && x&(x-1) == 0 }

// grader steps through the grading of one grid; GradeCells runs it to the end.
type grader struct {
	grid [cells]int
	// cand holds candidate masks; 0 for a filled cell.
	cand [cells]int
	// placed is how many cells are filled.
	placed int

	list, pick []int
	pos        [9]int
	links      [cells * 3]int
	linkCount  [cells]int
	colour     [cells]int
	stamp      [cells]int
	queue      [cells]int
	visited    [cells]bool
}

func newGrader(grid []int) (*grader, error) {
	if len(grid) != cells {
		return nil, fmt.Errorf("expected %d cells, got %d", cells, len(grid))
	}
	g := &grader{}
	var used [27]int
	for i, d := range grid {
		if d < 0 || d > 9 {
			return nil, fmt.Errorf("cell value out of range at %d: %d", i, d)
		}
		if d == 0 {
			continue
		}
		g.grid[i] = d
		g.placed++
		bit := 1 << (d - 1)
		used[rowOf(i)] |= bit
		used[9+colOf(i)] |= bit
		used[18+boxOf(i)] |= bit
	}
	for i := range cells {
		if g.grid[i] == 0 {
			g.cand[i] = all &^ (used[rowOf(i)] | used[9+colOf(i)] | used[18+boxOf(i)])
		}
	}
	return g, nil
}

// step applies the first available step; it returns the technique's index, or
// -1 when none applies.
func (g *grader) step() int {
	for t := range Techniques {
		if g.run(t) {
			return t
		}
	}
	return -1
}

func (g *grader) run(t int) bool {
	switch t {
	case 0:
		return g.hiddenSingle()
	case 1:
		return g.nakedSingle()
	case 2:
		return g.pointing()
	case 3:
		return g.claiming()
	case 4:
		return g.nakedSubset(2)
	case 5:
		return g.hiddenSubset(2)
	case 6:
		return g.nakedSubset(3)
	case 7:
		return g.hiddenSubset(3)
	case 8:
		return g.nakedSubset(4)
	case 9:
		return g.hiddenSubset(4)
	case 10:
		return g.fish(2)
	case 11:
		return g.fish(3)
	case 12:
		return g.xyWing()
	case 13:
		return g.xyzWing()
	case 14:
		return g.simpleColouring()
	default:
		return g.xyChain()
	}
}

func (g *grader) place(i, bit int) {
	g.grid[i] = lowBit(bit) + 1
	g.cand[i] = 0
	g.placed++
	for _, j := range peers[i] {
		g.cand[j] &^= bit
	}
}

// elim removes the candidates in mask from cell i; true if any were there.
func (g *grader) elim(i, mask int) bool {
	if g.cand[i]&mask == 0 {
		return false
	}
	g.cand[i] &^= mask
	return true
}

// elimOutside removes digit bit from the cells of unit from that are not in
// unit except; true if any went.
func (g *grader) elimOutside(from, except, bit int) bool {
	changed := false
	for _, c := range units[from] {
		if !member[except][c] && g.elim(c, bit) {
			changed = true
		}
	}
	return changed
}

// hiddenSingle: units 0..26, digits 1..9; a digit with exactly one place in a
// unit goes there.
func (g *grader) hiddenSingle() bool {
	for u := range units {
		for d := range 9 {
			bit := 1 << d
			at, n := -1, 0
			for _, c := range units[u] {
				if g.cand[c]&bit != 0 {
					at = c
					n++
				}
			}
			if n == 1 {
				g.place(at, bit)
				return true
			}
		}
	}
	return false
}

// nakedSingle: the lowest cell with exactly one candidate takes it.
func (g *grader) nakedSingle() bool {
	for i := range cells {
		if one(g.cand[i]) {
			g.place(i, g.cand[i])
			return true
		}
	}
	return false
}

// pointing: boxes 0..8, digits 1..9; when a digit's places in a box share a
// row (tried first) or a column, it goes from the rest of that line.
func (g *grader) pointing() bool {
	for b := range 9 {
		for d := range 9 {
			bit := 1 << d
			rowMask, colMask := 0, 0
			for _, c := range units[18+b] {
				if g.cand[c]&bit != 0 {
					rowMask |= 1 << rowOf(c)
					colMask |= 1 << colOf(c)
				}
			}
			if one(rowMask) && g.elimOutside(lowBit(rowMask), 18+b, bit) {
				return true
			}
			if one(colMask) && g.elimOutside(9+lowBit(colMask), 18+b, bit) {
				return true
			}
		}
	}
	return false
}

// claiming (box-line reduction): rows 0..8 then columns 0..8, digits 1..9;
// when a digit's places in a line share a box, it goes from the rest of that
// box.
func (g *grader) claiming() bool {
	for u := range 18 {
		for d := range 9 {
			bit := 1 << d
			boxMask := 0
			for _, c := range units[u] {
				if g.cand[c]&bit != 0 {
					boxMask |= 1 << boxOf(c)
				}
			}
			if one(boxMask) && g.elimOutside(18+lowBit(boxMask), u, bit) {
				return true
			}
		}
	}
	return false
}

// nakedSubset of size k (pair, triple, quad): units 0..26; among the cells
// with 2..k candidates, the first combination of k cells whose candidates
// together are exactly k digits removes those digits from the unit's other
// cells.
func (g *grader) nakedSubset(k int) bool {
	for u := range units {
		g.list = g.list[:0]
		for _, c := range units[u] {
			if n := popcount(g.cand[c]); n >= 2 && n <= k {
				g.list = append(g.list, c)
			}
		}
		if g.chooseNaked(u, k, 0, 0, 0) {
			return true
		}
	}
	return false
}

func (g *grader) chooseNaked(u, k, start, depth, union int) bool {
	if popcount(union) > k {
		return false
	}
	if depth == k {
		changed := false
		for _, c := range units[u] {
			if !slices.Contains(g.pick, c) && g.elim(c, union) {
				changed = true
			}
		}
		return changed
	}
	for j := start; j < len(g.list); j++ {
		c := g.list[j]
		g.pick = append(g.pick[:depth], c)
		if g.chooseNaked(u, k, j+1, depth+1, union|g.cand[c]) {
			return true
		}
	}
	return false
}

// hiddenSubset of size k: units 0..26; among the digits with 2..k places in
// the unit, the first combination of k digits whose places together are
// exactly k cells strips every other candidate from those cells.
func (g *grader) hiddenSubset(k int) bool {
	for u := range units {
		g.pos = [9]int{}
		for p, c := range units[u] {
			for m := g.cand[c]; m != 0; m &= m - 1 {
				g.pos[lowBit(m)] |= 1 << p
			}
		}
		g.list = g.list[:0]
		for d := range 9 {
			if n := popcount(g.pos[d]); n >= 2 && n <= k {
				g.list = append(g.list, d)
			}
		}
		if g.chooseHidden(u, k, 0, 0, 0, 0) {
			return true
		}
	}
	return false
}

func (g *grader) chooseHidden(u, k, start, depth, union, digits int) bool {
	if popcount(union) > k {
		return false
	}
	if depth == k {
		changed := false
		for p := range 9 {
			if union&(1<<p) != 0 && g.elim(units[u][p], all&^digits) {
				changed = true
			}
		}
		return changed
	}
	for j := start; j < len(g.list); j++ {
		d := g.list[j]
		if g.chooseHidden(u, k, j+1, depth+1, union|g.pos[d], digits|1<<d) {
			return true
		}
	}
	return false
}

// fish of size n (2 X-Wing, 3 Swordfish): digits 1..9, rows-based then
// columns-based. Among the base lines (rows, or columns) with 2..n places for
// the digit, the first combination of n lines whose places lie in exactly n
// cover lines removes the digit from those cover lines outside the base
// lines.
func (g *grader) fish(n int) bool {
	for d := range 9 {
		bit := 1 << d
		for o := range 2 {
			g.list = g.list[:0]
			for b := range 9 {
				m := 0
				for p, c := range units[o*9+b] {
					if g.cand[c]&bit != 0 {
						m |= 1 << p
					}
				}
				g.pos[b] = m
				if count := popcount(m); count >= 2 && count <= n {
					g.list = append(g.list, b)
				}
			}
			if g.chooseFish(o, bit, n, 0, 0, 0, 0) {
				return true
			}
		}
	}
	return false
}

func (g *grader) chooseFish(o, bit, n, start, depth, union, bases int) bool {
	if popcount(union) > n {
		return false
	}
	if depth == n {
		changed := false
		for p := range 9 {
			if union&(1<<p) == 0 {
				continue
			}
			for _, c := range units[(1-o)*9+p] {
				base := colOf(c)
				if o == 0 {
					base = rowOf(c)
				}
				if bases&(1<<base) == 0 && g.elim(c, bit) {
					changed = true
				}
			}
		}
		return changed
	}
	for j := start; j < len(g.list); j++ {
		b := g.list[j]
		if g.chooseFish(o, bit, n, j+1, depth+1, union|g.pos[b], bases|1<<b) {
			return true
		}
	}
	return false
}

// xyWing: pivots 0..80 with two candidates; first wing among the pivot's
// peers with two candidates sharing exactly one with the pivot (the other, z,
// is not the pivot's); second wing among the peers with exactly the pivot's
// other digit and z. z goes from every cell (ascending) that sees both wings.
func (g *grader) xyWing() bool {
	for p := range cells {
		pivot := g.cand[p]
		if popcount(pivot) != 2 {
			continue
		}
		for _, w1 := range peers[p] {
			c1 := g.cand[w1]
			if popcount(c1) != 2 || !one(c1&pivot) {
				continue
			}
			z := c1 &^ pivot
			want := pivot&^c1 | z
			for _, w2 := range peers[p] {
				if g.cand[w2] != want {
					continue
				}
				if g.elimSeeing(w1, w2, z) {
					return true
				}
			}
		}
	}
	return false
}

// elimSeeing removes digit bit from every cell that sees both a and b; true
// if any went.
func (g *grader) elimSeeing(a, b, bit int) bool {
	changed := false
	for t := range cells {
		if sees[a][t] && sees[b][t] && g.elim(t, bit) {
			changed = true
		}
	}
	return changed
}

// xyzWing: pivots 0..80 with three candidates; pairs of distinct peers (first
// below second) with two candidates each, both within the pivot's. Their
// shared digit z goes from every cell that sees the pivot and both wings.
func (g *grader) xyzWing() bool {
	for p := range cells {
		pivot := g.cand[p]
		if popcount(pivot) != 3 {
			continue
		}
		for _, w1 := range peers[p] {
			c1 := g.cand[w1]
			if popcount(c1) != 2 || c1&^pivot != 0 {
				continue
			}
			for _, w2 := range peers[p] {
				c2 := g.cand[w2]
				if w2 <= w1 || popcount(c2) != 2 || c2&^pivot != 0 || c2 == c1 {
					continue
				}
				z := c1 & c2
				changed := false
				for t := range cells {
					if sees[p][t] && sees[w1][t] && sees[w2][t] && g.elim(t, z) {
						changed = true
					}
				}
				if changed {
					return true
				}
			}
		}
	}
	return false
}

// simpleColouring: digits 1..9. The digit's strong links are the units with
// exactly two places for it. Each connected group of links is coloured
// alternately from its lowest cell (breadth first); groups in order of lowest
// cell. For each group: colour wrap first (colour 0 then 1: two cells of one
// colour that see each other make that colour false, so the digit goes from
// all its cells), then colour trap (a cell outside the group that sees both
// colours loses the digit).
func (g *grader) simpleColouring() bool {
	for d := range 9 {
		bit := 1 << d
		g.linkCount = [cells]int{}
		for i := range g.colour {
			g.colour[i] = -1
		}
		g.stamp = [cells]int{}
		for u := range units {
			a, b, n := -1, -1, 0
			for _, c := range units[u] {
				if g.cand[c]&bit == 0 {
					continue
				}
				if n == 0 {
					a = c
				} else {
					b = c
				}
				n++
			}
			if n == 2 {
				g.link(a, b)
				g.link(b, a)
			}
		}
		for s := range cells {
			if g.colour[s] != -1 || g.linkCount[s] == 0 {
				continue
			}
			size := g.colourGroup(s)
			if g.wrap(size, bit) {
				return true
			}
			if g.trap(s, size, bit) {
				return true
			}
		}
	}
	return false
}

func (g *grader) link(a, b int) {
	n := g.linkCount[a]
	for i := range n {
		if g.links[a*3+i] == b {
			return
		}
	}
	g.links[a*3+n] = b
	g.linkCount[a] = n + 1
}

// colourGroup colours the group of s breadth first into the queue; it returns
// the group's size.
func (g *grader) colourGroup(s int) int {
	head, tail := 0, 0
	g.queue[tail] = s
	tail++
	g.colour[s] = 0
	g.stamp[s] = s + 1
	for head < tail {
		v := g.queue[head]
		head++
		for i := range g.linkCount[v] {
			w := g.links[v*3+i]
			if g.colour[w] != -1 {
				continue
			}
			g.colour[w] = 1 - g.colour[v]
			g.stamp[w] = s + 1
			g.queue[tail] = w
			tail++
		}
	}
	return tail
}

// wrap is colour wrap on the coloured group in the queue: a colour with two
// cells in view of each other is false.
func (g *grader) wrap(size, bit int) bool {
	for colour := range 2 {
		if !g.seesItself(size, colour) {
			continue
		}
		for i := range size {
			if g.colour[g.queue[i]] == colour {
				g.elim(g.queue[i], bit)
			}
		}
		return true
	}
	return false
}

// seesItself reports whether two cells of colour in the queue's group see
// each other.
func (g *grader) seesItself(size, colour int) bool {
	for i := range size {
		for j := i + 1; j < size; j++ {
			if g.colour[g.queue[i]] == colour && g.colour[g.queue[j]] == colour && sees[g.queue[i]][g.queue[j]] {
				return true
			}
		}
	}
	return false
}

// trap is colour trap on the coloured group in the queue (group id s+1).
func (g *grader) trap(s, size, bit int) bool {
	changed := false
	for t := range cells {
		if g.cand[t]&bit == 0 || g.stamp[t] == s+1 {
			continue
		}
		seen := 0
		for i := range size {
			if sees[t][g.queue[i]] {
				seen |= 1 << g.colour[g.queue[i]]
			}
		}
		if seen == 3 && g.elim(t, bit) {
			changed = true
		}
	}
	return changed
}

// xyChain: start cells 0..80 with two candidates; for each of the start's
// digits x (low then high), a depth-first walk through bivalue peers
// (ascending, unvisited) that contain the digit carried from the previous
// cell, carrying the other one on. A chain of at least 3 and at most MaxChain
// cells whose last cell carries x removes x from every cell that sees both
// ends. The first elimination found wins.
func (g *grader) xyChain() bool {
	for s := range cells {
		cs := g.cand[s]
		if popcount(cs) != 2 {
			continue
		}
		low := cs & -cs
		for _, x := range [2]int{low, cs ^ low} {
			g.visited[s] = true
			hit := g.extend(s, x, s, cs^x, 1)
			g.visited[s] = false
			if hit {
				return true
			}
		}
	}
	return false
}

func (g *grader) extend(start, x, cur, carry, length int) bool {
	for _, next := range peers[cur] {
		cn := g.cand[next]
		if g.visited[next] || popcount(cn) != 2 || cn&carry == 0 {
			continue
		}
		other := cn ^ carry
		if length+1 >= 3 && other == x && g.elimSeeing(start, next, x) {
			return true
		}
		if length+1 < MaxChain {
			g.visited[next] = true
			hit := g.extend(start, x, next, other, length+1)
			g.visited[next] = false
			if hit {
				return true
			}
		}
	}
	return false
}

// GradeCells grades a grid (81 values, 0 = empty): it solves it with the
// grader until done or stuck. It errors on a grid of the wrong size or with
// values outside 0..9.
func GradeCells(grid []int) (Grade, error) {
	g, err := newGrader(grid)
	if err != nil {
		return Grade{}, err
	}
	var res Grade
	for g.placed < cells {
		t := g.step()
		if t < 0 {
			res.Level = StuckLevel
			return res, nil
		}
		res.Counts[t]++
		res.Steps++
		res.Level = max(res.Level, Techniques[t].Level)
	}
	res.Solved = true
	return res, nil
}
