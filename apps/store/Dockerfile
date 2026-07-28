FROM oven/bun:1-slim

# github-clone.ts (core/github-clone.ts) shells out to the real `git`
# binary for every org's connect/sync -- oven/bun:1-slim doesn't ship it.
# Confirmed missing via a real `railway ssh -s store -- git --version`
# before adding this, not assumed. ca-certificates is needed alongside it
# -- without it every HTTPS clone fails with "Problem with the SSL CA
# cert", confirmed the same way against a real clone attempt once git
# alone was installed.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN chmod +x docker-entrypoint.sh

RUN useradd --create-home --shell /bin/bash app && chown -R app:app /app
USER app

# GNT_STORE_PORT -- internal API, Railway private-network only. No MCP
# port here in production (see docker-entrypoint.sh).
EXPOSE 8787

ENTRYPOINT ["./docker-entrypoint.sh"]
