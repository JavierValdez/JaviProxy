import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
app.name = 'JaviProxy'

import type { IpcMainInvokeEvent, MenuItemConstructorOptions, OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  effectiveModel,
  fetchModels,
  inferProviderFromBaseUrl,
  normalizeProviderId,
  normalizeUpstreamBase,
  providerPreset,
  startProxyServer,
  testUpstream
} from './proxy'
import type { ProviderId, ProxyConfig, ProxyServerHandle } from './proxy'
import { setupAppUpdater } from './updater'

const isDev = process.env.NODE_ENV === 'development'
const DEFAULT_PORT = Number(process.env.PORT || 8787)
const DEFAULT_HOST = process.env.HOST || '127.0.0.1'

interface StoredProviderConfig {
  upstreamBase?: string
  apiKeyEncrypted?: string
  apiKeyPlain?: string
  model?: string
  fastModel?: string
  forceModel?: boolean
  forceModelValue?: string
  modelMapJson?: string
  extraBodyJson?: string
}

interface StoredConfig extends StoredProviderConfig {
  provider?: ProviderId
  providerSettings?: Partial<Record<ProviderId, StoredProviderConfig>>
}

let proxyHandle: ProxyServerHandle | null = null
let proxyError: string | null = null

function getStorePath(): string {
  return join(app.getPath('userData'), 'javiproxy-config.json')
}

function getProxyLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'proxy-debug.jsonl')
}

