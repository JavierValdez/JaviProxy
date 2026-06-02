import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'

type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

type UpdateMode = 'manual' | 'unsupported'

export interface AppUpdateState {
  stage: UpdateStage
  currentVersion: string
  autoUpdatesEnabled: boolean
  mode: UpdateMode
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

interface UpdateDownloadAsset {
  name: string
  url: string
  size: number | null
}

interface ReleaseMetadata {
  version: string
  releaseDate: string | null
  files: UpdateDownloadAsset[]
}

interface LatestReleaseInfo {
  version: string
  name: string
  releaseDate: string | null
  releaseNotes: string | null
  downloadAsset: UpdateDownloadAsset | null
}

const RELEASES_BASE_URL = (
  process.env.JAVIPROXY_RELEASES_BASE_URL ||
  'https://storage.googleapis.com/artictools-releases/javiproxy/releases'
).replace(/\/+$/, '')
const RELEASES_PAGE = RELEASES_BASE_URL

const updateState: AppUpdateState = {
  stage: 'idle',
  currentVersion: app.getVersion(),
  autoUpdatesEnabled: false,
  mode: 'unsupported',
  latestVersion: null,
  downloadedVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  downloadUrl: null,
  error: null
}

let updaterInitialized = false
let checkInFlight: Promise<void> | null = null
const listeners = new Set<BrowserWindow>()

function getOpenWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

function emitState(target?: BrowserWindow) {
  const state = { ...updateState }
  if (target && !target.isDestroyed()) {
    target.webContents.send('appUpdate:state', state)
  } else {
    for (const win of listeners) {
      if (!win.isDestroyed()) {
        win.webContents.send('appUpdate:state', state)
      }
    }
  }
}

function patchState(partial: Partial<AppUpdateState>) {
  Object.assign(updateState, partial)
  emitState()
}

function markUnsupported(reason: string) {
  patchState({
    stage: 'unsupported',
    mode: 'unsupported',
    autoUpdatesEnabled: false,
    error: reason
  })
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '')
}

function parseVersion(raw: string): { parts: number[]; preRelease: boolean } {
  const normalized = normalizeVersion(raw)
  const [stablePart, pre] = normalized.split('-', 2)
  const parts = stablePart
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
  return { parts, preRelease: Boolean(pre) }
}

function compareVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  const max = Math.max(av.parts.length, bv.parts.length)
  for (let i = 0; i < max; i += 1) {
    const ai = av.parts[i] ?? 0
    const bi = bv.parts[i] ?? 0
    if (ai > bi) return 1
    if (ai < bi) return -1
  }
  if (av.preRelease && !bv.preRelease) return -1
  if (!av.preRelease && bv.preRelease) return 1
  return 0
}

