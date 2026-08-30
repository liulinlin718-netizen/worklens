import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('splits a multi-day upload into timeline events and one traceable work item', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'worklens-test-model' }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      response.end(
        JSON.stringify({
          id: 'stub-run-1',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sourceDate: null,
                  events: [
                    {
                      title: '游戏 Agent 记忆方案完成评审',
                      workItemKey: 'agent-memory-plan',
                      workItemTitle: '游戏 Agent 记忆方案',
                      eventType: '评审',
                      eventDate: '2026-07-15',
                      datePrecision: 'day',
                      summary: '团队完成记忆方案评审。',
                      confidence: 0.94,
                      evidence: [{ quote: '完成游戏 Agent 记忆方案评审', blockIndex: 0 }]
                    },
                    {
                      title: '游戏 Agent 记忆方案进入验证',
                      workItemKey: 'agent-memory-plan',
                      workItemTitle: '游戏 Agent 记忆方案',
                      eventType: '验证',
                      eventDate: '2026-07-16',
                      datePrecision: 'day',
                      summary: '记忆方案进入验证，并开始补充失败重试入口。',
                      confidence: 0.91,
                      evidence: [{ quote: '开始验证记忆方案，需要增加失败重试入口', blockIndex: 1 }]
                    }
                  ],
                  dailyBriefs: [
                    {
                      workDate: '2026-07-15',
                      title: '记忆方案评审早会汇报',
                      overview: '完成记忆方案评审。',
                      completed: ['完成游戏 Agent 记忆方案评审'],
                      inProgress: [], blockers: [], nextSteps: ['开始方案验证'],
                      script: '大家早上好，昨天完成了游戏 Agent 记忆方案评审。今天开始验证，目前没有明显阻塞。'
                    },
                    {
                      workDate: '2026-07-16',
                      title: '记忆方案验证早会汇报',
                      overview: '记忆方案进入验证。',
                      completed: [], inProgress: ['验证记忆方案'], blockers: [], nextSteps: ['补充失败重试入口'],
                      script: '大家早上好，记忆方案已经进入验证。今天补充失败重试入口，目前没有明显阻塞。'
                    }
                  ],
                  summary: {
                    title: '记忆方案评审摘要',
                    content: '已完成方案评审，并形成失败重试需求。',
                    highlights: ['完成记忆方案评审', '补充失败重试入口']
                  },
                  standup: {
                    title: '记忆方案早会汇报',
                    overview: '昨天完成记忆方案评审，并确认失败重试事项。',
                    completed: ['完成游戏 Agent 记忆方案评审'],
                    inProgress: ['推进失败重试入口'],
                    blockers: [],
                    nextSteps: ['完成失败重试入口方案'],
                    script: '大家早上好，昨天完成了游戏 Agent 记忆方案评审。今天会继续推进失败重试入口，目前没有明显阻塞。'
                  }
                })
              }
            }
          ]
        })
      )
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const userData = mkdtempSync(join(tmpdir(), 'worklens-ai-e2e-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...environment, NODE_ENV: 'test' }
  })

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const sourceId = await page.evaluate(async (baseUrl) => {
      await window.worklens.saveProviderSettings({
        kind: 'openai_compatible',
        model: 'worklens-test-model',
        baseUrl,
        apiKey: 'local-test-key',
        sendImages: false,
        autoAnalyze: true
      })
      const connection = await window.worklens.testProvider()
      if (!connection.ok) throw new Error(connection.message)
      const source = await window.worklens.captureText({
        title: 'Agent 记忆评审',
        text: '7.15：完成游戏 Agent 记忆方案评审。\n7.16：开始验证记忆方案，需要增加失败重试入口。',
        businessDate: null
      })
      return source.id
    }, `http://127.0.0.1:${port}/v1`)

    await expect.poll(
      () => page.evaluate(async (id) => {
        const snapshot = await window.worklens.getSnapshot()
        return snapshot.sources.find((source) => source.id === id)?.status
      }, sourceId),
      { timeout: 15_000 }
    ).toBe('ready')
    const finalSnapshot = await page.evaluate(() => window.worklens.getSnapshot())

    expect(finalSnapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '游戏 Agent 记忆方案完成评审', eventDate: '2026-07-15' }),
        expect.objectContaining({ title: '游戏 Agent 记忆方案进入验证', eventDate: '2026-07-16' })
      ])
    )
    expect(finalSnapshot.workItems).toEqual([
      expect.objectContaining({ title: '游戏 Agent 记忆方案', eventCount: 2, latestDate: '2026-07-16' })
    ])
    expect(finalSnapshot.sources[0]).toMatchObject({ businessDate: null, workDates: ['2026-07-15', '2026-07-16'] })
    expect(finalSnapshot.dailyBriefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workDate: '2026-07-15', title: '记忆方案评审早会汇报' }),
        expect.objectContaining({ workDate: '2026-07-16', title: '记忆方案验证早会汇报' })
      ])
    )
    expect(finalSnapshot.dailyBriefs[0]!.script).toContain('大家早上好')

    await page.getByRole('button', { name: '早会逐字稿' }).click()
    const scriptEditor = page.getByLabel('逐字稿正文')
    await expect(scriptEditor).toBeVisible()
    await scriptEditor.fill('大家早上好，昨天完成了记忆方案评审。今天继续完善失败重试入口。')
    await scriptEditor.evaluate((element) => {
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nHQAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0)
      )
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([bytes], '评审截图.png', { type: 'image/png' }))
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
      )
    })
    await expect(page.locator('.script-image-grid figure')).toHaveCount(1)
    await page.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByText('逐字稿修改已保存')).toBeVisible()
    const editedBrief = (await page.evaluate(() => window.worklens.getSnapshot())).dailyBriefs[0]!
    expect(editedBrief.script).toContain('继续完善失败重试入口')
    expect(editedBrief.images).toHaveLength(1)

    await page.getByRole('button', { name: '工作时间线' }).click()
    const contentScrollbar = await page.locator('main.content').evaluate((content) => {
      const style = getComputedStyle(content)
      const scrollbarStyle = getComputedStyle(content, '::-webkit-scrollbar')
      return {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollbarGutter: style.scrollbarGutter,
        scrollbarWidth: scrollbarStyle.width
      }
    })
    expect(contentScrollbar).toEqual({
      overflowX: 'hidden',
      overflowY: 'scroll',
      scrollbarGutter: 'stable',
      scrollbarWidth: '10px'
    })
    const historyMarkers = page.locator('.timeline-history-markers button')
    await expect(historyMarkers).toHaveCount(2)
    await expect(historyMarkers.first()).toHaveAttribute('aria-label', /7 月 15 日/)
    await expect(historyMarkers.last()).toHaveAttribute('aria-label', /7 月 16 日/)
    await historyMarkers.first().click()
    await expect(historyMarkers.first()).toHaveAttribute('aria-current', 'date')
    await page.mouse.move(0, 0)
    await historyMarkers.first().hover()
    await expect(page.locator('.timeline-history-tooltip')).toContainText('7 月 15 日')
    await expect(page.locator('.timeline-history-tooltip')).toContainText('游戏 Agent 记忆方案完成评审')
    const timelineGeometry = await page.evaluate(() => {
      const markers = document.querySelector<HTMLElement>('.timeline-history-markers')!
      const buttons = Array.from(markers.querySelectorAll<HTMLElement>('button'))
      const preview = document.querySelector<HTMLElement>('.timeline-history-tooltip')!
      const markersBox = markers.getBoundingClientRect()
      const contentBox = document.querySelector<HTMLElement>('main.content')!.getBoundingClientRect()
      const pageBox = document.querySelector<HTMLElement>('.timeline-page')!.getBoundingClientRect()
      const firstBox = buttons[0]!.getBoundingClientRect()
      const lastBox = buttons.at(-1)!.getBoundingClientRect()
      const previewBox = preview.getBoundingClientRect()
      return {
        markerCenterOffset: Math.abs((firstBox.top + lastBox.bottom) / 2 - (markersBox.top + markersBox.height / 2)),
        markerViewportCenterOffset: Math.abs(markersBox.top + markersBox.height / 2 - (contentBox.top + contentBox.height / 2)),
        markerLeftOffset: pageBox.left - markersBox.left,
        activeLineWidth: buttons[0]!.querySelector<HTMLElement>('.timeline-history-line')!.getBoundingClientRect().width,
        markerTop: markersBox.top,
        markerScrollTop: markers.scrollTop,
        previewCenterOffset: Math.abs(previewBox.top + previewBox.height / 2 - (window.innerHeight + 92) / 2),
        previewHeight: previewBox.height
      }
    })
    expect(timelineGeometry.markerCenterOffset).toBeLessThan(2)
    expect(timelineGeometry.markerViewportCenterOffset).toBeLessThan(2)
    expect(timelineGeometry.markerLeftOffset).toBeGreaterThanOrEqual(11)
    expect(timelineGeometry.activeLineWidth).toBeLessThanOrEqual(22.1)
    expect(timelineGeometry.markerScrollTop).toBe(0)
    expect(timelineGeometry.previewCenterOffset).toBeLessThan(2)
    expect(timelineGeometry.previewHeight).toBeLessThanOrEqual(300)
    const wheelResult = await historyMarkers.first().evaluate(async (button) => {
      const activeSequence: string[] = []
      const recordActive = (): void => {
        const label = document.querySelector<HTMLElement>('.timeline-history-markers [aria-current="date"]')?.getAttribute('aria-label') ?? ''
        if (label && activeSequence.at(-1) !== label) activeSequence.push(label)
      }
      recordActive()
      const canceled = !button.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
      const startedAt = performance.now()
      while (performance.now() - startedAt < 650) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        recordActive()
      }
      return { canceled, activeSequence }
    })
    expect(wheelResult.canceled).toBe(true)
    expect(wheelResult.activeSequence).toHaveLength(2)
    expect(wheelResult.activeSequence[0]).toContain('7 月 15 日')
    expect(wheelResult.activeSequence[1]).toContain('7 月 16 日')
    await expect(historyMarkers.last()).toHaveAttribute('aria-current', 'date')
    await page.waitForTimeout(350)
    const markerAfterWheel = await page.locator('.timeline-history-markers').evaluate((markers) => ({ top: markers.getBoundingClientRect().top, scrollTop: markers.scrollTop }))
    expect(Math.abs(markerAfterWheel.top - timelineGeometry.markerTop)).toBeLessThan(2)
    expect(markerAfterWheel.scrollTop).toBe(0)
    const timelineCards = page.locator('.timeline-card-trigger')
    await expect(timelineCards).toHaveCount(2)
    await timelineCards.first().click()
    await expect(page.locator('.timeline-card-detail')).toHaveCount(1)
    await expect(page.getByText('相关原文：')).toBeVisible()
    await expect(page.getByRole('button', { name: /打开完整原始资料/ })).toBeVisible()
    await timelineCards.nth(1).click()
    await expect(page.locator('.timeline-card-detail')).toHaveCount(1)
    await expect(timelineCards.first()).toHaveAttribute('aria-expanded', 'false')
    await expect(timelineCards.nth(1)).toHaveAttribute('aria-expanded', 'true')
    const timelineActionAlignment = await page.locator('.timeline-expand-card.expanded').evaluate((card) => {
      const chevron = card.querySelector<SVGElement>('.timeline-card-trigger > svg')!.getBoundingClientRect()
      const deleteButton = card.querySelector<HTMLButtonElement>('.timeline-card-delete')!.getBoundingClientRect()
      const detail = card.querySelector<HTMLElement>('.timeline-card-detail')!.getBoundingClientRect()
      return {
        actionGap: deleteButton.left - chevron.right,
        centerOffset: Math.abs((deleteButton.top + deleteButton.height / 2) - (chevron.top + chevron.height / 2)),
        detailRightOffset: Math.abs(deleteButton.right - detail.right)
      }
    })
    expect(timelineActionAlignment.actionGap).toBeGreaterThanOrEqual(8)
    expect(timelineActionAlignment.centerOffset).toBeLessThanOrEqual(1)
    expect(timelineActionAlignment.detailRightOffset).toBeLessThanOrEqual(2)

    const timelineDeleteButtons = page.getByRole('button', { name: /删除时间线内容：/ })
    await expect(timelineDeleteButtons).toHaveCount(2)
    await timelineDeleteButtons.first().click()
    const timelineDeleteDialog = page.getByRole('alertdialog')
    await expect(timelineDeleteDialog).toContainText('原始资料和日报不会被删除')
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.timeline-card-trigger')).toHaveCount(1)
    const afterTimelineDelete = await page.evaluate(() => window.worklens.getSnapshot())
    expect(afterTimelineDelete.events).toHaveLength(1)
    expect(afterTimelineDelete.sources).toHaveLength(1)
    expect(afterTimelineDelete.dailyBriefs).toHaveLength(2)

    await page.getByRole('button', { name: '工作事项' }).click()
    const evidenceButtons = page.locator('.mini-evidence')
    await expect(evidenceButtons).toHaveCount(1)
    await evidenceButtons.first().click()
    await expect(page.locator('.work-item-expanded')).toHaveCount(1)
    await expect(page.locator('.work-item-history > article')).toHaveCount(1)
    await expect(page.locator('.work-item-sources > button')).toHaveCount(1)

    await page.getByRole('button', { name: /删除工作事项：/ }).click()
    const workItemDeleteDialog = page.getByRole('alertdialog')
    await expect(workItemDeleteDialog).toContainText('1 条历史工作内容')
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.work-item-card')).toHaveCount(0)
    const afterWorkItemDelete = await page.evaluate(() => window.worklens.getSnapshot())
    expect(afterWorkItemDelete.events).toHaveLength(0)
    expect(afterWorkItemDelete.workItems).toHaveLength(0)
    expect(afterWorkItemDelete.sources).toHaveLength(1)
    expect(afterWorkItemDelete.dailyBriefs).toHaveLength(2)

    await page.getByRole('textbox', { name: '全局搜索' }).fill('游戏 Agent')
    await expect(page.locator('.search-result').first()).toBeVisible()
    await page.locator('.search-result').filter({ hasText: 'Agent 记忆评审' }).first().click()
    await expect(page.locator('.source-drawer')).toBeVisible()
    await page.getByRole('button', { name: '关闭原始资料' }).click()

    const exportDirectory = join(userData, 'exports')
    await electronApp.evaluate(({ dialog }, outputDirectory) => {
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.SaveDialogOptions
        const extension = options.filters?.[0]?.extensions[0] ?? 'dat'
        return {
          canceled: false,
          filePath: `${outputDirectory}/worklens-export.${extension}`
        }
      }
    }, exportDirectory)
    await page.getByRole('button', { name: '导出与备份' }).click()
    await page.getByRole('button', { name: /工作汇报 Markdown/ }).click()
    await expect(page.getByText('请先选择完整的开始与结束日期')).toBeVisible()
    const dateInputs = page.locator('.date-range input[type="date"]')
    await dateInputs.first().fill('2026-07-15')
    await dateInputs.nth(1).fill('2026-07-15')
    await expect(page.getByText('当前范围：2026-07-15 至 2026-07-15')).toBeVisible()
    for (const name of [/工作汇报 Markdown/, /工作汇报 PDF/, /日报 CSV/]) {
      await page.getByRole('button', { name }).click()
      await expect(page.getByText('导出完成', { exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: '立即备份' }).click()
    await expect(page.getByText('备份已创建')).toBeVisible()
    for (const extension of ['md', 'pdf', 'csv', 'zip']) {
      const path = join(exportDirectory, `worklens-export.${extension}`)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).size).toBeGreaterThan(100)
    }

    await page.getByRole('textbox', { name: '全局搜索' }).fill('Agent 记忆评审')
    await page.locator('.search-result').filter({ hasText: 'Agent 记忆评审' }).first().click()
    await page.getByRole('button', { name: '删除资料' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.source-drawer')).toHaveCount(0)
    const deletedSnapshot = await page.evaluate(() => window.worklens.getSnapshot())
    expect(deletedSnapshot.sources).toHaveLength(0)
    expect(deletedSnapshot.events).toHaveLength(0)
    expect(deletedSnapshot.workItems).toHaveLength(0)
  } finally {
    await electronApp.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    rmSync(userData, { recursive: true, force: true })
  }
})
