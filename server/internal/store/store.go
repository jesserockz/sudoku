// Package store persists users and results in SQLite.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // pure-Go driver, keeps the binary CGO-free
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and applies pending
// migrations. Use ":memory:" for a throwaway database.
func Open(ctx context.Context, path string) (*Store, error) {
	q := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "foreign_keys(1)", "journal_mode(WAL)", "synchronous(NORMAL)"} {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// One connection: plenty for a family, and it rules out SQLITE_BUSY
	// between our own writers (and keeps :memory: a single database).
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// migrate applies migrations/NNNN_*.sql in order, tracking the last applied
// number in PRAGMA user_version.
func (s *Store) migrate(ctx context.Context) error {
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)

	var current int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	for _, name := range names {
		base := strings.TrimPrefix(name, "migrations/")
		num, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: bad name", base)
		}
		if num <= current {
			continue
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return err
		}
		if err := s.inTx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", num))
			return err
		}); err != nil {
			return fmt.Errorf("migration %s: %w", base, err)
		}
		current = num
	}
	return nil
}

func (s *Store) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

type User struct {
	ID          int64
	Subject     string
	DisplayName string
}

// UpsertUser returns the user with subject, creating it if needed and
// refreshing the display name when it has changed.
func (s *Store) UpsertUser(ctx context.Context, subject, displayName string) (User, error) {
	u := User{Subject: subject}
	var stored string
	err := s.db.QueryRowContext(ctx,
		`SELECT id, display_name FROM users WHERE subject = ?`, subject).Scan(&u.ID, &stored)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		err = s.db.QueryRowContext(ctx, `
			INSERT INTO users (subject, display_name) VALUES (?, ?)
			ON CONFLICT (subject) DO UPDATE SET display_name = excluded.display_name
			RETURNING id`, subject, displayName).Scan(&u.ID)
		if err != nil {
			return User{}, fmt.Errorf("insert user: %w", err)
		}
	case err != nil:
		return User{}, fmt.Errorf("get user: %w", err)
	case stored != displayName:
		_, err = s.db.ExecContext(ctx, `
			UPDATE users SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE id = ?`, displayName, u.ID)
		if err != nil {
			return User{}, fmt.Errorf("update user: %w", err)
		}
	}
	u.DisplayName = displayName
	return u, nil
}

type Result struct {
	UserID      int64
	Date        string // YYYY-MM-DD
	Level       int
	ElapsedMs   int64
	CompletedAt string // RFC 3339, as reported
}

// InsertResult stores r unless the user already has a result for that date
// and level. It returns the stored result and whether it was newly created;
// on a duplicate the existing (first) result is returned unchanged.
func (s *Store) InsertResult(ctx context.Context, r Result) (Result, bool, error) {
	var stored Result
	var created bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			INSERT INTO results (user_id, date, level, elapsed_ms, completed_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (user_id, date, level) DO NOTHING`,
			r.UserID, r.Date, r.Level, r.ElapsedMs, r.CompletedAt)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 1 {
			stored, created = r, true
			return nil
		}
		stored = Result{UserID: r.UserID, Date: r.Date, Level: r.Level}
		return tx.QueryRowContext(ctx, `
			SELECT elapsed_ms, completed_at FROM results
			WHERE user_id = ? AND date = ? AND level = ?`,
			r.UserID, r.Date, r.Level).Scan(&stored.ElapsedMs, &stored.CompletedAt)
	})
	if err != nil {
		return Result{}, false, fmt.Errorf("insert result: %w", err)
	}
	return stored, created, nil
}

// UserResults returns a user's results for date, ordered by level.
func (s *Store) UserResults(ctx context.Context, userID int64, date string) ([]Result, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT level, elapsed_ms, completed_at FROM results
		WHERE user_id = ? AND date = ? ORDER BY level`, userID, date)
	if err != nil {
		return nil, fmt.Errorf("user results: %w", err)
	}
	defer rows.Close()
	out := []Result{}
	for rows.Next() {
		r := Result{UserID: userID, Date: date}
		if err := rows.Scan(&r.Level, &r.ElapsedMs, &r.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DayResult is one result joined with its user, for leaderboards.
type DayResult struct {
	UserID      int64
	DisplayName string
	Level       int
	ElapsedMs   int64
}

// DayResults returns every result for date, ordered by level then time.
func (s *Store) DayResults(ctx context.Context, date string) ([]DayResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.user_id, u.display_name, r.level, r.elapsed_ms
		FROM results r JOIN users u ON u.id = r.user_id
		WHERE r.date = ?
		ORDER BY r.level, r.elapsed_ms, u.display_name, r.user_id`, date)
	if err != nil {
		return nil, fmt.Errorf("day results: %w", err)
	}
	defer rows.Close()
	out := []DayResult{}
	for rows.Next() {
		var r DayResult
		if err := rows.Scan(&r.UserID, &r.DisplayName, &r.Level, &r.ElapsedMs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
