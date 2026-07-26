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

# Kept in sync with e2e/constants.ts's ENABLED_PORT/DISABLED_PORT — those
# are used by playwright.config.ts (webServer urls, project baseURLs) and
# by the port-cleanup below, which has no access to a .ts import.
ENABLED_PORT="32111"
DISABLED_PORT="32112"

export DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
export REVIEW_PASSWORD="${REVIEW_PASSWORD:-e2e-review-password}"
export REVIEW_SECRET="${REVIEW_SECRET:-e2e-review-secret-not-for-production-use-only-for-tests}"

# Kills whatever is listening on `$1` (TCP), if anything. Used both as a
# pre-flight (a prior interrupted run can leave a `next start` bound to
# these ports — Playwright normally kills its own webServer children, but
# not if THIS script's own process was itself killed abruptly before or
# during the `playwright test` step) and in the exit trap. Scoped by exact
# port via `lsof -ti`, never a name/pattern match against the process
# list — a broad `pkill` pattern is how you kill an unrelated process that
# merely shares a substring in its command line.
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
  echo "==> Stopping any leftover E2E Next.js servers"
  kill_port "${ENABLED_PORT}"
  kill_port "${DISABLED_PORT}"
}
trap cleanup EXIT

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "==> ${CONTAINER} already exists from a previous run — removing it first"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
fi
kill_port "${ENABLED_PORT}"
kill_port "${DISABLED_PORT}"

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

# Both Next.js variants are built HERE, sequentially, before Playwright
# ever starts — not as part of playwright.config.ts's `webServer` commands.
# Playwright starts every `webServer` array entry CONCURRENTLY, and two
# `next build` invocations racing over the same project directory (shared
# Turbopack cache, shared `node_modules/.cache`) is a real, reproducible
# failure mode: one build can lose the race and leave `next start` with
# nothing to serve, or worse, a corrupted mix of both variants' output.
# Building sequentially here, then letting each `webServer` entry do
# nothing but `next start` an already-built, already-separate `distDir`,
# removes the race entirely — starting a pre-built server also only takes
# a fraction of a second, instead of needing a multi-minute webServer
# timeout to cover a full build.
echo "==> Building the ENABLED variant (NEXT_PUBLIC_REVIEW_ENABLED=1)"
NEXT_PUBLIC_REVIEW_ENABLED=1 pnpm run e2e:build:enabled

echo "==> Building the DISABLED variant (NEXT_PUBLIC_REVIEW_ENABLED unset)"
# Explicitly empty, not merely absent: the point is to prove the
# build-time literal folds to `false`, not to rely on an unset var
# possibly leaking in from a parent shell.
NEXT_PUBLIC_REVIEW_ENABLED= pnpm run e2e:build:disabled

echo "==> Ensuring Playwright's Chromium is installed"
pnpm exec playwright install chromium

echo "==> Running the Playwright suite"
pnpm exec playwright test "$@"
