CREATE TABLE users (
    id           INTEGER PRIMARY KEY,
    -- OIDC subject, or "dev:<sub>" for dev-mode users so the two never collide.
    subject      TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE results (
    user_id      INTEGER NOT NULL REFERENCES users (id),
    -- Game date, YYYY-MM-DD in the configured game timezone.
    date         TEXT    NOT NULL,
    level        INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
    elapsed_ms   INTEGER NOT NULL CHECK (elapsed_ms > 0),
    -- Client-reported RFC 3339 timestamp, stored verbatim.
    completed_at TEXT    NOT NULL,
    submitted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, date, level)
) STRICT;

CREATE INDEX results_by_date ON results (date, level, elapsed_ms);
