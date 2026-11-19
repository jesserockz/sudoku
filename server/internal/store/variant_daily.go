package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// VariantDailyResult is one completed variant of the day: the puzzle of date
// Date, a Graded puzzle of variant Variant (1 = Diagonal, 2 = Jigsaw, 3 =
// Killer).
type VariantDailyResult struct {
	UserID      int64
	Date        string // YYYY-MM-DD
	Variant     int
	ElapsedMs   int64
	CompletedAt string // RFC 3339, as reported

	// The fields below are used only by InsertVariantDailyResult.

	// ReplayStatus is "valid", "invalid" or "missing".
	ReplayStatus string
	ReplayError  string
	// Events is the replay's events as a JSON array, or empty for none.
	Events string
	// AutoFlag, when not empty, flags the new result as suspicious with
	// this reason, on behalf of the server.
	AutoFlag string
}

// InsertVariantDailyResult stores r unless the user already has a result for
// that date. It returns the stored result and whether it was newly created;
// on a duplicate the existing (first) result is returned unchanged, and its
// replay and flag are left alone.
func (s *Store) InsertVariantDailyResult(ctx context.Context, r VariantDailyResult) (VariantDailyResult, bool, error) {
	var stored VariantDailyResult
	var created bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		// flagged_at is the insert's own "now", so it equals submitted_at.
		res, err := tx.ExecContext(ctx, `
			INSERT INTO daily_variant_results (user_id, date, variant, elapsed_ms, completed_at,
				replay_status, replay_error, flagged_at, flag_reason, flag_auto)
			VALUES (?, ?, ?, ?, ?, ?, ?,
				CASE WHEN ?8 <> '' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END, ?8, ?8 <> '')
			ON CONFLICT (user_id, date) DO NOTHING`,
			r.UserID, r.Date, r.Variant, r.ElapsedMs, r.CompletedAt,
			r.ReplayStatus, r.ReplayError, r.AutoFlag)
		if err != nil {
			return err
		}
		// The driver's RowsAffected never fails.
		if n, _ := res.RowsAffected(); n == 1 {
			stored, created = r, true
			if r.Events == "" {
				return nil
			}
			_, err = tx.ExecContext(ctx, `
				INSERT INTO daily_variant_replays (user_id, date, events) VALUES (?, ?, ?)`,
				r.UserID, r.Date, r.Events)
			return err
		}
		stored = VariantDailyResult{UserID: r.UserID, Date: r.Date}
		return tx.QueryRowContext(ctx, `
			SELECT variant, elapsed_ms, completed_at FROM daily_variant_results
			WHERE user_id = ? AND date = ?`,
			r.UserID, r.Date).Scan(&stored.Variant, &stored.ElapsedMs, &stored.CompletedAt)
	})
	if err != nil {
		return VariantDailyResult{}, false, fmt.Errorf("insert variant daily result: %w", err)
	}
	return stored, created, nil
}

// UserVariantDailyResult returns a user's variant of the day result for date,
// or nil if they have none.
func (s *Store) UserVariantDailyResult(ctx context.Context, userID int64, date string) (*VariantDailyResult, error) {
	r := VariantDailyResult{UserID: userID, Date: date}
	err := s.db.QueryRowContext(ctx, `
		SELECT variant, elapsed_ms, completed_at FROM daily_variant_results
		WHERE user_id = ? AND date = ?`, userID, date).Scan(&r.Variant, &r.ElapsedMs, &r.CompletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("user variant daily result: %w", err)
	}
	return &r, nil
}

// VariantDailyDate is the date of one of a user's variant of the day results,
// for their streak.
type VariantDailyDate struct {
	Date string
	// AdminFlagged is set when an admin flagged the result. The server's own
	// flags don't count: they stay admin-only until an admin confirms one.
	AdminFlagged bool
}

