import { describe, expect, it } from 'vitest'
import { AnalysisResultSchema } from '@shared/contracts'
import {
  coerceAnalysisPayload,
  deriveTitle,
  escapeCsv,
  inferDateFromText,
  inferWorkDatesFromText,
  normalizeEntityKey,
  normalizeRequirementStatus,
  normalizeText,
  parseJsonObject
} from '@core/domain'

describe('domain helpers', () => {
  it('normalizes pasted text without destroying paragraphs', () => {
    expect(normalizeText('  需求 A\r\n  \r\n\r\n\r\n验收  \n')).toBe('需求 A\n\n\n验收')
  })

  it('derives a compact title from markdown', () => {
    expect(deriveTitle('# 游戏 Agent 评审\n其他内容')).toBe('游戏 Agent 评审')
  })

  it('extracts explicit Chinese dates and rejects invalid ones', () => {
    expect(inferDateFromText('会议时间是 2026年7月15日')).toMatchObject({
      value: '2026-07-15',
      precision: 'day'
    })
    expect(inferDateFromText('会议时间是 2026年2月31日')).toBeNull()
  })

  it('detects multi-day work-log headings without treating the upload day as a work date', () => {
    const reference = new Date('2026-08-28T12:00:00Z')
    const text = '6.15：完成登录页改版\n6.16（周二）继续接口联调\n计划 7 月 30 日上线'
    expect(inferWorkDatesFromText(text, reference)).toEqual(['2026-06-15', '2026-06-16'])
    expect(inferDateFromText(text, reference)).toBeNull()
  })

  it('normalizes entity keys across punctuation and case', () => {
    expect(normalizeEntityKey('Agent 记忆（V2）')).toBe(normalizeEntityKey('agent-记忆-v2'))
  })

  it('extracts JSON from fenced provider output', () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('escapes CSV cells safely', () => {
    expect(escapeCsv('a,"b"')).toBe('"a,""b"""')
  })

  it('maps common status aliases', () => {
    expect(normalizeRequirementStatus('open')).toBe('backlog')
    expect(normalizeRequirementStatus('in progress')).toBe('in_progress')
  })

  it('coerces loose CLI analysis payloads into the schema', () => {
    const coerced = coerceAnalysisPayload(
      parseJsonObject(
        '正在读取 source.txt。{"sourceDate":"2026-07-10","events":[{"title":"评审","date":"2026-07-10","description":"开会","evidence":{"quote":"会议纪要"}}],"summary":"整体摘要"}'
      )
    )
    const parsed = AnalysisResultSchema.parse(coerced)
    expect(parsed.sourceDate?.value).toBe('2026-07-10')
    expect(parsed.events[0]).toMatchObject({
      title: '评审',
      eventDate: '2026-07-10',
      summary: '开会'
    })
    expect(parsed.summary.content).toBe('整体摘要')
    expect(parsed.standup.script).toContain('大家早上好')
  })
})
