import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import {
  AskWorkQuestionInputSchema,
  CaptureTextInputSchema,
  ExportRequestSchema,
  SaveProviderSettingsSchema,
  SearchInputSchema,
  UpdateDailyBriefInputSchema,
  UpdateSourceDateInputSchema,
  type ActionResult,
  type ExportRequest,
  type ImportResult,
  type JobProgressEvent
} from '@shared/contracts'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { AnalysisService } from '@core/ai/analyzer'
import { UtilityAiRuntime } from '@core/ai/host-client'
import { ExportService, buildPrintHtml } from '@core/export/exporter'
import { IngestionService } from '@core/ingestion/parser'
import { UtilityParserRuntime } from '@core/ingestion/parser-host-client'
import { WorkLensDatabase } from '@core/storage/database'
import { SecureSecretStore } from '@core/storage/secure-store'

let mainWindow: BrowserWindow | null = null
let database: WorkLensDatabase | null = null
let ingestion: IngestionService | null = null
let analysis: AnalysisService | null = null
let exporter: ExportService | null = null
let closing = false
let analysisQueue: Promise<void> = Promise.resolve()
const automaticAnalysisTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeImportControllers = new Map<number, AbortController>()

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  await initializeServices()
  secureElectronSession()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (closing) return
  closing = true
  for (const timer of automaticAnalysisTimers.values()) clearTimeout(timer)
  automaticAnalysisTimers.clear()
  for (const controller of activeImportControllers.values()) controller.abort()
  activeImportControllers.clear()
  database?.checkpoint()
  database?.close()
})

async function initializeServices(): Promise<void> {
  const userData = app.getPath('userData')
  const workspaceRoot = join(userData, 'workspace')
  const stateRoot = join(userData, 'state')
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(join(workspaceRoot, 'blobs'), { recursive: true }),
    mkdir(join(workspaceRoot, 'derived'), { recursive: true }),
    mkdir(join(userData, 'cache'), { recursive: true })
  ])

  database = new WorkLensDatabase(join(workspaceRoot, 'worklens.sqlite'))
  await createAutomaticSnapshot(database, join(workspaceRoot, 'backups'))
  const secrets = new SecureSecretStore(join(stateRoot, 'secrets.enc.json'))
  const derivedRoot = join(workspaceRoot, 'derived')
  const cacheRoot = join(userData, 'cache')
  ingestion = new IngestionService(
    database,
    join(workspaceRoot, 'blobs'),
    derivedRoot,
    cacheRoot,
    new UtilityParserRuntime(join(__dirname, 'parser-host.js'), derivedRoot, cacheRoot)
  )
  analysis = new AnalysisService(
    database,
    secrets,
    new UtilityAiRuntime(join(__dirname, 'ai-host.js'))
  )
  exporter = new ExportService(database)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'WorkLens',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f3f1eb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  Menu.setApplicationMenu(buildMenu())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const rendererUrl = getDevelopmentRendererUrl(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL
  )
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(getPackagedRendererPath())
  }
}

function secureElectronSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getSnapshot, guard((_event) => requireDatabase().getSnapshot()))

  ipcMain.handle(
    IPC.listSourceAssets,
    guard((_event, rawSourceItemId) => {
      const sourceItemId = z.string().uuid().parse(rawSourceItemId)
      return requireDatabase().listSourceAssets(sourceItemId)
    })
  )

  ipcMain.handle(
    IPC.getAssetPreview,
    guard(async (_event, rawAssetId) => {
      const assetId = z.string().uuid().parse(rawAssetId)
      const asset = requireDatabase().getAssetLocation(assetId)
      const previewable = asset.mimeType.startsWith('image/') || asset.mimeType === 'application/pdf'
      if (!previewable) return { assetId, mimeType: asset.mimeType, dataUrl: null }
      const bytes = await readFile(asset.localPath)
      if (bytes.byteLength > 30 * 1024 * 1024) throw new Error('附件过大，请直接打开原件查看')
      return { assetId, mimeType: asset.mimeType, dataUrl: `data:${asset.mimeType};base64,${bytes.toString('base64')}` }
    })
  )

  ipcMain.handle(
    IPC.openAsset,
    guard(async (_event, rawAssetId): Promise<ActionResult> => {
      const assetId = z.string().uuid().parse(rawAssetId)
      const asset = requireDatabase().getAssetLocation(assetId)
      const message = await shell.openPath(asset.localPath)
      if (message) throw new Error(`无法打开附件：${message}`)
      return { ok: true, message: `已打开 ${asset.originalName}`, path: asset.localPath }
    })
  )

  ipcMain.handle(
    IPC.captureText,
    guard(async (event, rawInput) => {
      const input = CaptureTextInputSchema.parse(rawInput)
      const source = await requireIngestion().captureText(input)
      broadcastDataChanged()
      await analyzeSourceImmediatelyIfEnabled(source.id, event.sender)
      return requireDatabase().getSource(source.id)
    })
  )

  ipcMain.handle(
    IPC.importFiles,
    guard(async (event) => {
      const options: Electron.OpenDialogOptions = {
        title: '导入工作资料',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '支持的资料',
            extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'tiff']
          }
        ]
      }
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled) return emptyImportResult()
      return runImport(event, (progress, signal) =>
        requireIngestion().importFiles(selection.filePaths, progress, signal)
      )
    })
  )

  ipcMain.handle(
    IPC.importDroppedFiles,
    guard(async (event, rawFilePaths) => {
      const filePaths = z
        .array(z.string().trim().min(1).max(4_096))
        .min(1, '没有收到可读取的文件，请改用“选择文件”')
        .max(200, '单次最多导入 200 份文件')
        .parse(rawFilePaths)
      return runImport(event, (progress, signal) =>
        requireIngestion().importFiles(filePaths, progress, signal)
      )
    })
  )

  ipcMain.handle(
    IPC.cancelImport,
    guard((event): ActionResult => {
      const controller = activeImportControllers.get(event.sender.id)
      if (!controller) return { ok: false, message: '当前没有正在进行的导入' }
      controller.abort()
      return { ok: true, message: '正在停止导入，已完成的文件会保留' }
    })
  )

  ipcMain.handle(
    IPC.retryImportSource,
    guard(async (event, rawSourceItemId) => {
      const sourceItemId = z.string().uuid().parse(rawSourceItemId)
      const source = requireDatabase().getSource(sourceItemId)
      if (source.rawText.trim() && source.assetCount === 0) {
        await enqueueSourceAnalysis(sourceItemId, event.sender)
        return {
          imported: [requireDatabase().getSource(sourceItemId)],
          duplicates: [],
          failed: [],
          cancelled: false
        } satisfies ImportResult
      }
      return runImport(event, (progress, signal) =>
        requireIngestion().retrySource(sourceItemId, progress, signal)
      )
    })
  )

  ipcMain.handle(
    IPC.reanalyzeSource,
    guard(async (event, rawSourceItemId): Promise<ActionResult> => {
      const sourceItemId = z.string().uuid().parse(rawSourceItemId)
      const source = requireDatabase().getSource(sourceItemId)
      if (!source.rawText.trim()) throw new Error('这份资料没有可重新整理的文字内容')
      const previousDates = new Set(source.workDates)
      await enqueueSourceAnalysis(sourceItemId, event.sender)
      const refreshed = requireDatabase().getSource(sourceItemId)
      const refreshedDates = new Set(refreshed.workDates)
      for (const removedDate of previousDates) {
        if (refreshedDates.has(removedDate)) continue
        if (requireDatabase().listSourcesForDate(removedDate).length) {
          await enqueueDailyAnalysis(removedDate, event.sender, true)
        } else {
          requireDatabase().clearDailySynthesisForDate(removedDate)
          broadcastDataChanged()
        }
      }
      const dateSummary = refreshed.workDates.length
        ? `识别 ${refreshed.workDates.length} 个工作日`
        : '已使用资料日期完成归档'
      return { ok: true, message: `“${refreshed.title}”已重新整理，${dateSummary}` }
    })
  )

  ipcMain.handle(
    IPC.deleteSource,
    guard(async (event, rawSourceItemId): Promise<ActionResult> => {
      const sourceItemId = z.string().uuid().parse(rawSourceItemId)
      const deleted = requireDatabase().deleteSource(sourceItemId)
      const remainingPaths = new Set(requireDatabase().listAssets().map((asset) => asset.localPath))
      await Promise.all(deleted.assetPaths.filter((path) => !remainingPaths.has(path)).map((path) => rm(path, { force: true })))
      broadcastDataChanged()
      for (const workDate of deleted.affectedWorkDates) {
        if (requireDatabase().listSourcesForDate(workDate).length) {
          void scheduleAutomaticAnalysis(workDate, event.sender)
        }
      }
      return { ok: true, message: `已删除“${deleted.title}”及其关联内容` }
    })
  )

  ipcMain.handle(
    IPC.deleteWorkEvent,
    guard((_event, rawEventId): ActionResult => {
      const eventId = z.string().uuid().parse(rawEventId)
      const deleted = requireDatabase().deleteWorkEvent(eventId)
      broadcastDataChanged()
      return { ok: true, message: `已删除时间线内容“${deleted.title}”` }
    })
  )

  ipcMain.handle(
    IPC.deleteWorkItem,
    guard((_event, rawWorkItemKey): ActionResult => {
      const workItemKey = z.string().trim().min(1).max(500).parse(rawWorkItemKey)
      const deleted = requireDatabase().deleteWorkItem(workItemKey)
      broadcastDataChanged()
      return { ok: true, message: `已删除工作事项“${deleted.title}”及 ${deleted.deletedCount} 条历史内容` }
    })
  )

  ipcMain.handle(
    IPC.updateSourceDate,
    guard(async (event, rawInput) => {
      const input = UpdateSourceDateInputSchema.parse(rawInput)
      const current = requireDatabase().getSource(input.sourceItemId)
      const oldDate = (current.businessDate ?? current.createdAt).slice(0, 10)
      const updated = requireDatabase().setSourceDateManually(input.sourceItemId, input.businessDate)
      const dates = new Set([oldDate, input.businessDate])
      for (const date of dates) requireDatabase().clearDailySynthesisForDate(date)
      broadcastDataChanged()
      for (const date of dates) void scheduleAutomaticAnalysis(date, event.sender)
      return updated
    })
  )

  ipcMain.handle(
    IPC.generateDailyBrief,
    guard(async (event, rawWorkDate): Promise<ActionResult> => {
      const workDate = z.iso.date().parse(rawWorkDate)
      await enqueueDailyAnalysis(workDate, event.sender, false)
      return { ok: true, message: '早会逐字稿已生成' }
    })
  )

  ipcMain.handle(
    IPC.updateDailyBrief,
    guard((_event, rawInput) => {
      const input = UpdateDailyBriefInputSchema.parse(rawInput)
      const updated = requireDatabase().updateDailyBrief(input)
      broadcastDataChanged()
      return updated
    })
  )

  ipcMain.handle(
    IPC.askWorkQuestion,
    guard(async (_event, rawInput) => {
      const input = AskWorkQuestionInputSchema.parse(rawInput)
      return requireAnalysis().askWorkQuestion(input)
    })
  )

  ipcMain.handle(
    IPC.search,
    guard((_event, rawInput) => {
      const input = SearchInputSchema.parse(rawInput)
      return requireDatabase().search(input.query, input.entityTypes)
    })
  )

  ipcMain.handle(
    IPC.exportData,
    guard(async (_event, rawInput): Promise<ActionResult> => {
      const input = ExportRequestSchema.parse(rawInput)
      return exportData(input)
    })
  )

  ipcMain.handle(
    IPC.createBackup,
    guard(async (): Promise<ActionResult> => {
      const options: Electron.SaveDialogOptions = {
        title: '创建 WorkLens 备份',
        defaultPath: join(
          app.getPath('documents'),
          `WorkLens-backup-${new Date().toISOString().slice(0, 10)}.zip`
        ),
        filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
      }
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, message: '已取消备份' }
      requireDatabase().checkpoint()
      await requireExporter().writeZip(
        { format: 'zip', fromDate: null, toDate: null, includeAttachments: true },
        result.filePath
      )
      return { ok: true, message: '备份已创建', path: result.filePath }
    })
  )

  ipcMain.handle(
    IPC.getProviderSettings,
    guard(() => requireAnalysis().getProviderSettings())
  )

  ipcMain.handle(
    IPC.saveProviderSettings,
    guard(async (_event, rawInput) => {
      const input = SaveProviderSettingsSchema.parse(rawInput)
      const settings = await requireAnalysis().saveProviderSettings(input)
      broadcastDataChanged()
      return settings
    })
  )

  ipcMain.handle(
    IPC.listCursorCliModels,
    guard(() => requireAnalysis().listCursorCliModels())
  )

  ipcMain.handle(
    IPC.getCursorCliStatus,
    guard(() => requireAnalysis().getCursorCliStatus())
  )

  ipcMain.handle(
    IPC.loginCursorCli,
    guard(() => requireAnalysis().loginCursorCli())
  )

  ipcMain.handle(
    IPC.listCodexCliModels,
    guard(() => requireAnalysis().listCodexCliModels())
  )

  ipcMain.handle(
    IPC.getCodexCliStatus,
    guard(() => requireAnalysis().getCodexCliStatus())
  )

  ipcMain.handle(
    IPC.loginCodexCli,
    guard(() => requireAnalysis().loginCodexCli())
  )

  ipcMain.handle(
    IPC.testProvider,
    guard(async (): Promise<ActionResult> => {
      await requireAnalysis().testProvider()
      return { ok: true, message: '连接成功' }
    })
  )

  ipcMain.handle(
    IPC.copyText,
    guard((_event, rawText): ActionResult => {
      const text = z.string().max(50_000).parse(rawText)
      clipboard.writeText(text)
      return { ok: true, message: '逐字稿已复制到剪贴板' }
    })
  )
}

