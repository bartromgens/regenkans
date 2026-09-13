#!/usr/bin/env bash
# Forecast cleanup for production, runs inside the `api` Docker container.
# Deletes radar and ensemble forecast DB rows, their downloaded source files
# and their rendered frames older than 1 day, always keeping the most recently
# issued forecast of each kind.
#
# Ingestion renders every frame the slider can show, so the frames are the bulk
# of what this reclaims -- around a gigabyte a day.
#
# Schedule with cron: 0 3 * * * /path/to/scripts/cleanup_ensemble.sh >> /path/to/log/ensemble_cleanup.log 2>&1
# Overlapping cron invocations are skipped via flock.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE=(docker compose -f "$PROJECT_DIR/docker-compose.prod.yml")
LOCK_FILE="$PROJECT_DIR/log/cleanup_ensemble.lock"

cd "$PROJECT_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] Forecast cleanup already running, skipping"
  exit 0
fi

echo "[$(date -Iseconds)] Starting ensemble forecast cleanup"
"${COMPOSE[@]}" exec -T api python manage.py cleanup_ensemble_forecast --days 1
echo "[$(date -Iseconds)] Starting radar forecast cleanup"
"${COMPOSE[@]}" exec -T api python manage.py cleanup_radar_forecast --days 1
echo "[$(date -Iseconds)] Forecast cleanup complete"
