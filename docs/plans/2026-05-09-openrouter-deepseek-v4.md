# OpenRouter + DeepSeek V4 BYOK — Plan de Implementacion

> **Para Hermes:** Implementar task por task. Usar `patch(mode='replace')` para todas las ediciones.
> **Verificado por:** 2 sesiones kiro-cli Opus 4.6 + subagente de verificacion OpenRouter API.

**Goal:** Agregar OpenRouter como tercer proveedor en JaviProxy, permitiendo usar DeepSeek V4 Flash y V4 Pro via BYOK.

**Arquitectura:** JaviProxy ya tiene abstraccion multi-provider bien diseñada. Agregar OpenRouter es puramente mecanico: expandir el type union, agregar 1 preset, y agregar ramas en 7 funciones de env vars. La traduccion Anthropic↔OpenAI y el streaming no se tocan.

**Tech Stack:** Electron 32, TypeScript 5.5, React 18, node:http

**Datos verificados de OpenRouter API:**
- Base URL: `https://openrouter.ai/api/v1`
- Endpoint: `POST /chat/completions` (OpenAI-compatible, ya soportado)
- Modelos DeepSeek V4: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`
- Auth: `Authorization: Bearer sk-or-v1-...`
- Headers opcionales: `HTTP-Referer`, `X-OpenRouter-Title`
- BYOK: transparente, configurado en dashboard de OpenRouter

---

### Task 1: Agregar tipo y constantes de OpenRouter en proxy.ts

**Objective:** Expandir ProviderId y agregar constantes de base URL y modelos.

**Files:**
- Modify: `src/main/proxy.ts`

**Step 1: Expandir el type union ProviderId (linea 26)**

```typescript
// Antes:
export type ProviderId = 'opencode' | 'nvidia'

// Despues:
export type ProviderId = 'opencode' | 'nvidia' | 'openrouter'
```

**Step 2: Agregar constantes (despues de linea 44, junto a las otras URL constants)**

```typescript
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
```

**Step 3: Agregar array de modelos (despues de NVIDIA_MODEL_IDS, ~linea 83)**

```typescript
export const OPENROUTER_MODEL_IDS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-haiku-4.5',
  'moonshotai/kimi-k2.6',
  'qwen/qwen3-coder-480b-a35b-instruct',
  'meta-llama/llama-4-maverick'
]
```

**Verification:** `npx tsc -p tsconfig.node.json --noEmit`

---

### Task 2: Agregar preset de OpenRouter en PROVIDER_PRESETS

**Objective:** Agregar entrada completa del proveedor con sus defaults.

**Files:**
- Modify: `src/main/proxy.ts`

**Step 1: Agregar entrada en PROVIDER_PRESETS (linea ~109, despues del preset de nvidia)**

```typescript
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyLabel: 'OpenRouter API key',
    apiKeyPlaceholder: 'sk-or-v1-...',
    upstreamBase: OPENROUTER_BASE_URL,
    defaultModel: 'deepseek/deepseek-v4-flash',
    defaultFastModel: 'deepseek/deepseek-v4-flash',
    defaultExtraBodyJson: '',
    docsUrl: 'https://openrouter.ai/docs',
    modelIds: OPENROUTER_MODEL_IDS
  }
```

**Nota:** El usuario usa DeepSeek V4 como principal. defaultModel y defaultFastModel ambos apuntan a v4-flash inicialmente. El usuario los ajustara en la UI.

**Verification:** `npx tsc -p tsconfig.node.json --noEmit`

---

### Task 3: Actualizar normalizeProviderId e inferProviderFromBaseUrl

**Objective:** Agregar ramas de deteccion de OpenRouter.

**Files:**
- Modify: `src/main/proxy.ts`

**Step 1: normalizeProviderId (linea 112)**

```typescript
// Antes:
export function normalizeProviderId(value: unknown): ProviderId {
  return value === 'nvidia' ? 'nvidia' : 'opencode'
}

// Despues:
export function normalizeProviderId(value: unknown): ProviderId {
  if (value === 'nvidia') return 'nvidia'
  if (value === 'openrouter') return 'openrouter'
  return 'opencode'
}
```

**Step 2: inferProviderFromBaseUrl (linea 120)**

```typescript
// Agregar antes del return 'opencode':
  if (lower.includes('openrouter.ai')) return 'openrouter'
```

**Step 3 (opcional): Agregar headers de atribucion en upstreamHeaders (linea 2135)**

```typescript
function upstreamHeaders(config: ProxyConfig, hasBody: boolean): Record<string, string> {
  return {
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(config.provider === 'openrouter' ? {
      'http-referer': 'https://github.com/JavierValdez/JaviProxy',
      'x-openrouter-title': 'JaviProxy'
    } : {})
  }
}
```

**Nota:** El header correcto es `X-OpenRouter-Title` (no `X-Title`). Esto es opcional pero recomendado.

**Verification:** `npx tsc -p tsconfig.node.json --noEmit`

---

### Task 4: Agregar env vars de OpenRouter en index.ts

**Objective:** Agregar ramas 'openrouter' en las 7 funciones provider*Env.

**Files:**
- Modify: `src/main/index.ts`

**Patron para cada funcion — agregar despues del bloque 'nvidia':**

```typescript
// providerApiKeyEnv (linea 121): agregar antes del return final
  if (provider === 'openrouter') {
    return normalizeApiKeyInput(process.env.OPENROUTER_API_KEY || '')
  }

