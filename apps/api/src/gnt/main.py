import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from gnt.config import get_settings
from gnt.mcp_server.auth import McpAuthMiddleware
from gnt.mcp_server.server import mcp
from gnt.queue import close_pool, init_pool
from gnt.routers import (
    billing,
    brain,
    gaps,
    github,
    github_webhook,
    intercom,
    linear,
    notion,
    org_admin,
    platform_admin,
    roi,
    rules,
    settings,
    skill_packs,
    slack,
    transcribe,
    webhooks,
    zendesk,
)

# dsn=None (the default when SENTRY_DSN isn't set) is a documented no-op —
# safe to call unconditionally in local dev/CI, not just production. Must
# run before FastAPI() is constructed for the automatic FastAPI
# integration to instrument it. Railway sets RAILWAY_ENVIRONMENT_NAME on
# every service automatically; falls back to "development" for anything
# running outside Railway.
sentry_sdk.init(
    dsn=get_settings().sentry_dsn,
    environment=os.environ.get("RAILWAY_ENVIRONMENT_NAME", "development"),
)

mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_pool()
    async with mcp.session_manager.run():
        yield
    await close_pool()


# Same RAILWAY_ENVIRONMENT_NAME read as sentry_sdk.init above — /docs,
# /redoc, and /openapi.json default to on and unauthenticated, which hands
# anyone the full route map (including org-admin/offboarding paths) for
# free. Only production turns them off; local dev, CI, and Railway's own
# preview/staging environments keep them since that's exactly where a human
# actually wants to browse the API.
_docs_enabled = os.environ.get("RAILWAY_ENVIRONMENT_NAME", "development") != "production"

app = FastAPI(
    title="AI GNT API",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[get_settings().web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(brain.router)
app.include_router(skill_packs.router)
app.include_router(settings.router)
app.include_router(rules.router)
app.include_router(transcribe.router)
app.include_router(slack.router)
app.include_router(github.router)
app.include_router(github_webhook.router)
app.include_router(billing.router)
app.include_router(gaps.router)
app.include_router(roi.router)
app.include_router(webhooks.router)
app.include_router(org_admin.router)
app.include_router(platform_admin.router)
app.include_router(zendesk.router)
app.include_router(intercom.router)
app.include_router(notion.router)
app.include_router(linear.router)

# Mounted at settings.mcp_url's path, not a separately hardcoded "/mcp" —
# that's the one published, customer-facing URL (CLI output, docs, README
# all echo the same constant), so the mount can't silently drift from it.
app.mount(urlsplit(get_settings().mcp_url).path, McpAuthMiddleware(mcp_app))


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
