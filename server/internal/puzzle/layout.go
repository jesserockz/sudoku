package puzzle

import (
	"errors"
	"fmt"
	"slices"
)

// A Layout is the rules of a Sudoku variant as data: a port of
// web/src/core/layout.ts. Units (each holding 1 to 9 once) are numbered 0..8
// rows, 9..17 columns, 18..26 regions (the 3x3 boxes, or a jigsaw's irregular
// regions), then, for Diagonal, 27 the main diagonal and 28 the
// anti-diagonal. The cells of a unit, and the peers of a cell, ascend by cell
// index.

// The variants: 0 is standard Sudoku (the original endless series).
const (
	VariantStandard = 0
	// VariantDiagonal adds the two long diagonals as units.
	VariantDiagonal = 1
	// VariantJigsaw replaces the boxes with nine irregular regions.
	VariantJigsaw = 2
	// VariantKiller adds cages with sums, distinct digits within a cage.
	VariantKiller = 3
)

// Variants is the number of variants: variants are 0..Variants-1.
const Variants = 4

// VariantName is what players call a variant.
func VariantName(variant int) string {
	switch variant {
	case VariantStandard:
		return "Standard"
	case VariantDiagonal:
		return "Diagonal"
	case VariantJigsaw:
		return "Jigsaw"
	case VariantKiller:
		return "Killer"
	}
	return fmt.Sprintf("Variant %d", variant)
}

// Cage is a killer cage: its cells (ascending) and the sum of their digits.
type Cage struct {
	Cells []int `json:"cells"`
	Sum   int   `json:"sum"`
}

// Layout is a variant's units and cages. Build it with StandardLayout,
// DiagonalLayout, NewJigsawLayout or NewKillerLayout; it must not be modified.
type Layout struct {
	Variant int
	// Regions is the region (0..8) of each cell: its box, or its jigsaw region.
	Regions [cells]int
	// Diagonals reports whether the two long diagonals are units.
	Diagonals bool
	// Cages are the killer cages, ordered by their lowest cell.
	Cages []Cage

	units  [][9]int
	peers  [cells][]int
	cageOf [cells]int
	t      *tables
}

var (
	boxRegions = func() (r [cells]int) {
		for i := range r {
			r[i] = boxOf(i)
		}
		return r
	}()
	standardLayout = newLayout(VariantStandard, boxRegions, false, nil)
	diagonalLayout = newLayout(VariantDiagonal, boxRegions, true, nil)
)

// StandardLayout is standard Sudoku: rows, columns and boxes. Shared; do not
// modify.
func StandardLayout() *Layout { return standardLayout }

// DiagonalLayout is standard plus the two long diagonals. Shared; do not
// modify.
func DiagonalLayout() *Layout { return diagonalLayout }

// NewJigsawLayout is rows, columns and the regions given as a region index
// (0..8) per cell, nine cells each.
func NewJigsawLayout(regions [cells]int) (*Layout, error) {
	var size [9]int
	for _, g := range regions {
		if g < 0 || g >= 9 {
			return nil, fmt.Errorf("region out of range: %d", g)
		}
		size[g]++
	}
	for _, n := range size {
		if n != 9 {
			return nil, errors.New("every region must have 9 cells")
		}
	}
	return newLayout(VariantJigsaw, regions, false, nil), nil
}

// NewKillerLayout is standard units plus cages, which must cover every cell
// exactly once. Cages are copied, their cells sorted, and ordered by lowest
// cell.
func NewKillerLayout(cages []Cage) (*Layout, error) {
	var seen [cells]bool
	sorted := make([]Cage, len(cages))
	for k, cage := range cages {
		if len(cage.Cells) == 0 {
			return nil, errors.New("a cage needs at least one cell")
		}
		cs := slices.Clone(cage.Cells)
		slices.Sort(cs)
		for _, c := range cs {
			if c < 0 || c >= cells || seen[c] {
				return nil, fmt.Errorf("bad or repeated cage cell: %d", c)
			}
			seen[c] = true
		}
		sorted[k] = Cage{Cells: cs, Sum: cage.Sum}
	}
	if slices.Contains(seen[:], false) {
		return nil, errors.New("cages must cover every cell")
	}
	slices.SortFunc(sorted, func(a, b Cage) int { return a.Cells[0] - b.Cells[0] })
	return newLayout(VariantKiller, boxRegions, false, sorted), nil
}

func newLayout(variant int, regions [cells]int, diagonals bool, cages []Cage) *Layout {
	l := &Layout{Variant: variant, Regions: regions, Diagonals: diagonals, Cages: cages}
	l.units = make([][9]int, 27, 29)
	var fill [9]int
	for i := range cells {
		l.units[rowOf(i)][colOf(i)] = i
		l.units[9+colOf(i)][rowOf(i)] = i
		g := regions[i]
		l.units[18+g][fill[g]] = i
		fill[g]++
	}
	if diagonals {
		var main, anti [9]int
		for i := range 9 {
			main[i] = i * 10
			anti[i] = (i + 1) * 8
		}
		l.units = append(l.units, main, anti)
	}
	for i := range l.cageOf {
		l.cageOf[i] = -1
	}
	var sees [cells][cells]bool
	link := func(group []int) {
		for _, a := range group {
			for _, b := range group {
				if a != b {
					sees[a][b] = true
				}
			}
		}
	}
	for u := range l.units {
		link(l.units[u][:])
	}
	for k, cage := range cages {
		link(cage.Cells)
		for _, c := range cage.Cells {
			l.cageOf[c] = k
		}
	}
	for a := range cells {
		for b := range cells {
			if sees[a][b] {
				l.peers[a] = append(l.peers[a], b)
			}
		}
	}
	l.t = buildTables(l, &sees)
	return l
}

// Units returns every unit's cells, numbered as described above. Shared; do
// not modify.
func (l *Layout) Units() [][9]int { return l.units }

// LayoutPeers returns the cells that cannot hold the same digit as cell i
// (sharing a unit or a cage), ascending. Shared; do not modify.
func (l *Layout) LayoutPeers(i int) []int { return l.peers[i] }

// CageOf is the index in Cages of cell i's cage, or -1 without cages.
func (l *Layout) CageOf(i int) int { return l.cageOf[i] }

// Valid reports whether every unit and cage of grid (81 values, 0 = empty)
// is free of repeats and no complete cage misses its sum.
func (l *Layout) Valid(grid []int) bool {
	free := func(group []int) bool {
		seen := 0
		for _, c := range group {
			d := grid[c]
			if d == 0 {
				continue
			}
			if seen&(1<<d) != 0 {
				return false
			}
			seen |= 1 << d
		}
		return true
	}
	for u := range l.units {
		if !free(l.units[u][:]) {
			return false
		}
	}
	for _, cage := range l.Cages {
		if !free(cage.Cells) {
			return false
		}
		sum, full := 0, true
		for _, c := range cage.Cells {
			sum += grid[c]
			full = full && grid[c] != 0
		}
		if full && sum != cage.Sum {
			return false
		}
	}
	return true
}
