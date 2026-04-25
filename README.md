# JaviProxy

JaviProxy es una app de escritorio para usar OpenCode Go como router local para Claude Code.

Stack igual al de JaviSVN:

- Electron
- electron-vite
- React
- TypeScript
- IPC via preload
- Build macOS DMG y Windows NSIS con electron-builder

## Ejecutar la app

```bash
npm install
npm run app
```

La app controla el proxy desde la UI. El endpoint local que expone es:

```text
http://127.0.0.1:8787/v1/messages
```

La ventana real de Electron es la que permite guardar la API key, encender o apagar el proxy, abrir Claude Code y aplicar settings de VS Code. La vista de desarrollo en `http://localhost:5173` tambien puede leer el estado, listar modelos y probar el proxy local, pero no puede modificar configuracion porque no tiene acceso al preload de Electron.

En JaviProxy:

1. Guarda tu API key de OpenCode Go.
2. Deja el modelo en `kimi-k2.6`.
3. Usa el boton `Encender proxy`.
4. Prueba la conexion.
5. Abre Claude Code o configura VS Code desde la misma UI.

JaviProxy usa el endpoint de OpenCode Go:

```text
https://opencode.ai/zen/go/v1
```

No uses `https://opencode.ai/zen/v1` para Go; ese endpoint pertenece a Zen pay-as-you-go y puede responder `Insufficient balance` aunque tu suscripcion Go este activa.

## VS Code

La extension de Claude Code en VS Code puede funcionar con JaviProxy si el proceso de Claude recibe estas variables:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
- `ANTHROPIC_AUTH_TOKEN=javiproxy-local`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
- `ENABLE_TOOL_SEARCH=false`

La UI de JaviProxy incluye una seccion `VS Code` que puede aplicar estas variables al `settings.json` del workspace que elijas. Despues de aplicarlo, recarga VS Code y abre Claude Code desde la extension.

`ENABLE_TOOL_SEARCH=false` es intencional: Claude Code carga las tools y MCPs upfront, que es el modo mas compatible para proxies que traducen hacia modelos OpenAI-compatible como Kimi K2.6. Las skills siguen funcionando mediante la tool `Skill`, y los MCPs funcionan como tools normales cuando Claude Code los incluye en el request.

## Compatibilidad

JaviProxy traduce el contrato Anthropic de Claude Code hacia `chat/completions` de OpenCode Go para modelos como `kimi-k2.6`. Incluye compatibilidad para:

- texto normal y streaming SSE
- `tool_use` / `tool_result`
- `tool_choice` convertido a instruccion, porque Kimi puede rechazar ese campo directo
- MCP tools con nombres como `mcp__server__tool`
- skills a traves de la tool `Skill`
- formatos textuales de tools que algunos modelos emiten por error: `<tool_use>`, `<invoke>`, JSON de function calls, etiquetas HTML escapadas y etiquetas incompletas
- `/v1/messages/count_tokens` con conteo aproximado para evitar errores de compatibilidad

## Build

```bash
npm run build    # compila main, preload y renderer
npm run pack     # genera app sin instalador
npm run dist     # genera instaladores
npm run dist:mac # genera DMG en macOS
npm run dist:win # genera instalador Windows en Windows
```

## Seguridad

La API key se guarda en el directorio de datos de Electron:

```text
~/Library/Application Support/JaviProxy/javiproxy-config.json
```

En macOS y Windows se intenta cifrar usando `safeStorage` de Electron.
