#!/bin/bash
# Backup of the Bussola database.
#
# Usage:          ./api/backup.sh
# Cron (4am):     0 4 * * * /path/to/bussola/api/backup.sh
#
# Configurable through environment variables:
#   BUSSOLA_BACKUP_DIR   where to write the dumps (default: ~/backup/bussola)
#   BUSSOLA_CONTAINER    name of the pg container (default: bussola-postgres)
#   BUSSOLA_KEEP_DAYS    days of retention        (default: 30)

set -euo pipefail

# Paths derived from the script's own location: no hardcoded absolute path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [ ! -f "$ENV_FILE" ]; then
	echo "Error: .env not found at $ENV_FILE" >&2
	exit 1
fi

# set -a: every assigned variable is exported. It handles values containing
# spaces correctly, unlike export $(grep ... | xargs).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

BACKUP_DIR="${BUSSOLA_BACKUP_DIR:-$HOME/backup/bussola}"
CONTAINER="${BUSSOLA_CONTAINER:-bussola-postgres}"
KEEP_DAYS="${BUSSOLA_KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
FULL_PATH="${BACKUP_DIR}/${PGDATABASE}_$(date +%Y%m%d%H%M%S).sql"

# If pg_dump fails, do not leave a truncated file that looks like a good backup.
if ! docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
		pg_dump -U "$PGUSER" "$PGDATABASE" > "$FULL_PATH"; then
	rm -f "$FULL_PATH"
	echo "Error: pg_dump failed, backup removed." >&2
	exit 1
fi

gzip "$FULL_PATH"
find "$BACKUP_DIR" -name "${PGDATABASE}_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete

echo "Backup created: ${FULL_PATH}.gz"
