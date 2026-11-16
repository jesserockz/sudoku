package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Maintenance is the maintenance-mode setting.
type Maintenance struct {
	Enabled bool
	// Until is when maintenance might end, in UTC; nil when unknown. It is
	// only a hint for players.
	Until *time.Time
}

// Maintenance returns the stored maintenance setting.
func (s *Store) Maintenance(ctx context.Context) (Maintenance, error) {
	var (
		m     Maintenance
		until sql.NullString
	)
	if err := s.db.QueryRowContext(ctx, `SELECT enabled, until FROM maintenance_settings WHERE id = 1`).Scan(&m.Enabled, &until); err != nil {
		return Maintenance{}, fmt.Errorf("maintenance: %w", err)
	}
	if until.Valid {
		t, err := time.Parse(time.RFC3339, until.String)
		if err != nil {
			return Maintenance{}, fmt.Errorf("maintenance until %q: %w", until.String, err)
		}
		t = t.UTC()
		m.Until = &t
	}
	return m, nil
}

// SetMaintenance stores m, with Until normalised to UTC.
func (s *Store) SetMaintenance(ctx context.Context, m Maintenance) error {
	var until any
	if m.Until != nil {
		until = m.Until.UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO maintenance_settings (id, enabled, until) VALUES (1, ?1, ?2)
		ON CONFLICT (id) DO UPDATE SET enabled = ?1, until = ?2`, m.Enabled, until)
	if err != nil {
		return fmt.Errorf("set maintenance: %w", err)
	}
	return nil
}
