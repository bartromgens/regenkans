#!/usr/bin/env bash
# Ensemble forecast ingestion for production, runs inside the `api` Docker container.
# Schedule with cron: 0 */6 * * * /path/to/scripts/ingest_ensemble.sh >> /path/to/log/ensemble_ingest.log 2>&1
# Overlapping cron invocations are skipped via flock.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE=(docker compose -f "$PROJECT_DIR/docker-compose.prod.yml")
LOCK_FILE="$PROJECT_DIR/log/ingest_ensemble.lock"

cd "$PROJECT_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] Ensemble ingest already running, skipping"
  exit 0
fi

echo "[$(date -Iseconds)] Starting ensemble forecast ingest"
"${COMPOSE[@]}" exec -T api python manage.py ingest_ensemble_forecast
echo "[$(date -Iseconds)] Ensemble forecast ingest complete"
