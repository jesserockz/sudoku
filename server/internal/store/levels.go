package store

import (
	"context"
	"database/sql"
	"fmt"
)

// firstWeek sorts before every real ISO week; its schedule row covers all
// weeks until the first change.
const firstWeek = "0000-W00"

// LevelsForWeek returns the number of levels in effect for isoWeek.
func (s *Store) LevelsForWeek(ctx context.Context, isoWeek string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT levels FROM level_schedule
		WHERE effective_week <= ? ORDER BY effective_week DESC LIMIT 1`, isoWeek).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("levels for %s: %w", isoWeek, err)
	}
	return n, nil
}

// ScheduleLevels records levels as the configured count, given the current
// and next ISO weeks. It returns the week from which levels applies.
//
//   - Before any result exists, the count applies immediately to every week:
//     nobody has played, so there is nothing to keep consistent.
//   - Otherwise the current week keeps its count and a change takes effect
//     from nextWeek. Re-running with the current week's count cancels a
//     pending change; re-running with another count replaces it.
func (s *Store) ScheduleLevels(ctx context.Context, thisWeek, nextWeek string, levels int) (string, error) {
	var effective string
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var played bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM results)`).Scan(&played); err != nil {
			return err
		}
		if !played {
			if _, err := tx.ExecContext(ctx, `DELETE FROM level_schedule`); err != nil {
				return err
			}
			effective = firstWeek
			_, err := tx.ExecContext(ctx, `INSERT INTO level_schedule (effective_week, levels) VALUES (?, ?)`, firstWeek, levels)
			return err
		}

		// Drop any pending future change; it is re-added below if still wanted.
		if _, err := tx.ExecContext(ctx, `DELETE FROM level_schedule WHERE effective_week > ?`, thisWeek); err != nil {
			return err
		}
		var current int
		if err := tx.QueryRowContext(ctx, `
			SELECT levels FROM level_schedule
			WHERE effective_week <= ? ORDER BY effective_week DESC LIMIT 1`, thisWeek).Scan(&current); err != nil {
			return err
		}
		if current == levels {
			effective = thisWeek
			return nil
		}
		effective = nextWeek
		_, err := tx.ExecContext(ctx, `INSERT INTO level_schedule (effective_week, levels) VALUES (?, ?)`, nextWeek, levels)
		return err
	})
	if err != nil {
		return "", fmt.Errorf("schedule levels: %w", err)
	}
	return effective, nil
}
