#!/usr/bin/env bash
# Forecast cleanup for production, runs inside the `api` Docker container.
# Deletes forecast DB rows, their downloaded source files and their rendered
# frames past the retention window, always keeping the most recently issued
# forecast of each kind.
#
# Ensemble NetCDF files are a few hundred megabytes each, so they are kept for
# 2 hours. Radar files are small and the map shows four hours of past radar,
# so those are kept for 1 day. The job runs hourly.
#
# Schedule with cron: 30 * * * * /path/to/scripts/cleanup_ensemble.sh >> /path/to/log/ensemble_cleanup.log 2>&1
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

# --days is a float. 2/24 is exactly 2 hours.
ENSEMBLE_RETENTION_DAYS="$(python3 -c 'print(2/24)')"

echo "[$(date -Iseconds)] Starting ensemble forecast cleanup"
"${COMPOSE[@]}" exec -T api python manage.py cleanup_ensemble_forecast --days "$ENSEMBLE_RETENTION_DAYS"
echo "[$(date -Iseconds)] Starting radar forecast cleanup"
"${COMPOSE[@]}" exec -T api python manage.py cleanup_radar_forecast --days 1
echo "[$(date -Iseconds)] Forecast cleanup complete"