function parseYamlValue(raw: string): string {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function resolveReleaseUrl(value: string): string {
  const assetPath = parseYamlValue(value)
  if (/^https?:\/\//i.test(assetPath)) return assetPath
  return `${RELEASES_BASE_URL}/${assetPath.replace(/^\/+/, '')}`
}

function getReleaseAssetName(value: string): string {
  const assetPath = parseYamlValue(value).split('?')[0]
  try {
    const parsed = new URL(assetPath)
    return path.basename(decodeURIComponent(parsed.pathname))
  } catch {
    return path.basename(assetPath)
  }
}

function parseReleaseMetadata(raw: string): ReleaseMetadata {
  const versionMatch = raw.match(/^version:\s*(.+)$/m)
  if (!versionMatch) {
    throw new Error('Metadata de actualizacion invalida: falta version.')
  }

  const releaseDateMatch = raw.match(/^releaseDate:\s*(.+)$/m)
  const files: UpdateDownloadAsset[] = []
  let currentFile: UpdateDownloadAsset | null = null

  for (const line of raw.split(/\r?\n/)) {
    const urlMatch = line.match(/^\s*(?:-\s*)?url:\s*(.+)$/)
    if (urlMatch) {
      const assetPath = parseYamlValue(urlMatch[1])
      currentFile = {
        name: getReleaseAssetName(assetPath),
        url: resolveReleaseUrl(assetPath),
        size: null
      }
      files.push(currentFile)
      continue
    }

    const sizeMatch = line.match(/^\s*size:\s*(\d+)\s*$/)
    if (sizeMatch && currentFile) {
      currentFile.size = Number(sizeMatch[1])
    }
  }

  const pathMatch = raw.match(/^path:\s*(.+)$/m)
  if (files.length === 0 && pathMatch) {
    const assetPath = parseYamlValue(pathMatch[1])
    files.push({
      name: getReleaseAssetName(assetPath),
      url: resolveReleaseUrl(assetPath),
      size: null
    })
  }

  return {
    version: parseYamlValue(versionMatch[1]),
    releaseDate: releaseDateMatch ? parseYamlValue(releaseDateMatch[1]) : null,
    files
  }
}

function getMetadataFileName(): string | null {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'win32') return 'latest.yml'
  return null
}

function pickDownloadAsset(release: ReleaseMetadata): UpdateDownloadAsset | null {
  const platformPriority = process.platform === 'darwin'
    ? ['.dmg', '.zip']
    : process.platform === 'win32'
      ? ['.exe', '.msi', '.zip']
      : []

  for (const ext of platformPriority) {
    const found = release.files.find((asset) => asset.name.toLowerCase().endsWith(ext))
    if (found) return found
  }

  return release.files[0] ?? null
}

async function fetchLatestRelease(): Promise<LatestReleaseInfo> {
  const metadataFileName = getMetadataFileName()
  if (!metadataFileName) {
    throw new Error('No hay actualizaciones configuradas para esta plataforma.')
  }

  const response = await fetch(`${RELEASES_BASE_URL}/${metadataFileName}`, {
    headers: {
      Accept: 'text/yaml,text/plain',
      'User-Agent': `JaviProxy/${app.getVersion()}`
    },
    redirect: 'follow'
  })

  if (!response.ok) {
    throw new Error(`El bucket de releases respondio con estado ${response.status}.`)
  }

  const metadata = parseReleaseMetadata(await response.text())
  const version = normalizeVersion(metadata.version)

  return {
    version,
    name: `JaviProxy ${version}`,
    releaseDate: metadata.releaseDate,
    releaseNotes: null,
    downloadAsset: pickDownloadAsset(metadata)
  }
}

async function checkForUpdates(): Promise<AppUpdateState> {
  if (!updateState.autoUpdatesEnabled) return { ...updateState }
  if (checkInFlight) {
    await checkInFlight
    return { ...updateState }
  }

  patchState({ stage: 'checking', lastCheckedAt: new Date().toISOString(), progressPercent: null, error: null })

  checkInFlight = (async () => {
    const latest = await fetchLatestRelease()
    const latestVersion = normalizeVersion(latest.version)
    const currentVersion = app.getVersion()
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
    const downloadAsset = latest.downloadAsset

    if (hasUpdate && !downloadAsset) {
      patchState({
        stage: 'error',
        mode: 'manual',
        latestVersion,
        downloadedVersion: null,
        progressPercent: null,
        releaseName: latest.name,
        releaseDate: latest.releaseDate,
        releaseNotes: latest.releaseNotes,
        downloadUrl: RELEASES_PAGE,
        error: 'No se encontro un instalador compatible en el metadata de actualizacion.'
      })
      return
    }

    patchState({
      stage: hasUpdate ? 'available' : 'not-available',
      mode: 'manual',
      latestVersion,
      downloadedVersion: null,
      progressPercent: null,
      releaseName: latest.name,
      releaseDate: latest.releaseDate,
      releaseNotes: latest.releaseNotes,
      downloadUrl: hasUpdate ? downloadAsset?.url || null : null,
      error: null
    })
  })()

  try { await checkInFlight } catch (err) {
    patchState({ stage: 'error', error: formatError(err), progressPercent: null })
  } finally { checkInFlight = null }

  return { ...updateState }
}

async function downloadUpdate(): Promise<AppUpdateState> {
  if (!updateState.autoUpdatesEnabled) return { ...updateState }
  if (updateState.stage !== 'available') {
    throw new Error('No hay una actualizacion disponible para descargar')
  }

  const url = updateState.downloadUrl || RELEASES_PAGE
  await shell.openExternal(url)

  const ownerWindow = BrowserWindow.getFocusedWindow() || getOpenWindows()[0]
  const { response } = await dialog.showMessageBox(ownerWindow ?? undefined, {
    type: 'info',
    title: 'Instalar actualizacion',
    message: `JaviProxy ${updateState.latestVersion} se esta descargando`,
    detail:
      'Cuando la descarga termine, cierra JaviProxy antes de abrir el instalador.\n\n' +
      '¿Deseas salir ahora para instalar la actualizacion cuando se complete la descarga?',
    buttons: ['Salir ahora', 'Instalar despues'],
    defaultId: 0,
    cancelId: 1
  })

  if (response === 0) {
    app.quit()
  }

  return { ...updateState }
}

function registerIpc(): void {
  ipcMain.handle('appUpdate:getState', () => ({ ...updateState }))
  ipcMain.handle('appUpdate:check', async () => checkForUpdates())
  ipcMain.handle('appUpdate:download', async () => downloadUpdate())
  ipcMain.handle('appUpdate:quitAndInstall', () => {
    throw new Error('Instalacion automatica no disponible sin firma. Descarga e instala manualmente.')
  })
}

export function setupAppUpdater(window: BrowserWindow): void {
  if (updaterInitialized) {
    emitState(window)
    return
  }
  updaterInitialized = true
  registerIpc()

  if (!app.isPackaged) {
    markUnsupported('Actualizaciones automaticas disponibles solo en la app empaquetada.')
    return
  }

  if (!getMetadataFileName()) {
    markUnsupported('Actualizaciones disponibles solo para macOS y Windows.')
    return
  }

  updateState.autoUpdatesEnabled = true
  updateState.mode = 'manual'
  emitState()

  listeners.add(window)
  window.on('closed', () => { listeners.delete(window) })

  setTimeout(() => { void checkForUpdates() }, 6000)

  const everySixHoursMs = 6 * 60 * 60 * 1000
  setInterval(() => { void checkForUpdates() }, everySixHoursMs)
}
