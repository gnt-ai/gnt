FROM python:3.12-slim

# build-essential: some transitive deps fall back to source builds on
# platforms without a matching prebuilt wheel — cheaper to always have a
# compiler than to debug a failed build on a fresh arch/platform
# combination later.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app

# Repo-root-relative, not bare filenames -- Railway's Dockerfile Path
# setting (Build settings, "apps/api/Dockerfile") only picks which file to
# use as the Dockerfile; it doesn't scope the build context down to
# apps/api the way it does when the whole service is rooted there.
# Confirmed live: a bare `COPY pyproject.toml uv.lock ./` 404'd with
# "/pyproject.toml: not found" because the context BuildKit actually
# receives is the full monorepo root, which has no top-level pyproject.toml
# of its own (only apps/api/pyproject.toml does).
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-install-project

COPY apps/api .
RUN uv sync --frozen

# Belt-and-suspenders on the exec bit — git's own +x tracking on this file
# shouldn't be the only thing standing between a deploy and "permission
# denied" at container start.
RUN chmod +x docker-entrypoint.sh

# Drop root before the process actually runs — everything above needed
# root for apt-get/uv installs, nothing at runtime does.
RUN useradd --create-home --shell /bin/bash app && chown -R app:app /app
USER app

EXPOSE 8000

# PROCESS_TYPE picks api (default) vs the ARQ worker — see
# docker-entrypoint.sh. Same image, two Railway services.
ENTRYPOINT ["./docker-entrypoint.sh"]
