package puzzle

import (
	"fmt"
	"math/bits"
	"slices"
)

// A deterministic, human-style technique grader: a line-for-line port of the
// web client's web/src/generator/grader.ts (see there for the full
// description). The shared fixtures testdata/generator-v2.json and
// testdata/variants.json pin both.
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
// The grid's rules come from a Layout (standard for GradeCells): its units
// are the houses, its peers (unit and cage mates) are the cells a cell sees.
// Diagonals and jigsaw regions are houses like boxes; fish stay row and
// column based. Killer layouts add the cage techniques (KillerTechniques).
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

// CageTechniques are the killer techniques: cage combination (2), the 45 rule
// over one house (3), cage pointing (5) and the 45 rule over 2 or 3 adjacent
// rows or columns (6). Their ids follow Techniques' (16..19).
var CageTechniques = [...]Technique{
	{"cageCombination", 2},
	{"rule45", 3},
	{"cagePointing", 5},
	{"rule45Lines", 6},
}

// killerOrder is the technique ids a killer grid tries, in order.
var killerOrder = []int{0, 1, 16, 2, 3, 17, 18, 4, 5, 6, 7, 8, 9, 19, 10, 11, 12, 13, 14, 15}

var standardOrder = func() []int {
	o := make([]int, len(Techniques))
	for i := range o {
		o[i] = i
	}
	return o
}()

// KillerTechniques are the techniques of a killer grid in the order they are
// tried: hidden single, naked single, cage combination, pointing, claiming,
// 45 rule, cage pointing, the subsets, the 45 rule over lines, then the rest
// of Techniques in order. A killer grid's LayoutGrade.Counts is indexed by
// it.
var KillerTechniques = func() []Technique {
	all := append(Techniques[:], CageTechniques[:]...)
	t := make([]Technique, len(killerOrder))
	for i, id := range killerOrder {
		t[i] = all[id]
	}
	return t
}()

// TechniquesFor is the techniques of a layout in the order they are tried:
// KillerTechniques with cages, else Techniques.
func TechniquesFor(l *Layout) []Technique {
	if len(l.Cages) > 0 {
		return KillerTechniques
	}
	return Techniques[:]
}

// MaxRule45Cells is the most empty cells in a set of innies or outies the 45
// rule works on.
const MaxRule45Cells = 4

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

// maxLinks is the most units a cell is in (a diagonal's centre).
const maxLinks = 5

// sumSet is a cell set of the 45 rule with a known sum: innies or outies.
type sumSet struct {
	cells []int
	sum   int
}

// tables are a layout's lookup tables for the grader.
type tables struct {
	member [][cells]bool
	sees   *[cells][cells]bool
	// overlaps lists, for each unit from 18 on, the other units from 18 on
	// that share at least two cells with it, ascending.
	overlaps [][]int
	// rule45 holds, for each of units 0..26 of a killer layout, its innies
	// then its outies; rule45Lines the same for 2 then 3 adjacent rows (from
	// the top), then 2 then 3 adjacent columns.
	rule45, rule45Lines [][]sumSet
	order               []int
}

func buildTables(l *Layout, sees *[cells][cells]bool) *tables {
	t := &tables{sees: sees, member: make([][cells]bool, len(l.units)), overlaps: make([][]int, len(l.units))}
	for u := range l.units {
		for _, c := range l.units[u] {
			t.member[u][c] = true
		}
	}
	for u := 18; u < len(l.units); u++ {
		for v := 18; v < len(l.units); v++ {
			n := 0
			for _, c := range l.units[u] {
				if t.member[v][c] {
					n++
				}
			}
			if v != u && n >= 2 {
				t.overlaps[u] = append(t.overlaps[u], v)
			}
		}
	}
	t.order = standardOrder
	if len(l.Cages) == 0 {
		return t
	}
	t.order = killerOrder
	sets := func(units [][9]int, total int) []sumSet {
		var inside [cells]bool
		for _, u := range units {
			for _, c := range u {
				inside[c] = true
			}
		}
		whole, partial := 0, 0
		var innies, outies []int
		for _, cage := range l.Cages {
			n := 0
			for _, c := range cage.Cells {
				if inside[c] {
					n++
				}
			}
			if n == len(cage.Cells) {
				whole += cage.Sum
			} else if n > 0 {
				partial += cage.Sum
				for _, c := range cage.Cells {
					if inside[c] {
						innies = append(innies, c)
					} else {
						outies = append(outies, c)
					}
				}
			}
		}
		if len(innies) == 0 {
			return nil
		}
		slices.Sort(innies)
		slices.Sort(outies)
		return []sumSet{{innies, total - whole}, {outies, whole + partial - total}}
	}
	for u := range 27 {
		t.rule45 = append(t.rule45, sets(l.units[u:u+1], 45))
	}
	for _, first := range []int{0, 9} {
		for span := 2; span <= 3; span++ {
			for u := first; u+span <= first+9; u++ {
				t.rule45Lines = append(t.rule45Lines, sets(l.units[u:u+span], 45*span))
			}
		}
	}
	return t
}

