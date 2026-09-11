import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    vi.useRealTimers()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps source creation order when multiple records share a timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'))

    const first = database.createSource({
      title: '第一条记录',
      kind: 'text',
      rawText: '第一条内容',
      businessDate: '2026-08-24',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'stable-order-1'
    })
    const second = database.createSource({
      title: '第二条记录',
      kind: 'text',
      rawText: '第二条内容',
      businessDate: '2026-08-24',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'stable-order-2'
    })

    expect(database.listSourcesForDate('2026-08-24').map((source) => source.id)).toEqual([
      first.id,
      second.id
    ])
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
        if (request.title === 'WorkLens AI 连接校验') {
          const quote = '完成 WorkLens AI 连接校验，并确认可以读取本次验证正文。'
          return {
            provider: 'test-provider',
            model: 'test-model',
            externalRunId: 'probe-run',
            result: {
              sourceDate: null,
              events: [{
                title: '完成 WorkLens AI 连接校验',
                workItemKey: 'worklens-ai-check',
                workItemTitle: 'WorkLens AI 连接校验',
                eventType: '验证',
                eventDate: request.fallbackDate,
                datePrecision: 'day',
                summary: quote,
                confidence: 1,
                evidence: [{ quote, blockIndex: null }]
              }],
              dailyBriefs: [],
              summary: { title: '连接校验', content: quote, highlights: [quote] },
              standup: {
                title: '连接校验',
                overview: quote,
                completed: [quote],
                inProgress: [],
                blockers: [],
                nextSteps: [],
                script: quote
              }
            }
          }
        }
        if (request.mode !== 'fallback_refinement') receivedText = request.text
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

    await service.testProvider()
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
