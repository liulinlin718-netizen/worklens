// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { App } from '../../src/renderer/src/App'
import type { AppSnapshot, ImportResult, JobProgressEvent, ProviderSettings, SearchHit, SourceItem, WorkLensApi } from '../../src/shared/contracts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function source(id: string, rawText = '原始工作资料'): SourceItem {
  return { id, title: `资料 ${id}`, kind: 'text', rawText, excerpt: rawText, businessDate: '2026-09-13', datePrecision: 'day', dateOrigin: 'manual', status: 'queued', error: null, contentHash: id, assetCount: 0, workDates: ['2026-09-13'], createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z' }
}

function setupApi() {
  const state = { snapshot: { sources: [], events: [], workItems: [], dailyBriefs: [], dashboard: { totals: { sources: 0, events: 0, dailyBriefs: 0, processing: 0 }, eventTypes: [], activity: [], latestBrief: null } } as AppSnapshot }
  const settings: ProviderSettings = { kind: 'codex_cli', model: 'auto', baseUrl: '', hasApiKey: false, sendImages: false, autoAnalyze: true, connected: false, connectedAt: null, connectionMessage: '未连接 AI' }
  let progressListener: ((event: JobProgressEvent) => void) | undefined
  let dataListener: (() => void) | undefined
  const api = {
    getSnapshot: vi.fn(async () => state.snapshot),
    getProviderSettings: vi.fn(async () => settings),
    onDataChanged: vi.fn((listener: () => void) => { dataListener = listener; return () => { dataListener = undefined } }),
    onJobProgress: vi.fn((listener: (event: JobProgressEvent) => void) => { progressListener = listener; return () => { progressListener = undefined } }),
    captureText: vi.fn(async (input: { text: string }) => { const next = source(`saved-${state.snapshot.sources.length}`, input.text); state.snapshot = { ...state.snapshot, sources: [...state.snapshot.sources, next] }; return next }),
    importDroppedFiles: vi.fn(async (): Promise<ImportResult> => ({ imported: [], failed: [], duplicates: [], cancelled: false })),
    search: vi.fn(async (): Promise<SearchHit[]> => []), listSourceAssets: vi.fn(async () => []),
    retryImportSource: vi.fn(async (): Promise<ImportResult> => ({ imported: [], failed: [], duplicates: [], cancelled: false })),
    reanalyzeSource: vi.fn(async () => ({ ok: true, message: '整理完成' })),
    cancelImport: vi.fn(async () => ({ ok: true, message: '正在停止' }))
  }
  window.worklens = api as unknown as WorkLensApi
  return { state, settings, api, progress: (event: JobProgressEvent) => progressListener?.(event), dataChanged: () => dataListener?.() }
}

function navigate(name: string): void {
  fireEvent.click(within(document.querySelector<HTMLElement>('.sidebar')!).getByRole('button', { name }))
}

async function renderApp() {
  const view = render(createElement(App))
  await screen.findByRole('heading', { name: '工作记录趋势' })
  return view
}

