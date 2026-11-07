-- Endless puzzles get one numbered series per generator version (1 = Classic,
-- 2 = Graded), each with its own progress, numbering and leaderboards.
-- Everything stored so far is generator 1. generator becomes part of the key,
-- so both tables are rebuilt (SQLite cannot change a primary key in place).
CREATE TABLE endless_results_new (
    user_id       INTEGER NOT NULL REFERENCES users (id),
    generator     INTEGER NOT NULL DEFAULT 1 CHECK (generator IN (1, 2)),
    difficulty    INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    number        INTEGER NOT NULL CHECK (number >= 1),
    elapsed_ms    INTEGER NOT NULL CHECK (elapsed_ms > 0),
    completed_at  TEXT    NOT NULL,
    submitted_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    replay_status TEXT    NOT NULL CHECK (replay_status IN ('valid', 'invalid', 'missing')),
    replay_error  TEXT    NOT NULL DEFAULT '',
    flagged_at    TEXT,
    flagged_by    INTEGER REFERENCES users (id),
    flag_reason   TEXT    NOT NULL DEFAULT '',
    flag_auto     INTEGER NOT NULL DEFAULT 0 CHECK (flag_auto IN (0, 1)),
    PRIMARY KEY (user_id, generator, difficulty, number)
) STRICT;

INSERT INTO endless_results_new (user_id, generator, difficulty, number, elapsed_ms, completed_at, submitted_at,
        replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto)
    SELECT user_id, 1, difficulty, number, elapsed_ms, completed_at, submitted_at,
        replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto
    FROM endless_results;

CREATE TABLE endless_replays_new (
    user_id    INTEGER NOT NULL,
    generator  INTEGER NOT NULL DEFAULT 1,
    difficulty INTEGER NOT NULL,
    number     INTEGER NOT NULL,
    events     TEXT    NOT NULL,
    PRIMARY KEY (user_id, generator, difficulty, number),
    FOREIGN KEY (user_id, generator, difficulty, number)
        REFERENCES endless_results_new (user_id, generator, difficulty, number)
) STRICT;

INSERT INTO endless_replays_new (user_id, generator, difficulty, number, events)
    SELECT user_id, 1, difficulty, number, events FROM endless_replays;

DROP TABLE endless_replays;
DROP TABLE endless_results;
ALTER TABLE endless_results_new RENAME TO endless_results;
ALTER TABLE endless_replays_new RENAME TO endless_replays;

CREATE INDEX endless_results_by_puzzle ON endless_results (generator, difficulty, number, elapsed_ms);
CREATE INDEX endless_results_by_submitted ON endless_results (submitted_at);
