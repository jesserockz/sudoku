-- Endless puzzles (docs/API.md, "Endless seed"): numbered puzzles per
-- difficulty tier, shared by everyone and kept forever. The daily tables are
-- untouched.
--
-- difficulty is the tier 1 (Easy) to 5 (Diabolical), not a daily game level.
-- number is the puzzle's number within its tier, up to 2^53-1.
-- replay_status is 'valid', 'invalid' or 'missing'. A result is flagged as
-- suspicious when flagged_at is set; flag_auto is 1 when the server flagged it
-- on submission (flagged_by is then NULL).
CREATE TABLE endless_results (
    user_id       INTEGER NOT NULL REFERENCES users (id),
    difficulty    INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    number        INTEGER NOT NULL CHECK (number >= 1),
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
    PRIMARY KEY (user_id, difficulty, number)
) STRICT;

CREATE INDEX endless_results_by_puzzle ON endless_results (difficulty, number, elapsed_ms);
CREATE INDEX endless_results_by_submitted ON endless_results (submitted_at);

-- The recorded events (a JSON array) live apart from the results, as for the
-- dailies. Results without a replay have no row.
CREATE TABLE endless_replays (
    user_id    INTEGER NOT NULL,
    difficulty INTEGER NOT NULL,
    number     INTEGER NOT NULL,
    events     TEXT    NOT NULL,
    PRIMARY KEY (user_id, difficulty, number),
    FOREIGN KEY (user_id, difficulty, number) REFERENCES endless_results (user_id, difficulty, number)
) STRICT;
