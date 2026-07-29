# gnt-store

gnt's own rules storage: schema, CRUD, hybrid search, and git-native sync (`src/native/`)
behind the `GntStore` seam (`src/core/store.ts`) — no third-party knowledge-store
dependency. TypeScript/Bun, deliberately excluded from the pnpm workspace: it's
Bun-native at the runtime level (`Bun.serve`, `bun:test`), managed by its own
`bun install`/`bun.lock` and its own CI job, not pnpm/turbo.

Runs one server in local dev:

- `src/http/server.ts` — internal HTTP API, called only by `apps/api`, never public

This package is an internal service, not a customer-facing surface. It used to also
run its own MCP server (`src/mcp/server.ts`, duplicating `search_rules`/`get_rule`
and adding `log_decision`), but that's been removed (founder
decision) — `apps/api`'s own `mcp_server` is the one published MCP endpoint, and
apps/store is just an internal service it talks to over this HTTP API.

## Setup

```bash
bun install
cp .env.example .env
```

## Run

```bash
bun run serve       # internal HTTP API
```

Only the internal HTTP API runs in production (`docker-entrypoint.sh`) — `apps/api`
depends on it for the git-native rules CRUD flow (`routers/rules.py`).

## Production bind shape

Production sets `GNT_STORE_BIND=0.0.0.0`, not `127.0.0.1`. This is required,
not a misconfiguration: a Railway container has to bind `0.0.0.0` to be
reachable by *anything*, including Railway's own private network — binding
literally `127.0.0.1` inside a container makes it unreachable even from
`apps/api`, the one legitimate caller. Don't write a startup check for this
service that treats a non-loopback bind as evidence of public exposure; it
isn't, on Railway. The real signal for "is this service internet-reachable"
is whether it has a public domain or TCP proxy attached
(`RAILWAY_PUBLIC_DOMAIN` / `RAILWAY_TCP_PROXY_DOMAIN`) — see
`resolveNetworkExposure` in `src/http/server.ts`, which gates on exactly
that. This service is never supposed to have either attached; `apps/api`
reaches it over Railway's private network (`<service>.railway.internal`),
same pattern as `STORE_API_URL` in `apps/api/DEPLOY.md`.

## Test

```bash
bun test
```

Most of the suite needs a real local Postgres with the `vector` extension —
`createdb gnt_store_native_test` (NativeStore is Postgres-only, no in-memory
mode). Without one reachable at `postgres://localhost:5432/gnt_store_native_test`,
those tests skip cleanly rather than failing.

## Lint / typecheck

```bash
bun run lint
bun run typecheck
```
