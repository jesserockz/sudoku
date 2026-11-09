-- The admin now enables generators (1 = Classic, 2 = Graded, or both) with
-- immediate effect, instead of scheduling one per ISO week. With both
-- enabled players pick per game, so daily results get a generator of their
-- own and each generator keeps its own results and leaderboards.

-- Which generators players may use: one row, at least one enabled.
CREATE TABLE generator_settings (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    classic INTEGER NOT NULL CHECK (classic IN (0, 1)),
    graded  INTEGER NOT NULL CHECK (graded IN (0, 1)),
    CHECK (classic + graded >= 1)
) STRICT;

-- Seeded with the version the schedule gives the current week. A pending
-- change (a later week) is dropped: it simply never happens.
INSERT INTO generator_settings (id, classic, graded)
    SELECT 1, v <> 2, v = 2 FROM (
        SELECT COALESCE((
            SELECT version FROM generator_schedule
            WHERE effective_week <= strftime('%G-W%V', 'now')
            ORDER BY effective_week DESC LIMIT 1), 1) AS v);

-- generator becomes part of the key, so both tables are rebuilt (SQLite
-- cannot change a primary key in place). Each existing result gets the
-- version its ISO week used under the schedule.
CREATE TABLE results_new (
    user_id       INTEGER NOT NULL REFERENCES users (id),
    generator     INTEGER NOT NULL DEFAULT 1 CHECK (generator IN (1, 2)),
    -- Game date, YYYY-MM-DD in the configured game timezone.
    date          TEXT    NOT NULL,
    level         INTEGER NOT NULL CHECK (level >= 1),
    elapsed_ms    INTEGER NOT NULL CHECK (elapsed_ms > 0),
    -- Client-reported RFC 3339 timestamp, stored verbatim.
    completed_at  TEXT    NOT NULL,
    submitted_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    replay_status TEXT    CHECK (replay_status IN ('valid', 'invalid', 'missing')),
    replay_error  TEXT    NOT NULL DEFAULT '',
    flagged_at    TEXT,
    flagged_by    INTEGER REFERENCES users (id),
    flag_reason   TEXT    NOT NULL DEFAULT '',
    flag_auto     INTEGER NOT NULL DEFAULT 0 CHECK (flag_auto IN (0, 1)),
    PRIMARY KEY (user_id, generator, date, level)
) STRICT;

INSERT INTO results_new (user_id, generator, date, level, elapsed_ms, completed_at, submitted_at,
        replay_status, replay_error, flagged_at, flagged_by, flag_reason, flag_auto)
    SELECT r.user_id,
        CASE (SELECT g.version FROM generator_schedule g
              WHERE g.effective_week <= strftime('%G-W%V', r.date)
              ORDER BY g.effective_week DESC LIMIT 1)
            WHEN 2 THEN 2 ELSE 1 END,
        r.date, r.level, r.elapsed_ms, r.completed_at, r.submitted_at,
        r.replay_status, r.replay_error, r.flagged_at, r.flagged_by, r.flag_reason, r.flag_auto
    FROM results r;

CREATE TABLE replays_new (
    user_id   INTEGER NOT NULL,
    generator INTEGER NOT NULL DEFAULT 1,
    date      TEXT    NOT NULL,
    level     INTEGER NOT NULL,
    events    TEXT    NOT NULL,
    PRIMARY KEY (user_id, generator, date, level),
    FOREIGN KEY (user_id, generator, date, level) REFERENCES results_new (user_id, generator, date, level)
) STRICT;

-- A replay takes the generator its result was given above.
INSERT INTO replays_new (user_id, generator, date, level, events)
    SELECT p.user_id, n.generator, p.date, p.level, p.events
    FROM replays p
    JOIN results_new n ON n.user_id = p.user_id AND n.date = p.date AND n.level = p.level;

DROP TABLE replays;
DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
ALTER TABLE replays_new RENAME TO replays;

CREATE INDEX results_by_date ON results (generator, date, level, elapsed_ms);

DROP TABLE generator_schedule;