func popcount(x int) int { return bits.OnesCount(uint(x)) }

// lowBit is the index (0..8) of the lowest set bit of a non-zero mask.
func lowBit(x int) int { return bits.TrailingZeros(uint(x)) }

// one reports whether exactly one bit of x is set.
func one(x int) bool { return x != 0 && x&(x-1) == 0 }

// grader steps through the grading of one grid; GradeCells runs it to the end.
type grader struct {
	l     *Layout
	t     *tables
	units [][9]int
	sees  *[cells][cells]bool
	grid  [cells]int
	// cand holds candidate masks; 0 for a filled cell.
	cand [cells]int
	// placed is how many cells are filled.
	placed int

	list, pick []int
	pos        [9]int
	links      [cells * maxLinks]int
	linkCount  [cells]int
	colour     [cells]int
	stamp      [cells]int
	queue      [cells]int
	visited    [cells]bool

	sumList       []int
	found, assign [cells]int
	lo, hi        [cells + 1]int
}

func newGrader(grid []int, l *Layout) (*grader, error) {
	if len(grid) != cells {
		return nil, fmt.Errorf("expected %d cells, got %d", cells, len(grid))
	}
	g := &grader{l: l, t: l.t, units: l.units, sees: l.t.sees}
	for i, d := range grid {
		if d < 0 || d > 9 {
			return nil, fmt.Errorf("cell value out of range at %d: %d", i, d)
		}
		if d == 0 {
			continue
		}
		g.grid[i] = d
		g.placed++
	}
	for i := range cells {
		if g.grid[i] != 0 {
			continue
		}
		used := 0
		for _, p := range l.peers[i] {
			if g.grid[p] != 0 {
				used |= 1 << (g.grid[p] - 1)
			}
		}
		g.cand[i] = all &^ used
	}
	return g, nil
}

