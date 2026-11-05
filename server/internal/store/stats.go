package store

import (
	"context"
	"fmt"
)

// ScheduleEntry is one row of the level schedule: from EffectiveWeek on, each
// day has Levels games.
type ScheduleEntry struct {
	EffectiveWeek string
	Levels        int
}

// Schedule is the whole level schedule, oldest entry first.
type Schedule []ScheduleEntry

// LevelSchedule loads the whole level schedule, so many weeks can be
// resolved without a query each.
func (s *Store) LevelSchedule(ctx context.Context) (Schedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT effective_week, levels FROM level_schedule ORDER BY effective_week`)
	if err != nil {
		return nil, fmt.Errorf("level schedule: %w", err)
	}
	defer rows.Close()
	var out Schedule
	for rows.Next() {
		var e ScheduleEntry
		if err := rows.Scan(&e.EffectiveWeek, &e.Levels); err != nil {
			return nil, fmt.Errorf("level schedule: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LevelsFor is the number of levels in effect for isoWeek, as
// Store.LevelsForWeek: the latest entry not after the week (0 if none).
func (sc Schedule) LevelsFor(isoWeek string) int {
	levels := 0
	for _, e := range sc {
		if e.EffectiveWeek > isoWeek {
			break
		}
		levels = e.Levels
	}
	return levels
}

// UserDailyResult is one of a user's daily results, for their stats.
type UserDailyResult struct {
	Date      string
	Level     int
	ElapsedMs int64
	// AdminFlagged is set when an admin flagged the result. The server's own
	// flags don't count: they stay admin-only until an admin confirms one.
	AdminFlagged bool
}

// UserDailyResults returns all of a user's daily results, oldest first, then
// by level.
func (s *Store) UserDailyResults(ctx context.Context, userID int64) ([]UserDailyResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT date, level, elapsed_ms, flagged_at IS NOT NULL AND flag_auto = 0
		FROM results WHERE user_id = ? ORDER BY date, level`, userID)
	if err != nil {
		return nil, fmt.Errorf("user daily results: %w", err)
	}
	defer rows.Close()
	var out []UserDailyResult
	for rows.Next() {
		var r UserDailyResult
		if err := rows.Scan(&r.Date, &r.Level, &r.ElapsedMs, &r.AdminFlagged); err != nil {
			return nil, fmt.Errorf("user daily results: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountingDates returns, for every user with a result on date, the distinct
// dates up to and including date on which they have a result that is not
// admin-flagged, oldest first. These are the days that count towards a
// streak.
func (s *Store) CountingDates(ctx context.Context, date string) (map[int64][]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT r.user_id, r.date FROM results r
		WHERE r.date <= ? AND NOT (r.flagged_at IS NOT NULL AND r.flag_auto = 0)
			AND r.user_id IN (SELECT user_id FROM results WHERE date = ?)
		ORDER BY r.user_id, r.date`, date, date)
	if err != nil {
		return nil, fmt.Errorf("counting dates: %w", err)
	}
	defer rows.Close()
	out := map[int64][]string{}
	for rows.Next() {
		var id int64
		var d string
		if err := rows.Scan(&id, &d); err != nil {
			return nil, fmt.Errorf("counting dates: %w", err)
		}
		out[id] = append(out[id], d)
	}
	return out, rows.Err()
}

// EndlessStat summarises a user's endless results in one difficulty tier.
type EndlessStat struct {
	Difficulty int
	Completed  int
	// Highest is the highest puzzle number solved.
	Highest int64
	// BestMs is the fastest time and TotalMs the sum of all times.
	BestMs  int64
	TotalMs int64
}

// UserEndlessStats returns a user's endless summary for each tier they have
// played, ordered by difficulty. Flagged results are included.
func (s *Store) UserEndlessStats(ctx context.Context, userID int64) ([]EndlessStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT difficulty, COUNT(*), MAX(number), MIN(elapsed_ms), SUM(elapsed_ms)
		FROM endless_results WHERE user_id = ? GROUP BY difficulty ORDER BY difficulty`, userID)
	if err != nil {
		return nil, fmt.Errorf("user endless stats: %w", err)
	}
	defer rows.Close()
	var out []EndlessStat
	for rows.Next() {
		var e EndlessStat
		if err := rows.Scan(&e.Difficulty, &e.Completed, &e.Highest, &e.BestMs, &e.TotalMs); err != nil {
			return nil, fmt.Errorf("user endless stats: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