// providerBaseUrlEnv (linea 129): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_BASE_URL || ''

// providerModelEnv (linea 135): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL || ''

// providerFastModelEnv (linea 141): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_FAST_MODEL || ''

// providerForceModelEnv (linea 147): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_FORCE_MODEL || ''

// providerModelMapEnv (linea 153): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL_MAP_JSON

// providerExtraBodyEnv (linea 159): agregar
  if (provider === 'openrouter') return process.env.OPENROUTER_EXTRA_BODY_JSON
```

**Verification:** `npx tsc -p tsconfig.node.json --noEmit`

---

### Task 5: Agregar preset de OpenRouter en App.tsx (UI)

**Objective:** Duplicar el preset en el renderer para que aparezca en el selector de proveedor.

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Step 1: Expandir ProviderId local (linea 22)**

```typescript
// Antes:
type ProviderId = 'opencode' | 'nvidia'

// Despues:
type ProviderId = 'opencode' | 'nvidia' | 'openrouter'
```

**Step 2: Agregar entrada en PROVIDER_PRESETS (linea ~101, despues de nvidia)**

```typescript
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyLabel: 'OpenRouter API key',
    apiKeyPlaceholder: 'sk-or-v1-...',
    upstreamBase: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    defaultFastModel: 'deepseek/deepseek-v4-flash',
    defaultExtraBodyJson: '',
    docsUrl: 'https://openrouter.ai/docs',
    modelIds: [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4',
      'anthropic/claude-haiku-4.5',
      'moonshotai/kimi-k2.6',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'meta-llama/llama-4-maverick'
    ]
  }
```

**Verification:** `npm run build` (o `npx electron-vite build`)

---

### Task 6: Build y prueba funcional

**Objective:** Compilar, iniciar proxy, y verificar que OpenRouter funciona con DeepSeek V4.

**Step 1: Build**
```bash
cd ~/Documents/GitHub/JaviProxy
npm run build
```

**Step 2: Iniciar en dev mode**
```bash
npm run dev
```

**Step 3: Verificar en la UI**
- El selector de proveedor debe mostrar 3 opciones: OpenCode Go, NVIDIA NIM, OpenRouter
- Seleccionar OpenRouter debe mostrar API key placeholder `sk-or-v1-...`
- La base URL debe ser `https://openrouter.ai/api/v1`
- El modelo default debe ser `deepseek/deepseek-v4-flash`

**Step 4: Probar conexion con curl**
```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer javiproxy-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Responde solo: JaviProxy OK"}]
  }' | jq .
```

---

### Que NO necesita cambios (confirmado por analisis)

| Componente | Razon |
|------------|-------|
| `toOpenAIChatCompletion()` | Agnóstico al proveedor |
| `toAnthropicMessage()` | Agnóstico al proveedor |
| `sendAnthropicStream()` | Agnóstico al proveedor |
| `shouldUseSyntheticStream()` | Ya cubre deepseek via `.includes('deepseek')` |
| `parseTextAndToolUses()` | Agnóstico al proveedor |
| `upstreamChatCompletionsUrl()` | Agrega /chat/completions automáticamente |
| `upstreamModelsUrl()` | Agrega /models automáticamente |
| `fetchModels()` | Intenta /models estándar, fallback a hardcoded |
| `effectiveModel()` / `resolveModel()` | Sin lógica provider-específica |
| `modelMap()` | Traduce Codex names → config.model, funciona igual |
| `StoredConfig` / `StoredProviderConfig` | `Partial<Record<ProviderId, ...>>` ya acepta 'openrouter' |
| `getConfig()` / `saveConfig()` | Genéricos, sin lógica provider-específica |
| IPC handlers | Todos genéricos |
| `changeProvider()` en UI | Itera PROVIDER_PRESETS, OpenRouter aparece automáticamente |
| Formulario UI | Usa `config.apiKeyLabel`, `config.upstreamBase`, etc. — genérico |
| `extraBodyJson` | Ya permite parámetros arbitrarios por proveedor |

---

### Riesgos identificados

1. **Rate limits / HTTP 402**: OpenRouter devuelve 402 cuando se agota crédito. El proxy no tiene manejo especial, propagará el error al cliente. No es blocker.
2. **Modelos con prefijo org**: OpenRouter usa `org/model`. La detección de streaming sintético usa `.includes('deepseek')` que funciona con estos IDs.
3. **Streaming en modelos sin soporte**: Algunos modelos OpenRouter no soportan `stream: true`. El proxy ya maneja esto con fallback a synthetic.
4. **Modelos no listados en OpenRouter**: Si `deepseek/deepseek-v4-pro` no está aún en OpenRouter, el usuario puede ingresarlo manualmente en el campo de modelo (el formulario acepta texto libre con datalist de sugerencias).