// step applies the first available step; it returns the technique's index
// in TechniquesFor the layout, or -1 when none applies.
func (g *grader) step() int {
	for t, id := range g.t.order {
		if g.run(id) {
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
	case 15:
		return g.xyChain()
	case 16:
		return g.cageCombination()
	case 17:
		return g.rule45(g.t.rule45)
	case 18:
		return g.cagePointing()
	default:
		return g.rule45(g.t.rule45Lines)
	}
}

func (g *grader) place(i, bit int) {
	g.grid[i] = lowBit(bit) + 1
	g.cand[i] = 0
	g.placed++
	for _, j := range g.l.peers[i] {
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
	for _, c := range g.units[from] {
		if !g.t.member[except][c] && g.elim(c, bit) {
			changed = true
		}
	}
	return changed
}

// hiddenSingle: every unit in order, digits 1..9; a digit with exactly one
// place in a unit goes there.
func (g *grader) hiddenSingle() bool {
	for u := range g.units {
		for d := range 9 {
			bit := 1 << d
			at, n := -1, 0
			for _, c := range g.units[u] {
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

// pointing: units from 18 on (regions, then diagonals), digits 1..9; when a
// digit's places in the unit share a row (tried first) or a column, it goes
// from the rest of that line. Then, in ascending order, any other unit from
// 18 on that overlaps this one in two or more cells and holds all those places
// loses the digit outside this unit.
func (g *grader) pointing() bool {
	for u := 18; u < len(g.units); u++ {
		for d := range 9 {
			bit := 1 << d
			rowMask, colMask := 0, 0
			for _, c := range g.units[u] {
				if g.cand[c]&bit != 0 {
					rowMask |= 1 << rowOf(c)
					colMask |= 1 << colOf(c)
				}
			}
			if one(rowMask) && g.elimOutside(lowBit(rowMask), u, bit) {
				return true
			}
			if one(colMask) && g.elimOutside(9+lowBit(colMask), u, bit) {
				return true
			}
			if rowMask == 0 {
				continue
			}
			for _, v := range g.t.overlaps[u] {
				inside := true
				for _, c := range g.units[u] {
					if g.cand[c]&bit != 0 && !g.t.member[v][c] {
						inside = false
					}
				}
				if inside && g.elimOutside(v, u, bit) {
					return true
				}
			}
		}
	}
	return false
}

// claiming (box-line reduction): rows 0..8 then columns 0..8, digits 1..9;
// when a digit's places in a line share a region (box or jigsaw region), it
// goes from the rest of that region.
func (g *grader) claiming() bool {
	for u := range 18 {
		for d := range 9 {
			bit := 1 << d
			boxMask := 0
			for _, c := range g.units[u] {
				if g.cand[c]&bit != 0 {
					boxMask |= 1 << g.l.Regions[c]
				}
			}
			if one(boxMask) && g.elimOutside(18+lowBit(boxMask), u, bit) {
				return true
			}
		}
	}
	return false
}

// nakedSubset of size k (pair, triple, quad): every unit; among the cells
// with 2..k candidates, the first combination of k cells whose candidates
// together are exactly k digits removes those digits from the unit's other
// cells.
func (g *grader) nakedSubset(k int) bool {
	for u := range g.units {
		g.list = g.list[:0]
		for _, c := range g.units[u] {
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
		for _, c := range g.units[u] {
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

// hiddenSubset of size k: every unit; among the digits with 2..k places in
// the unit, the first combination of k digits whose places together are
// exactly k cells strips every other candidate from those cells.
func (g *grader) hiddenSubset(k int) bool {
	for u := range g.units {
		g.pos = [9]int{}
		for p, c := range g.units[u] {
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
			if union&(1<<p) != 0 && g.elim(g.units[u][p], all&^digits) {
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
				for p, c := range g.units[o*9+b] {
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
			for _, c := range g.units[(1-o)*9+p] {
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
		for _, w1 := range g.l.peers[p] {
			c1 := g.cand[w1]
			if popcount(c1) != 2 || !one(c1&pivot) {
				continue
			}
			z := c1 &^ pivot
			want := pivot&^c1 | z
			for _, w2 := range g.l.peers[p] {
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
		if g.sees[a][t] && g.sees[b][t] && g.elim(t, bit) {
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
		for _, w1 := range g.l.peers[p] {
			c1 := g.cand[w1]
			if popcount(c1) != 2 || c1&^pivot != 0 {
				continue
			}
			for _, w2 := range g.l.peers[p] {
				c2 := g.cand[w2]
				if w2 <= w1 || popcount(c2) != 2 || c2&^pivot != 0 || c2 == c1 {
					continue
				}
				z := c1 & c2
				changed := false
				for t := range cells {
					if g.sees[p][t] && g.sees[w1][t] && g.sees[w2][t] && g.elim(t, z) {
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
		for u := range g.units {
			a, b, n := -1, -1, 0
			for _, c := range g.units[u] {
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
		if g.links[a*maxLinks+i] == b {
			return
		}
	}
	g.links[a*maxLinks+n] = b
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
			w := g.links[v*maxLinks+i]
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
			if g.colour[g.queue[i]] == colour && g.colour[g.queue[j]] == colour && g.sees[g.queue[i]][g.queue[j]] {
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
			if g.sees[t][g.queue[i]] {
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
	for _, next := range g.l.peers[cur] {
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

// cageCombination: cages in order (by lowest cell). The cage's empty cells
// keep only the digits that appear in some way of filling them: one candidate
// per cell, no repeat between cells that see each other, adding up to the
// cage's sum less its filled digits. The first cage that loses a candidate is
// the step.
func (g *grader) cageCombination() bool {
	for _, cage := range g.l.Cages {
		if g.restrictSum(cage.Cells, cage.Sum, cells) {
			return true
		}
	}
	return false
}

// rule45 tries the 45 rule on groups (innies then outies of each group of
// houses), each restricted like a cage (repeats allowed only between cells
// that do not see each other) when 1 to MaxRule45Cells of its cells are
// empty. The first set that loses a candidate is the step.
func (g *grader) rule45(groups [][]sumSet) bool {
	for _, sets := range groups {
		for _, set := range sets {
			if g.restrictSum(set.cells, set.sum, MaxRule45Cells) {
				return true
			}
		}
	}
	return false
}

// cagePointing: cages in order, digits 1..9. A digit every filling of the
// cage must use (no set of distinct digits without it, drawn from the empty
// cells' candidates, adds up to the rest of the sum) whose places in the cage
// share a row, column or box (tried in that order) goes from the rest of that
// unit.
func (g *grader) cagePointing() bool {
	for k, cage := range g.l.Cages {
		rest, used, avail, n := cage.Sum, 0, 0, 0
		for _, c := range cage.Cells {
			if g.grid[c] != 0 {
				rest -= g.grid[c]
				used |= 1 << (g.grid[c] - 1)
			} else {
				n++
				avail |= g.cand[c]
			}
		}
		avail &^= used
		for m := avail; m != 0; m &= m - 1 {
			bit := m & -m
			if combos[(n*46+rest)*512+avail&^bit] != 0 {
				continue
			}
			rowMask, colMask, boxMask := 0, 0, 0
			for _, c := range cage.Cells {
				if g.cand[c]&bit == 0 {
					continue
				}
				rowMask |= 1 << rowOf(c)
				colMask |= 1 << colOf(c)
				boxMask |= 1 << g.l.Regions[c]
			}
			if one(rowMask) && g.elimOutsideCage(lowBit(rowMask), k, bit) {
				return true
			}
			if one(colMask) && g.elimOutsideCage(9+lowBit(colMask), k, bit) {
				return true
			}
			if one(boxMask) && g.elimOutsideCage(18+lowBit(boxMask), k, bit) {
				return true
			}
		}
	}
	return false
}

// elimOutsideCage removes digit bit from the cells of unit u outside cage k;
// true if any went.
func (g *grader) elimOutsideCage(u, k, bit int) bool {
	changed := false
	for _, c := range g.units[u] {
		if g.l.cageOf[c] != k && g.elim(c, bit) {
			changed = true
		}
	}
	return changed
}

// restrictSum restricts the empty cells among cs to the digits of some
// filling that adds up to sum less the filled cells' digits. It does nothing
// when no cell, or more than maxEmpty, is empty; true if a candidate went.
func (g *grader) restrictSum(cs []int, sum, maxEmpty int) bool {
	g.sumList = g.sumList[:0]
	rest := sum
	for _, c := range cs {
		if g.grid[c] != 0 {
			rest -= g.grid[c]
		} else {
			g.sumList = append(g.sumList, c)
		}
	}
	n := len(g.sumList)
	if n == 0 || n > maxEmpty {
		return false
	}
	// Suffix bounds for pruning: the least and most the cells from k on can
	// add up to.
	g.lo[n], g.hi[n] = 0, 0
	for k := n - 1; k >= 0; k-- {
		m := g.cand[g.sumList[k]]
		g.lo[k] = g.lo[k+1] + lowBit(m) + 1
		g.hi[k] = g.hi[k+1] + bits.Len(uint(m))
		g.found[k] = 0
	}
	g.fill(0, rest)
	changed := false
	for k := range n {
		if g.elim(g.sumList[k], all&^g.found[k]) {
			changed = true
		}
	}
	return changed
}

// fill walks the fillings of sumList depth first from position k with rest
// left to add; true once every candidate is known to be used.
func (g *grader) fill(k, rest int) bool {
	n := len(g.sumList)
	if k == n {
		done := true
		for j := range n {
			g.found[j] |= 1 << (g.assign[j] - 1)
			if g.found[j] != g.cand[g.sumList[j]] {
				done = false
			}
		}
		return done
	}
	c := g.sumList[k]
	for m := g.cand[c]; m != 0; m &= m - 1 {
		d := lowBit(m) + 1
		left := rest - d
		if left < g.lo[k+1] || left > g.hi[k+1] {
			continue
		}
		clash := false
		for j := range k {
			if g.assign[j] == d && g.sees[g.sumList[j]][c] {
				clash = true
			}
		}
		if clash {
			continue
		}
		g.assign[k] = d
		if g.fill(k+1, left) {
			return true
		}
	}
	return false
}

// LayoutGrade is the result of grading a grid under a layout: Grade with
// Counts indexed by TechniquesFor the layout.
type LayoutGrade struct {
	Solved bool
	// Level is the hardest level used; StuckLevel if not solved, 0 if the grid
	// was already complete.
	Level int
	// Steps is the number of steps (placements or eliminations) taken.
	Steps int
	// Counts is the steps taken per technique, indexed like TechniquesFor.
	Counts []int
}

// GradeLayout grades a grid (81 values, 0 = empty) under layout l: it solves
// it with the grader until done or stuck. It errors on a grid of the wrong
// size or with values outside 0..9.
func GradeLayout(grid []int, l *Layout) (LayoutGrade, error) {
	g, err := newGrader(grid, l)
	if err != nil {
		return LayoutGrade{}, err
	}
	techniques := TechniquesFor(l)
	res := LayoutGrade{Counts: make([]int, len(techniques))}
	for g.placed < cells {
		t := g.step()
		if t < 0 {
			res.Level = StuckLevel
			return res, nil
		}
		res.Counts[t]++
		res.Steps++
		res.Level = max(res.Level, techniques[t].Level)
	}
	res.Solved = true
	return res, nil
}

// GradeCells grades a grid (81 values, 0 = empty) under the standard layout:
// it solves it with the grader until done or stuck. It errors on a grid of
// the wrong size or with values outside 0..9.
func GradeCells(grid []int) (Grade, error) {
	lg, err := GradeLayout(grid, standardLayout)
	if err != nil {
		return Grade{}, err
	}
	res := Grade{Solved: lg.Solved, Level: lg.Level, Steps: lg.Steps}
	copy(res.Counts[:], lg.Counts)
	return res, nil
}
