#!/bin/sh
# Only the internal HTTP API runs in production -- apps/store's own MCP
# server has been removed (2026-07-16, founder decision): apps/api's
# mcp_server is the one published customer-facing
# MCP endpoint, not a second surface here. apps/api depends on this HTTP
# API for the git-native rules CRUD flow (routers/rules.py), independent
# of MCP.
set -e
exec bun run src/http/server.ts
