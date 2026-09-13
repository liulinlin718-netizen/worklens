import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkLensDatabase } from '@core/storage/database'
import type { AnalysisResult, DailyBriefImage } from '@shared/contracts'
import { isWorkItemFragmentTitle, normalizeWorkItemCategory } from '@shared/work-item-quality'

const workDate = '2026-09-11'
const images: DailyBriefImage[] = [{ id: '88a226d7-94c8-449f-b18d-c4200cbfcb7d', name: '现场截图', dataUrl: 'data:image/png;base64,AA==' }]
function result(script = 'AI 初稿', keys = ['login', 'api']): AnalysisResult {
  const standup = { title: '早会稿', overview: script, completed: [script], inProgress: [], blockers: [], nextSteps: [], script }
  return {
    sourceDate: null,
    events: keys.map((key, index) => ({
      title: `${key} 更新`, workItemKey: key, workItemTitle: `${key} 事项`, eventType: index ? 'testing' : 'development',
      eventDate: workDate, datePrecision: 'day', summary: `${key} 工作进展`, confidence: 0.91,
      evidence: [{ quote: `${key} 工作进展`, blockIndex: null }]
    })),
    dailyBriefs: [{ ...standup, workDate }],
    summary: { title: '摘要', content: script, highlights: [] }, standup
  }
}

