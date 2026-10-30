package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrNotFound is returned when the result asked for does not exist.
var ErrNotFound = errors.New("not found")

// timeLayout matches the strftime format the schema uses for its timestamps.
const timeLayout = "2006-01-02T15:04:05.000Z"

// FlagUser is the admin who flagged a result.
type FlagUser struct {
	ID          int64
	DisplayName string
}

// Flag marks a result as suspicious.
type Flag struct {
	Reason string
	// Auto is set when the server flagged the result on submission; By is
	// then nil.
	Auto bool
	By   *FlagUser
	At   string // RFC 3339 UTC
}

// AdminResult is one result with its replay status and flag, for admins.
type AdminResult struct {
	UserID       int64
	DisplayName  string
	Level        int
	ElapsedMs    int64
	CompletedAt  string
	SubmittedAt  string
	ReplayStatus string // "valid", "invalid", "missing" or "none"
	ReplayError  string
	Flag         *Flag // nil when not flagged
}

const adminSelect = `
	SELECT r.user_id, u.display_name, r.level, r.elapsed_ms, r.completed_at, r.submitted_at,
		COALESCE(r.replay_status, 'none'), r.replay_error,
		r.flagged_at, r.flag_reason, r.flag_auto, r.flagged_by, f.display_name
	FROM results r
	JOIN users u ON u.id = r.user_id
	LEFT JOIN users f ON f.id = r.flagged_by`

func scanAdminResult(sc interface{ Scan(...any) error }) (AdminResult, error) {
	var (
		r      AdminResult
		at     sql.NullString
		reason string
		auto   bool
		by     sql.NullInt64
		byName sql.NullString
	)
	if err := sc.Scan(&r.UserID, &r.DisplayName, &r.Level, &r.ElapsedMs, &r.CompletedAt, &r.SubmittedAt,
		&r.ReplayStatus, &r.ReplayError, &at, &reason, &auto, &by, &byName); err != nil {
		return AdminResult{}, err
	}
	if at.Valid {
		r.Flag = &Flag{Reason: reason, Auto: auto, At: at.String}
		if by.Valid {
			r.Flag.By = &FlagUser{ID: by.Int64, DisplayName: byName.String}
		}
	}
	return r, nil
}

// AdminDayResults returns every result for date with its replay status and
// flag, ordered by level then time.
func (s *Store) AdminDayResults(ctx context.Context, date string) ([]AdminResult, error) {
	rows, err := s.db.QueryContext(ctx, adminSelect+`
		WHERE r.date = ?
		ORDER BY r.level, r.elapsed_ms, u.display_name, r.user_id`, date)
	if err != nil {
		return nil, fmt.Errorf("admin day results: %w", err)
	}
	defer rows.Close()
	out := []AdminResult{}
	for rows.Next() {
		r, err := scanAdminResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminResult returns one result, or ErrNotFound.
func (s *Store) AdminResult(ctx context.Context, userID int64, date string, level int) (AdminResult, error) {
	r, err := scanAdminResult(s.db.QueryRowContext(ctx, adminSelect+`
		WHERE r.user_id = ? AND r.date = ? AND r.level = ?`, userID, date, level))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminResult{}, ErrNotFound
	}
	if err != nil {
		return AdminResult{}, fmt.Errorf("admin result: %w", err)
	}
	return r, nil
}

// ReplayEvents returns the stored events (a JSON array) of a result, or nil
// when it has no replay.
func (s *Store) ReplayEvents(ctx context.Context, userID int64, date string, level int) ([]byte, error) {
	var events string
	err := s.db.QueryRowContext(ctx, `
		SELECT events FROM replays WHERE user_id = ? AND date = ? AND level = ?`,
		userID, date, level).Scan(&events)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("replay events: %w", err)
	}
	return []byte(events), nil
}

// FlagResult flags a result as suspicious on behalf of admin by at time at,
// replacing any earlier flag. It returns ErrNotFound if there is no such
// result.
func (s *Store) FlagResult(ctx context.Context, userID int64, date string, level int, by int64, reason string, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE results SET flagged_at = ?, flagged_by = ?, flag_reason = ?, flag_auto = 0
		WHERE user_id = ? AND date = ? AND level = ?`,
		at.UTC().Format(timeLayout), by, reason, userID, date, level)
	return oneRow(res, err, "flag result")
}

// UnflagResult removes a result's flag (a no-op if it has none). It returns
// ErrNotFound if there is no such result.
func (s *Store) UnflagResult(ctx context.Context, userID int64, date string, level int) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE results SET flagged_at = NULL, flagged_by = NULL, flag_reason = '', flag_auto = 0
		WHERE user_id = ? AND date = ? AND level = ?`, userID, date, level)
	return oneRow(res, err, "unflag result")
}

func oneRow(res sql.Result, err error, what string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	// The driver's RowsAffected never fails.
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
