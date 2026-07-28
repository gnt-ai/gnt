#!/bin/sh
# Same image runs two Railway services: the API (default) and the ARQ
# worker. PROCESS_TYPE picks which one — set to "worker" only on the
# worker service, left unset on the api service.
set -e

if [ "$#" -gt 0 ]; then
  # A command was passed to the container (e.g. `docker compose run --rm
  # api uv run alembic upgrade head`, the self-host quickstart's one-time
  # migration step) -- run exactly that instead of falling through to the
  # api/worker startup below. Without this branch the entrypoint ignored
  # "$@" entirely and always launched uvicorn, so `docker compose run api
  # uv run alembic upgrade head` silently started the API server instead
  # of migrating -- caught self-hosting the compose stack end to end.
  exec "$@"
elif [ "$PROCESS_TYPE" = "worker" ]; then
  exec uv run arq gnt.workers.worker.WorkerSettings
else
  # --forwarded-allow-ips='*' -- uvicorn's --proxy-headers is on by default
  # (since 0.10.2) but only trusts X-Forwarded-Proto/-For from 127.0.0.1 by
  # default. Railway's edge terminates TLS and forwards plain HTTP from a
  # different internal IP, so without this the app always thinks it's
  # serving http, not https -- Starlette's own redirects (e.g. the mount
  # trailing-slash redirect on /mcp) then generate an http:// Location,
  # and any client that correctly refuses to forward an Authorization
  # header across a scheme-downgrading redirect (httpx does) drops the
  # bearer token, turning a working request into a 401. Safe to trust any
  # IP here specifically because Railway's private network is the only
  # thing that can reach this container directly -- there's no path for a
  # public client to spoof these headers by connecting straight to it.
  exec uv run uvicorn gnt.main:app --host 0.0.0.0 --port "${PORT:-8000}" --forwarded-allow-ips='*'
fi
