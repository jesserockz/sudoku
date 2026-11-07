package store

import (
	"context"
	"database/sql"
	"fmt"
)

// GeneratorEntry is one row of the generator schedule: from EffectiveWeek on,
// the dailies use generator Version. The first row's week is FirstWeek.
type GeneratorEntry struct {
	EffectiveWeek string
	Version       int
}

// GeneratorSchedule is the whole generator schedule, oldest entry first.
type GeneratorSchedule []GeneratorEntry

// GeneratorForWeek returns the generator version in effect for isoWeek.
func (s *Store) GeneratorForWeek(ctx context.Context, isoWeek string) (int, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `
		SELECT version FROM generator_schedule
		WHERE effective_week <= ? ORDER BY effective_week DESC LIMIT 1`, isoWeek).Scan(&v)
	if err != nil {
		return 0, fmt.Errorf("generator for %s: %w", isoWeek, err)
	}
	return v, nil
}

// GeneratorSchedule loads the whole schedule, oldest entry first, so many
// weeks can be resolved without a query each.
func (s *Store) GeneratorSchedule(ctx context.Context) (GeneratorSchedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT effective_week, version FROM generator_schedule ORDER BY effective_week`)
	if err != nil {
		return nil, fmt.Errorf("generator schedule: %w", err)
	}
	defer rows.Close()
	var out GeneratorSchedule
	for rows.Next() {
		var e GeneratorEntry
		if err := rows.Scan(&e.EffectiveWeek, &e.Version); err != nil {
			return nil, fmt.Errorf("generator schedule: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// VersionFor is the version in effect for isoWeek, as
// Store.GeneratorForWeek: the latest entry not after the week (0 if none).
func (sc GeneratorSchedule) VersionFor(isoWeek string) int {
	v := 0
	for _, e := range sc {
		if e.EffectiveWeek > isoWeek {
			break
		}
		v = e.Version
	}
	return v
}

// Pending is the change scheduled after thisWeek, if any: the first entry for
// a later week.
func (sc GeneratorSchedule) Pending(thisWeek string) *GeneratorEntry {
	for _, e := range sc {
		if e.EffectiveWeek > thisWeek {
			return &e
		}
	}
	return nil
}

// ScheduleGenerator records version as the generator for the weeks after
// thisWeek, given the current and next ISO weeks, and returns the week from
// which it applies. Unlike levels, a change is always pending: the current
// week keeps its generator, so a puzzle someone is part way through (or has
// finished) never changes under them.
//
// Any pending change is dropped first. If version is the current week's, that
// is the whole effect (a cancel) and the result is thisWeek; otherwise
// version is scheduled from nextWeek.
func (s *Store) ScheduleGenerator(ctx context.Context, thisWeek, nextWeek string, version int) (string, error) {
	effective := thisWeek
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM generator_schedule WHERE effective_week > ?`, thisWeek); err != nil {
			return err
		}
		var current int
		if err := tx.QueryRowContext(ctx, `
			SELECT version FROM generator_schedule
			WHERE effective_week <= ? ORDER BY effective_week DESC LIMIT 1`, thisWeek).Scan(&current); err != nil {
			return err
		}
		if current == version {
			return nil
		}
		effective = nextWeek
		_, err := tx.ExecContext(ctx, `INSERT INTO generator_schedule (effective_week, version) VALUES (?, ?)`, nextWeek, version)
		return err
	})
	if err != nil {
		return "", fmt.Errorf("schedule generator: %w", err)
	}
	return effective, nil
}
