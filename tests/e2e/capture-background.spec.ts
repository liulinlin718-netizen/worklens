import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ActionResult, JobProgressEvent } from '../../src/shared/contracts'

type BackgroundTestWindow = Window & { __pendingDuplicateAnalysis?: Promise<ActionResult> }

function analysisResponse(quote: string): string {
  const standup = {
    title: '验证工作早会稿', overview: quote, completed: [quote], inProgress: [], blockers: [],
    nextSteps: [], script: `大家早上好，昨天${quote}。目前没有明显阻塞。`
  }
  return JSON.stringify({
    id: 'local-background-test', choices: [{ message: { content: JSON.stringify({
      sourceDate: null,
      events: [{
        title: quote, workItemKey: quote, workItemTitle: quote.replace(/^完成/, '').replace(/验证$/, ''),
        eventType: '验证', eventDate: '2026-09-11', datePrecision: 'day', summary: quote,
        confidence: 1, evidence: [{ quote, blockIndex: null }]
      }],
      dailyBriefs: [{ workDate: '2026-09-11', ...standup }],
      summary: { title: '验证摘要', content: quote, highlights: [quote] }, standup
    }) } }]
  })
}

test('saves before a held AI response, preserves a failed record, and retries without duplication', async () => {
  const firstQuote = '完成 Atlas 登录模块验证'
  const retryQuote = '完成 Beacon 导出模块验证'
  let mode: 'hold' | 'fail' | 'success' = 'hold'
  let heldResponse: ServerResponse | undefined
  let analysisRequests = 0
  let requestArrived!: () => void
  const heldRequest = new Promise<void>((resolve) => { requestArrived = resolve })
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'local-background-model' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404
      response.end('{}')
      return
    }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    analysisRequests += 1
    if (mode === 'hold') {
      heldResponse = response
      requestArrived()
      return
    }
    if (mode === 'fail') {
      response.statusCode = 503
      response.end(JSON.stringify({ error: { message: '本地测试：整理服务暂时失败' } }))
      return
    }
    response.end(analysisResponse(body.includes('Beacon') ? retryQuote : firstQuote))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const userData = mkdtempSync(join(tmpdir(), 'worklens-capture-background-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`], env: { ...environment, NODE_ENV: 'test' }
    })
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const progressEvents: JobProgressEvent[] = []
    await page.exposeFunction('recordBackgroundProgress', (event: JobProgressEvent) => { progressEvents.push(event) })
    await page.evaluate(() => {
      const testWindow = window as unknown as { recordBackgroundProgress: (event: JobProgressEvent) => Promise<void> }
      window.worklens.onJobProgress((event) => { void testWindow.recordBackgroundProgress(event) })
    })
    await page.evaluate(async (baseUrl) => {
      await window.worklens.saveProviderSettings({ kind: 'openai_compatible', model: 'local-background-model',
        baseUrl, apiKey: 'disposable-local-key', sendImages: false, autoAnalyze: true })
      const connection = await window.worklens.testProvider()
      if (!connection.ok) throw new Error(connection.message)
    }, `http://127.0.0.1:${port}/v1`)
    await page.getByRole('button', { name: '工作资料库', exact: true }).click()

    const captured = page.evaluate((quote) => window.worklens.captureText({
      title: '等待响应的工作记录', text: `2026年9月11日${quote}。`, businessDate: '2026-09-11', deferAnalysis: true
    }), firstQuote)
    await heldRequest
    // The response latch remains closed until both the capture IPC and a fresh
    // database snapshot finish. An implementation that awaits AI cannot pass.
    const source = await captured
    expect(heldResponse?.writableEnded).toBe(false)
    const whileHeld = await page.evaluate(() => window.worklens.getSnapshot())
    expect(whileHeld.sources.find((item) => item.id === source.id)).toMatchObject({ rawText: `2026年9月11日${firstQuote}。` })
    expect(whileHeld.sources.find((item) => item.id === source.id)?.status).toBe('processing')
    expect(whileHeld.dailyBriefs).toHaveLength(0)
    const heldSourceRow = page.locator('.source-library-row').filter({ hasText: '等待响应的工作记录' })
    await expect(heldSourceRow.locator('.status-pill.processing')).toHaveText('合并中')

    // Submit the same source again while its first request is held. The IPC is
    // sent now; its promise is awaited only after the shared response is released.
    await page.evaluate((id) => {
      const testWindow = window as BackgroundTestWindow
      testWindow.__pendingDuplicateAnalysis = window.worklens.reanalyzeSource(id)
    }, source.id)
    await page.evaluate(() => window.worklens.getSnapshot())
    expect(analysisRequests).toBe(1)

    mode = 'success'
    heldResponse!.end(analysisResponse(firstQuote))
    expect((await page.evaluate(() => (window as BackgroundTestWindow).__pendingDuplicateAnalysis))?.ok).toBe(true)
    expect(analysisRequests).toBe(1)
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.worklens.getSnapshot())
      return snapshot.sources.find((item) => item.id === source.id)?.status
    }).toBe('ready')
    expect((await page.evaluate(() => window.worklens.getSnapshot())).dailyBriefs).toHaveLength(1)

    mode = 'fail'
    const failedSource = await page.evaluate((quote) => window.worklens.captureText({
      title: '可重试的工作记录', text: `2026年9月11日${quote}。`, businessDate: '2026-09-11', deferAnalysis: true
    }), retryQuote)
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.worklens.getSnapshot())
      return snapshot.sources.find((item) => item.id === failedSource.id)?.status
    }).toBe('failed')
    const failed = await page.evaluate(() => window.worklens.getSnapshot())
    expect(failed.sources.find((item) => item.id === failedSource.id)).toMatchObject({
      rawText: `2026年9月11日${retryQuote}。`, error: expect.stringContaining('整理服务暂时失败')
    })
    await expect.poll(() => progressEvents.some((event) => event.sourceItemId === failedSource.id && event.finished && event.outcome === 'error')).toBe(true)
    await expect(page.locator('.progress-banner.error[role="alert"]')).toContainText('整理服务暂时失败')
    await expect(page.locator('.source-library-row').filter({ hasText: '可重试的工作记录' }).locator('.status-pill.failed')).toHaveText('需重试')

    mode = 'success'
    const retry = await page.evaluate((id) => window.worklens.reanalyzeSource(id), failedSource.id)
    expect(retry.ok).toBe(true)
    const recovered = await page.evaluate(() => window.worklens.getSnapshot())
    expect(recovered.sources.map((item) => item.id).sort()).toEqual([source.id, failedSource.id].sort())
    expect(recovered.sources.find((item) => item.id === failedSource.id)).toMatchObject({ status: 'ready', error: null,
      rawText: `2026年9月11日${retryQuote}。` })
    expect(recovered.events.some((event) => event.summary.includes('Beacon'))).toBe(true)

    // One uploaded file can be present in both imported and failed when only AI
    // fails. The completion total must still count one physical input.
    mode = 'fail'
    const importText = '2026年9月11日完成 Cedar 数据模块验证。'
    const importPath = join(userData, '已保存但整理失败.txt')
    writeFileSync(importPath, importText)
    const importProgressStart = progressEvents.length
    await page.getByRole('button', { name: '批量上传', exact: true }).click()
    await page.locator('.batch-file-input').setInputFiles(importPath)
    await page.getByRole('button', { name: '开始处理 1 项', exact: true }).click()
    await expect.poll(() => progressEvents.slice(importProgressStart).find((event) => event.jobType === 'import' && event.finished)).toMatchObject({
      current: 1, total: 1, outcome: 'error'
    })
    const importFinished = progressEvents.slice(importProgressStart).find((event) => event.jobType === 'import' && event.finished)!
    expect(importFinished.message).toContain('原文已保存 1 份')
    expect(importFinished.message).toContain('AI 整理失败 1 份，可重试')
    expect(importFinished.message).not.toContain('导入失败')
    const afterImport = await page.evaluate(() => window.worklens.getSnapshot())
    expect(afterImport.sources).toHaveLength(3)
    const importedSource = afterImport.sources.filter((item) => item.id !== source.id && item.id !== failedSource.id)
    expect(importedSource).toHaveLength(1)
    expect(importedSource[0]).toMatchObject({ rawText: importText, status: 'failed', error: expect.stringContaining('整理服务暂时失败') })
  } finally {
    heldResponse?.destroy()
    await electronApp?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(userData, { recursive: true, force: true })
  }
})
