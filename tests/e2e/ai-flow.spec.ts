import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('merges one workday in the isolated AI host and materializes its stand-up brief', async () => {
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
                  sourceDate: {
                    value: '2026-07-15',
                    precision: 'day',
                    confidence: 0.98,
                    rationale: '资料包含明确日期'
                  },
                  events: [
                    {
                      title: '游戏 Agent 记忆方案评审',
                      eventType: '评审',
                      eventDate: '2026-07-15',
                      datePrecision: 'day',
                      summary: '团队完成记忆方案评审。',
                      confidence: 0.94,
                      evidence: [{ quote: '完成游戏 Agent 记忆方案评审', blockIndex: 0 }]
                    },
                    {
                      title: '失败重试入口方案',
                      eventType: '计划',
                      eventDate: '2026-07-15',
                      datePrecision: 'day',
                      summary: '评审后需要补充失败重试入口。',
                      confidence: 0.91,
                      evidence: [{ quote: '需要增加失败重试入口', blockIndex: 0 }]
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
    const finalSnapshot = await page.evaluate(async (baseUrl) => {
      await window.worklens.saveProviderSettings({
        kind: 'openai_compatible',
        model: 'worklens-test-model',
        baseUrl,
        apiKey: 'local-test-key',
        sendImages: false,
        autoAnalyze: false
      })
      const connection = await window.worklens.testProvider()
      if (!connection.ok) throw new Error(connection.message)
      const source = await window.worklens.captureText({
        title: 'Agent 记忆评审',
        text: '2026年7月15日完成游戏 Agent 记忆方案评审，需要增加失败重试入口。',
        businessDate: null
      })
      const analysis = await window.worklens.generateDailyBrief('2026-07-15')
      if (!analysis.ok) throw new Error(analysis.message)
      return window.worklens.getSnapshot()
    }, `http://127.0.0.1:${port}/v1`)

    expect(finalSnapshot.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: '游戏 Agent 记忆方案评审' })])
    )
    expect(finalSnapshot.dailyBriefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workDate: '2026-07-15', title: '记忆方案早会汇报' })
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
    const timelineCards = page.locator('.timeline-card-trigger')
    await expect(timelineCards).toHaveCount(2)
    await timelineCards.first().click()
    await expect(page.locator('.timeline-card-detail')).toHaveCount(1)
    await expect(page.getByText('原文内容：')).toBeVisible()
    await timelineCards.nth(1).click()
    await expect(page.locator('.timeline-card-detail')).toHaveCount(1)
    await expect(timelineCards.first()).toHaveAttribute('aria-expanded', 'false')
    await expect(timelineCards.nth(1)).toHaveAttribute('aria-expanded', 'true')

    await page.getByRole('button', { name: '工作事项' }).click()
    const evidenceButtons = page.locator('.mini-evidence')
    await expect(evidenceButtons).toHaveCount(2)
    await evidenceButtons.first().click()
    await expect(page.locator('.evidence-original')).toHaveCount(1)
    await evidenceButtons.nth(1).click()
    await expect(page.locator('.evidence-original')).toHaveCount(1)
    await expect(evidenceButtons.first()).toHaveAttribute('aria-expanded', 'false')
    await expect(evidenceButtons.nth(1)).toHaveAttribute('aria-expanded', 'true')

    await page.getByRole('textbox', { name: '全局搜索' }).fill('游戏 Agent')
    await expect(page.locator('.search-result')).toHaveCount(3)
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
  } finally {
    await electronApp.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    rmSync(userData, { recursive: true, force: true })
  }
})
