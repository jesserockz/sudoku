-- Endless puzzles come in variants (docs/API.md, "Variants"): 0 = standard,
-- 1 = Diagonal, 2 = Jigsaw, 3 = Killer, each its own numbered series per
-- generator. Everything stored so far is variant 0. variant becomes part of
-- the key, so both tables are rebuilt (SQLite cannot change a primary key in
-- place).
CREATE TABLE endless_results_new (
    user_id       INTEGER NOT NULL REFERENCES users (id),
    generator     INTEGER NOT NULL DEFAULT 1 CHECK (generator IN (1, 2)),
    variant       INTEGER NOT NULL DEFAULT 0 CHECK (variant BETWEEN 0 AND 3),
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
    PRIMARY KEY (user_id, generator, variant, difficulty, number)
) STRICT;

INSERT INTO endless_results_new (user_id, generator, variant, difficulty, number, elapsed_ms, completed_at, submitted_at,
        replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto)
    SELECT user_id, generator, 0, difficulty, number, elapsed_ms, completed_at, submitted_at,
        replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto
    FROM endless_results;

CREATE TABLE endless_replays_new (
    user_id    INTEGER NOT NULL,
    generator  INTEGER NOT NULL DEFAULT 1,
    variant    INTEGER NOT NULL DEFAULT 0,
    difficulty INTEGER NOT NULL,
    number     INTEGER NOT NULL,
    events     TEXT    NOT NULL,
    PRIMARY KEY (user_id, generator, variant, difficulty, number),
    FOREIGN KEY (user_id, generator, variant, difficulty, number)
        REFERENCES endless_results_new (user_id, generator, variant, difficulty, number)
) STRICT;

INSERT INTO endless_replays_new (user_id, generator, variant, difficulty, number, events)
    SELECT user_id, generator, 0, difficulty, number, events FROM endless_replays;

DROP TABLE endless_replays;
DROP TABLE endless_results;
ALTER TABLE endless_results_new RENAME TO endless_results;
ALTER TABLE endless_replays_new RENAME TO endless_replays;

CREATE INDEX endless_results_by_puzzle ON endless_results (generator, variant, difficulty, number, elapsed_ms);
CREATE INDEX endless_results_by_submitted ON endless_results (submitted_at);
