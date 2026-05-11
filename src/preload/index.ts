import { contextBridge, ipcRenderer } from 'electron'

const javiProxyAPI = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
  setConfig: (config: any) => ipcRenderer.invoke('config:set', config),
  getStatus: () => ipcRenderer.invoke('proxy:status'),
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  listModels: () => ipcRenderer.invoke('proxy:models'),
  testProxy: () => ipcRenderer.invoke('proxy:test'),
  openPath: (targetPath: string) => ipcRenderer.invoke('app:openPath', targetPath),
  launchClaude: () => ipcRenderer.invoke('claude:launch'),
  getCommands: () => ipcRenderer.invoke('claude:commands'),
  getVSCodeSettingsPayload: () => ipcRenderer.invoke('vscode:settingsPayload'),
  applyVSCodeWorkspaceSettings: () => ipcRenderer.invoke('vscode:applyWorkspaceSettings'),
  openVSCodeClaudePanel: (insiders?: boolean) => ipcRenderer.invoke('vscode:openClaudePanel', insiders),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),
  getUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkForUpdates: () => ipcRenderer.invoke('appUpdate:check'),
  downloadUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  onAppUpdateState: (cb: (state: any) => void) => {
    const handler = (_: any, state: any) => cb(state)
    ipcRenderer.on('appUpdate:state', handler)
    return () => ipcRenderer.removeListener('appUpdate:state', handler)
  }
}

const appUpdateAPI = {
  getState: () => ipcRenderer.invoke('appUpdate:getState'),
  check: () => ipcRenderer.invoke('appUpdate:check'),
  download: () => ipcRenderer.invoke('appUpdate:download'),
  onState: (cb: (state: any) => void) => {
    const handler = (_: any, state: any) => cb(state)
    ipcRenderer.on('appUpdate:state', handler)
    return () => ipcRenderer.removeListener('appUpdate:state', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('javiProxy', javiProxyAPI)
    contextBridge.exposeInMainWorld('appUpdate', appUpdateAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(globalThis as any).javiProxy = javiProxyAPI
  ;(globalThis as any).appUpdate = appUpdateAPI
}
