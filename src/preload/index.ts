import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  type AskWorkQuestionInput,
  type CaptureTextInput,
  type ExportRequest,
  type JobProgressEvent,
  type SaveProviderSettings,
  type SearchInput,
  type UpdateSourceDateInput,
  type UpdateDailyBriefInput,
  type WorkLensApi
} from '@shared/contracts'
import { IPC } from '@shared/ipc'

const api: WorkLensApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  listSourceAssets: (sourceItemId: string) => ipcRenderer.invoke(IPC.listSourceAssets, sourceItemId),
  getAssetPreview: (assetId: string) => ipcRenderer.invoke(IPC.getAssetPreview, assetId),
  openAsset: (assetId: string) => ipcRenderer.invoke(IPC.openAsset, assetId),
  captureText: (input: CaptureTextInput) => ipcRenderer.invoke(IPC.captureText, input),
  importFiles: () => ipcRenderer.invoke(IPC.importFiles),
  importDroppedFiles: (files: File[]) => {
    const filePaths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    return ipcRenderer.invoke(IPC.importDroppedFiles, filePaths)
  },
  cancelImport: () => ipcRenderer.invoke(IPC.cancelImport),
  retryImportSource: (sourceItemId: string) => ipcRenderer.invoke(IPC.retryImportSource, sourceItemId),
  reanalyzeSource: (sourceItemId: string) => ipcRenderer.invoke(IPC.reanalyzeSource, sourceItemId),
  deleteSource: (sourceItemId: string) => ipcRenderer.invoke(IPC.deleteSource, sourceItemId),
  deleteWorkEvent: (eventId: string) => ipcRenderer.invoke(IPC.deleteWorkEvent, eventId),
  deleteWorkItem: (workItemKey: string) => ipcRenderer.invoke(IPC.deleteWorkItem, workItemKey),
  updateWorkItem: (input) => ipcRenderer.invoke(IPC.updateWorkItem, input),
  mergeWorkItems: (input) => ipcRenderer.invoke(IPC.mergeWorkItems, input),
  updateSourceDate: (input: UpdateSourceDateInput) => ipcRenderer.invoke(IPC.updateSourceDate, input),
  generateDailyBrief: (workDate: string) => ipcRenderer.invoke(IPC.generateDailyBrief, workDate),
  updateDailyBrief: (input: UpdateDailyBriefInput) => ipcRenderer.invoke(IPC.updateDailyBrief, input),
  listDailyBriefVersions: (briefId) => ipcRenderer.invoke(IPC.listDailyBriefVersions, briefId),
  acceptDailyBriefVersion: (input) => ipcRenderer.invoke(IPC.acceptDailyBriefVersion, input),
  restoreDailyBriefVersion: (input) => ipcRenderer.invoke(IPC.restoreDailyBriefVersion, input),
  askWorkQuestion: (input: AskWorkQuestionInput) => ipcRenderer.invoke(IPC.askWorkQuestion, input),
  search: (input: SearchInput) => ipcRenderer.invoke(IPC.search, input),
  exportData: (input: ExportRequest) => ipcRenderer.invoke(IPC.exportData, input),
  createBackup: () => ipcRenderer.invoke(IPC.createBackup),
  getProviderSettings: () => ipcRenderer.invoke(IPC.getProviderSettings),
  saveProviderSettings: (input: SaveProviderSettings) =>
    ipcRenderer.invoke(IPC.saveProviderSettings, input),
  listCursorCliModels: () => ipcRenderer.invoke(IPC.listCursorCliModels),
  getCursorCliStatus: () => ipcRenderer.invoke(IPC.getCursorCliStatus),
  loginCursorCli: () => ipcRenderer.invoke(IPC.loginCursorCli),
  listCodexCliModels: () => ipcRenderer.invoke(IPC.listCodexCliModels),
  getCodexCliStatus: () => ipcRenderer.invoke(IPC.getCodexCliStatus),
  loginCodexCli: () => ipcRenderer.invoke(IPC.loginCodexCli),
  testProvider: () => ipcRenderer.invoke(IPC.testProvider),
  copyText: (text: string) => ipcRenderer.invoke(IPC.copyText, text),
  onDataChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.dataChanged, listener)
    return () => ipcRenderer.removeListener(IPC.dataChanged, listener)
  },
  onJobProgress: (callback: (event: JobProgressEvent) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: JobProgressEvent
    ): void => callback(value)
    ipcRenderer.on(IPC.jobProgress, listener)
    return () => ipcRenderer.removeListener(IPC.jobProgress, listener)
  }
}

contextBridge.exposeInMainWorld('worklens', api)
