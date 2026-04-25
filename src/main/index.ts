import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
app.name = 'JaviProxy'

import type { IpcMainInvokeEvent, MenuItemConstructorOptions, OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { startProxyServer, fetchModels, testUpstream, effectiveModel } from './proxy'
import type { ProxyConfig, ProxyServerHandle } from './proxy'
import { setupAppUpdater } from './updater'

const isDev = process.env.NODE_ENV === 'development'
const DEFAULT_PORT = Number(process.env.PORT || 8787)
const DEFAULT_HOST = process.env.HOST || '127.0.0.1'
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const LEGACY_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

interface StoredConfig {
  upstreamBase?: string
  apiKeyEncrypted?: string
  apiKeyPlain?: string
  model?: string
  fastModel?: string
  forceModel?: boolean
  forceModelValue?: string
  modelMapJson?: string
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

function getStoredApiKey(store = readStore()): string {
  if (process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY) {
    return process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY || ''
  }
  if (store.apiKeyEncrypted) return decryptSecret(store.apiKeyEncrypted)
  if (store.apiKeyPlain) {
    const apiKey = store.apiKeyPlain
    writeStore({ ...store, apiKeyPlain: undefined, apiKeyEncrypted: encryptSecret(apiKey) })
    return apiKey
  }
  return ''
}

function normalizeBaseUrl(value: string): string {
  const normalized = String(value || OPENCODE_GO_BASE_URL).replace(/\/+$/g, '')
  return normalized === LEGACY_ZEN_BASE_URL ? OPENCODE_GO_BASE_URL : normalized
}

function getConfig(): ProxyConfig {
  const store = readStore()
  const model = process.env.OPENCODE_GO_MODEL || store.model || 'kimi-k2.6'
  const forceModelValue = process.env.OPENCODE_FORCE_MODEL || store.forceModelValue || model
  return {
    upstreamBase: normalizeBaseUrl(process.env.OPENCODE_BASE_URL || store.upstreamBase || OPENCODE_GO_BASE_URL),
    apiKey: getStoredApiKey(store),
    model,
    fastModel: process.env.OPENCODE_GO_FAST_MODEL || store.fastModel || 'minimax-m2.5',
    forceModel: typeof store.forceModel === 'boolean' ? store.forceModel : true,
    forceModelValue,
    modelMapJson: process.env.OPENCODE_MODEL_MAP_JSON || store.modelMapJson || ''
  }
}

function saveConfig(input: Partial<ProxyConfig> & { apiKey?: string }): ProxyConfig {
  const current = readStore()
  const next: StoredConfig = {
    ...current,
    upstreamBase: input.upstreamBase ? normalizeBaseUrl(input.upstreamBase) : current.upstreamBase,
    model: input.model || current.model || 'kimi-k2.6',
    fastModel: input.fastModel || current.fastModel || 'minimax-m2.5',
    forceModel: typeof input.forceModel === 'boolean' ? input.forceModel : current.forceModel ?? true,
    forceModelValue: input.forceModelValue || input.model || current.forceModelValue || current.model || 'kimi-k2.6',
    modelMapJson: typeof input.modelMapJson === 'string' ? input.modelMapJson : current.modelMapJson || ''
  }

  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    next.apiKeyEncrypted = encryptSecret(input.apiKey.trim())
    next.apiKeyPlain = undefined
  }

  writeStore(next)
  return getConfig()
}

function publicConfig() {
  const config = getConfig()
  return {
    upstreamBase: config.upstreamBase,
    model: config.model,
    fastModel: config.fastModel,
    forceModel: config.forceModel,
    forceModelValue: config.forceModelValue,
    modelMapJson: config.modelMapJson,
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
  return {
    'claudeCode.environmentVariables': [
      { name: 'ANTHROPIC_BASE_URL', value: base },
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

ipcMain.handle('config:get', async () => publicConfig())
ipcMain.handle('config:set', async (_event, input) => {
  saveConfig(input || {})
  return publicConfig()
})
ipcMain.handle('proxy:status', async () => statusPayload())
ipcMain.handle('proxy:start', async () => startProxy())
ipcMain.handle('proxy:stop', async () => stopProxy())
ipcMain.handle('proxy:models', async () => fetchModels(getConfig()))
ipcMain.handle('proxy:test', async () => testUpstream(getConfig()))
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
