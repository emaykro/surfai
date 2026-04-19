#!/usr/bin/env bash
# SURFAI postgres backup — local-only.
#
# Runs pg_dump against DATABASE_URL from /opt/surfai/.env, writes a
# gzipped SQL dump to /opt/surfai/backups/, rotates daily dumps (7) and
# promotes Sunday dumps to weekly (retention 4).
#
# Invoked daily at 03:30 MSK by surfai-backup.timer.
#
# This is a local MVP: protects against SQL/migration mistakes and
# accidental deletions. Does NOT protect against VPS loss — off-site
# backup is a separate follow-up.
#
# Exit codes:
#   0  backup created (or already existed for today)
#   1  misconfiguration (no DATABASE_URL, missing pg_dump, etc)
#   2  pg_dump failed

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/surfai/backups}"
ENV_FILE="${ENV_FILE:-/opt/surfai/.env}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"

if ! command -v pg_dump >/dev/null; then
  echo "backup: pg_dump not found" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "backup: env file not found: $ENV_FILE" >&2
  exit 1
fi

# Load DATABASE_URL (ignore other vars so we don't leak credentials to subshells).
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
if [ -z "$DATABASE_URL" ]; then
  echo "backup: DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

DATE="$(date +%Y-%m-%d)"
FILE="$BACKUP_DIR/daily-$DATE.sql.gz"
TMP="$FILE.tmp"

if [ -f "$FILE" ]; then
  echo "backup: daily backup already exists for $DATE, skipping: $FILE"
else
  # --no-owner / --no-privileges keep the dump portable across restores.
  if ! pg_dump "$DATABASE_URL" --no-owner --no-privileges 2>/tmp/pg_dump.stderr | gzip > "$TMP"; then
    echo "backup: pg_dump failed:" >&2
    cat /tmp/pg_dump.stderr >&2 || true
    rm -f "$TMP"
    exit 2
  fi
  mv "$TMP" "$FILE"
  SIZE="$(du -h "$FILE" | cut -f1)"
  echo "backup: created $FILE ($SIZE)"
fi

# Rotate daily: keep newest $RETENTION_DAILY by mtime, delete the rest.
ls -1t "$BACKUP_DIR"/daily-*.sql.gz 2>/dev/null \
  | tail -n +$((RETENTION_DAILY + 1)) \
  | while read -r old; do
      rm -v "$old"
    done

# Sunday → promote today's daily to weekly.
if [ "$(date +%u)" = "7" ]; then
  WEEKLY="$BACKUP_DIR/weekly-$DATE.sql.gz"
  if [ ! -f "$WEEKLY" ]; then
    cp "$FILE" "$WEEKLY"
    echo "backup: promoted to weekly $WEEKLY"
  fi
  ls -1t "$BACKUP_DIR"/weekly-*.sql.gz 2>/dev/null \
    | tail -n +$((RETENTION_WEEKLY + 1)) \
    | while read -r old; do
        rm -v "$old"
      done
fi

# Report final disk usage for the backup directory.
echo "backup: $BACKUP_DIR total size: $(du -sh "$BACKUP_DIR" | cut -f1)"
