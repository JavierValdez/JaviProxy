# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- `npm run app` or `npm run dev` — Start the Electron app in development mode (via `scripts/run-electron-vite.mjs`)
- `npm start` — Preview the built app
- `npm run build` — Compile main, preload, and renderer processes (uses `electron-vite build`)
- `npm run pack` — Build and generate app bundle without installer
- `npm run dist` — Build and generate installers (DMG for macOS, NSIS for Windows)
- `npm run dist:mac` — Build DMG on macOS
- `npm run dist:win` — Build Windows installer on Windows

## Architecture

JaviProxy is an Electron desktop app that acts as a local proxy/router between Codex and OpenCode Go. It translates Codex's Anthropic Messages API requests into OpenAI-compatible `chat/completions` calls for models like `kimi-k2.6`.

### Three Process Layers

The app follows Electron's standard multi-process architecture:

1. **Main process** (`src/main/index.ts`) — Entry point. Manages windows, application menu, IPC handlers, encrypted config storage (via Electron `safeStorage`), VS Code workspace settings integration, and launching Codex in a terminal.
2. **Preload** (`src/preload/index.ts`) — Bridges main and renderer via `contextBridge`, exposing `window.javiProxy` with typed IPC methods.
3. **Renderer** (`src/renderer/src/`) — React 18 UI. Entry point is `main.tsx`, main component is `App.tsx`.

### Proxy Server

The HTTP proxy lives in `src/main/proxy.ts`. It is an `http.createServer` that:
- Accepts Anthropic Messages API format at `/v1/messages`
- Translates requests to OpenAI Chat Completions format (`toOpenAIChatCompletion`)
- Forwards to the upstream OpenCode Go endpoint (`https://opencode.ai/zen/go/v1` by default)
- Translates responses back to Anthropic format (`toAnthropicMessage`)
- Handles SSE streaming (`sendAnthropicStream`)

Key translation details:
- `tool_use` / `tool_result` blocks are converted to/from OpenAI `tool_calls`
- `tool_choice` is converted to a system prompt instruction (Kimi rejects the direct `tool_choice` field)
- The proxy injects a system prompt (`TOOL_BRIDGE_SYSTEM_PROMPT`) guiding the model to use native OpenAI tool_calls
- `parseTextAndToolUses` handles models that emit tools as XML tags (`<tool_use>`, `<invoke>`), JSON, plain text lines, or HTML-escaped variants

### Dual Proxy Modes

The codebase has two independent proxy implementations:
1. **Electron-integrated** (`src/main/proxy.ts`) — Started by the main process, config managed via IPC and stored encrypted in Electron's user data directory.
2. **Standalone** (`src/opencode-go-proxy.mjs`) — A self-contained Node.js server that can run without Electron. Used by the dev renderer view at `http://localhost:5173` (which can read proxy state but cannot modify config since it lacks the preload bridge).

### TypeScript Configuration

- `tsconfig.json` uses project references
- `tsconfig.node.json` — Main + preload processes (extends `@electron-toolkit/tsconfig/tsconfig.node.json`)
- `tsconfig.web.json` — Renderer process (extends `@electron-toolkit/tsconfig/tsconfig.web.json`), with path alias `@renderer/*` → `src/renderer/src/*`

### Build Configuration

`electron.vite.config.ts` configures three Vite builds (main, preload, renderer). The renderer uses `@vitejs/plugin-react`. A custom `fixCjsShimPlugin` patches the CJS module shim import during bundling.

## Important Notes

- The local proxy endpoint is `http://127.0.0.1:8787/v1/messages`
- The correct upstream base URL is `https://opencode.ai/zen/go/v1`. Do NOT use `https://opencode.ai/zen/v1` — that endpoint belongs to Zen pay-as-you-go and will respond with "Insufficient balance" even if a Go subscription is active.
- Default model is `kimi-k2.6`; default fast model is `minimax-m2.5`
- Codex model names (e.g., `Codex-sonnet-4-6`, `sonnet`, `opus`, `haiku`) are mapped to OpenCode Go models via `modelMap()` in `proxy.ts`
- `forceModel` is enabled by default, so all requests are routed to the configured model regardless of what Codex requests
- The API key is stored encrypted at `~/Library/Application Support/JaviProxy/javiproxy-config.json` (macOS) using `safeStorage`
- `ENABLE_TOOL_SEARCH=false` is intentionally set for VS Code workspace settings — this makes Codex load tools and MCPs upfront, which is the most compatible mode for OpenAI-compatible proxies
