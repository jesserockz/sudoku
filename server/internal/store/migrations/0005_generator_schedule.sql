-- Which puzzle generator version each ISO week's dailies use. The row with
-- the greatest effective_week <= a week applies to it, as for level_schedule.
-- Seeded with generator 1 (the original), so every existing week keeps its
-- puzzles. Results are keyed by date, so they stay tied to the version of
-- their week whatever the schedule becomes.
CREATE TABLE generator_schedule (
    effective_week TEXT    PRIMARY KEY,
    version        INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

INSERT INTO generator_schedule (effective_week, version) VALUES ('0000-W00', 1);
