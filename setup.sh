#!/usr/bin/env bash
# Self-host quickstart. Does what docs/self-hosting/README.md's manual path
# does by hand: copies both .env files, generates every secret gnt can
# generate for itself (Fernet keys, the shared api<->store secrets), asks
# for the three keys nothing can generate for you, then builds, migrates,
# and boots the compose stack.
#
# Safe to re-run: it never overwrites a .env file that already exists, and
# it only fills in a field if it's still holding its .env.example
# placeholder value. The two shared secrets (api<->store) are the one
# exception -- they're always re-synced across both files, since a
# mismatch there fails closed on every request (see env-vars.md).
#
# Everything this script does, you can also do by hand -- see
# docs/self-hosting/README.md if you'd rather drive each step yourself.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "docker not found -- https://docs.docker.com/get-docker/" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Neither 'docker compose' nor 'docker-compose' found." >&2
  exit 1
fi

# Fernet key generation needs python3 + cryptography. apps/api already
# depends on cryptography (pyproject.toml), so a `uv sync`'d apps/api
# checkout covers it even without a global cryptography install.
PY="python3"
if ! $PY -c "import cryptography" >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    PY="uv run --project apps/api python3"
  else
    echo "python3 needs the 'cryptography' package -- pip install cryptography," >&2
    echo "or install uv (https://docs.astral.sh/uv/) and this script will use" >&2
    echo "apps/api's own environment instead." >&2
    exit 1
  fi
fi

[ -f apps/api/.env ]   || cp apps/api/.env.example apps/api/.env
[ -f apps/store/.env ] || cp apps/store/.env.example apps/store/.env

# The three keys nothing above can generate for you. Skipping any of them
# still boots the stack -- gnt just can't actually do anything with the
# skipped piece until you add it (see env-vars.md). Only asked when the
# current value is still the .env.example placeholder, so re-running this
# script never re-prompts for a key you've already set. Skipped entirely
# when stdin isn't a terminal (CI, piped input) rather than hanging.
prompt_if_placeholder() {
  local file=$1 key=$2 placeholder=$3 prompt=$4
  local current value
  current=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-) || true
  if [ "$current" != "$placeholder" ] && [ -n "$current" ]; then
    return 0
  fi
  [ -t 0 ] || return 0
  read -rp "$prompt" value || value=""
  printf '%s' "$value"
}

echo "gnt needs three keys to be useful, not just to boot. Enter to skip any of them --"
echo "add it to the .env file later and restart."
echo
anthropic_key=$(prompt_if_placeholder apps/api/.env ANTHROPIC_API_KEY "sk-ant-..." \
  "Anthropic API key, runs the rule-conflict check (console.anthropic.com/settings/keys): ")
groq_key=$(prompt_if_placeholder apps/api/.env GROQ_API_KEY "gsk_..." \
  "Groq API key, voice-input transcription, free tier (console.groq.com): ")
zeroentropy_key=$(prompt_if_placeholder apps/store/.env ZEROENTROPY_API_KEY "" \
  "ZeroEntropy API key, embeddings/reranking for rule search (zeroentropy.dev): ")

echo
echo "Filling in generated secrets ..."
ANTHROPIC_OVERRIDE="$anthropic_key" GROQ_OVERRIDE="$groq_key" ZEROENTROPY_OVERRIDE="$zeroentropy_key" \
  $PY - <<'PY'
import os
import re
import secrets
from pathlib import Path
from cryptography.fernet import Fernet

api_env = Path("apps/api/.env")
store_env = Path("apps/store/.env")


def read_kv(path: Path) -> dict[str, str]:
    kv = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            kv[m.group(1)] = m.group(2)
    return kv


def reuse_or_generate(current: str | None, placeholder: str) -> str:
    return current if current and current != placeholder else secrets.token_hex(32)