function readStore(): StoredConfig {
  try {
    return JSON.parse(readFileSync(getStorePath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeStore(data: StoredConfig): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getStorePath(), JSON.stringify(data, null, 2), 'utf-8')
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return value
  }
}

function selectedProvider(store = readStore()): ProviderId {
  const envProvider = process.env.JAVIPROXY_PROVIDER
  if (envProvider) return normalizeProviderId(envProvider)
  if (store.provider) return normalizeProviderId(store.provider)
  return inferProviderFromBaseUrl(process.env.JAVIPROXY_BASE_URL || process.env.OPENCODE_BASE_URL || store.upstreamBase)
}

function legacyProvider(store: StoredConfig): ProviderId {
  return inferProviderFromBaseUrl(store.upstreamBase)
}

function getStoredProviderSettings(store: StoredConfig, provider: ProviderId): StoredProviderConfig {
  const explicit = store.providerSettings?.[provider] || {}
  const legacyBelongsToProvider = provider === (store.provider ? normalizeProviderId(store.provider) : legacyProvider(store))
  if (!legacyBelongsToProvider) return explicit

  return {
    upstreamBase: store.upstreamBase,
    apiKeyEncrypted: store.apiKeyEncrypted,
    apiKeyPlain: store.apiKeyPlain,
    model: store.model,
    fastModel: store.fastModel,
    forceModel: store.forceModel,
    forceModelValue: store.forceModelValue,
    modelMapJson: store.modelMapJson,
    extraBodyJson: store.extraBodyJson,
    ...explicit
  }
}

function updateStoredProviderSettings(store: StoredConfig, provider: ProviderId, settings: StoredProviderConfig): StoredConfig {
  return {
    ...store,
    providerSettings: {
      ...(store.providerSettings || {}),
      [provider]: settings
    }
  }
}

function providerApiKeyEnv(provider: ProviderId): string {
  if (process.env.JAVIPROXY_API_KEY) return normalizeApiKeyInput(process.env.JAVIPROXY_API_KEY)
  if (provider === 'nvidia') {
    return normalizeApiKeyInput(process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || process.env.NVAPI_KEY || '')
  }
  if (provider === 'openrouter') {
    return normalizeApiKeyInput(process.env.OPENROUTER_API_KEY || '')
  }
  return normalizeApiKeyInput(process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY || '')
}

function providerBaseUrlEnv(provider: ProviderId): string {
  if (process.env.JAVIPROXY_BASE_URL) return process.env.JAVIPROXY_BASE_URL
  if (provider === 'nvidia') return process.env.NVIDIA_BASE_URL || process.env.NVIDIA_NIM_BASE_URL || ''
  if (provider === 'openrouter') return process.env.OPENROUTER_BASE_URL || ''
  return process.env.OPENCODE_BASE_URL || ''
}

function providerModelEnv(provider: ProviderId): string {
  if (process.env.JAVIPROXY_MODEL) return process.env.JAVIPROXY_MODEL
  if (provider === 'nvidia') return process.env.NVIDIA_MODEL || process.env.NVIDIA_NIM_MODEL || ''
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL || ''
  return process.env.OPENCODE_GO_MODEL || ''
}

function providerFastModelEnv(provider: ProviderId): string {
  if (process.env.JAVIPROXY_FAST_MODEL) return process.env.JAVIPROXY_FAST_MODEL
  if (provider === 'nvidia') return process.env.NVIDIA_FAST_MODEL || process.env.NVIDIA_NIM_FAST_MODEL || ''
  if (provider === 'openrouter') return process.env.OPENROUTER_FAST_MODEL || ''
  return process.env.OPENCODE_GO_FAST_MODEL || ''
}

function providerForceModelEnv(provider: ProviderId): string {
  if (process.env.JAVIPROXY_FORCE_MODEL) return process.env.JAVIPROXY_FORCE_MODEL
  if (provider === 'nvidia') return process.env.NVIDIA_FORCE_MODEL || process.env.NVIDIA_NIM_FORCE_MODEL || ''
  if (provider === 'openrouter') return process.env.OPENROUTER_FORCE_MODEL || ''
  return process.env.OPENCODE_FORCE_MODEL || ''
}

function providerModelMapEnv(provider: ProviderId): string | undefined {
  if (process.env.JAVIPROXY_MODEL_MAP_JSON !== undefined) return process.env.JAVIPROXY_MODEL_MAP_JSON
  if (provider === 'nvidia') return process.env.NVIDIA_MODEL_MAP_JSON
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL_MAP_JSON
  return process.env.OPENCODE_MODEL_MAP_JSON
}

function providerExtraBodyEnv(provider: ProviderId): string | undefined {
  if (process.env.JAVIPROXY_EXTRA_BODY_JSON !== undefined) return process.env.JAVIPROXY_EXTRA_BODY_JSON
  if (provider === 'nvidia') return process.env.NVIDIA_EXTRA_BODY_JSON || process.env.NVIDIA_NIM_EXTRA_BODY_JSON
  if (provider === 'openrouter') return process.env.OPENROUTER_EXTRA_BODY_JSON
  return process.env.OPENCODE_EXTRA_BODY_JSON
}

function getStoredApiKey(store: StoredConfig, provider: ProviderId): string {
  const envKey = providerApiKeyEnv(provider)
  if (envKey) return envKey

  const settings = getStoredProviderSettings(store, provider)
  if (settings.apiKeyEncrypted) return normalizeApiKeyInput(decryptSecret(settings.apiKeyEncrypted))
  if (settings.apiKeyPlain) {
    const apiKey = normalizeApiKeyInput(settings.apiKeyPlain)
    const nextSettings = {
      ...settings,
      apiKeyPlain: undefined,
      apiKeyEncrypted: encryptSecret(apiKey)
    }
    writeStore({
      ...updateStoredProviderSettings(store, provider, nextSettings),
      apiKeyPlain: undefined
    })
    return apiKey
  }
  return ''
}

function normalizeApiKeyInput(value: string): string {
  let cleaned = String(value || '').trim()
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim()

  const authorizationMatch = cleaned.match(/^authorization\s*:\s*bearer\s+(.+)$/i)
  if (authorizationMatch) cleaned = authorizationMatch[1].trim()

  const bearerMatch = cleaned.match(/^bearer\s+(.+)$/i)
  if (bearerMatch) cleaned = bearerMatch[1].trim()

  return cleaned.replace(/^["']|["']$/g, '').trim()
}

function getConfig(): ProxyConfig {
  const store = readStore()
  const provider = selectedProvider(store)
  const preset = providerPreset(provider)
  const settings = getStoredProviderSettings(store, provider)
  const model = providerModelEnv(provider) || settings.model || preset.defaultModel
  const forceModelValue = providerForceModelEnv(provider) || settings.forceModelValue || model
  const modelMapJson = providerModelMapEnv(provider) ?? settings.modelMapJson ?? ''
  const extraBodyJson = providerExtraBodyEnv(provider) ?? settings.extraBodyJson ?? preset.defaultExtraBodyJson
  return {
    provider,
    upstreamBase: normalizeUpstreamBase(provider, providerBaseUrlEnv(provider) || settings.upstreamBase || preset.upstreamBase),
    apiKey: getStoredApiKey(store, provider),
    model,
    fastModel: providerFastModelEnv(provider) || settings.fastModel || preset.defaultFastModel,
    forceModel: typeof settings.forceModel === 'boolean' ? settings.forceModel : true,
    forceModelValue,
    modelMapJson,
    extraBodyJson
  }
}

function saveConfig(input: Partial<ProxyConfig> & { apiKey?: string }): ProxyConfig {
  const current = readStore()
  const provider = normalizeProviderId(input.provider || selectedProvider(current))
  const preset = providerPreset(provider)
  const settings = getStoredProviderSettings(current, provider)
  const extraBodyJson = typeof input.extraBodyJson === 'string' ? input.extraBodyJson : settings.extraBodyJson ?? preset.defaultExtraBodyJson
  validateExtraBodyJson(extraBodyJson)
  const nextSettings: StoredProviderConfig = {
    ...settings,
    upstreamBase: normalizeUpstreamBase(provider, input.upstreamBase || settings.upstreamBase || preset.upstreamBase),
    model: input.model || settings.model || preset.defaultModel,
    fastModel: input.fastModel || settings.fastModel || preset.defaultFastModel,
    forceModel: typeof input.forceModel === 'boolean' ? input.forceModel : settings.forceModel ?? true,
    forceModelValue: input.forceModelValue || input.model || settings.forceModelValue || settings.model || preset.defaultModel,
    modelMapJson: typeof input.modelMapJson === 'string' ? input.modelMapJson : settings.modelMapJson || '',
    extraBodyJson
  }

  const normalizedApiKey = typeof input.apiKey === 'string' ? normalizeApiKeyInput(input.apiKey) : ''
  if (normalizedApiKey) {
    nextSettings.apiKeyEncrypted = encryptSecret(normalizedApiKey)
    nextSettings.apiKeyPlain = undefined
  }

  let updatedStore = updateStoredProviderSettings(current, provider, nextSettings)
  const legacy = legacyProvider(current)
  if (legacy !== provider && !updatedStore.providerSettings?.[legacy]) {
    updatedStore = updateStoredProviderSettings(updatedStore, legacy, getStoredProviderSettings(current, legacy))
  }

  const next: StoredConfig = {
    ...updatedStore,
    provider,
    upstreamBase: nextSettings.upstreamBase,
    model: nextSettings.model,
    fastModel: nextSettings.fastModel,
    forceModel: nextSettings.forceModel,
    forceModelValue: nextSettings.forceModelValue,
    modelMapJson: nextSettings.modelMapJson,
    extraBodyJson: nextSettings.extraBodyJson
  }

  writeStore(next)
  return getConfig()
}

function validateExtraBodyJson(value: string): void {
  const cleaned = value.trim()
  if (!cleaned) return
  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parametros extra debe ser un objeto JSON valido.')
    }
  } catch (error: any) {
    throw new Error(error?.message === 'Parametros extra debe ser un objeto JSON valido.'
      ? error.message
      : 'Parametros extra debe ser un objeto JSON valido.')
  }
}

function publicConfig() {
  const config = getConfig()
  const preset = providerPreset(config.provider)
  return {
    provider: config.provider,
    providerLabel: preset.label,
    providerDocsUrl: preset.docsUrl,
    apiKeyLabel: preset.apiKeyLabel,
    apiKeyPlaceholder: preset.apiKeyPlaceholder,
    upstreamBase: config.upstreamBase,
    model: config.model,
    fastModel: config.fastModel,
    forceModel: config.forceModel,
    forceModelValue: config.forceModelValue,
    modelMapJson: config.modelMapJson,
    extraBodyJson: config.extraBodyJson,
    effectiveModel: effectiveModel(config),
    hasApiKey: Boolean(config.apiKey),
    maskedApiKey: maskKey(config.apiKey),
    storePath: getStorePath(),
    logPath: getProxyLogPath(),
    platform: process.platform,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    commands: buildCommandPayload()
  }
}

function statusPayload() {
  const config = getConfig()
  return {
    ok: Boolean(proxyHandle && !proxyError),
    running: Boolean(proxyHandle),
    error: proxyError,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    messagesUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1/messages`,
    provider: config.provider,
    providerLabel: providerPreset(config.provider).label,
    upstreamBase: config.upstreamBase,
    effectiveModel: effectiveModel(config),
    hasApiKey: Boolean(config.apiKey),
    logPath: getProxyLogPath()
  }
}

async function ensureProxyStarted(): Promise<void> {
  if (proxyHandle) return
  proxyError = null
  try {
    proxyHandle = await startProxyServer({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      getConfig,
      logPath: getProxyLogPath()
    })
  } catch (error: any) {
    proxyError = error?.code === 'EADDRINUSE'
      ? `El puerto ${DEFAULT_PORT} ya esta en uso. Cierra el otro proxy o cambia PORT.`
      : error?.message || String(error)
  }
}

async function startProxy(): Promise<ReturnType<typeof statusPayload>> {
  await ensureProxyStarted()
  return statusPayload()
}

async function stopProxy(): Promise<ReturnType<typeof statusPayload>> {
  if (!proxyHandle) {
    proxyError = null
    return statusPayload()
  }

  const server = proxyHandle.server
  proxyHandle = null
  proxyError = null

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  return statusPayload()
}

function createWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const preloadCandidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js')
  ]
  const preloadPath = preloadCandidates.find((p) => existsSync(p)) || preloadCandidates[0]

  const windowsIconCandidates = [
    join(app.getAppPath(), 'resources', 'icon.ico'),
    join(process.resourcesPath, 'icon.ico'),
    join(__dirname, '../../resources/icon.ico')
  ]
  const windowsIconPath = process.platform === 'win32'
    ? windowsIconCandidates.find((p) => existsSync(p))
    : undefined

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'JaviProxy',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    ...(windowsIconPath ? { icon: windowsIconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  const shouldMaximize = Boolean(sourceWindow && !sourceWindow.isDestroyed() && sourceWindow.isMaximized())
  if (sourceWindow && !sourceWindow.isDestroyed() && !shouldMaximize) {
    const [x, y] = sourceWindow.getPosition()
    const [width, height] = sourceWindow.getSize()
    window.setBounds({ x: x + 28, y: y + 28, width, height })
  }

  window.on('ready-to-show', () => {
    if (shouldMaximize) window.maximize()
    window.show()
    setupAppUpdater(window)
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function openNewWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const referenceWindow = sourceWindow && !sourceWindow.isDestroyed()
    ? sourceWindow
    : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  return createWindow(referenceWindow)
}

function setupApplicationMenu(): void {
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Nueva ventana',
      accelerator: 'CmdOrCtrl+N',
      click: () => openNewWindow()
    },
    { type: 'separator' },
    process.platform === 'darwin'
      ? { role: 'close', label: 'Cerrar ventana' }
      : { role: 'quit', label: 'Salir' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'Archivo', submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildCommandPayload() {
  const base = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  return {
    endpoint: `${base}/v1/messages`,
    mac: [
      `export ANTHROPIC_BASE_URL=${shellQuote(base)}`,
      `export ANTHROPIC_AUTH_TOKEN=${shellQuote('javiproxy-local')}`,
      `export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
      `export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
      `export ENABLE_TOOL_SEARCH=false`,
      `claude --model claude-sonnet-4-6`
    ].join(' && '),
    windows: [
      `$env:ANTHROPIC_BASE_URL=${psQuote(base)}`,
      `$env:ANTHROPIC_AUTH_TOKEN=${psQuote('javiproxy-local')}`,
      `$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'`,
      `$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1'`,
      `$env:ENABLE_TOOL_SEARCH='false'`,
      `claude --model claude-sonnet-4-6`
    ].join('; ')
  }
}

