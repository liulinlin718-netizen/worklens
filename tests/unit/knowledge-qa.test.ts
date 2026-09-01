import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalysisService } from '@core/ai/analyzer'
import type { AiRuntime } from '@core/ai/host-protocol'
import type { SecureSecretStore } from '@core/storage/secure-store'
import {
  WorkLensDatabase,
  extractKnowledgeTerms,
  inferQuestionDateRange
} from '@core/storage/database'

describe('local work knowledge Q&A', () => {
  let directory: string
  let database: WorkLensDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-knowledge-'))
    database = new WorkLensDatabase(join(directory, 'worklens.sqlite'))
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('understands common Chinese date ranges and useful project terms', () => {
    expect(inferQuestionDateRange('上个月我做了什么？', '2026-08-25')).toEqual({
      from: '2026-07-01',
      to: '2026-07-31'
    })
    expect(inferQuestionDateRange('最近14天有哪些阻塞？', '2026-08-25')).toEqual({
      from: '2026-08-12',
      to: '2026-08-25'
    })
    expect(extractKnowledgeTerms('我想问一下上个月支付项目做了什么')).toContain('支付项目')
  })

  it('retrieves only locally relevant records for a dated question', () => {
    const payment = database.createSource({
      title: '支付系统发布记录',
      kind: 'text',
      rawText: '完成支付系统灰度发布，并观察核心成功率。',
      businessDate: '2026-07-18',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'knowledge-payment'
    })
    const login = database.createSource({
      title: '登录页改版',
      kind: 'text',
      rawText: '完成登录页视觉调整。',
      businessDate: '2026-08-20',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'knowledge-login'
    })

    const context = database.findKnowledgeContext(
      '上个月支付项目完成了什么？',
      '2026-08-25'
    )

    expect(context.map((item) => item.entityId)).toContain(payment.id)
    expect(context.map((item) => item.entityId)).not.toContain(login.id)
  })

  it('uses the selected local agent and returns only verified source citations', async () => {
    const source = database.createSource({
      title: '支付系统发布记录',
      kind: 'text',
      rawText: '完成支付系统灰度发布，并观察核心成功率。',
      businessDate: '2026-07-18',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'knowledge-answer'
    })
    database.saveProviderSettings({
      kind: 'codex_cli',
      model: 'gpt-5.6-terra',
      baseUrl: '',
      sendImages: false,
      autoAnalyze: true,
      connected: true,
      connectedAt: '2026-08-25T08:00:00.000Z',
      connectionMessage: '连接正常'
    })
    let runtimeRequest: Parameters<AiRuntime['answerKnowledgeQuestion']>[1] | null = null
    let runtimeKind = ''
    const runtime: AiRuntime = {
      analyze: async () => { throw new Error('not used') },
      answerKnowledgeQuestion: async (configuration, request) => {
        runtimeRequest = request
        runtimeKind = configuration.kind
        return {
          provider: configuration.kind === 'codex_cli' ? 'codex_cli' : 'cursor_cli',
          model: configuration.model,
          externalRunId: 'knowledge-run',
          result: {
            answer: '7 月完成了支付系统灰度发布，并持续观察成功率。',
            citations: [
              { refId: `source:${source.id}`, quote: '完成支付系统灰度发布' },
              { refId: 'source:not-real', quote: '不存在的内容' }
            ],
            suggestedQuestions: ['灰度发布后还有哪些跟进？']
          }
        }
      },
      test: async () => undefined,
      listModels: async () => [],
      getCursorCliStatus: async () => ({ installed: true, authenticated: true, binaryPath: '/test/agent', version: 'test', accountLabel: null, message: 'ready' }),
      loginCursorCli: async () => ({ installed: true, authenticated: true, binaryPath: '/test/agent', version: 'test', accountLabel: null, message: 'ready' }),
      getCodexCliStatus: async () => ({ installed: true, authenticated: true, binaryPath: '/test/codex', version: 'test', accountLabel: null, authMode: 'chatgpt', planType: 'plus', message: 'ready' }),
      loginCodexCli: async () => ({ installed: true, authenticated: true, binaryPath: '/test/codex', version: 'test', accountLabel: null, authMode: 'chatgpt', planType: 'plus', message: 'ready' })
    }
    const service = new AnalysisService(database, {} as SecureSecretStore, runtime)

    const answer = await service.askWorkQuestion({
      question: '2026年7月支付项目完成了什么？',
      history: []
    })

    expect(runtimeRequest).not.toBeNull()
    expect(runtimeRequest!.context).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: source.id })])
    )
    expect(runtimeKind).toBe('codex_cli')
    expect(answer.provider).toBe('codex_cli')
    expect(answer.citations).toEqual([
      expect.objectContaining({ entityId: source.id, quote: '完成支付系统灰度发布' })
    ])
  })
})
