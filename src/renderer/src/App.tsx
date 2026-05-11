import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Code2,
  Cpu,
  KeyRound,
  Play,
  Power,
  RefreshCw,
  Rocket,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Terminal
} from 'lucide-react'
import appIcon from './assets/icon.png'

type ProviderId = 'opencode' | 'nvidia' | 'openrouter'

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

interface ProviderUiPreset {
  id: ProviderId
  label: string
  apiKeyLabel: string
  apiKeyPlaceholder: string
  upstreamBase: string
  defaultModel: string
  defaultFastModel: string
  defaultExtraBodyJson: string
  docsUrl: string
  modelIds: string[]
}

const PROVIDER_PRESETS: Record<ProviderId, ProviderUiPreset> = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode Go',
    apiKeyLabel: 'OpenCode Go API key',
    apiKeyPlaceholder: 'oc_...',
    upstreamBase: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'kimi-k2.6',
    defaultFastModel: 'minimax-m2.5',
    defaultExtraBodyJson: '',
    docsUrl: 'https://opencode.ai/go',
    modelIds: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5',
      'glm-5.1',
      'kimi-k2.5',
      'kimi-k2.6',
      'mimo-v2-omni',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'minimax-m2.5',
      'minimax-m2.7',
      'qwen3.5-plus',
      'qwen3.6-plus'
    ]
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    apiKeyLabel: 'NVIDIA API key',
    apiKeyPlaceholder: 'nvapi-...',
    upstreamBase: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'moonshotai/kimi-k2.6',
    defaultFastModel: 'deepseek-ai/deepseek-v4-flash',
    defaultExtraBodyJson: '{\n  "chat_template_kwargs": {\n    "thinking": true\n  }\n}',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
    modelIds: [
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k2-thinking',
      'moonshotai/kimi-k2-instruct',
      'deepseek-ai/deepseek-v4-flash',
      'deepseek-ai/deepseek-v4-pro',
      'minimaxai/minimax-m2.5',
      'minimaxai/minimax-m2.7',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'qwen/qwen3-next-80b-a3b-thinking',
      'qwen/qwen3-5-122b-a10b',
      'z-ai/glm5.1',
      'z-ai/glm4.7',
      'meta/llama-3.1-8b-instruct',
      'meta/llama-3.3-70b-instruct',
      'mistralai/devstral-2-123b-instruct-2512',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'nvidia/nemotron-3-super-120b-a12b'
    ]
  },
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
}

const DEFAULT_PROVIDER = PROVIDER_PRESETS.opencode

const FALLBACK_CONFIG: JaviProxyConfig = {
  provider: DEFAULT_PROVIDER.id,
  providerLabel: DEFAULT_PROVIDER.label,
  providerDocsUrl: DEFAULT_PROVIDER.docsUrl,
  apiKeyLabel: DEFAULT_PROVIDER.apiKeyLabel,
  apiKeyPlaceholder: DEFAULT_PROVIDER.apiKeyPlaceholder,
  upstreamBase: DEFAULT_PROVIDER.upstreamBase,
  model: DEFAULT_PROVIDER.defaultModel,
  fastModel: DEFAULT_PROVIDER.defaultFastModel,
  forceModel: true,
  forceModelValue: DEFAULT_PROVIDER.defaultModel,
  modelMapJson: '',
  extraBodyJson: DEFAULT_PROVIDER.defaultExtraBodyJson,
  effectiveModel: DEFAULT_PROVIDER.defaultModel,
  hasApiKey: false,
  maskedApiKey: '',
  storePath: '',
  logPath: '',
  platform: 'unknown',
  port: 8787,
  host: '127.0.0.1',
  commands: {
    endpoint: 'http://127.0.0.1:8787/v1/messages',
    mac: '',
    windows: ''
  }
}

const LOCAL_PROXY_BASE_URL = 'http://127.0.0.1:8787'

