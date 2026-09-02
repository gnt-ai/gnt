#!/usr/bin/env bash
set -euo pipefail

corepack enable
corepack prepare pnpm@11.10.0 --activate

curl --proto '=https' --tlsv1.2 -LsSf https://astral.sh/uv/install.sh | sh
export PATH="${HOME}/.local/bin:${PATH}"

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

pnpm install --frozen-lockfile
(cd apps/store && bun install --frozen-lockfile)

echo "GNT development tools installed. See CONTRIBUTING.md for service-specific commands."
