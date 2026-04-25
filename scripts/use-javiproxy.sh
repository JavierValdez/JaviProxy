#!/usr/bin/env bash
# Source this file to make plain `claude` use JaviProxy in the current shell:
#   source scripts/use-javiproxy.sh

export ANTHROPIC_BASE_URL="${OPENCODE_PROXY_BASE_URL:-http://127.0.0.1:${PORT:-8787}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-javiproxy-local}"
export ANTHROPIC_CUSTOM_MODEL_OPTION="${ANTHROPIC_CUSTOM_MODEL_OPTION:-claude-sonnet-4-6}"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="${ANTHROPIC_CUSTOM_MODEL_OPTION_NAME:-JaviProxy}"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="${ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:-OpenCode Go through JaviProxy}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"

echo "JaviProxy enabled for this shell: $ANTHROPIC_BASE_URL"
echo "Run: claude --model claude-sonnet-4-6"
