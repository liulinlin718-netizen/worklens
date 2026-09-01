import { describe, expect, it } from 'vitest'
import { AnalysisResultSchema } from '@shared/contracts'
import {
  coerceAnalysisPayload,
  deriveStableWorkItemTitle,
  deriveTitle,
  deriveWorkItemKey,
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

  it('derives a conservative stable work-item title without inventing context', () => {
    expect(deriveStableWorkItemTitle('今天完成登录页视觉改版。')).toBe('登录页视觉改版')
    expect(deriveStableWorkItemTitle('测赛宇的 MCP 了')).toBe('赛宇的 MCP')
    expect(deriveStableWorkItemTitle('修复 Game Skill 调用异常')).toBe('Game Skill 调用异常')
    expect(deriveStableWorkItemTitle('Game Visual Design Skill 第三轮回归验证')).toBe('Game Visual Design Skill')
    expect(deriveStableWorkItemTitle('页面测试')).toBe('页面测试')
    expect(deriveStableWorkItemTitle('做机器人')).toBe('机器人')
  })

  it('removes conversational and question framing without inventing title facts', () => {
    expect(deriveStableWorkItemTitle('看一下上周的 Atlas 数据和 case')).toBe('Atlas 数据和 case')
    expect(deriveStableWorkItemTitle('Atlas Skill 继续帮忙看一下')).toBe('Atlas Skill')
    expect(deriveStableWorkItemTitle('16 继续关注移动端 UI 适配问题')).toBe('移动端 UI 适配问题')
    expect(deriveStableWorkItemTitle('Atlas Skill 进行继续升级')).toBe('Atlas Skill')
    expect(deriveStableWorkItemTitle('能不能帮忙看一下 Atlas Skill 在移动端的 case 兼容情况是否符合预期？'))
      .toBe('Atlas Skill 在移动端的 case 兼容情况')
    expect(deriveStableWorkItemTitle('先看一下 Atlas Skill 能不能支持图片粘贴')).toBe('Atlas Skill 支持图片粘贴')
    expect(deriveStableWorkItemTitle('16 Pro 移动端适配')).toBe('16 Pro 移动端适配')
  })

  it('uses a grounded topic instead of URL, priority, degree or result wrappers', () => {
    expect(deriveStableWorkItemTitle('https://example.invalid/report\nAtlas Skill 移动端调用问题'))
      .toBe('Atlas Skill 移动端调用问题')
    expect(deriveStableWorkItemTitle('https://example.invalid/report Atlas Skill 移动端调用问题'))
      .toBe('Atlas Skill 移动端调用问题')
    expect(deriveStableWorkItemTitle('高优测试一下 Atlas Skill 各种数据')).toBe('Atlas Skill 数据')
    expect(deriveStableWorkItemTitle('Atlas Skill 数据统一性好')).toBe('Atlas Skill 数据统一性')
    expect(deriveStableWorkItemTitle('看一下各种数据，Atlas Skill 移动端 case 兼容性，统一性好'))
      .toBe('Atlas Skill 移动端 case 兼容性')
    expect(deriveStableWorkItemTitle('https://example.invalid/report', '工作事项')).toBe('工作事项')
  })

  it('keeps a grounded metric subject instead of selecting its bare value clause', () => {
    expect(deriveStableWorkItemTitle('首轮时间有较明显增加,平均来到了10min'))
      .toBe('首轮时间增加')
  })

  it('uses one stable key for named work across testing stages', () => {
    expect(deriveWorkItemKey('Game Visual Design Skill 首轮测试'))
      .toBe(deriveWorkItemKey('Game Visual Design Skill 第二轮回归验证'))
    expect(deriveWorkItemKey('登录页视觉改版测试'))
      .toBe(deriveWorkItemKey('登录页视觉改版修复'))
    expect(deriveWorkItemKey('Skill A 首轮测试')).not.toBe(deriveWorkItemKey('Skill B 首轮测试'))
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
