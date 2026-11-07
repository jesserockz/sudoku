package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// EndlessResult is one completed endless puzzle: number Number of tier
// Difficulty (1 = Easy to 5 = Diabolical) in the series of generator version
// Generator (1 = Classic, 2 = Graded).
type EndlessResult struct {
	UserID      int64
	Generator   int
	Difficulty  int
	Number      int64
	ElapsedMs   int64
	CompletedAt string // RFC 3339, as reported

	// The fields below are used only by InsertEndlessResult.

	// ReplayStatus is "valid", "invalid" or "missing".
	ReplayStatus string
	ReplayError  string
	// Events is the replay's events as a JSON array, or empty for none.
	Events string
	// AutoFlag, when not empty, flags the new result as suspicious with
	// this reason, on behalf of the server.
	AutoFlag string
}

// InsertEndlessResult stores r unless the user already has a result for that
// generator, difficulty and number. It returns the stored result and whether it was newly
// created; on a duplicate the existing (first) result is returned unchanged,
// and its replay and flag are left alone.
func (s *Store) InsertEndlessResult(ctx context.Context, r EndlessResult) (EndlessResult, bool, error) {
	var stored EndlessResult
	var created bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		// flagged_at is the insert's own "now", so it equals submitted_at.
		res, err := tx.ExecContext(ctx, `
			INSERT INTO endless_results (user_id, generator, difficulty, number, elapsed_ms, completed_at,
				replay_status, replay_error, flagged_at, flag_reason, flag_auto)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?,
				CASE WHEN ?9 <> '' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END, ?9, ?9 <> '')
			ON CONFLICT (user_id, generator, difficulty, number) DO NOTHING`,
			r.UserID, r.Generator, r.Difficulty, r.Number, r.ElapsedMs, r.CompletedAt,
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
				INSERT INTO endless_replays (user_id, generator, difficulty, number, events) VALUES (?, ?, ?, ?, ?)`,
				r.UserID, r.Generator, r.Difficulty, r.Number, r.Events)
			return err
		}
		stored = EndlessResult{UserID: r.UserID, Generator: r.Generator, Difficulty: r.Difficulty, Number: r.Number}
		return tx.QueryRowContext(ctx, `
			SELECT elapsed_ms, completed_at FROM endless_results
			WHERE user_id = ? AND generator = ? AND difficulty = ? AND number = ?`,
			r.UserID, r.Generator, r.Difficulty, r.Number).Scan(&stored.ElapsedMs, &stored.CompletedAt)
	})
	if err != nil {
		return EndlessResult{}, false, fmt.Errorf("insert endless result: %w", err)
	}
	return stored, created, nil
}

// UserEndlessResults returns all of a user's endless results, ordered by
// generator, difficulty then number.
func (s *Store) UserEndlessResults(ctx context.Context, userID int64) ([]EndlessResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT generator, difficulty, number, elapsed_ms, completed_at FROM endless_results
		WHERE user_id = ? ORDER BY generator, difficulty, number`, userID)
	if err != nil {
		return nil, fmt.Errorf("user endless results: %w", err)
	}
	defer rows.Close()
	out := []EndlessResult{}
	for rows.Next() {
		r := EndlessResult{UserID: userID}
		if err := rows.Scan(&r.Generator, &r.Difficulty, &r.Number, &r.ElapsedMs, &r.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// EndlessTime is one user's time on an endless puzzle, for leaderboards.
type EndlessTime struct {
	UserID      int64
	DisplayName string
	ElapsedMs   int64
	// Flagged is set when an admin flagged the result as suspicious. The
	// server's own flags stay admin-only until an admin confirms one.
	Flagged bool
}

// EndlessPuzzleResults returns every result for one endless puzzle of a
// generator's series, fastest first.
func (s *Store) EndlessPuzzleResults(ctx context.Context, generator, difficulty int, number int64) ([]EndlessTime, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.user_id, u.display_name, r.elapsed_ms, r.flagged_at IS NOT NULL AND r.flag_auto = 0
		FROM endless_results r JOIN users u ON u.id = r.user_id
		WHERE r.generator = ? AND r.difficulty = ? AND r.number = ?
		ORDER BY r.elapsed_ms, u.display_name, r.user_id`, generator, difficulty, number)
	if err != nil {
		return nil, fmt.Errorf("endless puzzle results: %w", err)
	}
	defer rows.Close()
	out := []EndlessTime{}
	for rows.Next() {
		var r EndlessTime
		if err := rows.Scan(&r.UserID, &r.DisplayName, &r.ElapsedMs, &r.Flagged); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// EndlessProgress is one user's progress in one difficulty tier.
type EndlessProgress struct {
	Difficulty  int
	UserID      int64
	DisplayName string
	// Completed is how many puzzles of the tier the user has solved, and
	// Highest the highest number among them.
	Completed int
	Highest   int64
	// Flagged is set when an admin flagged any of the results. The server's
	// own flags stay admin-only until an admin confirms one.
	Flagged bool
}

// EndlessProgressAll returns every user's progress in every tier they have
// played in one generator's series, ordered by difficulty.
func (s *Store) EndlessProgressAll(ctx context.Context, generator int) ([]EndlessProgress, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.difficulty, r.user_id, u.display_name, COUNT(*), MAX(r.number),
			MAX(r.flagged_at IS NOT NULL AND r.flag_auto = 0)
		FROM endless_results r JOIN users u ON u.id = r.user_id
		WHERE r.generator = ?
		GROUP BY r.difficulty, r.user_id
		ORDER BY r.difficulty, r.user_id`, generator)
	if err != nil {
		return nil, fmt.Errorf("endless progress: %w", err)
	}
	defer rows.Close()
	out := []EndlessProgress{}
	for rows.Next() {
		var p EndlessProgress
		if err := rows.Scan(&p.Difficulty, &p.UserID, &p.DisplayName, &p.Completed, &p.Highest, &p.Flagged); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AdminEndlessResult is one endless result with its replay status and flag,
// for admins.
type AdminEndlessResult struct {
	UserID       int64
	DisplayName  string
	Generator    int
	Difficulty   int
	Number       int64
	ElapsedMs    int64
	CompletedAt  string
	SubmittedAt  string
	ReplayStatus string // "valid", "invalid" or "missing"
	ReplayError  string
	Flag         *Flag // nil when not flagged
}

const adminEndlessSelect = `
	SELECT r.user_id, u.display_name, r.generator, r.difficulty, r.number, r.elapsed_ms, r.completed_at, r.submitted_at,
		r.replay_status, r.replay_error,
		r.flagged_at, r.flag_reason, r.flag_auto, r.flagged_by, f.display_name
	FROM endless_results r
	JOIN users u ON u.id = r.user_id
	LEFT JOIN users f ON f.id = r.flagged_by`

func scanAdminEndlessResult(sc interface{ Scan(...any) error }) (AdminEndlessResult, error) {
	var (
		r      AdminEndlessResult
		at     sql.NullString
		reason string
		auto   bool
		by     sql.NullInt64
		byName sql.NullString
	)
	if err := sc.Scan(&r.UserID, &r.DisplayName, &r.Generator, &r.Difficulty, &r.Number, &r.ElapsedMs, &r.CompletedAt, &r.SubmittedAt,
		&r.ReplayStatus, &r.ReplayError, &at, &reason, &auto, &by, &byName); err != nil {
		return AdminEndlessResult{}, err
	}
	if at.Valid {
		r.Flag = &Flag{Reason: reason, Auto: auto, At: at.String}
		if by.Valid {
			r.Flag.By = &FlagUser{ID: by.Int64, DisplayName: byName.String}
		}
	}
	return r, nil
}

// AdminEndlessResultsBetween returns every endless result submitted in
// [from, to), given as UTC timestamps in the schema's format, with its replay
// status and flag, ordered by generator, difficulty, number then time.
func (s *Store) AdminEndlessResultsBetween(ctx context.Context, from, to time.Time) ([]AdminEndlessResult, error) {
	rows, err := s.db.QueryContext(ctx, adminEndlessSelect+`
		WHERE r.submitted_at >= ? AND r.submitted_at < ?
		ORDER BY r.generator, r.difficulty, r.number, r.elapsed_ms, u.display_name, r.user_id`,
		from.UTC().Format(timeLayout), to.UTC().Format(timeLayout))
	if err != nil {
		return nil, fmt.Errorf("admin endless results: %w", err)
	}
	defer rows.Close()
	out := []AdminEndlessResult{}
	for rows.Next() {
		r, err := scanAdminEndlessResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminEndlessResult returns one endless result, or ErrNotFound.
func (s *Store) AdminEndlessResult(ctx context.Context, userID int64, generator, difficulty int, number int64) (AdminEndlessResult, error) {
	r, err := scanAdminEndlessResult(s.db.QueryRowContext(ctx, adminEndlessSelect+`
		WHERE r.user_id = ? AND r.generator = ? AND r.difficulty = ? AND r.number = ?`, userID, generator, difficulty, number))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminEndlessResult{}, ErrNotFound
	}
	if err != nil {
		return AdminEndlessResult{}, fmt.Errorf("admin endless result: %w", err)
	}
	return r, nil
}

// EndlessReplayEvents returns the stored events (a JSON array) of an endless
// result, or nil when it has no replay.
func (s *Store) EndlessReplayEvents(ctx context.Context, userID int64, generator, difficulty int, number int64) ([]byte, error) {
	var events string
	err := s.db.QueryRowContext(ctx, `
		SELECT events FROM endless_replays WHERE user_id = ? AND generator = ? AND difficulty = ? AND number = ?`,
		userID, generator, difficulty, number).Scan(&events)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("endless replay events: %w", err)
	}
	return []byte(events), nil
}

// FlagEndlessResult flags an endless result as suspicious on behalf of admin
// by at time at, replacing any earlier flag. It returns ErrNotFound if there
// is no such result.
func (s *Store) FlagEndlessResult(ctx context.Context, userID int64, generator, difficulty int, number int64, by int64, reason string, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE endless_results SET flagged_at = ?, flagged_by = ?, flag_reason = ?, flag_auto = 0
		WHERE user_id = ? AND generator = ? AND difficulty = ? AND number = ?`,
		at.UTC().Format(timeLayout), by, reason, userID, generator, difficulty, number)
	return oneRow(res, err, "flag endless result")
}

// UnflagEndlessResult removes an endless result's flag (a no-op if it has
// none). It returns ErrNotFound if there is no such result.
func (s *Store) UnflagEndlessResult(ctx context.Context, userID int64, generator, difficulty int, number int64) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE endless_results SET flagged_at = NULL, flagged_by = NULL, flag_reason = '', flag_auto = 0
		WHERE user_id = ? AND generator = ? AND difficulty = ? AND number = ?`, userID, generator, difficulty, number)
	return oneRow(res, err, "unflag endless result")
}
