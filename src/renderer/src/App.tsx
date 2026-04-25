import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Code2,
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
import appIcon from './assets/javiproxy.svg'

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

const FALLBACK_CONFIG: JaviProxyConfig = {
  upstreamBase: 'https://opencode.ai/zen/go/v1',
  model: 'kimi-k2.6',
  fastModel: 'minimax-m2.5',
  forceModel: true,
  forceModelValue: 'kimi-k2.6',
  modelMapJson: '',
  effectiveModel: 'kimi-k2.6',
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

const RECOMMENDED_MODELS = [
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
      models: Array.isArray(json.data) ? json.data.map((model: any) => String(model.id)) : RECOMMENDED_MODELS,
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
    return `${cleaned}\n\nJaviProxy debe usar https://opencode.ai/zen/go/v1 para tu suscripcion OpenCode Go. Si sigues viendo este error, revisa que la API key pertenezca al workspace Go correcto.`
  }

  return cleaned
}

export default function App() {
  const [config, setConfig] = useState<JaviProxyConfig>(FALLBACK_CONFIG)
  const [status, setStatus] = useState<JaviProxyStatus | null>(null)
  const [models, setModels] = useState<string[]>(RECOMMENDED_MODELS)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [proxyToggling, setProxyToggling] = useState(false)
  const [vscodeApplying, setVscodeApplying] = useState(false)
  const [vscodeOpening, setVscodeOpening] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])

  const modelOptions = useMemo(() => {
    return Array.from(new Set([...RECOMMENDED_MODELS, ...models])).sort()
  }, [models])

  const toast = (message: string, type: Toast['type'] = 'info') => {
    const id = Date.now()
    setToasts((items) => [...items, { id, message, type }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600)
  }

  const refresh = async () => {
    const api = javiProxyApi()
    const [nextConfig, nextStatus] = await Promise.all([
      api.getConfig(),
      api.getStatus()
    ])
    setConfig(nextConfig)
    setStatus(nextStatus)
  }

  const refreshModels = async () => {
    try {
      const result = await javiProxyApi().listModels()
      if (Array.isArray(result.models) && result.models.length) {
        setModels(result.models)
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
  }, [])

  const saveConfig = async () => {
    setSaving(true)
    try {
      const payload: Partial<JaviProxyConfig> & { apiKey?: string } = {
        upstreamBase: config.upstreamBase,
        model: config.model,
        fastModel: config.fastModel,
        forceModel: config.forceModel,
        forceModelValue: config.forceModelValue || config.model,
        modelMapJson: config.modelMapJson
      }
      if (apiKey.trim()) payload.apiKey = apiKey.trim()
      const nextConfig = await javiProxyApi().setConfig(payload)
      setConfig(nextConfig)
      setApiKey('')
      await refresh()
      toast('Configuracion guardada', 'success')
    } catch (error: any) {
      toast(friendlyError(error) || 'No se pudo guardar', 'error')
    } finally {
      setSaving(false)
    }
  }

  const testProxy = async () => {
    setTesting(true)
    setTestResult('')
    try {
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
  }

  const isReady = Boolean(status?.running && config.hasApiKey && !status?.error)
  const canOpenNativePath = Boolean(window.javiProxy?.openPath)

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-title">JaviProxy</div>
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
              <div className="sidebar-subtitle">OpenCode Go Router</div>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">Estado</div>
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
              <Save size={15} /> Guardar
            </button>
            <button className="sidebar-action" onClick={toggleProxy} disabled={proxyToggling}>
              <Power size={15} /> {status?.running ? 'Apagar proxy' : 'Encender proxy'}
            </button>
            <button className="sidebar-action" onClick={testProxy} disabled={testing || !config.hasApiKey}>
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
              <p>Claude Code conectado a OpenCode Go con {config.effectiveModel}</p>
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
                <span>OpenCode Go API key</span>
                <input
                  type="password"
                  value={apiKey}
                  placeholder={config.hasApiKey ? `Guardada: ${config.maskedApiKey}` : 'oc_...'}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>

              <label className="field">
                <span>OpenCode base URL</span>
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
                <button className="btn" onClick={testProxy} disabled={testing || !config.hasApiKey}>
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
