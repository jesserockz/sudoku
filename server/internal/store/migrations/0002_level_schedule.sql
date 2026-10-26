-- How many levels each ISO week has. The row with the greatest
-- effective_week <= a week applies to it. Weeks are "YYYY-Www", which sort
-- correctly as text. Seeded with the original fixed five levels.
CREATE TABLE level_schedule (
    effective_week TEXT    PRIMARY KEY,
    levels         INTEGER NOT NULL CHECK (levels >= 1)
) STRICT;

INSERT INTO level_schedule (effective_week, levels) VALUES ('0000-W00', 5);

-- Drop the hard "level BETWEEN 1 AND 5" check: the upper bound is now the
-- week's configured level count, enforced by the API. SQLite can't alter a
-- CHECK, so rebuild the table.
CREATE TABLE results_new (
    user_id      INTEGER NOT NULL REFERENCES users (id),
    date         TEXT    NOT NULL,
    level        INTEGER NOT NULL CHECK (level >= 1),
    elapsed_ms   INTEGER NOT NULL CHECK (elapsed_ms > 0),
    completed_at TEXT    NOT NULL,
    submitted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, date, level)
) STRICT;

INSERT INTO results_new (user_id, date, level, elapsed_ms, completed_at, submitted_at)
SELECT user_id, date, level, elapsed_ms, completed_at, submitted_at FROM results;

DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
CREATE INDEX results_by_date ON results (date, level, elapsed_ms);