// UserVariantDailyDates returns the dates of all of a user's variant of the
// day results, oldest first.
func (s *Store) UserVariantDailyDates(ctx context.Context, userID int64) ([]VariantDailyDate, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT date, flagged_at IS NOT NULL AND flag_auto = 0
		FROM daily_variant_results WHERE user_id = ? ORDER BY date`, userID)
	if err != nil {
		return nil, fmt.Errorf("user variant daily dates: %w", err)
	}
	defer rows.Close()
	var out []VariantDailyDate
	for rows.Next() {
		var d VariantDailyDate
		if err := rows.Scan(&d.Date, &d.AdminFlagged); err != nil {
			return nil, fmt.Errorf("user variant daily dates: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// VariantDailyTime is one user's time on a day's variant puzzle, for the
// leaderboard.
type VariantDailyTime struct {
	UserID      int64
	DisplayName string
	Variant     int
	ElapsedMs   int64
	// Flagged is set when an admin flagged the result as suspicious. The
	// server's own flags stay admin-only until an admin confirms one.
	Flagged bool
}

// VariantDailyResults returns every variant of the day result for date,
// fastest first.
func (s *Store) VariantDailyResults(ctx context.Context, date string) ([]VariantDailyTime, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.user_id, u.display_name, r.variant, r.elapsed_ms, r.flagged_at IS NOT NULL AND r.flag_auto = 0
		FROM daily_variant_results r JOIN users u ON u.id = r.user_id
		WHERE r.date = ?
		ORDER BY r.elapsed_ms, u.display_name, r.user_id`, date)
	if err != nil {
		return nil, fmt.Errorf("variant daily results: %w", err)
	}
	defer rows.Close()
	out := []VariantDailyTime{}
	for rows.Next() {
		var r VariantDailyTime
		if err := rows.Scan(&r.UserID, &r.DisplayName, &r.Variant, &r.ElapsedMs, &r.Flagged); err != nil {
			return nil, fmt.Errorf("variant daily results: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminVariantDailyResult is one variant of the day result with its replay
// status and flag, for admins.
type AdminVariantDailyResult struct {
	UserID       int64
	DisplayName  string
	Date         string
	Variant      int
	ElapsedMs    int64
	CompletedAt  string
	SubmittedAt  string
	ReplayStatus string // "valid", "invalid" or "missing"
	ReplayError  string
	Flag         *Flag // nil when not flagged
}

const adminVariantDailySelect = `
	SELECT r.user_id, u.display_name, r.date, r.variant, r.elapsed_ms, r.completed_at, r.submitted_at,
		r.replay_status, r.replay_error,
		r.flagged_at, r.flag_reason, r.flag_auto, r.flagged_by, f.display_name
	FROM daily_variant_results r
	JOIN users u ON u.id = r.user_id
	LEFT JOIN users f ON f.id = r.flagged_by`

func scanAdminVariantDailyResult(sc interface{ Scan(...any) error }) (AdminVariantDailyResult, error) {
	var (
		r      AdminVariantDailyResult
		at     sql.NullString
		reason string
		auto   bool
		by     sql.NullInt64
		byName sql.NullString
	)
	if err := sc.Scan(&r.UserID, &r.DisplayName, &r.Date, &r.Variant, &r.ElapsedMs, &r.CompletedAt, &r.SubmittedAt,
		&r.ReplayStatus, &r.ReplayError, &at, &reason, &auto, &by, &byName); err != nil {
		return AdminVariantDailyResult{}, err
	}
	if at.Valid {
		r.Flag = &Flag{Reason: reason, Auto: auto, At: at.String}
		if by.Valid {
			r.Flag.By = &FlagUser{ID: by.Int64, DisplayName: byName.String}
		}
	}
	return r, nil
}

// AdminVariantDailyResults returns every variant of the day result for date
// with its replay status and flag, fastest first.
func (s *Store) AdminVariantDailyResults(ctx context.Context, date string) ([]AdminVariantDailyResult, error) {
	rows, err := s.db.QueryContext(ctx, adminVariantDailySelect+`
		WHERE r.date = ?
		ORDER BY r.elapsed_ms, u.display_name, r.user_id`, date)
	if err != nil {
		return nil, fmt.Errorf("admin variant daily results: %w", err)
	}
	defer rows.Close()
	out := []AdminVariantDailyResult{}
	for rows.Next() {
		r, err := scanAdminVariantDailyResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminVariantDailyResult returns one result, or ErrNotFound.
func (s *Store) AdminVariantDailyResult(ctx context.Context, userID int64, date string) (AdminVariantDailyResult, error) {
	r, err := scanAdminVariantDailyResult(s.db.QueryRowContext(ctx, adminVariantDailySelect+`
		WHERE r.user_id = ? AND r.date = ?`, userID, date))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminVariantDailyResult{}, ErrNotFound
	}
	if err != nil {
		return AdminVariantDailyResult{}, fmt.Errorf("admin variant daily result: %w", err)
	}
	return r, nil
}

// VariantDailyReplayEvents returns the stored events (a JSON array) of a
// result, or nil when it has no replay.
func (s *Store) VariantDailyReplayEvents(ctx context.Context, userID int64, date string) ([]byte, error) {
	var events string
	err := s.db.QueryRowContext(ctx, `
		SELECT events FROM daily_variant_replays WHERE user_id = ? AND date = ?`, userID, date).Scan(&events)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("variant daily replay events: %w", err)
	}
	return []byte(events), nil
}

// FlagVariantDailyResult flags a result as suspicious on behalf of admin by
// at time at, replacing any earlier flag. It returns ErrNotFound if there is
// no such result.
func (s *Store) FlagVariantDailyResult(ctx context.Context, userID int64, date string, by int64, reason string, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE daily_variant_results SET flagged_at = ?, flagged_by = ?, flag_reason = ?, flag_auto = 0
		WHERE user_id = ? AND date = ?`,
		at.UTC().Format(timeLayout), by, reason, userID, date)
	return oneRow(res, err, "flag variant daily result")
}

// UnflagVariantDailyResult removes a result's flag (a no-op if it has none).
// It returns ErrNotFound if there is no such result.
func (s *Store) UnflagVariantDailyResult(ctx context.Context, userID int64, date string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE daily_variant_results SET flagged_at = NULL, flagged_by = NULL, flag_reason = '', flag_auto = 0
		WHERE user_id = ? AND date = ?`, userID, date)
	return oneRow(res, err, "unflag variant daily result")
}
