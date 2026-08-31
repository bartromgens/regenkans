#!/usr/bin/env bash
# Radar forecast ingestion for production, runs inside the `api` Docker container.
# Schedule with cron: */5 * * * * /path/to/scripts/ingest_radar.sh >> /path/to/log/radar_ingest.log 2>&1
# Overlapping cron invocations are skipped via flock.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE=(docker compose -f "$PROJECT_DIR/docker-compose.prod.yml")
LOCK_FILE="$PROJECT_DIR/log/ingest_radar.lock"

cd "$PROJECT_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] Radar ingest already running, skipping"
  exit 0
fi

echo "[$(date -Iseconds)] Starting radar forecast ingest"
"${COMPOSE[@]}" exec -T api python manage.py ingest_radar_forecast
echo "[$(date -Iseconds)] Radar forecast ingest complete"
