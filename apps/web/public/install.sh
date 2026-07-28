#!/bin/sh
# gnt.ai CLI installer -- curl -fsSL https://gntai.dev/install.sh | sh
#
# @gnt-ai/cli is a standard npm package (https://www.npmjs.com/package/@gnt-ai/cli),
# not a standalone binary -- this script exists for convenience (one line,
# no need to know it's npm-backed), not to hide what it's actually doing.
# It checks for Node, checks the version the CLI actually requires, then
# runs the real `npm install -g @gnt-ai/cli` underneath. If you'd rather
# run that yourself, it's right there.
set -e

REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=13

fail() {
  echo "gnt install failed: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is not installed. Install Node.js >=${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} from https://nodejs.org and re-run this script."
command -v npm >/dev/null 2>&1 || fail "npm is not installed (usually ships with Node). Install Node.js >=${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} from https://nodejs.org and re-run this script."

node_version=$(node -v | sed 's/^v//')
node_major=$(echo "$node_version" | cut -d. -f1)
node_minor=$(echo "$node_version" | cut -d. -f2)

if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ] || { [ "$node_major" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$node_minor" -lt "$REQUIRED_NODE_MINOR" ]; }; then
  fail "node ${node_version} is too old -- the gnt CLI requires >=${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}. Upgrade Node and re-run this script."
fi

echo "Installing @gnt-ai/cli (node ${node_version} detected)..."
npm install -g @gnt-ai/cli

echo "Installed. Run 'gnt login' to get started."
