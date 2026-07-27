#!/usr/bin/env bash
set -euo pipefail

# @r3lab/web-review — README screenshot generator (WP23).
#
# Brings up a uniquely-named Postgres container on a NON-DEFAULT host port,
# applies the package's own sql/postgres.sql, builds the demo app with the
# overlay enabled, starts it, then runs scripts/screenshots.mjs (plain
# Playwright, no test runner) to seed realistic review content and capture
# a handful of cropped, retina PNGs into docs/images/.
#
# Modeled directly on examples/next-demo/scripts/e2e.sh — same container-
# naming/port-isolation/teardown-by-name discipline, since this machine runs
# many unrelated project containers with live data:
#   - the container name is unique to this script (r3wr-shots-pg)
#   - the host port (55510) is non-default and distinct from both the demo's
#     own docker-compose Postgres (55434) and the E2E suite's (55499)
#   - the demo server's port (32130) is distinct from the E2E suite's
#     (32111/32112)
#   - teardown targets that exact container name only, never `docker compose
#     down`, never `docker system prune`, never `$(docker ps -q)`
#   - port cleanup is scoped to `lsof -ti:<port>` exact matches, never a
#     broad `pkill` pattern

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> repo root

CONTAINER="r3wr-shots-pg"
PG_PORT="55510"
PG_DB="r3wr_shots"
PG_USER="r3wr"
PG_PASSWORD="r3wr"
APP_PORT="32130"
DIST_DIR=".next-shots"

export DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
export REVIEW_PASSWORD="${REVIEW_PASSWORD:-shots-review-password}"
export REVIEW_SECRET="${REVIEW_SECRET:-shots-review-secret-not-for-production-use-only-for-shots}"
export SHOTS_BASE_URL="http://localhost:${APP_PORT}"

# Exact-port-scoped kill — see examples/next-demo/scripts/e2e.sh's own
# `kill_port` doc comment for why this is never a name/pattern `pkill`.
kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${pids}" ]; then
    echo "==> Killing process(es) on port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
}

cleanup() {
  echo "==> Tearing down ${CONTAINER} (by name only)"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  echo "==> Stopping any leftover screenshot Next.js server"
  kill_port "${APP_PORT}"
}
trap cleanup EXIT

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "==> ${CONTAINER} already exists from a previous run — removing it first"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
fi
kill_port "${APP_PORT}"

echo "==> Starting ${CONTAINER} on host port ${PG_PORT}"
docker run -d \
  --name "${CONTAINER}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  -e "POSTGRES_DB=${PG_DB}" \
  -p "${PG_PORT}:5432" \
  postgres:17-alpine >/dev/null

echo "==> Waiting for Postgres to accept connections"
ready=""
for _ in $(seq 1 30); do
  if docker exec "${CONTAINER}" pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
    ready="1"
    break
  fi
  sleep 1
done
if [ -z "${ready}" ]; then
  echo "Postgres did not become ready in time" >&2
  exit 1
fi

echo "==> Applying packages/web-review/sql/postgres.sql"
psql "${DATABASE_URL}" -f packages/web-review/sql/postgres.sql

echo "==> Building @r3lab/web-review (so the workspace exports map resolves fresh dist/)"
pnpm -F @r3lab/web-review build

echo "==> Building the demo app with the overlay enabled (dist dir: ${DIST_DIR})"
(cd examples/next-demo && NEXT_PUBLIC_REVIEW_ENABLED=1 NEXT_DIST_DIR="${DIST_DIR}" pnpm exec next build)

echo "==> Starting the demo app on port ${APP_PORT}"
(cd examples/next-demo && NEXT_DIST_DIR="${DIST_DIR}" pnpm exec next start -p "${APP_PORT}" >/tmp/r3wr-shots-next.log 2>&1 &)

echo "==> Waiting for the demo app to respond"
ready=""
for _ in $(seq 1 30); do
  if curl -sf "${SHOTS_BASE_URL}" >/dev/null 2>&1; then
    ready="1"
    break
  fi
  sleep 1
done
if [ -z "${ready}" ]; then
  echo "Demo app did not become ready in time — see /tmp/r3wr-shots-next.log" >&2
  cat /tmp/r3wr-shots-next.log >&2 || true
  exit 1
fi

echo "==> Ensuring Playwright's Chromium is installed"
pnpm exec playwright install chromium

echo "==> Generating screenshots"
node scripts/screenshots.mjs

echo "==> Done — see docs/images/"