async function runImport(
  event: IpcMainInvokeEvent,
  importer: (
    progress: (event: { fileName: string; message: string; current: number; total: number }) => void,
    signal: AbortSignal
  ) => Promise<ImportResult>
): Promise<ImportResult> {
  const senderId = event.sender.id
  if (activeImportControllers.has(senderId)) {
    throw new Error('已有一批文件正在导入，请等待完成或先取消')
  }
  const controller = new AbortController()
  activeImportControllers.set(senderId, controller)
  try {
    const result = await importer(
      ({ fileName, message, current, total }) => {
        sendJobProgress(event.sender, '', `${fileName} · ${message}`, 'import', current, total)
      },
      controller.signal
    )
    broadcastDataChanged()
    const settings = await requireAnalysis().getProviderSettings()
    if (settings.autoAnalyze) {
      if (!settings.connected) {
        result.analysisSkipped = '未连接 AI，资料已保存但未整理'
      } else {
        for (const source of result.imported) {
          if (controller.signal.aborted) {
            result.cancelled = true
            break
          }
          try {
            await enqueueSourceAnalysis(source.id, event.sender, controller.signal)
          } catch (error) {
            if (controller.signal.aborted) {
              result.cancelled = true
              break
            }
            result.failed.push({
              fileName: source.title,
              error: `资料已保存，但内容理解失败：${error instanceof Error ? error.message : String(error)}`,
              sourceItemId: source.id
            })
          }
        }
      }
      result.imported = result.imported.map((source) => requireDatabase().getSource(source.id))
    }
    const processed = result.imported.length + result.duplicates.length + result.failed.length
    const message = result.cancelled
      ? '导入已取消，已完成的文件已保留'
      : result.analysisSkipped
        ? result.analysisSkipped
      : `批量导入完成：新增 ${result.imported.length}，跳过 ${result.duplicates.length}，失败 ${result.failed.length}`
    sendJobProgress(event.sender, '', message, 'import', processed, processed, true)
    return result
  } catch (error) {
    sendJobProgress(
      event.sender,
      '',
      `批量导入未完成：${error instanceof Error ? error.message : String(error)}`,
      'import',
      undefined,
      undefined,
      true
    )
    throw error
  } finally {
    if (activeImportControllers.get(senderId) === controller) {
      activeImportControllers.delete(senderId)
    }
  }
}

