import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalysisService } from '@core/ai/analyzer'
import type { AiRuntime } from '@core/ai/host-protocol'
import type { SecureSecretStore } from '@core/storage/secure-store'
import { WorkLensDatabase } from '@core/storage/database'
import { SaveProviderSettingsSchema } from '@shared/contracts'

describe('persistent AI connection', () => {
  let directory: string
  let database: WorkLensDatabase
  let analyzeCalls: number
  let testCalls: number
  let runtime: AiRuntime

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-provider-connection-'))
    database = new WorkLensDatabase(join(directory, 'worklens.sqlite'))
    analyzeCalls = 0
    testCalls = 0
    runtime = {
      analyze: async (_configuration, request) => {
        analyzeCalls += 1
        const quote = request.text.split('\n').find((line) => line.includes('完成')) ?? request.text
        return {
          provider: 'cursor_cli',
          model: 'auto',
          externalRunId: 'connection-probe',
          result: {
            sourceDate: {
              value: request.fallbackDate,
              precision: 'day',
              confidence: 1,
              rationale: '连接验证正文包含明确日期'
            },
            events: [{
              title: '完成 WorkLens AI 连接校验',
              workItemKey: 'worklens-ai-connection-check',
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
      },
      answerKnowledgeQuestion: async () => { throw new Error('not used') },
      test: async () => { testCalls += 1 },
      listModels: async () => [],
      getCursorCliStatus: async () => ({ installed: true, authenticated: true, binaryPath: '/test/cursor', version: 'test', accountLabel: null, message: 'ready' }),
      loginCursorCli: async () => ({ installed: true, authenticated: true, binaryPath: '/test/cursor', version: 'test', accountLabel: null, message: 'ready' }),
      getCodexCliStatus: async () => ({ installed: true, authenticated: true, binaryPath: '/test/codex', version: 'test', accountLabel: null, authMode: 'chatgpt', planType: 'pro', message: 'ready' }),
      loginCodexCli: async () => ({ installed: true, authenticated: true, binaryPath: '/test/codex', version: 'test', accountLabel: null, authMode: 'chatgpt', planType: 'pro', message: 'ready' })
    }
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('blocks organization before creating jobs or changing the source status', async () => {
    const source = database.createSource({
      title: '未连接时的工作记录',
      kind: 'text',
      rawText: '2026年8月30日完成设置页调整。',
      businessDate: '2026-08-30',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'disconnected-source'
    })
    const service = new AnalysisService(database, {} as SecureSecretStore, runtime)

    await expect(service.analyzeSource(source.id)).rejects.toThrow('未连接 AI')

    expect(analyzeCalls).toBe(0)
    expect(database.getSource(source.id).status).toBe('queued')
  })

  it('stores a successful connection and keeps it when unchanged settings are saved', async () => {
    const service = new AnalysisService(database, {} as SecureSecretStore, runtime)
    await service.testProvider()

    expect(testCalls).toBe(1)
    expect(analyzeCalls).toBe(1)
    expect(database.getProviderSettings()).toMatchObject({
      kind: 'cursor_cli',
      connected: true,
      connectionMessage: '连接正常'
    })

    const saved = await service.saveProviderSettings({
      kind: 'cursor_cli',
      model: 'auto',
      baseUrl: '',
      sendImages: false,
      autoAnalyze: true
    })
    expect(saved.connected).toBe(true)
    expect(saved.connectedAt).not.toBeNull()

    database.close()
    database = new WorkLensDatabase(join(directory, 'worklens.sqlite'))
    expect(database.getProviderSettings()).toMatchObject({
      kind: 'cursor_cli',
      connected: true,
      connectionMessage: '连接正常'
    })
  })

  it('disconnects when the selected interface changes', async () => {
    const service = new AnalysisService(database, {} as SecureSecretStore, runtime)
    await service.testProvider()

    const saved = await service.saveProviderSettings({
      kind: 'codex_cli',
      model: 'auto',
      baseUrl: '',
      sendImages: false,
      autoAnalyze: true
    })

    expect(saved).toMatchObject({
      kind: 'codex_cli',
      connected: false,
      connectionMessage: '设置已更新，请连接 AI'
    })
  })

  it('rejects settings for the removed Cursor API provider', () => {
    expect(SaveProviderSettingsSchema.safeParse({
      kind: 'cursor',
      model: 'auto',
      baseUrl: '',
      sendImages: false,
      autoAnalyze: true
    }).success).toBe(false)
  })
})
