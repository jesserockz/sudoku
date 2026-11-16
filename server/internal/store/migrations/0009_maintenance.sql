-- Maintenance mode: an admin switches it on while deploying or testing.
-- Non-admins are then answered 503 maintenance until it is switched off.
-- until is an optional RFC 3339 UTC timestamp for when it might end; it is
-- only a hint shown to players and does not switch anything off.
CREATE TABLE maintenance_settings (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    until   TEXT
) STRICT;

INSERT INTO maintenance_settings (id, enabled, until) VALUES (1, 0, NULL);