function buildVSCodeSettingsPayload() {
  const base = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  const config = getConfig()
  const preset = providerPreset(config.provider)
  return {
    'claudeCode.environmentVariables': [
      { name: 'ANTHROPIC_BASE_URL', value: base },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'javiproxy-local' },
      { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION', value: 'claude-sonnet-4-6' },
      { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', value: 'JaviProxy' },
      { name: 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', value: `${preset.label} through JaviProxy` },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
      { name: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', value: '1' },
      { name: 'ENABLE_TOOL_SEARCH', value: 'false' }
    ],
    'claudeCode.disableLoginPrompt': true
  }
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

async function applyVSCodeWorkspaceSettings(): Promise<{ ok: boolean; path?: string; canceled?: boolean }> {
  const focused = BrowserWindow.getFocusedWindow()
  const options: OpenDialogOptions = {
    title: 'Selecciona el workspace de VS Code',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = focused
    ? await dialog.showOpenDialog(focused, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }

  const workspacePath = result.filePaths[0]
  const vscodeDir = join(workspacePath, '.vscode')
  const settingsPath = join(vscodeDir, 'settings.json')
  mkdirSync(vscodeDir, { recursive: true })

  let current: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      current = JSON.parse(stripJsonComments(readFileSync(settingsPath, 'utf-8')))
    } catch {
      current = {}
    }
  }

  const next = {
    ...current,
    ...buildVSCodeSettingsPayload()
  }

  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return { ok: true, path: settingsPath }
}

async function openVSCodeClaudePanel(insiders = false): Promise<{ ok: boolean; url: string }> {
  const scheme = insiders ? 'vscode-insiders' : 'vscode'
  const url = `${scheme}://anthropic.claude-code/open`
  await shell.openExternal(url)
  return { ok: true, url }
}

async function launchClaude(): Promise<{ ok: boolean; command: string; message?: string }> {
  const commands = buildCommandPayload()

  if (process.platform === 'darwin') {
    const command = commands.mac
    const child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return { ok: true, command }
  }

  if (process.platform === 'win32') {
    const command = commands.windows
    const child = spawn('powershell.exe', ['-NoExit', '-Command', command], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return { ok: true, command }
  }

  return { ok: false, command: commands.mac, message: 'Launch automatico disponible en macOS y Windows.' }
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '********'
  return `${key.slice(0, 5)}...${key.slice(-4)}`
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function psQuote(value: string): string {
  return `'${String(value).replaceAll("'", "''")}'`
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.javiproxy.app')

  if (isDev && process.platform === 'darwin' && app.dock) {
    const iconPath = join(app.getAppPath(), 'ico.png')
    if (existsSync(iconPath)) app.dock.setIcon(iconPath)
  }

  setupApplicationMenu()
  await ensureProxyStarted()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  proxyHandle?.server.close()
})

ipcMain.handle('app:newWindow', async (event) => {
  openNewWindow(getEventWindow(event))
  return true
})

ipcMain.handle('config:getApiKey', async () => getStoredApiKey(readStore(), getConfig().provider))
ipcMain.handle('config:get', async () => publicConfig())
ipcMain.handle('config:set', async (_event, input) => {
  saveConfig(input || {})
  return publicConfig()
})
ipcMain.handle('proxy:status', async () => statusPayload())
ipcMain.handle('proxy:start', async () => startProxy())
ipcMain.handle('proxy:stop', async () => stopProxy())
ipcMain.handle('proxy:models', async () => fetchModels(getConfig()))
ipcMain.handle('proxy:test', async () => testUpstream(getConfig(), getProxyLogPath()))
ipcMain.handle('app:openPath', async (_event, targetPath: string) => {
  const result = await shell.openPath(targetPath)
  if (result) throw new Error(result)
  return true
})
ipcMain.handle('claude:launch', async () => launchClaude())
ipcMain.handle('claude:commands', async () => buildCommandPayload())
ipcMain.handle('vscode:settingsPayload', async () => buildVSCodeSettingsPayload())
ipcMain.handle('vscode:applyWorkspaceSettings', async () => applyVSCodeWorkspaceSettings())
ipcMain.handle('vscode:openClaudePanel', async (_event, insiders?: boolean) => openVSCodeClaudePanel(Boolean(insiders)))
