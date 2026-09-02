#!/usr/bin/env bash
# Ensemble forecast cleanup for production, runs inside the `api` Docker container.
# Deletes ensemble forecast DB rows and NetCDF files older than 1 day, always
# keeping the most recently issued forecast.
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
  echo "[$(date -Iseconds)] Ensemble cleanup already running, skipping"
  exit 0
fi

echo "[$(date -Iseconds)] Starting ensemble forecast cleanup"
"${COMPOSE[@]}" exec -T api python manage.py cleanup_ensemble_forecast --days 1
echo "[$(date -Iseconds)] Ensemble forecast cleanup complete"