function commandPayload(): JaviProxyCommands {
  return {
    endpoint: `${LOCAL_PROXY_BASE_URL}/v1/messages`,
    mac: [
      `export ANTHROPIC_BASE_URL='${LOCAL_PROXY_BASE_URL}'`,
      `export ANTHROPIC_AUTH_TOKEN='javiproxy-local'`,
      `export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
      `export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
      `export ENABLE_TOOL_SEARCH=false`,
      `claude --model claude-sonnet-4-6`
    ].join(' && '),
    windows: [
      `$env:ANTHROPIC_BASE_URL='${LOCAL_PROXY_BASE_URL}'`,
      `$env:ANTHROPIC_AUTH_TOKEN='javiproxy-local'`,
      `$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'`,
      `$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1'`,
      `$env:ENABLE_TOOL_SEARCH='false'`,
      `claude --model claude-sonnet-4-6`
    ].join('; ')
  }
}

function browserOnlyError(action: string): Error {
  return new Error(`${action} requiere la ventana de JaviProxy. Esta pestana de localhost solo puede leer y probar el proxy local.`)
}

const browserFallbackApi: Window['javiProxy'] = {
  async getConfig() {
    const status = await this.getStatus()
    return {
      ...FALLBACK_CONFIG,
      upstreamBase: status.upstreamBase,
      effectiveModel: status.effectiveModel,
      hasApiKey: status.hasApiKey,
      maskedApiKey: status.hasApiKey ? 'Guardada en Electron' : '',
      logPath: status.logPath || '',
      port: status.port,
      host: status.host,
      commands: commandPayload()
    }
  },
  async setConfig() {
    throw browserOnlyError('Guardar configuracion')
  },
  async getStatus() {
    try {
      const response = await fetch(`${LOCAL_PROXY_BASE_URL}/health`)
      const json = await response.json()
      return {
        ok: Boolean(json.ok),
        running: Boolean(json.ok),
        error: null,
        host: json.host || '127.0.0.1',
        port: json.port || 8787,
        baseUrl: LOCAL_PROXY_BASE_URL,
        messagesUrl: json.messagesUrl || `${LOCAL_PROXY_BASE_URL}/v1/messages`,
        provider: json.provider || FALLBACK_CONFIG.provider,
        providerLabel: json.providerLabel || FALLBACK_CONFIG.providerLabel,
        upstreamBase: json.upstreamBase || FALLBACK_CONFIG.upstreamBase,
        effectiveModel: json.effectiveModel || FALLBACK_CONFIG.effectiveModel,
        hasApiKey: Boolean(json.hasApiKey),
        logPath: json.logPath || ''
      }
    } catch {
      return {
        ok: false,
        running: false,
        error: 'Proxy local no disponible. Abre JaviProxy y enciende el proxy.',
        host: '127.0.0.1',
        port: 8787,
        baseUrl: LOCAL_PROXY_BASE_URL,
        messagesUrl: `${LOCAL_PROXY_BASE_URL}/v1/messages`,
        provider: FALLBACK_CONFIG.provider,
        providerLabel: FALLBACK_CONFIG.providerLabel,
        upstreamBase: FALLBACK_CONFIG.upstreamBase,
        effectiveModel: FALLBACK_CONFIG.effectiveModel,
        hasApiKey: false,
        logPath: ''
      }
    }
  },
  async startProxy() {
    throw browserOnlyError('Encender proxy')
  },
  async stopProxy() {
    throw browserOnlyError('Apagar proxy')
  },
  async listModels() {
    const response = await fetch(`${LOCAL_PROXY_BASE_URL}/v1/models`)
    const json = await response.json()
    return {
      ok: response.ok,
      models: Array.isArray(json.data) ? json.data.map((model: any) => String(model.id)) : DEFAULT_PROVIDER.modelIds,
      raw: json
    }
  },
  async testProxy() {
    const response = await fetch(`${LOCAL_PROXY_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer javiproxy-local',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Responde solo: JaviProxy OK' }] }]
      })
    })
    const json = await response.json()
    if (!response.ok) throw new Error(json?.error?.message || 'Prueba fallida')
    return {
      ok: true,
      model: json.model || FALLBACK_CONFIG.effectiveModel,
      message: json.content?.find((block: any) => block.type === 'text')?.text || '',
      usage: json.usage || null
    }
  },
  async openPath() {
    throw browserOnlyError('Abrir ruta local')
  },
  async launchClaude() {
    throw browserOnlyError('Abrir Claude Code')
  },
  async getCommands() {
    return commandPayload()
  },
  async getVSCodeSettingsPayload() {
    return {
      'claudeCode.environmentVariables': [
        { name: 'ANTHROPIC_BASE_URL', value: LOCAL_PROXY_BASE_URL },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'javiproxy-local' },
        { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION', value: 'claude-sonnet-4-6' },
        { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', value: 'JaviProxy' },
        { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', value: 'OpenCode Go through JaviProxy' },
        { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
        { name: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', value: '1' },
        { name: 'ENABLE_TOOL_SEARCH', value: 'false' }
      ],
      'claudeCode.disableLoginPrompt': true
    }
  },
  async applyVSCodeWorkspaceSettings() {
    throw browserOnlyError('Aplicar settings a VS Code')
  },
  async openVSCodeClaudePanel() {
    throw browserOnlyError('Abrir VS Code')
  },
  async newWindow() {
    return false
  },
  async getUpdateState() {
    return {
      stage: 'unsupported' as const,
      currentVersion: '0.0.0',
      autoUpdatesEnabled: false,
      mode: 'unsupported' as const,
      latestVersion: null,
      downloadedVersion: null,
      progressPercent: null,
      lastCheckedAt: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      downloadUrl: null,
      error: 'Actualizaciones no disponibles en modo navegador'
    }
  },
  async checkForUpdates() {
    return this.getUpdateState()
  },
  async downloadUpdate() {
    return this.getUpdateState()
  },
  onAppUpdateState() {
    return undefined
  }
}

function javiProxyApi() {
  return window.javiProxy || browserFallbackApi
}

function friendlyError(error: any): string {
  const raw = error?.message || String(error)
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')

  if (/Insufficient balance/i.test(cleaned)) {
    return `${cleaned}\n\nRevisa que la API key pertenezca al proveedor seleccionado y que la base URL corresponda a ese proveedor. Para OpenCode Go usa https://opencode.ai/zen/go/v1.`
  }

  return cleaned
}

function validateExtraBodyJson(value: string): boolean {
  const cleaned = value.trim()
  if (!cleaned) return true
  const parsed = JSON.parse(cleaned)
  return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
}

export default function App() {
  const [config, setConfig] = useState<JaviProxyConfig>(FALLBACK_CONFIG)
  const [status, setStatus] = useState<JaviProxyStatus | null>(null)
  const [models, setModels] = useState<string[]>(DEFAULT_PROVIDER.modelIds)
  const [modelsProvider, setModelsProvider] = useState<ProviderId>(DEFAULT_PROVIDER.id)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [proxyToggling, setProxyToggling] = useState(false)
  const [vscodeApplying, setVscodeApplying] = useState(false)
  const [vscodeOpening, setVscodeOpening] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [configDirty, setConfigDirty] = useState(false)
  const configDirtyRef = useRef(false)

  useEffect(() => {
    configDirtyRef.current = configDirty
  }, [configDirty])

  const modelOptions = useMemo(() => {
    const preset = PROVIDER_PRESETS[config.provider] || DEFAULT_PROVIDER
    const fetchedModels = modelsProvider === config.provider ? models : []
    return Array.from(new Set([...preset.modelIds, ...fetchedModels])).sort()
  }, [config.provider, models, modelsProvider])

  const toast = (message: string, type: Toast['type'] = 'info') => {
    const id = Date.now()
    setToasts((items) => [...items, { id, message, type }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600)
  }

  const refresh = useCallback(async () => {
    const api = javiProxyApi()
    const [nextConfig, nextStatus] = await Promise.all([
      api.getConfig(),
      api.getStatus()
    ])
    if (!configDirtyRef.current) setConfig(nextConfig)
    setStatus(nextStatus)
  }, [])

  const refreshModels = async () => {
    try {
      const result = await javiProxyApi().listModels()
      if (Array.isArray(result.models) && result.models.length) {
        setModels(result.models)
        setModelsProvider(config.provider)
        toast('Modelos actualizados', 'success')
      }
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudieron cargar los modelos', 'error')
    }
  }

  useEffect(() => {
    void refresh()
    void refreshModels()
    const id = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const api = javiProxyApi()
    if (!api.getUpdateState) return
    void api.getUpdateState().then(setAppUpdateState).catch(() => {})
    const unsub = api.onAppUpdateState?.((state) => setAppUpdateState(state))
    return () => { unsub?.() }
  }, [])

  const buildConfigPayload = (): Partial<JaviProxyConfig> & { apiKey?: string } => {
    if (!validateExtraBodyJson(config.extraBodyJson)) {
      throw new Error('Parametros extra debe ser un objeto JSON valido.')
    }

    const payload: Partial<JaviProxyConfig> & { apiKey?: string } = {
      provider: config.provider,
      upstreamBase: config.upstreamBase,
      model: config.model,
      fastModel: config.fastModel,
      forceModel: config.forceModel,
      forceModelValue: config.forceModelValue || config.model,
      modelMapJson: config.modelMapJson,
      extraBodyJson: config.extraBodyJson
    }
    if (apiKey.trim()) payload.apiKey = apiKey.trim()
    return payload
  }

  const persistConfig = async (showToast = true): Promise<JaviProxyConfig> => {
    setSaving(true)
    try {
      const payload = buildConfigPayload()
      const nextConfig = await javiProxyApi().setConfig(payload)
      setConfig(nextConfig)
      setConfigDirty(false)
      setApiKey('')
      await refresh()
      if (showToast) toast('Configuracion guardada', 'success')
      return nextConfig
    } catch (error: any) {
      if (showToast) toast(friendlyError(error) || 'No se pudo guardar', 'error')
      throw error
    } finally {
      setSaving(false)
    }
  }

  const saveConfig = async () => {
    try {
      await persistConfig(true)
    } catch {
      // The save path already reports user-facing errors.
    }
  }

  const testProxy = async () => {
    setTesting(true)
    setTestResult('')
    try {
      if (apiKey.trim() || configDirty) {
        await persistConfig(false)
      }
      const result = await javiProxyApi().testProxy()
      setTestResult(`${result.model}: ${result.message}`)
      toast('Conexion verificada', 'success')
    } catch (error: any) {
      const message = friendlyError(error) || 'Prueba fallida'
      setTestResult(message)
      toast(message.split('\n')[0], 'error')
    } finally {
      setTesting(false)
    }
  }

  const launchClaude = async () => {
    setLaunching(true)
    try {
      const result = await javiProxyApi().launchClaude()
      if (result.ok) toast('Claude Code abierto', 'success')
      else toast(result.message || 'No se pudo abrir Claude Code', 'error')
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudo abrir Claude Code', 'error')
    } finally {
      setLaunching(false)
    }
  }

  const toggleProxy = async () => {
    setProxyToggling(true)
    try {
      const nextStatus = status?.running
        ? await javiProxyApi().stopProxy()
        : await javiProxyApi().startProxy()
      setStatus(nextStatus)
      toast(nextStatus.running ? 'Proxy encendido' : 'Proxy apagado', 'success')
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudo cambiar el estado del proxy', 'error')
    } finally {
      setProxyToggling(false)
    }
  }

  const copyVSCodeSettings = async () => {
    const payload = await javiProxyApi().getVSCodeSettingsPayload()
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    toast('Configuracion de VS Code copiada', 'success')
  }

  const applyVSCodeSettings = async () => {
    setVscodeApplying(true)
    try {
      const result = await javiProxyApi().applyVSCodeWorkspaceSettings()
      if (result.canceled) {
        toast('Configuracion cancelada', 'info')
      } else {
        toast(`Settings aplicado: ${result.path}`, 'success')
      }
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudo configurar VS Code', 'error')
    } finally {
      setVscodeApplying(false)
    }
  }

  const openVSCodeClaude = async (insiders: boolean) => {
    setVscodeOpening(true)
    try {
      await javiProxyApi().openVSCodeClaudePanel(insiders)
      toast(insiders ? 'Abriendo Claude en VS Code Insiders' : 'Abriendo Claude en VS Code', 'success')
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudo abrir VS Code', 'error')
    } finally {
      setVscodeOpening(false)
    }
  }

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    toast(`${label} copiado`, 'success')
  }

  const copyCommand = async () => {
    const command = config.platform === 'win32' ? config.commands.windows : config.commands.mac
    await navigator.clipboard.writeText(command)
    toast('Comando copiado', 'success')
  }

  const openLocalPath = async (targetPath: string, label: string) => {
    try {
      await javiProxyApi().openPath(targetPath)
      toast(`${label} abierto`, 'success')
    } catch (error: any) {
      toast(friendlyError(error) || `No se pudo abrir ${label.toLowerCase()}`, 'error')
    }
  }

  const updateConfig = <K extends keyof JaviProxyConfig>(key: K, value: JaviProxyConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }))
    setConfigDirty(true)
  }

  const changeProvider = async (provider: ProviderId) => {
    try {
      // Switch provider in store and load its saved config
      await javiProxyApi().setConfig({ provider })
      const nextConfig = await javiProxyApi().getConfig()
      setConfig(nextConfig)
      setConfigDirty(false)
      setApiKey('')
      // Refresh model list for new provider
      try {
        const result = await javiProxyApi().listModels()
        if (Array.isArray(result.models) && result.models.length) {
          setModels(result.models)
          setModelsProvider(provider)
        } else {
          setModels(PROVIDER_PRESETS[provider]?.modelIds || [])
          setModelsProvider(provider)
        }
      } catch {
        setModels(PROVIDER_PRESETS[provider]?.modelIds || [])
        setModelsProvider(provider)
      }
    } catch {
      // Fallback: if store switch fails, use preset defaults
      const preset = PROVIDER_PRESETS[provider] || DEFAULT_PROVIDER
      setConfig((current) => ({
        ...current,
        provider: preset.id,
        providerLabel: preset.label,
        providerDocsUrl: preset.docsUrl,
        apiKeyLabel: preset.apiKeyLabel,
        apiKeyPlaceholder: preset.apiKeyPlaceholder,
        upstreamBase: preset.upstreamBase,
        model: preset.defaultModel,
        fastModel: preset.defaultFastModel,
        forceModelValue: preset.defaultModel,
        extraBodyJson: preset.defaultExtraBodyJson,
        effectiveModel: preset.defaultModel,
        hasApiKey: false,
        maskedApiKey: ''
      }))
      setApiKey('')
      setModels(preset.modelIds)
      setModelsProvider(provider)
      setConfigDirty(true)
    }
  }

  const isReady = Boolean(status?.running && config.hasApiKey && !status?.error)
  const canOpenNativePath = Boolean(window.javiProxy?.openPath)
  const canTest = Boolean(config.hasApiKey || apiKey.trim())
  const provider = PROVIDER_PRESETS[config.provider] || DEFAULT_PROVIDER

  return (
    <div className="app">
      {appUpdateState?.stage === 'available' && (
        <div className="update-banner">
          <span>Nueva version {appUpdateState.latestVersion} disponible</span>
          <button className="btn btn-primary" style={{ padding: '2px 12px', fontSize: 12 }} onClick={() => window.appUpdate?.download().then(setAppUpdateState).catch(() => {})}>
            Descargar
          </button>
          <button className="btn btn-default" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setAppUpdateState(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="titlebar">
        <div className="titlebar-title">JaviProxy</div>
        <div className="titlebar-update-area">
          {appUpdateState && appUpdateState.stage !== 'unsupported' && (
            <>
              <span className="titlebar-app-version">v{appUpdateState.currentVersion}</span>
              {appUpdateState.stage === 'available' ? (
                <button
                  className="titlebar-update-chip titlebar-update-chip-new"
                  onClick={() => window.javiProxy?.downloadUpdate().then(setAppUpdateState).catch(() => {})}
                  title={`v${appUpdateState.latestVersion} disponible — clic para descargar`}
                >
                  🆕
                </button>
              ) : appUpdateState.stage === 'checking' ? (
                <span className="spinner" style={{ width: 10, height: 10, flexShrink: 0 }} />
              ) : (
                <button
                  className="titlebar-update-btn"
                  onClick={() => window.javiProxy?.checkForUpdates().then(setAppUpdateState).catch(() => {})}
                  title={appUpdateState.stage === 'error' ? `Error: ${appUpdateState.error}` : 'Buscar actualizaciones'}
                >
                  {appUpdateState.stage === 'error' ? '⚠️ Error' : 'Buscar actualizaciones'}
                </button>
              )}
            </>
          )}
        </div>
        <div className={`titlebar-status ${isReady ? 'status-ok' : 'status-warn'}`}>
          {isReady ? 'Activo' : 'Pendiente'}
        </div>
      </div>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-header">
            <img src={appIcon} alt="JaviProxy" className="sidebar-logo" />
            <div>
              <div className="sidebar-appname">JaviProxy</div>
              <div className="sidebar-subtitle">{config.providerLabel} Router</div>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">Estado</div>
            <div className="sidebar-item active-soft">
              <Cpu size={16} />
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">Proveedor</div>
                <div className="sidebar-item-sub">{config.providerLabel}</div>
              </div>
            </div>
            <div className={`sidebar-item ${status?.ok ? 'active' : ''}`}>
              <Activity size={16} />
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">Proxy local</div>
                <div className="sidebar-item-sub">{status?.running ? '127.0.0.1:8787' : 'Apagado'}</div>
              </div>
            </div>
            <div className={`sidebar-item ${config.hasApiKey ? 'active-soft' : ''}`}>
              <KeyRound size={16} />
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">API key</div>
                <div className="sidebar-item-sub">{config.hasApiKey ? config.maskedApiKey : 'No guardada'}</div>
              </div>
            </div>
            <div className="sidebar-item active-soft">
              <Server size={16} />
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">Modelo</div>
                <div className="sidebar-item-sub">{config.effectiveModel}</div>
              </div>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">Acciones</div>
            <button className="sidebar-action" onClick={saveConfig} disabled={saving}>
              <Save size={15} /> {configDirty ? 'Guardar cambios *' : 'Guardar'}
            </button>
            <button className="sidebar-action" onClick={toggleProxy} disabled={proxyToggling}>
              <Power size={15} /> {status?.running ? 'Apagar proxy' : 'Encender proxy'}
            </button>
            <button className="sidebar-action" onClick={testProxy} disabled={testing || saving || !canTest}>
              <ShieldCheck size={15} /> Probar
            </button>
            <button className="sidebar-action" onClick={launchClaude} disabled={launching || !status?.ok}>
              <Rocket size={15} /> Abrir Claude
            </button>
          </div>
        </aside>

        <main className="main">
          <header className="main-header">
            <div>
              <h1>JaviProxy</h1>
              <p>Claude Code conectado a {config.providerLabel} con {config.effectiveModel}</p>
            </div>
            <div className="header-actions">
              <button className="btn" onClick={refresh}>
                <RefreshCw size={16} /> Actualizar
              </button>
              <button className={`btn ${status?.running ? '' : 'btn-primary'}`} onClick={toggleProxy} disabled={proxyToggling}>
                <Power size={16} /> {status?.running ? 'Apagar proxy' : 'Encender proxy'}
              </button>
              <button className="btn btn-primary" onClick={saveConfig} disabled={saving}>
                <Save size={16} /> Guardar
              </button>
            </div>
          </header>

          {status?.error && (
            <div className="alert error">
              <AlertTriangle size={18} />
              <span>{status.error}</span>
            </div>
          )}

          <section className="grid">
            <div className="panel">
              <div className="panel-title">
                <Settings size={18} />
                <h2>Configuracion</h2>
              </div>

              <label className="field">
                <span>Proveedor</span>
                <select
                  value={config.provider}
                  onChange={(event) => changeProvider(event.target.value as ProviderId)}
                >
                  {Object.values(PROVIDER_PRESETS).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{config.apiKeyLabel || provider.apiKeyLabel}</span>
                <div className="field-with-copy">
                <input
                  type="password"
                  value={apiKey}
                  placeholder={config.hasApiKey ? `Guardada: ${config.maskedApiKey}` : (config.apiKeyPlaceholder || provider.apiKeyPlaceholder)}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setConfigDirty(true)
                  }}
                />
                {config.hasApiKey && (
                  <button
                    className="icon-btn"
                    title="Copiar API key"
                    onClick={async () => {
                      try {
                        const key = await javiProxyApi().getApiKey()
                        await navigator.clipboard.writeText(key)
                        toast('API key copiada', 'success')
                      } catch {
                        toast('No se pudo copiar la API key', 'error')
                      }
                    }}
                  >
                    <Clipboard size={15} />
                  </button>
                )}
                </div>
              </label>

              <label className="field">
                <span>Invoke URL o base OpenAI-compatible</span>
                <input
                  value={config.upstreamBase}
                  onChange={(event) => updateConfig('upstreamBase', event.target.value)}
                />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>Modelo principal</span>
                  <input
                    list="model-options"
                    value={config.model}
                    onChange={(event) => {
                      updateConfig('model', event.target.value)
                      if (config.forceModel) updateConfig('forceModelValue', event.target.value)
                    }}
                  />
                </label>
                <label className="field">
                  <span>Modelo rapido</span>
                  <input
                    list="model-options"
                    value={config.fastModel}
                    onChange={(event) => updateConfig('fastModel', event.target.value)}
                  />
                </label>
              </div>

              <datalist id="model-options">
                {modelOptions.map((model) => <option key={model} value={model} />)}
              </datalist>

              <label className="checkline">
                <input
                  type="checkbox"
                  checked={config.forceModel}
                  onChange={(event) => updateConfig('forceModel', event.target.checked)}
                />
                <span>Forzar Claude Code hacia {config.forceModelValue || config.model}</span>
              </label>

              <label className="field">
                <span>Modelo forzado</span>
                <input
                  list="model-options"
                  value={config.forceModelValue}
                  onChange={(event) => updateConfig('forceModelValue', event.target.value)}
                />
              </label>

              <label className="field">
                <span>Parametros extra del proveedor</span>
                <textarea
                  value={config.extraBodyJson}
                  placeholder='{"chat_template_kwargs":{"thinking":true}}'
                  onChange={(event) => updateConfig('extraBodyJson', event.target.value)}
                />
              </label>
            </div>

            <div className="panel">
              <div className="panel-title">
                <Terminal size={18} />
                <h2>Proxy local</h2>
              </div>

              <div className="metric">
                <span>Endpoint</span>
                <code>{config.commands.endpoint}</code>
                <button className="icon-btn" onClick={() => copy(config.commands.endpoint, 'Endpoint')} title="Copiar endpoint">
                  <Clipboard size={15} />
                </button>
              </div>

              <div className="metric">
                <span>Log</span>
                <code title={config.logPath || 'Se mostrara al iniciar el proxy'}>
                  {config.logPath || 'Se mostrara al iniciar el proxy'}
                </code>
                <button className="icon-btn" onClick={() => config.logPath && copy(config.logPath, 'Ruta de log')} title="Copiar ruta del log" disabled={!config.logPath}>
                  <Clipboard size={15} />
                </button>
              </div>

              <p className="panel-copy">
                El log guarda request Anthropic entrante, payload traducido a OpenAI, respuesta o chunks de upstream y el resultado final traducido por el proxy.
              </p>

              <div className={`status-card ${status?.running ? 'good' : 'warn'}`}>
                <div>{status?.running ? 'Proxy encendido' : 'Proxy apagado'}</div>
                <span>{status?.running ? 'Claude Code puede enrutar por JaviProxy.' : 'Enciende el proxy antes de abrir Claude Code.'}</span>
              </div>

              <div className="button-row">
                <button className={`btn ${status?.running ? '' : 'btn-primary'}`} onClick={toggleProxy} disabled={proxyToggling}>
                  <Power size={16} /> {status?.running ? 'Apagar proxy' : 'Encender proxy'}
                </button>
                <button className="btn btn-primary" onClick={launchClaude} disabled={launching || !status?.ok}>
                  <Play size={16} /> Abrir Claude Code
                </button>
                <button className="btn" onClick={copyCommand} disabled={!config.commands.mac && !config.commands.windows}>
                  <Clipboard size={16} /> Copiar comando
                </button>
                <button className="btn" onClick={() => openLocalPath(config.logPath, 'Log')} disabled={!config.logPath || !canOpenNativePath}>
                  <Terminal size={16} /> Abrir log
                </button>
                <button className="btn" onClick={testProxy} disabled={testing || saving || !canTest}>
                  <ShieldCheck size={16} /> Probar conexion
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                <Code2 size={18} />
                <h2>VS Code</h2>
              </div>
              <p className="panel-copy">
                La extension de VS Code funciona si su proceso de Claude recibe las variables de JaviProxy. Puedes aplicar la configuracion al workspace que elijas y luego recargar VS Code.
              </p>
              <div className="button-row">
                <button className="btn btn-primary" onClick={applyVSCodeSettings} disabled={vscodeApplying}>
                  <Save size={16} /> Aplicar a workspace
                </button>
                <button className="btn" onClick={copyVSCodeSettings}>
                  <Clipboard size={16} /> Copiar settings
                </button>
              </div>
              <div className="button-row vs-row">
                <button className="btn" onClick={() => openVSCodeClaude(false)} disabled={vscodeOpening || !status?.running}>
                  <Code2 size={16} /> Abrir VS Code
                </button>
                <button className="btn" onClick={() => openVSCodeClaude(true)} disabled={vscodeOpening || !status?.running}>
                  <Code2 size={16} /> Abrir Insiders
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                <CheckCircle2 size={18} />
                <h2>Prueba</h2>
              </div>
              <div className={`status-card ${isReady ? 'good' : 'warn'}`}>
                <div>{isReady ? 'Listo para Claude Code' : 'Falta configurar'}</div>
                <span>{config.effectiveModel}</span>
              </div>
              <pre className="result-box">{testResult || 'Sin prueba ejecutada'}</pre>
            </div>

            <div className="panel">
              <div className="panel-title">
                <Server size={18} />
                <h2>Modelos</h2>
              </div>
              <div className="model-toolbar">
                <button className="btn" onClick={refreshModels}>
                  <RefreshCw size={16} /> Recargar
                </button>
                <span>{modelOptions.length} modelos</span>
              </div>
              <div className="model-list">
                {modelOptions.slice(0, 24).map((model) => (
                  <button
                    key={model}
                    className={`model-chip ${model === config.effectiveModel ? 'selected' : ''}`}
                    onClick={() => {
                      updateConfig('model', model)
                      updateConfig('forceModelValue', model)
                    }}
                  >
                    {model}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>

      <div className="toasts">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.type}`}>{item.message}</div>
        ))}
      </div>
    </div>
  )
}
