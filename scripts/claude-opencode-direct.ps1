param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

if (-not $env:OPENCODE_API_KEY) {
  Write-Error "Missing OPENCODE_API_KEY. Export your OpenCode Go/Zen API key first."
  exit 1
}

$env:ANTHROPIC_BASE_URL = if ($env:OPENCODE_DIRECT_BASE_URL) { $env:OPENCODE_DIRECT_BASE_URL } else { "https://opencode.ai/zen" }
$env:ANTHROPIC_API_KEY = $env:OPENCODE_API_KEY
if (-not $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) { $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1" }

if ($ClaudeArgs.Count -eq 0) {
  & claude --model claude-sonnet-4-6
} else {
  & claude @ClaudeArgs
}
exit $LASTEXITCODE