function captureTextArea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/^例如：/) as HTMLTextAreaElement
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('entry drafts and active processing in the complete app', () => {
  it('restores an unsaved capture title, body and date after page navigation and app remount', async () => {
    setupApi()
    const view = await renderApp()
    navigate('每日记录')
    fireEvent.change(screen.getByLabelText('工作日期'), { target: { value: '2026-09-10' } })
    fireEvent.change(screen.getByPlaceholderText('给这条记录起个标题（可选）'), { target: { value: '还未提交的标题' } })
    fireEvent.change(captureTextArea(), { target: { value: '这是尚未保存为资料的工作内容。' } })
    navigate('工作事项')
    navigate('每日记录')
    expect(captureTextArea()).toHaveValue('这是尚未保存为资料的工作内容。')
    view.unmount()
    await renderApp()
    navigate('每日记录')
    expect(screen.getByLabelText('工作日期')).toHaveValue('2026-09-10')
    expect(screen.getByPlaceholderText('给这条记录起个标题（可选）')).toHaveValue('还未提交的标题')
    expect(captureTextArea()).toHaveValue('这是尚未保存为资料的工作内容。')
  })

  it('keeps typing made during a pending capture and blocks duplicate submits after returning to the page', async () => {
    const { api } = setupApi()
    const pending = deferred<SourceItem>()
    api.captureText.mockImplementationOnce(() => pending.promise)
    await renderApp()
    navigate('每日记录')
    fireEvent.change(captureTextArea(), { target: { value: '提交时的原文' } })
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    fireEvent.change(captureTextArea(), { target: { value: '提交时的原文\n保存期间补充的文字' } })
    navigate('工作事项')
    navigate('每日记录')
    expect(screen.getByRole('button', { name: '正在保存原文' })).toBeDisabled()
    await act(async () => pending.resolve(source('saved', '提交时的原文')))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存记录' })).toBeEnabled())
    expect(captureTextArea()).toHaveValue('提交时的原文\n保存期间补充的文字')
    expect(api.captureText).toHaveBeenCalledOnce()
    expect(api.captureText).toHaveBeenCalledWith(expect.objectContaining({ text: '提交时的原文', deferAnalysis: true }))
  })

  it('does not discard the body when a draft is persisted with its date temporarily cleared', async () => {
    setupApi()
    const view = await renderApp()
    navigate('每日记录')
    fireEvent.change(captureTextArea(), { target: { value: '日期还没选好，但这些文字不能丢失。' } })
    fireEvent.change(screen.getByLabelText('工作日期'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: '保存记录' })).toBeDisabled()
    view.unmount()
    await renderApp()
    navigate('每日记录')
    expect(captureTextArea()).toHaveValue('日期还没选好，但这些文字不能丢失。')
    expect(screen.getByLabelText('工作日期')).toHaveValue('')
    expect(screen.getByRole('button', { name: '保存记录' })).toBeDisabled()
  })

  it('keeps mixed file/text queues through navigation and persists unsubmitted pasted text across remount', async () => {
    setupApi()
    const view = await renderApp()
    navigate('批量上传')
    const file = new File(['文件原文'], '工作记录.txt', { type: 'text/plain' })
    fireEvent.change(document.querySelector('.batch-file-input')!, { target: { files: [file] } })
    fireEvent.change(captureTextArea(), { target: { value: '粘贴到队列的原文' } })
    fireEvent.click(screen.getByRole('button', { name: '加入待处理' }))
    fireEvent.change(captureTextArea(), { target: { value: '还在编辑的下一段内容' } })
    navigate('每日记录')
    navigate('批量上传')
    expect(screen.getByRole('button', { name: '移除 工作记录.txt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除 粘贴到队列的原文' })).toBeInTheDocument()
    expect(captureTextArea()).toHaveValue('还在编辑的下一段内容')
    view.unmount()
    await renderApp()
    navigate('批量上传')
    expect(screen.getByRole('button', { name: '移除 粘贴到队列的原文' })).toBeInTheDocument()
    expect(captureTextArea()).toHaveValue('还在编辑的下一段内容')
  })

  it('preserves failed pasted originals and retries the exact text from the retained result after navigation', async () => {
    const { api } = setupApi()
    api.captureText.mockRejectedValueOnce(new Error('磁盘暂时不可写'))
    await renderApp()
    navigate('批量上传')
    const original = '粘贴失败测试\n这段原文必须能够重新保存。'
    fireEvent.change(captureTextArea(), { target: { value: original } })
    fireEvent.click(screen.getByRole('button', { name: '加入待处理' }))
    fireEvent.click(screen.getByRole('button', { name: '开始处理 1 项' }))
    await screen.findByRole('button', { name: '重新保存' })
    expect(screen.getByText('粘贴原文已保留在待处理列表')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('worklens.batch-text-draft.v1')!).pendingTexts[0].text).toBe(original)
    navigate('工作事项')
    navigate('批量上传')
    fireEvent.click(screen.getByRole('button', { name: '重新保存' }))
    await screen.findByText('粘贴原文已保存，可在本批结果中继续查看整理状态')
    expect(screen.queryByRole('button', { name: '重新保存' })).not.toBeInTheDocument()
    expect(api.captureText).toHaveBeenLastCalledWith({ title: '', text: original, businessDate: null, deferAnalysis: true })
    expect(JSON.parse(localStorage.getItem('worklens.batch-text-draft.v1')!).pendingTexts).toEqual([])
    expect(screen.getByRole('heading', { name: '本次归档结果' })).toBeInTheDocument()
  })

  it('retains live batch progress and final results when leaving and reentering the page', async () => {
    const { api, state, progress } = setupApi()
    const pending = deferred<ImportResult>()
    api.importDroppedFiles.mockImplementationOnce(() => pending.promise)
    await renderApp()
    navigate('批量上传')
    fireEvent.change(document.querySelector('.batch-file-input')!, { target: { files: [new File(['原文'], '正在导入.txt')] } })
    fireEvent.click(screen.getByRole('button', { name: '开始处理 1 项' }))
    act(() => progress({ sourceItemId: '', jobType: 'import', message: '正在解析测试文件', current: 1, total: 3 }))
    navigate('每日记录')
    expect(screen.getByText('批量资料正在后台处理，切换页面不会中断')).toBeInTheDocument()
    navigate('批量上传')
    expect(screen.getByRole('heading', { name: '正在整理这批资料' })).toBeInTheDocument()
    expect(document.querySelector('.batch-processing')).toHaveTextContent('正在解析测试文件')
    const saved = source('imported')
    state.snapshot = { ...state.snapshot, sources: [saved] }
    await act(async () => pending.resolve({ imported: [saved], duplicates: [], failed: [], cancelled: false }))
    await screen.findByRole('heading', { name: '本次归档结果' })
    navigate('工作事项')
    fireEvent.click(screen.getByRole('button', { name: '查看本批结果' }))
    expect(screen.getByRole('heading', { name: '本次归档结果' })).toBeInTheDocument()
    expect(api.importDroppedFiles).toHaveBeenCalledOnce()
  })

  it('keeps a failed manual analysis actionable in the batch result and succeeds on a later retry', async () => {
    const { api, settings, state } = setupApi()
    settings.connected = true
    settings.autoAnalyze = false
    await renderApp()
    navigate('批量上传')
    fireEvent.change(captureTextArea(), { target: { value: '需要后续人工开始整理的原文' } })
    fireEvent.click(screen.getByRole('button', { name: '加入待处理' }))
    fireEvent.click(screen.getByRole('button', { name: '开始处理 1 项' }))
    await screen.findByRole('button', { name: '开始整理' })
    const saved = state.snapshot.sources[0]!
    api.retryImportSource.mockResolvedValueOnce({ imported: [saved], duplicates: [], failed: [], cancelled: false })
    api.reanalyzeSource.mockImplementationOnce(async () => {
      state.snapshot = { ...state.snapshot, sources: [{ ...saved, status: 'failed', error: '本次 AI 连接中断' }] }
      throw new Error('本次 AI 连接中断')
    })
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }))
    await screen.findByRole('button', { name: '重新解析' })
    expect(document.querySelector('.batch-summary')).toHaveTextContent('1 份失败')
    navigate('每日记录')
    navigate('批量上传')
    expect(screen.getByRole('button', { name: '重试整理' })).toBeInTheDocument()
    api.retryImportSource.mockImplementationOnce(async () => {
      const ready: SourceItem = { ...saved, status: 'ready' }
      state.snapshot = { ...state.snapshot, sources: [ready] }
      return { imported: [ready], duplicates: [], failed: [], cancelled: false }
    })
    fireEvent.click(screen.getByRole('button', { name: '重新解析' }))
    await screen.findByText('整理完成，可查看对应早会稿')
    expect(screen.queryByRole('button', { name: '重新解析' })).not.toBeInTheDocument()
    expect(document.querySelector('.batch-summary')).toHaveTextContent('0 份失败')
  })

  it('clears obsolete batch failure messages when the source is repaired elsewhere', async () => {
    const { api, state, dataChanged } = setupApi()
    const failed: SourceItem = { ...source('repair-elsewhere'), status: 'failed', error: '需要重新整理' }
    api.captureText.mockImplementationOnce(async () => {
      state.snapshot = { ...state.snapshot, sources: [failed] }
      return failed
    })
    await renderApp()
    navigate('批量上传')
    fireEvent.change(captureTextArea(), { target: { value: '稍后从其他入口重试的原文' } })
    fireEvent.click(screen.getByRole('button', { name: '加入待处理' }))
    fireEvent.click(screen.getByRole('button', { name: '开始处理 1 项' }))
    await screen.findByRole('button', { name: '重新解析' })
    navigate('每日记录')
    state.snapshot = { ...state.snapshot, sources: [{ ...failed, status: 'ready', error: null }] }
    await act(async () => dataChanged())
    navigate('批量上传')
    expect(screen.queryByRole('button', { name: '重新解析' })).not.toBeInTheDocument()
    expect(document.querySelector('.batch-summary')).toHaveTextContent('0 份失败')
    expect(screen.getByRole('button', { name: '完成并查看时间线' })).toBeInTheDocument()
  })
})