describe('durable content protection', () => {
  let directory: string
  let database: WorkLensDatabase
  let sourceId: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-protection-'))
    database = new WorkLensDatabase(join(directory, 'test.sqlite'))
    sourceId = database.createSource({ title: '工作记录', kind: 'text', rawText: 'login 工作进展；api 工作进展；72%', businessDate: workDate,
      datePrecision: 'day', dateOrigin: 'manual', contentHash: 'test-source' }).id
  })
  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  function generate(script = 'AI 初稿') {
    return database.saveDailySynthesis([sourceId], result(script), 'test', 'test-model', workDate)!
  }
  function reopen() {
    database.close()
    database = new WorkLensDatabase(join(directory, 'test.sqlite'))
  }

  it('keeps manual script and images through repeated generation and restart; adopts and restores complete versions', () => {
    const initial = generate()
    const manual = database.updateDailyBrief({ briefId: initial.id, script: '人工确认的汇报', images, expectedUpdatedAt: initial.updatedAt })
    generate('AI 第二稿')
    generate('AI 第三稿')
    reopen()
    const protectedBrief = database.getDailyBrief(workDate)!
    expect(protectedBrief).toMatchObject({ script: manual.script, images, manualLocked: true, updatedAt: manual.updatedAt })
    const versions = database.listDailyBriefVersions(initial.id)
    expect(versions.map((version) => version.script)).toEqual(expect.arrayContaining(['AI 初稿', '人工确认的汇报', 'AI 第二稿', 'AI 第三稿']))
    expect(versions.filter((version) => version.isCurrent)).toHaveLength(1)
    const candidate = versions.find((version) => version.versionId === protectedBrief.pendingAiVersionId)!
    expect(candidate.script).toBe('AI 第三稿')
    const accepted = database.acceptDailyBriefVersion({ briefId: initial.id, versionId: candidate.versionId, expectedUpdatedAt: protectedBrief.updatedAt })
    expect(accepted).toMatchObject({ script: 'AI 第三稿', images, manualLocked: true, pendingAiVersionId: null })
    generate('AI 第四稿')
    expect(database.getDailyBrief(workDate)?.script).toBe('AI 第三稿')
    const manualVersion = versions.find((version) => version.script === '人工确认的汇报')!
    const restored = database.restoreDailyBriefVersion({ briefId: initial.id, versionId: manualVersion.versionId })
    expect(restored).toMatchObject({ script: '人工确认的汇报', images, completed: manual.completed, manualLocked: true })
    expect(database.listDailyBriefVersions(initial.id).some((version) => version.kind === 'restore' && version.isCurrent)).toBe(true)
  })

  it('rejects stale saves and versions belonging to another date without changing either saved draft', () => {
    const initial = generate()
    database.updateDailyBrief({ briefId: initial.id, script: '第一次修改', images, expectedUpdatedAt: initial.updatedAt })
    expect(() => database.updateDailyBrief({ briefId: initial.id, script: '旧窗口修改', images: [], expectedUpdatedAt: initial.updatedAt })).toThrow('已有更新')
    const otherResult = result('另一天的稿')
    otherResult.events.forEach((event) => { event.eventDate = '2026-09-10' })
    otherResult.dailyBriefs[0]!.workDate = '2026-09-10'
    const other = database.saveDailySynthesis([sourceId], otherResult, 'test', 'test-model', '2026-09-10')!
    const otherVersion = database.listDailyBriefVersions(other.id)[0]!
    expect(() => database.restoreDailyBriefVersion({ briefId: initial.id, versionId: otherVersion.versionId })).toThrow('找不到')
    expect(database.getDailyBrief(workDate)?.script).toBe('第一次修改')
    expect(database.getDailyBrief('2026-09-10')?.script).toBe('另一天的稿')
  })

  it('retains all AI history for an unedited brief and keeps manual text when derived data is cleared', () => {
    const initial = generate()
    expect(generate('新 AI 稿').script).toBe('新 AI 稿')
    expect(database.listDailyBriefVersions(initial.id)).toHaveLength(2)
    database.updateDailyBrief({ briefId: initial.id, script: '手工定稿', images })
    database.clearDailySynthesisForDate(workDate)
    expect(database.getDailyBrief(workDate)).toMatchObject({ script: '手工定稿', images })
    database.deleteSource(sourceId)
    expect(database.getDailyBrief(workDate)).toMatchObject({ script: '手工定稿', sourceItemIds: [] })
    const originalManual = database.listDailyBriefVersions(initial.id).find((version) => version.script === '手工定稿')!
    expect(database.restoreDailyBriefVersion({ briefId: initial.id, versionId: originalManual.versionId })).toMatchObject({ id: initial.id, script: '手工定稿', images, sourceItemIds: [] })
  })

  it('migrates existing manual revisions into usable protected version history once', () => {
    const initial = generate()
    database.updateDailyBrief({ briefId: initial.id, script: '旧版本人工稿', images })
    database.close()
    const legacy = new DatabaseSync(join(directory, 'test.sqlite'))
    legacy.exec(`DELETE FROM schema_migrations WHERE version = 6;
      DROP TABLE daily_brief_versions;
      ALTER TABLE daily_briefs DROP COLUMN manual_locked;
      ALTER TABLE daily_briefs DROP COLUMN current_version_id;
      ALTER TABLE daily_briefs DROP COLUMN pending_ai_version_id;`)
    legacy.close()
    database = new WorkLensDatabase(join(directory, 'test.sqlite'))
    expect(database.getDailyBrief(workDate)).toMatchObject({ script: '旧版本人工稿', images, manualLocked: true })
    const count = database.listDailyBriefVersions(initial.id).length
    expect(count).toBeGreaterThanOrEqual(2)
    reopen()
    expect(database.listDailyBriefVersions(initial.id)).toHaveLength(count)
    generate('迁移后新 AI 稿')
    expect(database.getDailyBrief(workDate)?.script).toBe('旧版本人工稿')
  })

  it('persists edited title/category and merges every event, source, and reference across reanalysis and restart', () => {
    generate()
    const secondSourceId = database.createSource({ title: '补充记录', kind: 'text', rawText: 'second 工作进展', businessDate: '2026-09-10', datePrecision: 'day', dateOrigin: 'manual', contentHash: 'second' }).id
    const secondResult = result('补充稿', ['second'])
    secondResult.events[0]!.eventDate = '2026-09-10'
    secondResult.dailyBriefs[0]!.workDate = '2026-09-10'
    database.saveDailySynthesis([secondSourceId], secondResult, 'test', 'test-model', '2026-09-10')
    const before = database.listEvents()
    expect(database.updateWorkItem({ workItemKey: 'login', title: '登录体验升级', eventType: 'Testing' })).toMatchObject({ title: '登录体验升级', eventType: '测试', manualEdited: true })
    database.mergeWorkItems({ sourceWorkItemKey: 'api', targetWorkItemKey: 'login' })
    const merged = database.mergeWorkItems({ sourceWorkItemKey: 'second', targetWorkItemKey: 'login' })
    expect(merged.eventIds.sort()).toEqual(before.map((event) => event.id).sort())
    expect(merged.sourceItemIds.sort()).toEqual([sourceId, secondSourceId].sort())
    expect(merged.evidence).toHaveLength(3)
    expect(database.getSource(sourceId).rawText).toContain('api 工作进展')
    generate('重新整理')
    reopen()
    expect(database.listWorkItems()).toHaveLength(1)
    expect(database.listWorkItems()[0]).toMatchObject({ key: 'login', title: '登录体验升级', eventType: '测试', eventCount: 3 })
    expect(database.listEvents().every((event) => event.workItemKey === 'login')).toBe(true)
    expect(database.search('登录体验升级', ['event'])).toHaveLength(3)
    const knowledgeEvents = database.findKnowledgeContext('登录体验升级', workDate).filter((item) => item.entityType === 'event')
    expect(knowledgeEvents).toHaveLength(3)
    expect(knowledgeEvents.every((item) => item.title.includes('登录体验升级'))).toBe(true)
    expect(() => database.mergeWorkItems({ sourceWorkItemKey: 'api', targetWorkItemKey: 'login' })).toThrow('另一个')
    expect(database.deleteWorkItem('api').deletedCount).toBe(3)
    expect(database.listSources()).toHaveLength(2)
  })

  it('flags numeric/time fragments conservatively and keeps custom categories and original evidence', () => {
    expect(normalizeWorkItemCategory(' Development ')).toBe('开发')
    expect(normalizeWorkItemCategory('安全演练')).toBe('安全演练')
    expect(normalizeWorkItemCategory('bug')).toBe('问题')
    expect(normalizeWorkItemCategory('bug_followup')).toBe('问题跟进')
    expect(normalizeWorkItemCategory('verification')).toBe('验证')
    expect(normalizeWorkItemCategory('work')).toBe('工作')
    expect(normalizeWorkItemCategory('进行中')).toBe('进行中')
    for (const title of ['72%', '晚上22:07', '22:07']) expect(isWorkItemFragmentTitle(title)).toBe(true)
    for (const title of ['3D 引擎', '72% 覆盖率提升', '2FA 登录', 'A/B 测试']) expect(isWorkItemFragmentTitle(title)).toBe(false)
    const fragmentResult = result('碎片稿', ['fragment'])
    fragmentResult.events[0] = { ...fragmentResult.events[0]!, title: '72%', workItemTitle: '72%', summary: '72%', confidence: 0.4, evidence: [{ quote: '72%', blockIndex: null }] }
    database.saveDailySynthesis([sourceId], fragmentResult, 'test', 'test-model', workDate)
    expect(database.listWorkItems()[0]).toMatchObject({ isFragment: true, reviewReasons: expect.arrayContaining([expect.stringContaining('提取碎片'), expect.stringContaining('把握较低')]) })
    const fixed = database.updateWorkItem({ workItemKey: 'fragment', title: '测试覆盖率提升到 72%', eventType: 'testing' })
    expect(fixed.isFragment).toBe(false)
    expect(fixed.evidence[0]?.quote).toBe('72%')
    expect(database.getSource(sourceId).rawText).toContain('72%')
  })

  it('keeps transitive merge and edits when AI changes keys and titles; rejects an alias cycle', () => {
    const original = result('三个事项', ['first', 'second', 'third'])
    database.saveDailySynthesis([sourceId], original, 'test', 'test-model', workDate)
    database.mergeWorkItems({ sourceWorkItemKey: 'first', targetWorkItemKey: 'second' })
    database.mergeWorkItems({ sourceWorkItemKey: 'second', targetWorkItemKey: 'third' })
    database.updateWorkItem({ workItemKey: 'first', title: '人工确认的统一事项', eventType: 'verification' })
    expect(() => database.mergeWorkItems({ sourceWorkItemKey: 'third', targetWorkItemKey: 'first' })).toThrow('另一个')
    reopen()
    const changed = result('重新命名', ['first', 'second', 'third'])
    changed.events.forEach((event, index) => {
      event.workItemKey = `renamed${index}`
      event.workItemTitle = `AI 新标题 ${index}`
      event.title = `AI 改写的新进展 ${index}`
    })
    database.saveDailySynthesis([sourceId], changed, 'test', 'test-model', workDate)
    expect(database.listWorkItems()).toHaveLength(1)
    expect(database.listWorkItems()[0]).toMatchObject({ key: 'third', title: '人工确认的统一事项', eventType: '验证', eventCount: 3 })
    expect(database.listWorkItems()[0]!.evidence).toHaveLength(3)
  })

  it('does not infer a merge from an ambiguous quotation shared by manually separated items', () => {
    const original = result('分别记录', ['first', 'second'])
    original.events.forEach((event) => { event.evidence = [{ quote: '共同上下文', blockIndex: null }] })
    database.saveDailySynthesis([sourceId], original, 'test', 'test-model', workDate)
    database.updateWorkItem({ workItemKey: 'first', title: '独立事项甲', eventType: '研究' })
    database.updateWorkItem({ workItemKey: 'second', title: '独立事项乙', eventType: '设计' })
    original.events.forEach((event, index) => { event.workItemKey = `changed${index}` })
    database.saveDailySynthesis([sourceId], original, 'test', 'test-model', workDate)
    expect(database.listWorkItems()).toHaveLength(2)
    expect(database.listEvents()).toHaveLength(2)
  })

  function saveQuotedEvents(quotes: string[], keys: string[], recordId: string) {
    const generated = result('原文引用测试', keys)
    generated.events.forEach((event, index) => { event.evidence = [{ quote: quotes[index]!, blockIndex: null }] })
    database.saveDailySynthesis([recordId], generated, 'test', 'test-model', workDate)
  }
  function sourceForQuotes(quotes: string[], hash: string): string {
    return database.createSource({ title: '登录验证记录', kind: 'text', rawText: quotes.join('。'), businessDate: workDate,
      datePrecision: 'day', dateOrigin: 'manual', contentHash: hash }).id
  }

  it('retains manual title and category when reanalysis renames the key and shortens a substantial source quotation', () => {
    const fullQuote = '登录模块第二轮测试完成，验证超时回退'
    const shortQuote = '登录模块第二轮测试完成'
    const recordId = sourceForQuotes([fullQuote], 'shortened-quote')
    saveQuotedEvents([fullQuote], ['loginold'], recordId)
    database.updateWorkItem({ workItemKey: 'loginold', title: '人工确认的登录体验升级', eventType: '验证' })
    reopen()
    saveQuotedEvents([shortQuote], ['loginnew'], recordId)
    expect(database.listWorkItems()).toEqual([expect.objectContaining({
      key: 'loginold', title: '人工确认的登录体验升级', eventType: '验证', manualEdited: true
    })])
    expect(database.listWorkItems()[0]!.evidence[0]!.quote).toBe(shortQuote)
    expect(database.getSource(recordId).rawText).toBe(fullQuote)
  })

  it('rejects contained quotation matching when the same substantial phrase belongs to two protected items', () => {
    const common = '登录模块第二轮测试完成'
    const quotes = [`${common}，验证超时回退`, `${common}，验证短信兜底`]
    const recordId = sourceForQuotes(quotes, 'ambiguous-contained-quote')
    saveQuotedEvents(quotes, ['loginfirst', 'loginsecond'], recordId)
    database.updateWorkItem({ workItemKey: 'loginfirst', title: '独立超时回退', eventType: '验证' })
    database.updateWorkItem({ workItemKey: 'loginsecond', title: '独立短信兜底', eventType: '测试' })
    saveQuotedEvents([common, common], ['changedfirst', 'changedsecond'], recordId)
    const items = database.listWorkItems()
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.key).sort()).toEqual(['changedfirst', 'changedsecond'])
    expect(items.every((item) => !item.manualEdited)).toBe(true)
  })

  it('prefers an exact protected quotation over another protected item with a containing quotation', () => {
    const exactQuote = '登录模块第二轮测试完成'
    const quotes = [exactQuote, `${exactQuote}，验证超时回退`]
    const recordId = sourceForQuotes(quotes, 'exact-before-contained-quote')
    saveQuotedEvents(quotes, ['exactitem', 'longitem'], recordId)
    database.updateWorkItem({ workItemKey: 'exactitem', title: '精确原文对应事项', eventType: '验证' })
    database.updateWorkItem({ workItemKey: 'longitem', title: '长引文的独立事项', eventType: '测试' })
    saveQuotedEvents([exactQuote], ['newgeneratedkey'], recordId)
    expect(database.listWorkItems()).toEqual([expect.objectContaining({ key: 'exactitem', title: '精确原文对应事项', eventType: '验证' })])
  })

  it('does not apply a manual choice from short quotations or a different source', () => {
    const fullQuote = '登录模块第二轮测试完成，验证超时回退'
    const recordId = sourceForQuotes([fullQuote], 'short-quote-protected')
    saveQuotedEvents([fullQuote], ['original'], recordId)
    database.updateWorkItem({ workItemKey: 'original', title: '人工确认的事项', eventType: '验证' })
    saveQuotedEvents(['登录模块'], ['shortgenerated'], recordId)
    expect(database.listWorkItems()[0]).toMatchObject({ key: 'shortgenerated', manualEdited: false })
    const otherRecordId = sourceForQuotes([fullQuote], 'separate-source-quotation')
    saveQuotedEvents(['登录模块第二轮测试完成'], ['othersource'], otherRecordId)
    expect(database.listWorkItems().find((item) => item.key === 'othersource')).toMatchObject({ manualEdited: false })
    expect(database.listWorkItems()).toHaveLength(2)
  })
})
