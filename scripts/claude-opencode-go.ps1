param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$port = if ($env:PORT) { $env:PORT } else { "8787" }
$baseUrl = if ($env:OPENCODE_PROXY_BASE_URL) { $env:OPENCODE_PROXY_BASE_URL } else { "http://127.0.0.1:$port" }

$env:ANTHROPIC_BASE_URL = $baseUrl
if (-not $env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = "javiproxy-local" }
if (-not $env:ANTHROPIC_CUSTOM_MODEL_OPTION) { $env:ANTHROPIC_CUSTOM_MODEL_OPTION = "claude-sonnet-4-6" }
if (-not $env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME) { $env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = "JaviProxy" }
if (-not $env:ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION) { $env:ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = "OpenCode Go through JaviProxy" }
if (-not $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) { $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1" }
if (-not $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) { $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1" }

if ($ClaudeArgs.Count -eq 0) {
  & claude --model claude-sonnet-4-6
} else {
  & claude @ClaudeArgs
}
exit $LASTEXITCODE
