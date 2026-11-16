-- The OIDC issuer's signing keys as last fetched, so after a restart the
-- server verifies tokens without the issuer (see auth.KeyCache).
CREATE TABLE oidc_keys (
    issuer     TEXT NOT NULL PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
