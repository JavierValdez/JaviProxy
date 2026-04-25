#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENCODE_API_KEY:-}" ]]; then
  echo "Missing OPENCODE_API_KEY. Export your OpenCode Go/Zen API key first." >&2
  exit 1
fi

# Claude Code appends /v1/messages to ANTHROPIC_BASE_URL.
export ANTHROPIC_BASE_URL="${OPENCODE_DIRECT_BASE_URL:-https://opencode.ai/zen}"
export ANTHROPIC_API_KEY="$OPENCODE_API_KEY"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"

exec claude "$@"
