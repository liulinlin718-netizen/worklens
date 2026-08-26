import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkLensDatabase } from '@core/storage/database'

describe('WorkLensDatabase', () => {
  let directory: string
  let database: WorkLensDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-db-test-'))
    database = new WorkLensDatabase(join(directory, 'test.sqlite'))
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('stores immutable sources and finds them through FTS', () => {
    const source = database.createSource({
      title: '游戏 Agent 记忆评审',
      kind: 'text',
      rawText: '讨论长期记忆召回率与失败回退。',
      businessDate: '2026-07-15',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'hash-1'
    })

    expect(database.getSource(source.id).rawText).toContain('长期记忆')
    expect(database.search('记忆')).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: source.id, entityType: 'source' })])
    )
  })

  it('moves a source to a manually corrected date and locks later inference', () => {
    const source = database.createSource({
      title: '日期待修正的会议记录',
      kind: 'text',
      rawText: '正文中的日期不完整。',
      businessDate: '2026-08-20',
      datePrecision: 'day',
      dateOrigin: 'inferred',
      contentHash: 'manual-date-source'
    })

    const corrected = database.setSourceDateManually(source.id, '2026-08-18')
    database.updateSourceDate(source.id, '2026-08-25', 'day', 'inferred')

    expect(corrected).toMatchObject({
      businessDate: '2026-08-18',
      dateOrigin: 'manual',
      status: 'queued'
    })
    expect(database.getSource(source.id).businessDate).toBe('2026-08-18')
    expect(database.listSourcesForDate('2026-08-20')).toHaveLength(0)
    expect(database.listSourcesForDate('2026-08-18')).toHaveLength(1)
  })

  it('only materializes AI proposals after human acceptance', () => {
    const source = database.createSource({
      title: '需求讨论',
      kind: 'text',
      rawText: '需要增加失败重试入口。',
      businessDate: null,
      datePrecision: 'unknown',
      dateOrigin: 'inferred',
      contentHash: 'hash-2'
    })
    const [proposal] = database.addProposals(source.id, [
      {
        kind: 'requirement',
        payload: {
          title: '失败重试入口',
          description: '让用户能够重试失败任务',
          status: 'backlog',
          priority: 'high',
          acceptanceCriteria: ['失败记录显示重试按钮'],
          confidence: 0.91,
          evidence: [{ quote: '需要增加失败重试入口。', blockIndex: 0 }]
        },
        confidence: 0.91,
        rationale: '明确需求句',
        provider: 'test',
        model: 'test-model'
      }
    ])

    expect(database.listRequirements()).toHaveLength(0)
    database.reviewProposal(proposal!.id, true)

    const [requirement] = database.listRequirements()
    expect(requirement).toMatchObject({
      title: '失败重试入口',
      status: 'backlog',
      priority: 'high'
    })
    expect(requirement!.evidence[0]?.quote).toContain('失败重试')
    expect(database.listProposals()).toHaveLength(0)
    expect(database.getSource(source.id).status).toBe('ready')
  })

  it('accepts every pending proposal in one pass', () => {
    const source = database.createSource({
      title: '批量审核',
      kind: 'text',
      rawText: '会议讨论时间线与导出。',
      businessDate: null,
      datePrecision: 'unknown',
      dateOrigin: 'inferred',
      contentHash: 'hash-accept-all'
    })
    database.addProposals(source.id, [
      {
        kind: 'event',
        payload: {
          title: '评审会',
          eventType: 'meeting',
          eventDate: '2026-07-16',
          datePrecision: 'day',
          summary: '讨论时间线与导出',
          confidence: 0.88,
          evidence: [{ quote: '会议讨论时间线与导出。', blockIndex: 0 }]
        },
        confidence: 0.88,
        rationale: '',
        provider: 'test',
        model: 'test'
      },
      {
        kind: 'requirement',
        payload: {
          title: '导出',
          description: '支持导出资料',
          status: 'backlog',
          priority: 'medium',
          acceptanceCriteria: [],
          confidence: 0.84,
          evidence: [{ quote: '会议讨论时间线与导出。', blockIndex: 0 }]
        },
        confidence: 0.84,
        rationale: '',
        provider: 'test',
        model: 'test'
      }
    ])

    expect(database.acceptAllPendingProposals()).toBe(2)
    expect(database.listProposals()).toHaveLength(0)
    expect(database.listEvents()).toHaveLength(1)
    expect(database.listRequirements()).toHaveLength(1)
    expect(database.getSource(source.id).status).toBe('ready')
  })

  it('locks a manually changed requirement status', () => {
    const source = database.createSource({
      title: '需求',
      kind: 'text',
      rawText: '实现时间线。',
      businessDate: null,
      datePrecision: 'unknown',
      dateOrigin: 'inferred',
      contentHash: 'hash-3'
    })
    const [proposal] = database.addProposals(source.id, [
      {
        kind: 'requirement',
        payload: {
          title: '时间线',
          description: '按日期展示记录',
          status: 'planned',
          priority: 'medium',
          acceptanceCriteria: [],
          confidence: 0.8,
          evidence: [{ quote: '实现时间线。', blockIndex: 0 }]
        },
        confidence: 0.8,
        rationale: '',
        provider: 'test',
        model: 'test'
      }
    ])
    database.reviewProposal(proposal!.id, true)
    const requirement = database.listRequirements()[0]!
    database.updateRequirementStatus(requirement.id, 'done')
    expect(database.listRequirements()[0]).toMatchObject({ status: 'done', manualLocked: true })
  })

  it('materializes one replaceable daily brief and skips weekends for stand-up day', () => {
    const source = database.createSource({
      title: '周五工作记录',
      kind: 'text',
      rawText: '完成登录页改版，接口权限仍在等待，周一继续联调。',
      businessDate: '2026-07-17',
      datePrecision: 'day',
      dateOrigin: 'manual',
      contentHash: 'daily-brief-source'
    })
    const result = {
      sourceDate: null,
      events: [
        {
          title: '完成登录页改版',
          eventType: '交付',
          eventDate: '2026-07-17',
          datePrecision: 'day' as const,
          summary: '登录页改版已经完成。',
          confidence: 0.93,
          evidence: [{ quote: '完成登录页改版', blockIndex: 0 }]
        }
      ],
      summary: { title: '周五日报', content: '完成改版，等待权限。', highlights: [] },
      standup: {
        title: '周一早会汇报',
        overview: '周五完成登录页改版。',
        completed: ['完成登录页改版'],
        inProgress: ['等待接口权限'],
        blockers: ['缺少接口权限'],
        nextSteps: ['继续联调'],
        script: '大家早上好，周五完成了登录页改版，今天继续联调。'
      }
    }

    database.saveDailySynthesis([source.id], result, 'test', 'test-model', '2026-07-17')
    const snapshot = database.getSnapshot()
    expect(snapshot.dailyBriefs).toHaveLength(1)
    expect(snapshot.dailyBriefs[0]).toMatchObject({
      workDate: '2026-07-17',
      standupDate: '2026-07-20',
      sourceItemIds: [source.id]
    })
    expect(snapshot.events).toHaveLength(1)
    expect(database.getSource(source.id).status).toBe('ready')

    database.saveDailySynthesis(
      [source.id],
      {
        ...result,
        events: [],
        standup: { ...result.standup, script: '更新后的逐字稿。' }
      },
      'test',
      'test-model',
      '2026-07-17'
    )
    expect(database.listDailyBriefs()).toHaveLength(1)
    expect(database.listDailyBriefs()[0]!.script).toBe('更新后的逐字稿。')
    expect(database.listEvents()).toHaveLength(0)

    const brief = database.listDailyBriefs()[0]!
    const updated = database.updateDailyBrief({
      briefId: brief.id,
      script: '人工修改并保存的逐字稿。',
      images: [{
        id: 'd9ec5ab0-9a26-4cbf-9875-9f2aa59cc2a7',
        name: '进度截图.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo='
      }]
    })
    expect(updated).toMatchObject({
      script: '人工修改并保存的逐字稿。',
      images: [{ name: '进度截图.png' }]
    })
  })
})