api_kv = read_kv(api_env)
# STORE_INTERNAL_API_SECRET/APPROVAL_SIGNING_SECRET must byte-for-byte match
# GNT_STORE_INTERNAL_API_SECRET/GNT_APPROVAL_SIGNING_SECRET on the store
# side. Reuse whatever's already in apps/api/.env if it's real (so re-runs
# don't rotate a secret a running stack depends on); always re-write both
# files with the same value either way, so the two can never drift apart.
shared = {
    "STORE_INTERNAL_API_SECRET": reuse_or_generate(
        api_kv.get("STORE_INTERNAL_API_SECRET"), "change-me-to-a-random-secret"
    ),
    "APPROVAL_SIGNING_SECRET": reuse_or_generate(
        api_kv.get("APPROVAL_SIGNING_SECRET"), "change-me-to-a-different-random-secret"
    ),
}

overrides = {
    "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_OVERRIDE", ""),
    "GROQ_API_KEY": os.environ.get("GROQ_OVERRIDE", ""),
}
store_overrides = {"ZEROENTROPY_API_KEY": os.environ.get("ZEROENTROPY_OVERRIDE", "")}


def fill(path: Path, shared_keys: dict[str, str], overrides: dict[str, str]) -> None:
    out = []
    for line in path.read_text().splitlines(keepends=True):
        m = re.match(r"^([A-Z_]+)=(.*?)(\r?\n)?$", line)
        if not m:
            out.append(line)
            continue
        key, value, nl = m.group(1), m.group(2), m.group(3) or ""
        if overrides.get(key):
            out.append(f"{key}={overrides[key]}{nl}")
        elif key in shared_keys:
            out.append(f"{key}={shared_keys[key]}{nl}")
        elif value == "change-me-to-a-fernet-key":
            out.append(f"{key}={Fernet.generate_key().decode()}{nl}")
        elif value in ("change-me-to-a-random-secret", "change-me-to-a-different-random-secret"):
            out.append(f"{key}={secrets.token_hex(32)}{nl}")
        else:
            out.append(line)
    path.write_text("".join(out))


fill(api_env, shared, overrides)
fill(
    store_env,
    {
        "GNT_STORE_INTERNAL_API_SECRET": shared["STORE_INTERNAL_API_SECRET"],
        "GNT_APPROVAL_SIGNING_SECRET": shared["APPROVAL_SIGNING_SECRET"],
    },
    store_overrides,
)
PY

echo
echo "Building images (first run takes a few minutes) ..."
$DC build

echo
echo "Running the one-time migration ..."
$DC run --rm api uv run alembic upgrade head

echo
echo "Starting the stack ..."
$DC up -d

echo -n "Waiting for the API"
up=""
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8000/healthz >/dev/null 2>&1; then
    up=1
    break
  fi
  echo -n "."
  sleep 1
done
echo

if [ -z "$up" ]; then
  echo "Still not answering after 30s -- check '$DC logs api'." >&2
  exit 1
fi

echo "gnt is up: http://localhost:8000 (MCP server at /mcp)."

missing=()
if grep -q '^ANTHROPIC_API_KEY=sk-ant-\.\.\.$' apps/api/.env 2>/dev/null; then
  missing+=("ANTHROPIC_API_KEY in apps/api/.env -- console.anthropic.com/settings/keys")
fi
if grep -q '^GROQ_API_KEY=gsk_\.\.\.$' apps/api/.env 2>/dev/null; then
  missing+=("GROQ_API_KEY in apps/api/.env -- console.groq.com, free tier, only needed for voice input")
fi
if grep -q '^ZEROENTROPY_API_KEY=$' apps/store/.env 2>/dev/null; then
  missing+=("ZEROENTROPY_API_KEY in apps/store/.env -- zeroentropy.dev, needed for rule search")
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "Still running on placeholders for:"
  for m in "${missing[@]}"; do echo "  - $m"; done
  echo "Add real values, then: $DC up -d --force-recreate api worker store"
fi

echo
echo "Next: docs/self-hosting/README.md covers first login (gnt login's browser step"
echo "needs apps/web, which this stack doesn't run) and connecting a GitHub repo for"
echo "rules. apps/api/DEPLOY.md covers the production-hardening step before this goes"
echo "anywhere near real data."