function emptyImportResult(): ImportResult {
  return { imported: [], duplicates: [], failed: [], cancelled: false }
}

async function exportData(request: ExportRequest): Promise<ActionResult> {
  const extensions = {
    markdown: 'md',
    pdf: 'pdf',
    csv: 'csv',
    zip: 'zip'
  } as const
  const extension = extensions[request.format]
  const options: Electron.SaveDialogOptions = {
    title: '导出 WorkLens 数据',
    defaultPath: join(
      app.getPath('documents'),
      `WorkLens-${new Date().toISOString().slice(0, 10)}.${extension}`
    ),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, message: '已取消导出' }

  if (request.format === 'markdown' || request.format === 'csv') {
    await requireExporter().writeTextExport(request, result.filePath, request.format)
  } else if (request.format === 'zip') {
    await requireExporter().writeZip(request, result.filePath)
  } else {
    await writePdf(request, result.filePath)
  }
  return { ok: true, message: '导出完成', path: result.filePath }
}

async function writePdf(request: ExportRequest, targetPath: string): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(app.getPath('temp'), 'worklens-pdf-'))
  const htmlPath = join(temporaryDirectory, 'report.html')
  const temporaryTarget = `${targetPath}.${process.pid}.tmp`
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  try {
    await writeFile(htmlPath, buildPrintHtml(requireExporter().getBundle(request)), 'utf8')
    await printWindow.loadFile(htmlPath)
    const pdf = await printWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    })
    await writeFile(temporaryTarget, pdf, { mode: 0o600 })
    await rename(temporaryTarget, targetPath)
  } finally {
    printWindow.destroy()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function guard<T extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: T) => R
): (event: IpcMainInvokeEvent, ...args: T) => R {
  return (event, ...args) => {
    assertTrustedSender(event)
    return handler(event, ...args)
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('拒绝来自非受信页面的请求')
  }

  const url = event.senderFrame?.url ?? ''
  const trusted = isTrustedRendererUrl(
    url,
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    getPackagedRendererPath()
  )
  if (!trusted) throw new Error('拒绝来自非受信页面的请求')
}

