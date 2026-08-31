#!/usr/bin/env bash
set -euo pipefail

git fetch origin

LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/master)

if [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
  echo "Error: Local commits not pushed to remote."
  echo "  Local:  $LOCAL_COMMIT"
  echo "  Remote: $REMOTE_COMMIT"
  echo "Please push your changes before deploying."
  exit 1
fi

VPS_USER="bart"
VPS_HOST="regenkans.nl"
VPS_PATH="/home/bart/regenkans"

ssh "${VPS_USER}@${VPS_HOST}" bash <<EOF
  set -euo pipefail
  cd "${VPS_PATH}"
  git pull
  docker compose -f docker-compose.prod.yml build
  docker compose -f docker-compose.prod.yml up -d
  docker compose -f docker-compose.prod.yml exec -T api python manage.py migrate --noinput
  docker compose -f docker-compose.prod.yml exec -T api python manage.py collectstatic --noinput
EOF
