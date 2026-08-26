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
    const exportResults = await page.evaluate(async () => {
      const formats = ['markdown', 'pdf', 'csv', 'zip'] as const
      const results = []
      for (const format of formats) {
        results.push(
          await window.worklens.exportData({
            format,
            fromDate: null,
            toDate: null,
            includeAttachments: true
          })
        )
      }
      return results
    })
    expect(exportResults.every((result) => result.ok)).toBe(true)
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