describe('search destination integration', () => {
  it('opens the specific work item and opens original search hits in the library drawer', async () => {
    const { state, api } = setupApi()
    const original = source('original', '支付项目的原始记录')
    state.snapshot.sources = [original]
    state.snapshot.events = [{ id: 'event-target', title: '接口进展', workItemKey: 'payment', workItemTitle: '支付项目', eventType: '开发', eventDate: '2026-09-13', datePrecision: 'day', summary: '完成联调', sourceItemId: original.id, confidence: 0.9, manualLocked: false, evidence: [], requirementIds: [], createdAt: original.createdAt, updatedAt: original.updatedAt }]
    state.snapshot.workItems = [{ id: 'payment', key: 'payment', title: '支付项目', eventType: '开发', firstDate: '2026-09-13', latestDate: '2026-09-13', summary: '完成联调', confidence: 0.9, evidence: [], sourceItemIds: [original.id], eventIds: ['event-target'], eventCount: 1, updatedAt: original.updatedAt }]
    api.search.mockResolvedValueOnce([{ entityType: 'event', entityId: 'event-target', title: '检索命中支付项目', excerpt: '接口进展', date: '2026-09-13', rank: 1 }])
    await renderApp()
    fireEvent.change(screen.getByLabelText('全局搜索'), { target: { value: '支付' } })
    fireEvent.click(await screen.findByRole('button', { name: /检索命中支付项目/ }))
    const target = await screen.findByRole('article', { name: '工作事项：支付项目' })
    await waitFor(() => expect(target).toHaveFocus())
    expect(within(target).getByRole('button', { name: /1 次进展/ })).toHaveAttribute('aria-expanded', 'true')
    api.search.mockResolvedValueOnce([{ entityType: 'source', entityId: original.id, title: '检索原始记录', excerpt: '来源', date: '2026-09-13', rank: 1 }])
    fireEvent.change(screen.getByLabelText('全局搜索'), { target: { value: '原始资料' } })
    fireEvent.click(await screen.findByRole('button', { name: /检索原始记录/ }))
    expect(screen.getByRole('heading', { level: 1, name: '工作资料库' })).toBeInTheDocument()
    expect(document.querySelector('.source-drawer')).toHaveTextContent(original.rawText)
    await waitFor(() => expect(api.listSourceAssets).toHaveBeenCalledWith(original.id))
  })

  it('reports a stale search hit explicitly instead of navigating to an unrelated item', async () => {
    const { api } = setupApi()
    api.search.mockResolvedValueOnce([{ entityType: 'event', entityId: 'deleted-event', title: '已移除的事项命中', excerpt: '旧索引', date: null, rank: 1 }])
    await renderApp()
    fireEvent.change(screen.getByLabelText('全局搜索'), { target: { value: '已移除' } })
    fireEvent.click(await screen.findByRole('button', { name: /已移除的事项命中/ }))
    await waitFor(() => expect(document.querySelector('.toast.error')).toHaveTextContent(/不存在|已删除|移除|未找到|找不到/))
    expect(screen.queryByRole('article', { name: /^工作事项：/ })).not.toBeInTheDocument()
  })
})
