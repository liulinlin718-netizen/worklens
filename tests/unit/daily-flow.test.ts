import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalysisService } from '@core/ai/analyzer'
import type { AiRuntime } from '@core/ai/host-protocol'
import type { SecureSecretStore } from '@core/storage/secure-store'
import { WorkLensDatabase } from '@core/storage/database'

describe('daily work synthesis flow', () => {
  let directory: string
  let database: WorkLensDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-daily-flow-'))
    database = new WorkLensDatabase(join(directory, 'worklens.sqlite'))
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('combines every source from one workday and materializes the brief without review', async () => {
    const first = database.createSource({
      title: '上午开发记录',
      kind: 'text',
      rawText: '完成登录页改版并部署到测试环境。',
      businessDate: '2026-08-24',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'daily-flow-1'
    })
    const second = database.createSource({
      title: '下午沟通记录',
      kind: 'text',
      rawText: '接口联调正在等待权限，明天继续推进。',
      businessDate: '2026-08-24',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'daily-flow-2'
    })
    let receivedText = ''
    const runtime: AiRuntime = {
      analyze: async (_configuration, request) => {
        receivedText = request.text
        return {
          provider: 'test-provider',
          model: 'test-model',
          externalRunId: 'run-1',
          result: {
            sourceDate: null,
            events: [
              {
                title: '登录页改版交付',
                workItemKey: 'login-page-redesign',
                workItemTitle: '登录页改版',
                eventType: '交付',
                eventDate: '2026-08-24',
                datePrecision: 'day',
                summary: '登录页改版完成并进入测试。',
                confidence: 0.94,
                evidence: [{ quote: '完成登录页改版并部署到测试环境', blockIndex: 0 }]
              },
              {
                title: '接口联调等待权限',
                workItemKey: 'api-integration',
                workItemTitle: '接口联调',
                eventType: '问题',
                eventDate: '2026-08-24',
                datePrecision: 'day',
                summary: '接口联调等待权限后继续推进。',
                confidence: 0.9,
                evidence: [{ quote: '接口联调正在等待权限', blockIndex: 1 }]
              }
            ],
            dailyBriefs: [],
            summary: {
              title: '8 月 24 日工作日报',
              content: '完成页面改版，接口联调等待权限。',
              highlights: ['完成登录页改版', '等待接口权限']
            },
            standup: {
              title: '明日早会汇报',
              overview: '昨天完成登录页改版，接口联调等待权限。',
              completed: ['完成登录页改版并部署测试环境'],
              inProgress: ['接口联调'],
              blockers: ['等待接口权限'],
              nextSteps: ['继续接口联调'],
              script: '大家早上好，昨天完成了登录页改版。接口联调正在等待权限，今天会继续推进。'
            }
          }
        }
      },
      answerKnowledgeQuestion: async () => {
        throw new Error('not used')
      },
      test: async () => undefined,
      listModels: async () => [],
      getCursorCliStatus: async () => ({
        installed: true,
        authenticated: true,
        binaryPath: '/test/agent',
        version: 'test',
        accountLabel: null,
        message: 'ready'
      }),
      loginCursorCli: async () => ({
        installed: true,
        authenticated: true,
        binaryPath: '/test/agent',
        version: 'test',
        accountLabel: null,
        message: 'ready'
      }),
      getCodexCliStatus: async () => ({
        installed: true,
        authenticated: true,
        binaryPath: '/test/codex',
        version: 'test',
        accountLabel: null,
        authMode: 'chatgpt',
        planType: 'plus',
        message: 'ready'
      }),
      loginCodexCli: async () => ({
        installed: true,
        authenticated: true,
        binaryPath: '/test/codex',
        version: 'test',
        accountLabel: null,
        authMode: 'chatgpt',
        planType: 'plus',
        message: 'ready'
      })
    }
    const service = new AnalysisService(
      database,
      {} as SecureSecretStore,
      runtime
    )

    const brief = await service.analyzeWorkDate('2026-08-24')

    expect(receivedText).toContain('上午开发记录')
    expect(receivedText).toContain('下午沟通记录')
    expect(brief.sourceItemIds).toEqual([first.id, second.id])
    expect(brief.standupDate).toBe('2026-08-25')
    expect(brief.script).toContain('大家早上好')
    const snapshot = database.getSnapshot()
    expect(snapshot.sources).toEqual([
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ status: 'ready' })
    ])
    expect(snapshot.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: '登录页改版交付' })])
    )
    expect(snapshot.dailyBriefs).toEqual([
      expect.objectContaining({ workDate: '2026-08-24' })
    ])
    expect(
      snapshot.events.find((event) => event.title === '接口联调等待权限')?.evidence[0]
        ?.sourceItemId
    ).toBe(second.id)
  })
})
