-- The variant of the day (docs/API.md, "Variant of the day"): one extra daily
-- puzzle, a Graded Diagonal, Jigsaw or Killer puzzle drawn from the week seed
-- and the day. A user has at most one result per date, with its own replay,
-- flag and leaderboard. variant records which variant the day's puzzle was
-- (1 = Diagonal, 2 = Jigsaw, 3 = Killer).
CREATE TABLE daily_variant_results (
    user_id       INTEGER NOT NULL REFERENCES users (id),
    -- Game date, YYYY-MM-DD in the configured game timezone.
    date          TEXT    NOT NULL,
    variant       INTEGER NOT NULL CHECK (variant BETWEEN 1 AND 3),
    elapsed_ms    INTEGER NOT NULL CHECK (elapsed_ms > 0),
    -- Client-reported RFC 3339 timestamp, stored verbatim.
    completed_at  TEXT    NOT NULL,
    submitted_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    replay_status TEXT    NOT NULL CHECK (replay_status IN ('valid', 'invalid', 'missing')),
    replay_error  TEXT    NOT NULL DEFAULT '',
    flagged_at    TEXT,
    flagged_by    INTEGER REFERENCES users (id),
    flag_reason   TEXT    NOT NULL DEFAULT '',
    flag_auto     INTEGER NOT NULL DEFAULT 0 CHECK (flag_auto IN (0, 1)),
    PRIMARY KEY (user_id, date)
) STRICT;

CREATE TABLE daily_variant_replays (
    user_id INTEGER NOT NULL,
    date    TEXT    NOT NULL,
    events  TEXT    NOT NULL,
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id, date) REFERENCES daily_variant_results (user_id, date)
) STRICT;

CREATE INDEX daily_variant_results_by_date ON daily_variant_results (date, elapsed_ms);