function getPackagedRendererPath(): string {
  return join(__dirname, '../renderer/index.html')
}

export function getDevelopmentRendererUrl(
  isPackaged: boolean,
  configuredUrl: string | undefined
): string | undefined {
  if (isPackaged || !configuredUrl) return undefined

  try {
    const url = new URL(configuredUrl)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

export function isTrustedRendererUrl(
  candidateUrl: string,
  isPackaged: boolean,
  configuredDevelopmentUrl: string | undefined,
  packagedRendererPath: string
): boolean {
  const expectedUrl =
    getDevelopmentRendererUrl(isPackaged, configuredDevelopmentUrl) ??
    pathToFileURL(packagedRendererPath).href

  try {
    const candidate = new URL(candidateUrl)
    const expected = new URL(expectedUrl)
    return (
      candidate.protocol === expected.protocol &&
      candidate.origin === expected.origin &&
      candidate.host === expected.host &&
      candidate.username === expected.username &&
      candidate.password === expected.password &&
      candidate.pathname === expected.pathname &&
      candidate.search === expected.search &&
      candidate.hash === expected.hash
    )
  } catch {
    return false
  }
}

function broadcastDataChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.dataChanged)
}

async function scheduleAutomaticAnalysis(
  workDate: string,
  sender: Electron.WebContents
): Promise<void> {
  try {
    const settings = await requireAnalysis().getProviderSettings()
    if (!settings.autoAnalyze) return
    if (!settings.connected) {
      sendJobProgress(sender, '', '未连接 AI，已跳过自动整理', 'analysis', undefined, undefined, true)
      return
    }
    const timerKey = `date:${workDate}`
    const existingTimer = automaticAnalysisTimers.get(timerKey)
    if (existingTimer) clearTimeout(existingTimer)
    automaticAnalysisTimers.set(
      timerKey,
      setTimeout(() => {
        automaticAnalysisTimers.delete(timerKey)
        if (closing) return
        void enqueueDailyAnalysis(workDate, sender, true).catch(() => undefined)
      }, 600)
    )
  } catch {
    // The source remains available locally and can be retried manually.
  }
}

async function analyzeSourceImmediatelyIfEnabled(
  sourceItemId: string,
  sender: Electron.WebContents
): Promise<void> {
  try {
    const settings = await requireAnalysis().getProviderSettings()
    if (!settings.autoAnalyze) return
    if (!settings.connected) {
      let title = '工作资料'
      try {
        title = requireDatabase().getSource(sourceItemId).title
      } catch {
        // The source may have been deleted before the progress message is sent.
      }
      sendJobProgress(
        sender,
        sourceItemId,
        `${title} · 未连接 AI，资料已保存但未整理`,
        'analysis',
        undefined,
        undefined,
        true
      )
      return
    }
    await enqueueSourceAnalysis(sourceItemId, sender)
  } catch {
    // The material is already stored locally. The failed status and progress
    // message let the user retry without losing the uploaded content.
  }
}

