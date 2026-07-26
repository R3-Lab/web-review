#!/usr/bin/env bash
set -euo pipefail

# @r3lab/web-review example — end-to-end suite runner (WP11).
#
# Brings up a uniquely-named Postgres container on a NON-DEFAULT host port
# (never 5432, never the demo's own docker-compose port), applies the
# package's own sql/postgres.sql, runs the real-browser Playwright suite
# against a real Next.js build and real Postgres (no mocking anywhere in
# the E2E suite), and tears the container down BY NAME — never a bulk or
# wildcard Docker command — on exit, whether the run passed, failed, or was
# interrupted.
#
# This machine runs many unrelated project containers with live data, so:
#   - the container name is unique to this project (r3wr-e2e-postgres)
#   - the host port is non-default and distinct from the demo's own
#     docker-compose Postgres (55434) so both can run at once
#   - teardown targets that exact name only, never `docker compose down`,
#     never `docker system prune`, never `$(docker ps -q)`

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> examples/next-demo

CONTAINER="r3wr-e2e-postgres"
PG_PORT="55499"
PG_DB="r3wr_e2e"
PG_USER="r3wr"
PG_PASSWORD="r3wr"

export DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
export REVIEW_PASSWORD="${REVIEW_PASSWORD:-e2e-review-password}"
export REVIEW_SECRET="${REVIEW_SECRET:-e2e-review-secret-not-for-production-use-only-for-tests}"

cleanup() {
  echo "==> Tearing down ${CONTAINER} (by name only)"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "==> ${CONTAINER} already exists from a previous run — removing it first"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
fi

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
psql "${DATABASE_URL}" -f ../../packages/web-review/sql/postgres.sql

echo "==> Building @r3lab/web-review (so the workspace exports map resolves fresh dist/)"
pnpm -F @r3lab/web-review build

echo "==> Ensuring Playwright's Chromium is installed"
pnpm exec playwright install chromium

echo "==> Running the Playwright suite"
pnpm exec playwright test "$@"
