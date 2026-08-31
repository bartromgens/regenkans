#!/usr/bin/env bash
set -euo pipefail

VPS_USER="bart"
VPS_HOST="regenkans.nl"
VPS_PATH="/home/bart/regenkans"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT_DIR="${1:-./backups}"
OUTPUT_FILE="${OUTPUT_DIR}/regenkans_${TIMESTAMP}.dump"

mkdir -p "$OUTPUT_DIR"

ssh "${VPS_USER}@${VPS_HOST}" bash <<EOF | cat > "$OUTPUT_FILE"
  set -euo pipefail
  cd "${VPS_PATH}"
  docker compose -f docker-compose.prod.yml exec -T db \
    pg_dump -U regenkans -d regenkans -Fc
EOF

echo "Backup saved to ${OUTPUT_FILE} ($(du -h "$OUTPUT_FILE" | cut -f1))"
