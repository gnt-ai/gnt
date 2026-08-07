#!/usr/bin/env bash
# Docker-only evaluation path: build the full stack with isolated demo data,
# migrate it, seed one approved rule, and exercise check_action over real MCP.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "docker not found -- https://docs.docker.com/get-docker/" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Neither 'docker compose' nor 'docker-compose' found." >&2
  exit 1
fi

# docker-compose.yml normally reads the user's apps/*/.env files. Point its
# parameterized paths at checked-in throwaway demo values instead, so an
# existing self-host checkout never lends real secrets to demo containers.
export GNT_COMPOSE_API_ENV_FILE=docker/demo/api.env
export GNT_COMPOSE_STORE_ENV_FILE=docker/demo/store.env
# Keep normal self-host ports unchanged while avoiding the ports most likely
# to be occupied by another local stack. Each can still be overridden.
export GNT_DEMO_API_PORT="${GNT_DEMO_API_PORT:-18000}"
export GNT_COMPOSE_API_PORT="$GNT_DEMO_API_PORT"
export GNT_COMPOSE_POSTGRES_PORT="${GNT_DEMO_POSTGRES_PORT:-15432}"
export GNT_COMPOSE_REDIS_PORT="${GNT_DEMO_REDIS_PORT:-16379}"

demo_compose=(
  "${compose[@]}"
  --project-name gnt-demo
  --file docker-compose.yml
  --file docker-compose.demo.yml
  --profile demo
)

echo "Building the gnt demo stack ..."
"${demo_compose[@]}" build api store

echo "Running database migrations ..."
"${demo_compose[@]}" run --rm api uv run alembic upgrade head

echo "Starting Postgres, Redis, store, API, and worker ..."
"${demo_compose[@]}" up -d postgres redis store api worker

echo -n "Waiting for the API"
healthy=""
for _ in $(seq 1 60); do
  if "${demo_compose[@]}" exec -T api curl -sf http://localhost:8000/healthz >/dev/null 2>&1; then
    healthy=1
    break
  fi
  echo -n "."
  sleep 1
done
echo

if [ -z "$healthy" ]; then
  echo "The demo API did not become healthy; container logs follow." >&2
  "${demo_compose[@]}" logs >&2
  exit 1
fi

"${demo_compose[@]}" run --rm demo-seed

echo
echo "The demo stack is still running. Stop it and delete its isolated data with:"
echo "  ${compose[*]} --project-name gnt-demo --file docker-compose.yml --file docker-compose.demo.yml down -v"
