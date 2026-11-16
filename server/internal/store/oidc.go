package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// LoadOIDCKeys returns the keys last saved for issuer, or nil when there are
// none. It implements auth.KeyCache.
func (s *Store) LoadOIDCKeys(ctx context.Context, issuer string) ([]byte, error) {
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM oidc_keys WHERE issuer = ?`, issuer).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load oidc keys: %w", err)
	}
	return []byte(data), nil
}

// SaveOIDCKeys replaces the keys saved for issuer. It implements auth.KeyCache.
func (s *Store) SaveOIDCKeys(ctx context.Context, issuer string, data []byte) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO oidc_keys (issuer, data) VALUES (?1, ?2)
		ON CONFLICT (issuer) DO UPDATE SET data = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		issuer, string(data))
	if err != nil {
		return fmt.Errorf("save oidc keys: %w", err)
	}
	return nil
}
