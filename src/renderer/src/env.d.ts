/// <reference types="vite/client" />

interface JaviProxyConfig {
  upstreamBase: string
  model: string
  fastModel: string
  forceModel: boolean
  forceModelValue: string
  modelMapJson: string
  effectiveModel: string
  hasApiKey: boolean
  maskedApiKey: string
  storePath: string
  logPath: string
  platform: string
  port: number
  host: string
  commands: JaviProxyCommands
}

interface JaviProxyStatus {
  ok: boolean
  running: boolean
  error: string | null
  host: string
  port: number
  baseUrl: string
  messagesUrl: string
  upstreamBase: string
  effectiveModel: string
  hasApiKey: boolean
  logPath: string
}

interface JaviProxyCommands {
  endpoint: string
  mac: string
  windows: string
}

interface JaviProxyModelsResult {
  ok: boolean
  models: string[]
  raw: unknown
}

interface AppUpdateState {
  stage: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  currentVersion: string
  autoUpdatesEnabled: boolean
  mode: 'manual' | 'unsupported'
  latestVersion: string | null
  downloadedVersion: string | null
  progressPercent: number | null
  lastCheckedAt: string | null
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  downloadUrl: string | null
  error: string | null
}

interface Window {
  javiProxy?: {
    getConfig: () => Promise<JaviProxyConfig>
    setConfig: (config: Partial<JaviProxyConfig> & { apiKey?: string }) => Promise<JaviProxyConfig>
    getStatus: () => Promise<JaviProxyStatus>
    startProxy: () => Promise<JaviProxyStatus>
    stopProxy: () => Promise<JaviProxyStatus>
    listModels: () => Promise<JaviProxyModelsResult>
    testProxy: () => Promise<{ ok: boolean; model: string; message: string; usage: unknown }>
    openPath: (targetPath: string) => Promise<boolean>
    launchClaude: () => Promise<{ ok: boolean; command: string; message?: string }>
    getCommands: () => Promise<JaviProxyCommands>
    getVSCodeSettingsPayload: () => Promise<Record<string, unknown>>
    applyVSCodeWorkspaceSettings: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
    openVSCodeClaudePanel: (insiders?: boolean) => Promise<{ ok: boolean; url: string }>
    newWindow: () => Promise<boolean>
    getUpdateState: () => Promise<AppUpdateState>
    checkForUpdates: () => Promise<AppUpdateState>
    downloadUpdate: () => Promise<AppUpdateState>
    onAppUpdateState: (cb: (state: AppUpdateState) => void) => (() => void) | undefined
  }
  appUpdate?: {
    getState: () => Promise<AppUpdateState>
    check: () => Promise<AppUpdateState>
    download: () => Promise<AppUpdateState>
    onState: (cb: (state: AppUpdateState) => void) => (() => void) | undefined
  }
}
