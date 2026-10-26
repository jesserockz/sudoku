#!/bin/sh
# Online backup of the sudoku SQLite database. Uses SQLite's backup API via
# the sqlite3 CLI, so it is safe while the server is running (WAL mode).
#
# Env: DB (database path), BACKUP_DIR (destination), KEEP_DAYS (retention).
set -eu

DB="${DB:-/var/lib/sudoku/sudoku.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sudoku}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [ ! -f "$DB" ]; then
    echo "no database at $DB; nothing to back up" >&2
    exit 0
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/sudoku-$stamp.db"
tmp="$dest.partial"
trap 'rm -f "$tmp"' EXIT

sqlite3 "$DB" ".timeout 10000" ".backup '$tmp'"
check="$(sqlite3 "$tmp" "PRAGMA integrity_check;")"
if [ "$check" != "ok" ]; then
    echo "integrity check failed on backup: $check" >&2
    exit 1
fi
mv "$tmp" "$dest"
echo "backed up $DB to $dest"

find "$BACKUP_DIR" -maxdepth 1 -name 'sudoku-*.db' -type f -mtime +"$KEEP_DAYS" -print -delete