function enqueueDailyAnalysis(
  workDate: string,
  sender: Electron.WebContents,
  automatic: boolean
): Promise<void> {
  if (!automatic) {
    const timerKey = `date:${workDate}`
    const pendingAutomaticRun = automaticAnalysisTimers.get(timerKey)
    if (pendingAutomaticRun) clearTimeout(pendingAutomaticRun)
    automaticAnalysisTimers.delete(timerKey)
  }
  const task = analysisQueue.catch(() => undefined).then(async () => {
    const prefix = automatic ? '自动生成日报' : '重新生成日报'
    if (automatic && requireDatabase().listSourcesForDate(workDate).length === 0) {
      requireDatabase().clearDailySynthesisForDate(workDate)
      sendJobProgress(sender, '', `${workDate} · 当天已无资料，旧日报已清除`, 'analysis', undefined, undefined, true)
      broadcastDataChanged()
      return
    }
    sendJobProgress(sender, '', `${workDate} · ${prefix}已开始`, 'analysis')
    try {
      await requireAnalysis().analyzeWorkDate(workDate, (message) => {
        sendJobProgress(sender, '', `${workDate} · ${message}`, 'analysis')
      })
      sendJobProgress(sender, '', `${workDate} · 明日早会逐字稿已生成`, 'analysis', undefined, undefined, true)
    } catch (error) {
      sendJobProgress(
        sender,
        '',
        `${workDate} · ${prefix}失败：${error instanceof Error ? error.message : String(error)}`,
        'analysis',
        undefined,
        undefined,
        true
      )
      throw error
    } finally {
      broadcastDataChanged()
    }
  })
  analysisQueue = task.catch(() => undefined)
  return task
}

function enqueueSourceAnalysis(
  sourceItemId: string,
  sender: Electron.WebContents,
  signal?: AbortSignal
): Promise<void> {
  const task = analysisQueue.catch(() => undefined).then(async () => {
    let sourceTitle = '跨日期资料'
    try {
      sourceTitle = requireDatabase().getSource(sourceItemId).title
    } catch {
      return
    }
    sendJobProgress(sender, sourceItemId, `${sourceTitle} · 正在识别各条工作的实际日期`, 'analysis')
    try {
      await requireAnalysis().analyzeSource(sourceItemId, (message) => {
        sendJobProgress(sender, sourceItemId, `${sourceTitle} · ${message}`, 'analysis')
      }, signal)
      sendJobProgress(sender, sourceItemId, `${sourceTitle} · 已按工作日期拆分并归档`, 'analysis', undefined, undefined, true)
    } catch (error) {
      sendJobProgress(
        sender,
        sourceItemId,
        `${sourceTitle} · 自动整理失败：${error instanceof Error ? error.message : String(error)}`,
        'analysis',
        undefined,
        undefined,
        true
      )
      throw error
    } finally {
      broadcastDataChanged()
    }
  })
  analysisQueue = task.catch(() => undefined)
  return task
}

function sendJobProgress(
  sender: Electron.WebContents,
  sourceItemId: string,
  message: string,
  jobType: JobProgressEvent['jobType'],
  current?: number,
  total?: number,
  finished?: boolean
): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC.jobProgress, { sourceItemId, message, jobType, current, total, finished })
  }
}

function requireDatabase(): WorkLensDatabase {
  if (!database) throw new Error('数据库尚未初始化')
  return database
}

function requireIngestion(): IngestionService {
  if (!ingestion) throw new Error('导入服务尚未初始化')
  return ingestion
}

function requireAnalysis(): AnalysisService {
  if (!analysis) throw new Error('AI 服务尚未初始化')
  return analysis
}

function requireExporter(): ExportService {
  if (!exporter) throw new Error('导出服务尚未初始化')
  return exporter
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'about' as const }, { role: 'quit' as const }] }]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
    }
  ])
}

async function createAutomaticSnapshot(
  workspaceDatabase: WorkLensDatabase,
  backupDirectory: string
): Promise<void> {
  await mkdir(backupDirectory, { recursive: true })
  workspaceDatabase.checkpoint()
  const fileName = `worklens-${new Date().toISOString().slice(0, 10)}.sqlite`
  const snapshotPath = join(backupDirectory, fileName)
  await copyFile(workspaceDatabase.filePath, snapshotPath)
  const snapshots = (await readdir(backupDirectory))
    .filter((entry) => /^worklens-\d{4}-\d{2}-\d{2}\.sqlite$/.test(entry))
    .sort()
  for (const staleSnapshot of snapshots.slice(0, -7)) {
    await rm(join(backupDirectory, staleSnapshot), { force: true })
  }
}
