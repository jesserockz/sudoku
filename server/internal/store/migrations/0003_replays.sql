-- Replay verification and anti-cheat flags (docs/API.md, "Replays").
--
-- replay_status is NULL for results stored before replays existed (served as
-- "none"); otherwise 'valid', 'invalid' or 'missing'.
ALTER TABLE results ADD COLUMN replay_status TEXT
    CHECK (replay_status IN ('valid', 'invalid', 'missing'));
-- Why the replay check failed; empty unless replay_status is 'invalid'.
ALTER TABLE results ADD COLUMN replay_error TEXT NOT NULL DEFAULT '';
-- A result is flagged as suspicious when flagged_at is set. flag_auto is 1
-- when the server flagged it on submission (flagged_by is then NULL).
ALTER TABLE results ADD COLUMN flagged_at TEXT;
ALTER TABLE results ADD COLUMN flagged_by INTEGER REFERENCES users (id);
ALTER TABLE results ADD COLUMN flag_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE results ADD COLUMN flag_auto INTEGER NOT NULL DEFAULT 0 CHECK (flag_auto IN (0, 1));

-- The recorded events (a JSON array) live apart from results so the
-- leaderboard queries stay light. Results without a replay have no row.
CREATE TABLE replays (
    user_id INTEGER NOT NULL,
    date    TEXT    NOT NULL,
    level   INTEGER NOT NULL,
    events  TEXT    NOT NULL,
    PRIMARY KEY (user_id, date, level),
    FOREIGN KEY (user_id, date, level) REFERENCES results (user_id, date, level)
) STRICT;
