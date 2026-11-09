package store

import (
	"context"
	"fmt"
	"slices"
)

// Generator versions, as stored (puzzle.VersionClassic and VersionGraded).
const (
	generatorClassic = 1
	generatorGraded  = 2
)

// EnabledGenerators returns the generator versions players may use,
// ascending: [1], [2] or [1 2]. It is never empty.
func (s *Store) EnabledGenerators(ctx context.Context) ([]int, error) {
	var classic, graded bool
	err := s.db.QueryRowContext(ctx, `SELECT classic, graded FROM generator_settings WHERE id = 1`).Scan(&classic, &graded)
	if err != nil {
		return nil, fmt.Errorf("enabled generators: %w", err)
	}
	var out []int
	if classic {
		out = append(out, generatorClassic)
	}
	if graded {
		out = append(out, generatorGraded)
	}
	return out, nil
}

// SetEnabledGenerators makes versions (1 and/or 2) the enabled generators,
// with immediate effect. Other values are ignored; enabling none is an error.
func (s *Store) SetEnabledGenerators(ctx context.Context, versions []int) error {
	classic, graded := 0, 0
	if slices.Contains(versions, generatorClassic) {
		classic = 1
	}
	if slices.Contains(versions, generatorGraded) {
		graded = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO generator_settings (id, classic, graded) VALUES (1, ?1, ?2)
		ON CONFLICT (id) DO UPDATE SET classic = ?1, graded = ?2`, classic, graded)
	if err != nil {
		return fmt.Errorf("set enabled generators: %w", err)
	}
	return nil
}
