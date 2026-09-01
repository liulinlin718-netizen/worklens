import { describe, expect, it } from 'vitest'
import type { AnalysisResult, SourceItem } from '@shared/contracts'
import {
  assertGroundedAnalysis,
  canonicalizeWorkItems,
  materializeTimelineAnalysis,
  mergeAnalysisResults,
  refineFallbackTimelineAnalysis,
  splitText
} from '@core/ai/analyzer'

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sourceDate: null,
    events: [],
    dailyBriefs: [],
    summary: { title: '摘要', content: '内容', highlights: [] },
    standup: {
      title: '明日早会汇报',
      overview: '今天完成了工作整理。',
      completed: [],
      inProgress: [],
      blockers: [],
      nextSteps: [],
      script: '大家早上好，今天同步一下工作。'
    },
    ...overrides
  }
}

function source(rawText: string, overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: '跨日工作记录',
    kind: 'text',
    rawText,
    excerpt: rawText.slice(0, 180),
    businessDate: null,
    datePrecision: 'unknown',
    dateOrigin: 'inferred',
    status: 'processing',
    error: null,
    contentHash: 'hash',
    assetCount: 0,
    workDates: [],
    createdAt: '2026-08-30T09:00:00.000Z',
    updatedAt: '2026-08-30T09:00:00.000Z',
    ...overrides
  }
}

describe('analysis orchestration', () => {
  it('rejects a structured provider refusal instead of storing it as work', () => {
    const result = analysis({
      events: [{
        title: '资料未读取',
        workItemKey: 'source-unreadable',
        workItemTitle: '资料未读取',
        eventType: '问题',
        eventDate: '2026-07-28',
        datePrecision: 'day',
        summary: '无法在规定的工具限制下读取 source.txt。',
        confidence: 0.62,
        evidence: [{ quote: '6.15', blockIndex: null }]
      }],
      summary: { title: '资料未读取', content: '没有可核验的工作资料。', highlights: [] },
      standup: {
        title: '明日早会汇报',
        overview: '没有可核验的工作资料。',
        completed: [],
        inProgress: [],
        blockers: ['无法读取 source.txt'],
        nextSteps: ['请提供 source.txt 正文'],
        script: '目前无法读取 source.txt，需要提供文件正文后继续。'
      }
    })

    expect(() => assertGroundedAnalysis(result, '6.15\n完成登录页视觉改版。'))
      .toThrow('AI 未能读取本次资料正文')
  })

  it('rejects events whose evidence cannot be found in the source', () => {
    const result = analysis({
      events: [{
        title: '虚构事项',
        workItemKey: 'invented',
        workItemTitle: '虚构事项',
        eventType: '工作',
        eventDate: '2026-08-30',
        datePrecision: 'day',
        summary: '不存在的工作内容。',
        confidence: 0.8,
        evidence: [{ quote: '这句话不在原始资料中', blockIndex: null }]
      }]
    })

    expect(() => assertGroundedAnalysis(result, '2026-08-30\n完成批量上传优化。'))
      .toThrow('无法在原文中核验')
  })

  it('allows an empty provider event list so trusted local extraction can recover it', () => {
    const result = analysis()

    expect(() => assertGroundedAnalysis(result, '2026-08-30\n完成批量上传优化。'))
      .not.toThrow()
  })

  it('keeps grounded events when one provider event uses unverifiable evidence', () => {
    const result = analysis({
      events: [
        {
          title: '完成批量上传优化',
          workItemKey: 'batch-upload',
          workItemTitle: '批量上传',
          eventType: '交付',
          eventDate: '2026-08-30',
          datePrecision: 'day',
          summary: '完成批量上传优化。',
          confidence: 0.9,
          evidence: [{ quote: '完成批量上传优化。', blockIndex: null }]
        },
        {
          title: '虚构事项',
          workItemKey: 'invented',
          workItemTitle: '虚构事项',
          eventType: '工作',
          eventDate: '2026-08-30',
          datePrecision: 'day',
          summary: '不存在的工作内容。',
          confidence: 0.8,
          evidence: [{ quote: '这句话不在原始资料中', blockIndex: null }]
        }
      ]
    })

    expect(() => assertGroundedAnalysis(result, '2026-08-30\n完成批量上传优化。'))
      .not.toThrow()
    expect(result.events.map((event) => event.title)).toEqual(['完成批量上传优化'])
  })

  it('splits long input on paragraph boundaries', () => {
    const chunks = splitText('第一段\n\n第二段很长\n\n第三段', 10)
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true)
    expect(chunks.join('\n\n')).toContain('第一段')
  })

  it('splits long work logs at date headings instead of cutting a workday in half', () => {
    const chunks = splitText(`6.15
完成登录页视觉改版和交互检查。
6.16
完成测试环境验证与问题修复。
6.17
完成接口联调和回归验证。`, 35)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatch(/^6\.15/u)
    expect(chunks[1]).toMatch(/^6\.16/u)
    expect(chunks[2]).toMatch(/^6\.17/u)
  })

  it('deduplicates entities while preserving evidence', () => {
    const merged = mergeAnalysisResults([
      analysis({
        events: [
          {
            title: '登录页改版',
            workItemKey: 'login-page-redesign',
            workItemTitle: '登录页改版',
            eventType: '交付',
            eventDate: '2026-07-15',
            datePrecision: 'day',
            summary: '完成改版',
            confidence: 0.8,
            evidence: [{ quote: '完成登录页改版', blockIndex: 0 }]
          }
        ]
      }),
      analysis({
        events: [
          {
            title: '登录页-改版',
            workItemKey: 'login-page-redesign',
            workItemTitle: '登录页改版',
            eventType: '交付',
            eventDate: '2026-07-15',
            datePrecision: 'day',
            summary: '完成登录页改版并上线测试环境',
            confidence: 0.92,
            evidence: [{ quote: '已上线测试环境', blockIndex: 2 }]
          }
        ]
      })
    ])

    expect(merged.events).toHaveLength(1)
    expect(merged.events[0]).toMatchObject({
      confidence: 0.92,
      summary: '完成登录页改版并上线测试环境'
    })
    expect(merged.events[0]!.evidence).toHaveLength(2)
  })

  it('keeps different updates for the same work item on the same day', () => {
    const merged = mergeAnalysisResults([
      analysis({
        events: [
          {
            title: '完成登录页视觉改版',
            workItemKey: 'login-page',
            workItemTitle: '登录页改版',
            eventType: '交付',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '完成视觉方案。',
            confidence: 0.9,
            evidence: [{ quote: '完成登录页视觉改版', blockIndex: 0 }]
          },
          {
            title: '修复登录页交互问题',
            workItemKey: 'login-page',
            workItemTitle: '登录页改版',
            eventType: '问题修复',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '修复输入框交互。',
            confidence: 0.88,
            evidence: [{ quote: '修复登录页输入框交互问题', blockIndex: 1 }]
          }
        ]
      })
    ])

    expect(merged.events).toHaveLength(2)
  })

  it('merges partial daily updates into one stand-up script', () => {
    const merged = mergeAnalysisResults([
      analysis({
        standup: {
          title: '早会汇报',
          overview: '完成登录页改版。',
          completed: ['完成登录页改版'],
          inProgress: [],
          blockers: [],
          nextSteps: ['开始接口联调'],
          script: '第一段逐字稿'
        }
      }),
      analysis({
        standup: {
          title: '早会汇报',
          overview: '接口联调等待权限。',
          completed: ['完成登录页改版'],
          inProgress: ['接口联调'],
          blockers: ['等待接口权限'],
          nextSteps: ['开始接口联调'],
          script: '第二段逐字稿'
        }
      })
    ])

    expect(merged.standup.completed).toEqual(['完成登录页改版'])
    expect(merged.standup.blockers).toEqual(['等待接口权限'])
    expect(merged.standup.script).toContain('大家早上好')
    expect(merged.standup.script).toContain('等待接口权限')
  })

  it('assigns and corrects model dates from the matching source sections', () => {
    const input = source(`2026-06-15
完成登录页视觉改版。

2026-06-16
登录页进入测试，并完成一轮交互问题修复。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '完成登录页视觉改版',
            workItemKey: 'login-page',
            workItemTitle: '登录页改版',
            eventType: '交付',
            eventDate: '2026-08-30',
            datePrecision: 'day',
            summary: '完成登录页视觉改版。',
            confidence: 0.9,
            evidence: [{ quote: '完成登录页视觉改版。', blockIndex: null }]
          },
          {
            title: '登录页进入测试',
            workItemKey: 'login-page',
            workItemTitle: '登录页改版',
            eventType: '验证',
            eventDate: null,
            datePrecision: 'unknown',
            summary: '进入测试并修复交互问题。',
            confidence: 0.88,
            evidence: [{ quote: '登录页进入测试，并完成一轮交互问题修复。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.eventDate)).toEqual([
      '2026-06-15',
      '2026-06-16'
    ])
  })

  it('creates dated timeline events when a provider returns an empty event list', () => {
    const input = source(`6月15日
完成登录页视觉改版。

6月16日
开始接口联调，等待测试环境权限。

6月17日
修复联调数据格式问题，并完成回归验证。`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    expect(materialized.events.map((event) => event.eventDate)).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17'
    ])
    expect(materialized.events[0]?.summary).toContain('登录页视觉改版')
    expect(materialized.events[1]?.summary).toContain('接口联调')
    expect(materialized.events[2]?.summary).toContain('回归验证')
  })

  it('prefers separate source entries over one duplicate composite model event', () => {
    const input = source(`2026-06-16
我是足球的游戏开发，数据埋点的学习，开展 dogfooding。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: '开发游戏并学习埋点',
          workItemKey: 'game-and-analytics',
          workItemTitle: '游戏与埋点',
          eventType: '开发',
          eventDate: '2026-06-16',
          datePrecision: 'day',
          summary: '开发游戏、学习埋点并开展 dogfooding。',
          confidence: 0.99,
          evidence: [{
            quote: '我是足球的游戏开发，数据埋点的学习，开展 dogfooding。',
            blockIndex: null
          }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.title)).toEqual([
      '我是足球的游戏开发',
      '数据埋点的学习',
      '开展 dogfooding'
    ])
  })

  it('splits a composite model event even when its evidence quotes only the first entry', () => {
    const input = source(`2026-06-16
1. 完成登录页改版
2. 开始接口联调`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: '完成登录页改版并开始接口联调',
          workItemKey: 'login-and-api',
          workItemTitle: '登录与接口工作',
          eventType: '工作',
          eventDate: '2026-06-16',
          datePrecision: 'day',
          summary: '完成登录页改版，并开始接口联调。',
          confidence: 0.96,
          evidence: [{ quote: '完成登录页改版', blockIndex: null }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成登录页改版',
      '开始接口联调'
    ])
  })

  it('keeps separately extracted AI events without adding local duplicates', () => {
    const input = source(`2026-06-16
1. 完成登录页改版
2. 开始接口联调`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '完成登录页改版',
            workItemKey: 'login-page',
            workItemTitle: '登录页改版',
            eventType: '交付',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '完成登录页改版。',
            confidence: 0.95,
            evidence: [{ quote: '完成登录页改版', blockIndex: null }]
          },
          {
            title: '开始接口联调',
            workItemKey: 'api-integration',
            workItemTitle: '接口联调',
            eventType: '工作',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '开始接口联调。',
            confidence: 0.93,
            evidence: [{ quote: '开始接口联调', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成登录页改版',
      '开始接口联调'
    ])
    expect(materialized.events.every((event) => event.confidence > 0.9)).toBe(true)
  })

  it('keeps two similar but independent same-day items', () => {
    const input = source(`2026-06-16
1. 完成登录页样式调整
2. 完成登录页交互调整`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '完成登录页样式调整',
            workItemKey: 'login-style',
            workItemTitle: '登录页样式',
            eventType: '交付',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '完成登录页样式调整。',
            confidence: 0.94,
            evidence: [{ quote: '完成登录页样式调整', blockIndex: null }]
          },
          {
            title: '完成登录页交互调整',
            workItemKey: 'login-interaction',
            workItemTitle: '登录页交互',
            eventType: '交付',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '完成登录页交互调整。',
            confidence: 0.92,
            evidence: [{ quote: '完成登录页交互调整', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成登录页样式调整',
      '完成登录页交互调整'
    ])
  })

  it('does not turn an embedded analysis prompt into timeline work', () => {
    const input = source(`2026-07-03
- 完成 Discover 页面补埋测试。
你是 Combos 用户分层分析助手。
筛选标准：
1. 工程交付类：源码、工程文件、项目导出。
- “加几个关卡 / 敌人 / 道具”
输出格式：
{ "is_professional_user": true }`)
    const materialized = materializeTimelineAnalysis(
      analysis(),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成 Discover 页面补埋测试'
    ])
  })

  it('keeps prompt artifact state across fake date headings and resumes after its fenced output', () => {
    const input = source([
      '2026-07-03',
      '1. 完成真实的首页埋点验证。',
      '你是用户分层分析助手。',
      '筛选标准：',
      '2026-01-12',
      '1. 示例任务：加几个关卡和敌人。',
      '输出格式：',
      '```json',
      '{ "events": [] }',
      '```',
      '2026-07-07',
      '1. 完成真实的分层结果复核。'
    ].join('\n'))
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.eventDate)).toEqual([
      '2026-07-03',
      '2026-07-07'
    ])
    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成真实的首页埋点验证',
      '完成真实的分层结果复核'
    ])
  })

  it('drops an otherwise grounded AI event whose evidence exists only in a prompt example', () => {
    const promptExample = '示例任务：发布一个并不存在的营销活动。'
    const input = source([
      '2026-07-03',
      '完成真实的首页埋点验证。',
      '系统提示：',
      '范例：',
      '2026-01-12',
      promptExample,
      '输出格式：',
      '{ "events": [] }'
    ].join('\n'))
    const providerResult = analysis({
      events: [
        {
          title: '完成首页埋点验证',
          workItemKey: 'home-analytics',
          workItemTitle: '首页埋点验证',
          eventType: '验证',
          eventDate: '2026-07-03',
          datePrecision: 'day',
          summary: '完成真实的首页埋点验证。',
          confidence: 0.94,
          evidence: [{ quote: '完成真实的首页埋点验证。', blockIndex: null }]
        },
        {
          title: '发布营销活动',
          workItemKey: 'marketing-campaign',
          workItemTitle: '营销活动',
          eventType: '交付',
          eventDate: '2026-01-12',
          datePrecision: 'day',
          summary: promptExample,
          confidence: 0.99,
          evidence: [{ quote: promptExample, blockIndex: null }]
        }
      ]
    })

    // It is grounded in the transport payload, but not in the trusted work text.
    expect(() => assertGroundedAnalysis(providerResult, input.rawText)).not.toThrow()
    const materialized = materializeTimelineAnalysis(
      providerResult,
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.title)).toEqual(['完成首页埋点验证'])
    expect(materialized.events.some((event) => event.eventDate === '2026-01-12')).toBe(false)
  })

  it.each([
    {
      name: 'Chinese system/example/output prompt with a JSON fence',
      prompt: [
        '系统提示：',
        '角色：你是工作分类专家。',
        '范例：',
        '2025-02-03',
        '1. 这是中文伪造示例。',
        '输出格式：',
        '```json',
        '{ "events": [] }',
        '```'
      ]
    },
    {
      name: 'English system/role/example/output prompt in a generic fence',
      prompt: [
        '~~~text',
        'System Prompt:',
        'Role: You are a work classifier.',
        'Examples:',
        '2025-02-03',
        '1. This is a fake example task.',
        'Output Format:',
        '{ "events": [] }',
        '~~~'
      ]
    },
    {
      name: 'explicit prompt fence variant',
      prompt: [
        '```prompt',
        'You are a work-summary assistant.',
        'Example:',
        '2025-02-03',
        '1. Another fake example task.',
        '```'
      ]
    },
    {
      name: 'unfenced one-line JSON output variant',
      prompt: [
        'Instructions:',
        'Example:',
        '2025-02-03',
        '1. A fake task from the example.',
        'Output Format:',
        '{ "events": [] }'
      ]
    }
  ])('ignores $name', ({ prompt }) => {
    const input = source([
      '2026-08-01',
      '1. 完成真实任务一。',
      ...prompt,
      '2026-08-02',
      '1. 完成真实任务二。'
    ].join('\n'))
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.eventDate)).toEqual([
      '2026-08-01',
      '2026-08-02'
    ])
    expect(materialized.events.map((event) => event.title)).toEqual([
      '完成真实任务一',
      '完成真实任务二'
    ])
  })

  it('fills missing dated sections and does not reuse stale generated dates', () => {
    const input = source(`6.15
完成登录页视觉改版。

6.16
开始接口联调。`, { workDates: ['2026-07-28'] })
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: '完成登录页视觉改版',
          workItemKey: 'login-page',
          workItemTitle: '登录页改版',
          eventType: '交付',
          eventDate: '2026-06-15',
          datePrecision: 'day',
          summary: '完成登录页视觉改版。',
          confidence: 0.9,
          evidence: [{ quote: '完成登录页视觉改版。', blockIndex: null }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.eventDate)).toEqual([
      '2026-06-15',
      '2026-06-16'
    ])
    expect(materialized.events.some((event) => event.eventDate === '2026-07-28')).toBe(false)
  })

  it('recovers every numbered work item when the provider collapses a day into one summary', () => {
    const input = source(`6.22
今日工作
1.APP 端看板构建
2.skills 应用 SOP 构建
3.skills 批量测试
4.排查 AI 回复后中断用户项目原因`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: '推进当日多项工作',
          workItemKey: 'daily-work',
          workItemTitle: '当日工作',
          eventType: '工作',
          eventDate: '2026-06-22',
          datePrecision: 'day',
          summary: '推进看板、SOP、批量测试和问题排查。',
          confidence: 0.82,
          evidence: [{
            quote: '1.APP 端看板构建\n2.skills 应用 SOP 构建\n3.skills 批量测试\n4.排查 AI 回复后中断用户项目原因',
            blockIndex: null
          }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    const quotes = materialized.events.flatMap((event) => event.evidence.map((item) => item.quote))
    expect(quotes).toEqual(expect.arrayContaining([
      'APP 端看板构建',
      'skills 应用 SOP 构建',
      'skills 批量测试',
      '排查 AI 回复后中断用户项目原因'
    ]))
    expect(materialized.events.filter((event) => event.eventDate === '2026-06-22').length)
      .toBeGreaterThanOrEqual(4)
  })

  it('splits a compact comma list into independent work events', () => {
    const input = source(`6.17
埋点学习和交接,足球游戏进行收尾,埋点看板制定,测试环境交接。`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.summary)).toEqual([
      '埋点学习和交接',
      '足球游戏进行收尾',
      '埋点看板制定',
      '测试环境交接'
    ])
  })

  it('keeps top-level work items without turning nested detail into extra events', () => {
    const input = source(`6.24
1.完成用户数据分析并形成报告。
  1.动作格斗 141 个
  2.跑酷平台 41 个
报告中的统计说明不应成为独立工作。
2.完善排行榜功能并发布。`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events.map((event) => event.summary)).toEqual([
      '完成用户数据分析并形成报告',
      '完善排行榜功能并发布'
    ])
  })

  it('does not treat a data range as a new work-log date', () => {
    const input = source(`7.3
1.整理专业用户筛选标准。
6.29-7.5 Combos 专业用户筛选

7.7
1.完成专业用户筛选。`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(Array.from(new Set(materialized.events.map((event) => event.eventDate)))).toEqual([
      '2026-07-03',
      '2026-07-07'
    ])
  })

  it('keeps more than thirty distinct work dates', () => {
    const january = Array.from({ length: 31 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}\n1.完成事项 ${index + 1}`)
    const february = Array.from({ length: 17 }, (_, index) => `2026-02-${String(index + 1).padStart(2, '0')}\n1.完成事项 ${index + 32}`)
    const input = source([...january, ...february].join('\n'))
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(48)
    expect(new Set(materialized.events.map((event) => event.eventDate)).size).toBe(48)
  })

  it('groups stages of the same named Skill into one stable work item', () => {
    const input = source(`2026-06-15
Game Visual Design Skill 首轮测试。
2026-06-16
修复 Game Visual Design Skill 调用异常。
2026-06-17
Game Visual Design Skill 第三轮回归验证。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Game Visual Design Skill 首轮测试',
            workItemKey: 'skill-first-test',
            workItemTitle: 'Game Visual Design Skill 首轮测试',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '完成第一轮测试。',
            confidence: 0.9,
            evidence: [{ quote: 'Game Visual Design Skill 首轮测试。', blockIndex: null }]
          },
          {
            title: '修复 Game Visual Design Skill 调用异常',
            workItemKey: 'skill-fix',
            workItemTitle: 'Game Visual Design Skill 调用异常修复',
            eventType: '问题修复',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '处理调用异常。',
            confidence: 0.88,
            evidence: [{ quote: '修复 Game Visual Design Skill 调用异常。', blockIndex: null }]
          },
          {
            title: 'Game Visual Design Skill 第三轮回归验证',
            workItemKey: 'skill-regression',
            workItemTitle: 'Game Visual Design Skill 回归验证',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '进行第三轮回归验证。',
            confidence: 0.91,
            evidence: [{ quote: 'Game Visual Design Skill 第三轮回归验证。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(1)
    expect(new Set(materialized.events.map((event) => event.workItemTitle))).toEqual(
      new Set(['Game Visual Design Skill'])
    )
    expect(materialized.events.map((event) => event.title)).toEqual([
      'Game Visual Design Skill 首轮测试',
      '修复 Game Visual Design Skill 调用异常',
      'Game Visual Design Skill 第三轮回归验证'
    ])
  })

  it('reuses a grounded provider key across chunks for stages of the same named module', () => {
    const input = source(`2026-06-15
素材生成模块首轮测试。
2026-06-18
修复素材生成模块调用错误。
2026-06-22
素材生成模块回归验证。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '素材生成模块首轮测试',
            workItemKey: 'asset-generation-module',
            workItemTitle: '素材生成模块',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '开展首轮测试。',
            confidence: 0.9,
            evidence: [{ quote: '素材生成模块首轮测试。', blockIndex: null }]
          },
          {
            title: '修复素材生成模块调用错误',
            workItemKey: 'asset-generation-module',
            workItemTitle: '素材生成模块调用修复',
            eventType: '问题修复',
            eventDate: '2026-06-18',
            datePrecision: 'day',
            summary: '修复调用错误。',
            confidence: 0.88,
            evidence: [{ quote: '修复素材生成模块调用错误。', blockIndex: null }]
          },
          {
            title: '素材生成模块回归验证',
            workItemKey: 'asset-generation-module',
            workItemTitle: '素材生成模块回归',
            eventType: '验证',
            eventDate: '2026-06-22',
            datePrecision: 'day',
            summary: '进行回归验证。',
            confidence: 0.91,
            evidence: [{ quote: '素材生成模块回归验证。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    expect(new Set(materialized.events.map((event) => event.eventDate)).size).toBe(3)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(1)
  })

  it('merges repeated module themes without joining different sub-features through the module name', () => {
    const input = source(`2026-06-15
素材中心模块上传测试。
2026-06-16
修复素材中心模块支付问题。
2026-06-17
素材中心模块上传回归。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '素材中心模块上传测试',
            workItemKey: 'asset-upload-test',
            workItemTitle: '素材中心模块上传',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试上传能力。',
            confidence: 0.9,
            evidence: [{ quote: '素材中心模块上传测试。', blockIndex: null }]
          },
          {
            title: '修复素材中心模块支付问题',
            workItemKey: 'asset-payment-fix',
            workItemTitle: '素材中心模块支付',
            eventType: '问题修复',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '修复支付问题。',
            confidence: 0.9,
            evidence: [{ quote: '修复素材中心模块支付问题。', blockIndex: null }]
          },
          {
            title: '素材中心模块上传回归',
            workItemKey: 'asset-upload-regression',
            workItemTitle: '素材中心模块上传',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '回归上传能力。',
            confidence: 0.9,
            evidence: [{ quote: '素材中心模块上传回归。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    const uploadEvents = materialized.events.filter((event) => event.title.includes('上传'))
    const paymentEvent = materialized.events.find((event) => event.title.includes('支付'))!
    expect(new Set(uploadEvents.map((event) => event.workItemKey)).size).toBe(1)
    expect(uploadEvents[0]?.workItemKey).not.toBe(paymentEvent.workItemKey)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
  })

  it('does not trust one broad provider key for different themes under the same product', () => {
    const input = source(`2026-06-15
Generator 素材生成测试。
2026-06-16
修复 Generator 素材下载问题。`)
    const events: AnalysisResult['events'] = [
      {
        title: 'Generator 素材生成测试',
        workItemKey: 'generator-work',
        workItemTitle: 'Generator 素材',
        eventType: '验证',
        eventDate: '2026-06-15',
        datePrecision: 'day',
        summary: '测试素材生成。',
        confidence: 0.9,
        evidence: [{ quote: 'Generator 素材生成测试。', blockIndex: null }]
      },
      {
        title: '修复 Generator 素材下载问题',
        workItemKey: 'generator-work',
        workItemTitle: 'Generator 素材',
        eventType: '问题修复',
        eventDate: '2026-06-16',
        datePrecision: 'day',
        summary: '修复素材下载问题。',
        confidence: 0.9,
        evidence: [{ quote: '修复 Generator 素材下载问题。', blockIndex: null }]
      }
    ]
    const run = (orderedEvents: AnalysisResult['events']): AnalysisResult =>
      materializeTimelineAnalysis(
        analysis({ events: orderedEvents }),
        [input],
        null,
        '2026-08-30'
      )
    const materialized = run(events)
    const reversed = run([...events].reverse())
    const signatures = (result: AnalysisResult): Array<[string, string, string]> =>
      result.events
        .map((event) => [event.title, event.workItemKey, event.workItemTitle] as [string, string, string])
        .sort((left, right) => left[0].localeCompare(right[0]))

    expect(materialized.events).toHaveLength(2)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
    expect(new Set(materialized.events.map((event) => event.workItemTitle)).size).toBe(2)
    expect(materialized.events.map((event) => event.workItemTitle)).not.toContain('Generator 素材')
    expect(signatures(reversed)).toEqual(signatures(materialized))
  })

  it('keeps a generic test and a grounded sub-theme regression under the same named Skill key', () => {
    const input = source(`2026-06-15
Alpha Skill 首轮测试。
2026-06-17
Alpha Skill 图片生成回归。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Alpha Skill 首轮测试',
            workItemKey: 'alpha-skill',
            workItemTitle: 'Alpha Skill',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '开展首轮测试。',
            confidence: 0.9,
            evidence: [{ quote: 'Alpha Skill 首轮测试。', blockIndex: null }]
          },
          {
            title: 'Alpha Skill 图片生成回归',
            workItemKey: 'alpha-skill',
            workItemTitle: 'Alpha Skill 图片生成',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '回归图片生成。',
            confidence: 0.9,
            evidence: [{ quote: 'Alpha Skill 图片生成回归。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(1)
  })

  it('carries one grounded provider identity across nearby context-omitted updates', () => {
    const input = source(`7.15：完成游戏 Agent 记忆方案评审。
7.16：开始验证记忆方案，需要增加失败重试入口。
补充记忆回放验收清单。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '游戏 Agent 记忆方案完成评审',
            workItemKey: 'agent-memory-plan',
            workItemTitle: '游戏 Agent 记忆方案',
            eventType: '评审',
            eventDate: '2026-07-15',
            datePrecision: 'day',
            summary: '团队完成记忆方案评审。',
            confidence: 0.94,
            evidence: [{ quote: '完成游戏 Agent 记忆方案评审', blockIndex: 0 }]
          },
          {
            title: '游戏 Agent 记忆方案进入验证',
            workItemKey: 'agent-memory-plan',
            workItemTitle: '游戏 Agent 记忆方案',
            eventType: '验证',
            eventDate: '2026-07-16',
            datePrecision: 'day',
            summary: '记忆方案进入验证，并开始补充失败重试入口。',
            confidence: 0.91,
            evidence: [{ quote: '开始验证记忆方案，需要增加失败重试入口', blockIndex: 1 }]
          },
          {
            title: '补充记忆回放验收清单',
            workItemKey: 'agent-memory-plan',
            workItemTitle: '游戏 Agent 记忆方案',
            eventType: '验证',
            eventDate: '2026-07-16',
            datePrecision: 'day',
            summary: '补充记忆回放的验收清单。',
            confidence: 0.9,
            evidence: [{ quote: '补充记忆回放验收清单', blockIndex: 2 }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(1)
    expect(new Set(materialized.events.map((event) => event.workItemTitle))).toEqual(
      new Set(['游戏 Agent 记忆方案'])
    )
  })

  it('does not bridge two incompatible context-omitted sub-themes across dates', () => {
    const input = source(`2026-06-15
完成 Alpha Skill 方案评审。
2026-06-16
补充图片生成检查清单。
2026-06-17
补充文档解析检查清单。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Alpha Skill 方案完成评审',
            workItemKey: 'alpha-skill-plan',
            workItemTitle: 'Alpha Skill 方案',
            eventType: '评审',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '完成方案评审。',
            confidence: 0.92,
            evidence: [{ quote: '完成 Alpha Skill 方案评审', blockIndex: 0 }]
          },
          {
            title: '补充图片生成检查清单',
            workItemKey: 'alpha-skill-plan',
            workItemTitle: 'Alpha Skill 方案',
            eventType: '验证',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '补充图片生成检查清单。',
            confidence: 0.9,
            evidence: [{ quote: '补充图片生成检查清单', blockIndex: 1 }]
          },
          {
            title: '补充文档解析检查清单',
            workItemKey: 'alpha-skill-plan',
            workItemTitle: 'Alpha Skill 方案',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '补充文档解析检查清单。',
            confidence: 0.9,
            evidence: [{ quote: '补充文档解析检查清单', blockIndex: 2 }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
    expect(materialized.events[1]?.workItemKey).not.toBe(materialized.events[2]?.workItemKey)
  })

  it('keeps a grounded Remix identity across object-only and social-publish stages', () => {
    const input = source(`2026-08-14
Remix两个游戏。
2026-08-18
Remix两个游戏发社媒。
2026-08-20
Remix两个游戏发社媒。发了社媒。`)
    const events: AnalysisResult['events'] = [
      {
        title: 'Remix 两个游戏',
        workItemKey: 'remix-games-social',
        workItemTitle: 'Remix两个游戏发社媒',
        eventType: '开发',
        eventDate: '2026-08-14',
        datePrecision: 'day',
        summary: '完成两个游戏的 Remix。',
        confidence: 0.9,
        evidence: [{ quote: 'Remix两个游戏。', blockIndex: 0 }]
      },
      {
        title: 'Remix 两个游戏并发社媒',
        workItemKey: 'remix-games-social',
        workItemTitle: 'Remix两个游戏发社媒',
        eventType: '发布',
        eventDate: '2026-08-18',
        datePrecision: 'day',
        summary: 'Remix两个游戏发社媒。',
        confidence: 0.91,
        evidence: [{ quote: 'Remix两个游戏发社媒。', blockIndex: 1 }]
      },
      {
        title: '完成两个 Remix 游戏并发布社媒',
        workItemKey: 'remix-games-social',
        workItemTitle: 'Remix两个游戏发社媒',
        eventType: '发布',
        eventDate: '2026-08-20',
        datePrecision: 'day',
        summary: 'Remix 两个游戏并发布社媒。',
        confidence: 0.92,
        evidence: [{ quote: 'Remix两个游戏发社媒。发了社媒。', blockIndex: 2 }]
      }
    ]
    const materialized = materializeTimelineAnalysis(
      analysis({ events }),
      [input],
      null,
      '2026-08-30'
    )

    const providerEvents = materialized.events.filter((event) => event.confidence > 0.8)
    expect(providerEvents).toHaveLength(2)
    expect(new Set(providerEvents.map((event) => event.workItemKey)).size).toBe(1)
    expect(new Set(providerEvents.map((event) => event.workItemTitle))).toEqual(
      new Set(['Remix两个游戏发社媒'])
    )
  })

  it('keeps credit-shortage inspection stages under one grounded provider identity', () => {
    const input = source(`2026-07-16
credit不足的问题。看数据。
2026-07-17
credit不足的问题。看数据。
2026-07-20
credit不足的问题。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: '查看 credit 不足问题数据',
            workItemKey: 'credit-shortage',
            workItemTitle: 'credit不足的问题',
            eventType: '分析',
            eventDate: '2026-07-16',
            datePrecision: 'day',
            summary: '通过数据继续分析 credit 不足问题。',
            confidence: 0.9,
            evidence: [{ quote: 'credit不足的问题。看数据。', blockIndex: 0 }]
          },
          {
            title: 'credit不足的问题。看数据',
            workItemKey: 'credit-shortage',
            workItemTitle: 'credit不足的问题',
            eventType: '问题',
            eventDate: '2026-07-17',
            datePrecision: 'day',
            summary: 'credit不足的问题。看数据。',
            confidence: 0.91,
            evidence: [{ quote: 'credit不足的问题。看数据。', blockIndex: 1 }]
          },
          {
            title: 'credit不足的问题',
            workItemKey: 'credit-shortage',
            workItemTitle: 'credit不足的问题',
            eventType: '问题',
            eventDate: '2026-07-20',
            datePrecision: 'day',
            summary: 'credit不足的问题。',
            confidence: 0.92,
            evidence: [{ quote: 'credit不足的问题', blockIndex: 2 }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    const providerEvents = materialized.events.filter((event) => event.confidence > 0.8)
    expect(providerEvents).toHaveLength(3)
    expect(new Set(providerEvents.map((event) => event.workItemKey)).size).toBe(1)
    expect(new Set(providerEvents.map((event) => event.workItemTitle))).toEqual(
      new Set(['credit不足的问题'])
    )
  })

  it('repairs provider key drift only when the same distinctive title is exact-grounded in both groups', () => {
    const events = canonicalizeWorkItems([
      {
        title: '查看 credit 不足问题数据',
        workItemKey: 'credit-inspection-stage',
        workItemTitle: 'credit不足的问题',
        eventType: '分析',
        eventDate: '2026-07-16',
        datePrecision: 'day',
        summary: '查看 credit 不足问题数据。',
        confidence: 0.9,
        evidence: [{ quote: 'credit不足的问题。检查支付失败数据。', blockIndex: 0 }]
      },
      {
        title: '继续跟进 credit 不足问题',
        workItemKey: 'credit-followup-stage',
        workItemTitle: 'credit不足的问题',
        eventType: '问题',
        eventDate: '2026-07-20',
        datePrecision: 'day',
        summary: '继续跟进 credit 不足问题。',
        confidence: 0.92,
        evidence: [{ quote: 'credit不足的问题。持续跟进余额校验。', blockIndex: 1 }]
      }
    ])

    expect(events).toHaveLength(2)
    expect(new Set(events.map((event) => event.workItemKey)).size).toBe(1)
    expect(new Set(events.map((event) => event.workItemTitle)).size).toBe(1)
    expect(events[0]!.workItemTitle).toContain('credit')
  })

  it('does not repair key drift when the same grounded Skill label hides two explicit sub-themes', () => {
    const events = canonicalizeWorkItems([
      {
        title: 'Alpha Skill 图片生成修复',
        workItemKey: 'alpha-image-stage',
        workItemTitle: 'Alpha Skill',
        eventType: '问题修复',
        eventDate: '2026-06-15',
        datePrecision: 'day',
        summary: '修复图片生成。',
        confidence: 0.9,
        evidence: [{ quote: 'Alpha Skill 图片生成修复。', blockIndex: null }]
      },
      {
        title: 'Alpha Skill 文档解析修复',
        workItemKey: 'alpha-document-stage',
        workItemTitle: 'Alpha Skill',
        eventType: '问题修复',
        eventDate: '2026-06-16',
        datePrecision: 'day',
        summary: '修复文档解析。',
        confidence: 0.9,
        evidence: [{ quote: 'Alpha Skill 文档解析修复。', blockIndex: null }]
      }
    ])

    expect(new Set(events.map((event) => event.workItemKey)).size).toBe(2)
    expect(new Set(events.map((event) => event.workItemTitle)).size).toBe(2)
  })

  it('keeps two Skill sub-themes separate around one generic stage independent of input order', () => {
    const input = source(`2026-06-15
Alpha Skill 图片生成修复。
2026-06-16
Alpha Skill 文档解析修复。
2026-06-17
Alpha Skill 首轮测试。`)
    const events: AnalysisResult['events'] = [
      {
        title: 'Alpha Skill 图片生成修复',
        workItemKey: 'alpha-image-generation',
        workItemTitle: 'Alpha Skill 图片生成',
        eventType: '问题修复',
        eventDate: '2026-06-15',
        datePrecision: 'day',
        summary: '修复图片生成。',
        confidence: 0.9,
        evidence: [{ quote: 'Alpha Skill 图片生成修复。', blockIndex: null }]
      },
      {
        title: 'Alpha Skill 文档解析修复',
        workItemKey: 'alpha-document-parsing',
        workItemTitle: 'Alpha Skill 文档解析',
        eventType: '问题修复',
        eventDate: '2026-06-16',
        datePrecision: 'day',
        summary: '修复文档解析。',
        confidence: 0.9,
        evidence: [{ quote: 'Alpha Skill 文档解析修复。', blockIndex: null }]
      },
      {
        title: 'Alpha Skill 首轮测试',
        workItemKey: 'alpha-skill',
        workItemTitle: 'Alpha Skill',
        eventType: '验证',
        eventDate: '2026-06-17',
        datePrecision: 'day',
        summary: '开展首轮测试。',
        confidence: 0.9,
        evidence: [{ quote: 'Alpha Skill 首轮测试。', blockIndex: null }]
      }
    ]
    const run = (orderedEvents: AnalysisResult['events']): AnalysisResult =>
      materializeTimelineAnalysis(
        analysis({ events: orderedEvents }),
        [input],
        null,
        '2026-08-30'
      )
    const forward = run(events)
    const reversed = run([...events].reverse())
    const signatures = (result: AnalysisResult): Array<[string, string, string]> =>
      result.events
        .map((event) => [event.title, event.workItemKey, event.workItemTitle] as [string, string, string])
        .sort((left, right) => left[0].localeCompare(right[0]))

    expect(forward.events).toHaveLength(3)
    expect(new Set(forward.events.map((event) => event.workItemKey)).size).toBe(2)
    expect(signatures(reversed)).toEqual(signatures(forward))
    const imageKey = forward.events.find((event) => event.title.includes('图片生成'))?.workItemKey
    const documentKey = forward.events.find((event) => event.title.includes('文档解析'))?.workItemKey
    const genericKey = forward.events.find((event) => event.title.includes('首轮测试'))?.workItemKey
    expect(imageKey).not.toBe(documentKey)
    expect([imageKey, documentKey]).toContain(genericKey)
  })

  it('does not merge different leaf Skills through one shared umbrella Skill', () => {
    const input = source(`2026-06-15
Platform Skill 与 Alpha Skill 首轮测试。
2026-06-16
Platform Skill 与 Beta Skill 首轮测试。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Platform Skill 与 Alpha Skill 首轮测试',
            workItemKey: 'platform-skill',
            workItemTitle: 'Platform Skill',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试 Platform Skill 与 Alpha Skill。',
            confidence: 0.9,
            evidence: [{ quote: 'Platform Skill 与 Alpha Skill 首轮测试。', blockIndex: null }]
          },
          {
            title: 'Platform Skill 与 Beta Skill 首轮测试',
            workItemKey: 'platform-skill',
            workItemTitle: 'Platform Skill',
            eventType: '验证',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '测试 Platform Skill 与 Beta Skill。',
            confidence: 0.9,
            evidence: [{ quote: 'Platform Skill 与 Beta Skill 首轮测试。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
  })

  it('treats grounded 能力 and 功能 suffixes as the same named scope', () => {
    const input = source(`2026-06-15
Atlas Skill 图片生成能力测试。
2026-06-17
Atlas Skill 图片生成功能回归。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Atlas Skill 图片生成能力测试',
            workItemKey: 'atlas-capability-test',
            workItemTitle: 'Atlas Skill 图片生成能力',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试图片生成能力。',
            confidence: 0.9,
            evidence: [{ quote: 'Atlas Skill 图片生成能力测试。', blockIndex: null }]
          },
          {
            title: 'Atlas Skill 图片生成功能回归',
            workItemKey: 'atlas-function-regression',
            workItemTitle: 'Atlas Skill 图片生成功能',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '回归图片生成功能。',
            confidence: 0.9,
            evidence: [{ quote: 'Atlas Skill 图片生成功能回归。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(1)
  })

  it('does not form a large item through a transitive theme bridge', () => {
    const input = source(`2026-06-15
Generator 模型切换测试。
2026-06-16
Generator 模型切换埋点测试。
2026-06-17
Generator 切换埋点回归。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Generator 模型切换测试',
            workItemKey: 'generator-model-switch',
            workItemTitle: 'Generator 模型切换',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试模型切换。',
            confidence: 0.9,
            evidence: [{ quote: 'Generator 模型切换测试。', blockIndex: null }]
          },
          {
            title: 'Generator 模型切换埋点测试',
            workItemKey: 'generator-switch-tracking',
            workItemTitle: 'Generator 模型切换埋点',
            eventType: '验证',
            eventDate: '2026-06-16',
            datePrecision: 'day',
            summary: '测试模型切换埋点。',
            confidence: 0.9,
            evidence: [{ quote: 'Generator 模型切换埋点测试。', blockIndex: null }]
          },
          {
            title: 'Generator 切换埋点回归',
            workItemKey: 'generator-tracking-regression',
            workItemTitle: 'Generator 切换埋点',
            eventType: '验证',
            eventDate: '2026-06-17',
            datePrecision: 'day',
            summary: '回归切换埋点。',
            confidence: 0.9,
            evidence: [{ quote: 'Generator 切换埋点回归。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(3)
    const keyCounts = Array.from(materialized.events.reduce((counts, event) => {
      counts.set(event.workItemKey, (counts.get(event.workItemKey) ?? 0) + 1)
      return counts
    }, new Map<string, number>()).values()).sort((left, right) => right - left)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
    expect(keyCounts).toEqual([2, 1])
  })

  it('does not merge different named Skills that share generic testing words', () => {
    const input = source(`2026-06-15
Alpha Skill 第一轮测试。
Beta Skill 第一轮测试。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [
          {
            title: 'Alpha Skill 第一轮测试',
            workItemKey: 'generic-test',
            workItemTitle: 'Alpha Skill 测试',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试 Alpha Skill。',
            confidence: 0.9,
            evidence: [{ quote: 'Alpha Skill 第一轮测试。', blockIndex: null }]
          },
          {
            title: 'Beta Skill 第一轮测试',
            workItemKey: 'generic-test',
            workItemTitle: 'Beta Skill 测试',
            eventType: '验证',
            eventDate: '2026-06-15',
            datePrecision: 'day',
            summary: '测试 Beta Skill。',
            confidence: 0.9,
            evidence: [{ quote: 'Beta Skill 第一轮测试。', blockIndex: null }]
          }
        ]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(2)
    expect(new Set(materialized.events.map((event) => event.workItemKey)).size).toBe(2)
  })

  it('uses collision-free keys when unrelated groups normalize to the same label', () => {
    const input = source(`2026-06-15
Alpha 页面测试。
Beta 页面测试。
Gamma 页面测试。`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    const titlesByKey = new Map<string, Set<string>>()
    for (const event of materialized.events) {
      titlesByKey.set(event.workItemKey, new Set([
        ...(titlesByKey.get(event.workItemKey) ?? []),
        event.workItemTitle
      ]))
    }
    expect(materialized.events).toHaveLength(3)
    expect(Array.from(titlesByKey.values()).every((titles) => titles.size === 1)).toBe(true)
  })

  it('rejects an unsupported item title and falls back to evidence wording', () => {
    const input = source(`2026-06-15
Game Skill 第一轮测试。`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: 'Game Skill 第一轮测试',
          workItemKey: 'invented-project',
          workItemTitle: '星河项目自动通过',
          eventType: '验证',
          eventDate: '2026-06-15',
          datePrecision: 'day',
          summary: '进行第一轮测试。',
          confidence: 0.9,
          evidence: [{ quote: 'Game Skill 第一轮测试。', blockIndex: null }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events[0]?.workItemTitle).toBe('Game Skill')
    expect(materialized.events[0]?.workItemTitle).not.toContain('星河')
    expect(materialized.events[0]?.workItemTitle).not.toContain('通过')
  })

  it('selects a grounded noun phrase instead of a conversational provider title', () => {
    const wording = '能不能帮忙看一下 Atlas Skill 在移动端的 case 兼容情况是否符合预期？'
    const input = source(`2026-06-15\n${wording}`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: wording,
          workItemKey: 'atlas-mobile-question',
          workItemTitle: wording,
          eventType: '验证',
          eventDate: '2026-06-15',
          datePrecision: 'day',
          summary: wording,
          confidence: 0.9,
          evidence: [{ quote: wording, blockIndex: null }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(1)
    expect(materialized.events[0]?.workItemTitle).toBe('Atlas Skill 在移动端的 case 兼容情况')
    expect(materialized.events[0]?.workItemTitle).not.toMatch(/能不能|帮忙|看一下|是否|符合预期/u)
    expect(materialized.events[0]?.title).toBe(wording)
  })

  it('prefers a more specific grounded event identity over a grounded provider conversation', () => {
    const wording = '跟甲方对一下需求，完成封面需求与 FooUI 截图逻辑确认。'
    const input = source(`2026-06-15\n${wording}`)
    const materialized = materializeTimelineAnalysis(
      analysis({
        events: [{
          title: '完成封面需求与 FooUI 截图逻辑确认',
          workItemKey: 'client-requirement-sync',
          workItemTitle: '跟甲方对一下需求',
          eventType: '确认',
          eventDate: '2026-06-15',
          datePrecision: 'day',
          summary: '确认封面需求与截图逻辑。',
          confidence: 0.94,
          evidence: [{ quote: wording, blockIndex: null }]
        }]
      }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(1)
    expect(materialized.events[0]?.workItemTitle).toBe('封面需求与 FooUI 截图逻辑确认')
    expect(materialized.events[0]?.workItemTitle).not.toContain('跟甲方对一下')
  })

  it('derives a grounded fallback title after URL and compound result wrappers', () => {
    const wording = '高优测试一下 Atlas Skill 各种数据，统一性好。'
    const input = source(`2026-06-15\nhttps://example.invalid/report\n${wording}`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(1)
    expect(materialized.events[0]?.workItemTitle).toBe('Atlas Skill 数据')
    expect(materialized.events[0]?.workItemTitle).not.toMatch(/https?:|高优|测试一下|各种|统一性好/u)
    expect(materialized.events[0]?.evidence[0]?.quote).toContain('Atlas Skill 各种数据')
  })

  it('sends empty-provider local recovery through semantic refinement', async () => {
    const wording = 'Atlas Skill 完成第一轮数据兼容测试。'
    const input = source(`2026-06-15\n${wording}`)
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )
    let calls = 0
    const quote = materialized.events[0]?.evidence[0]?.quote ?? wording
    const refined = await refineFallbackTimelineAnalysis(
      materialized,
      refinementOptions(async (request) => {
        calls += 1
        expect(request.mode).toBe('fallback_refinement')
        return {
          provider: 'test-provider',
          model: 'test-model',
          externalRunId: null,
          result: analysis({
            events: [{
              title: 'Atlas Skill 数据兼容首轮测试',
              workItemKey: 'atlas-skill-data-compatibility',
              workItemTitle: 'Atlas Skill 数据兼容',
              eventType: '验证',
              eventDate: '2026-06-15',
              datePrecision: 'day',
              summary: wording,
              confidence: 0.93,
              evidence: [{ quote, blockIndex: null }]
            }]
          })
        }
      })
    )

    expect(calls).toBe(1)
    expect(refined.result.events).toHaveLength(1)
    expect(refined.result.events[0]).toMatchObject({
      workItemTitle: 'Atlas Skill 数据兼容',
      confidence: 0.93
    })
  })

  it('uses the local source date only when the text contains no time clue', () => {
    const input = source('完成批量上传页面优化，并修复拖拽导入问题。')
    const materialized = materializeTimelineAnalysis(
      analysis({ events: [] }),
      [input],
      null,
      '2026-08-30'
    )

    expect(materialized.events).toHaveLength(1)
    expect(materialized.events[0]?.eventDate).toBe('2026-08-30')
    expect(materialized.events[0]?.summary).toContain('批量上传页面优化')
  })

  it('losslessly replaces only fallback events with an exact dated evidence match', async () => {
    const firstQuote = 'Alpha Skill 完成第一轮数据兼容测试。'
    const secondQuote = '整理另一个页面的复盘记录。'
    const initial = analysis({
      events: [
        fallbackTestEvent(firstQuote, '2026-06-15'),
        fallbackTestEvent(secondQuote, '2026-06-16')
      ]
    })
    const refined = await refineFallbackTimelineAnalysis(initial, refinementOptions(async (request) => ({
      provider: 'test-provider',
      model: 'test-model',
      externalRunId: null,
      result: analysis({
        events: [{
          title: 'Alpha Skill 完成首轮数据兼容测试',
          workItemKey: 'alpha-skill-data-compatibility',
          workItemTitle: 'Alpha Skill 数据兼容',
          eventType: '验证',
          eventDate: '2026-06-15',
          datePrecision: 'day',
          summary: '模型生成的摘要不应替换本地事实。',
          confidence: 0.91,
          evidence: [{ quote: firstQuote, blockIndex: null }]
        }]
      })
    })))

    expect(refined.result.events).toHaveLength(2)
    expect(refined.result.events[0]).toMatchObject({
      title: 'Alpha Skill 完成首轮数据兼容测试',
      workItemTitle: 'Alpha Skill 数据兼容',
      eventDate: '2026-06-15',
      summary: firstQuote,
      confidence: 0.91
    })
    expect(refined.result.events[1]).toMatchObject({
      title: secondQuote,
      eventDate: '2026-06-16',
      confidence: 0.64
    })
  })

  it('groups refined stages of one Skill but never joins two different Skills', async () => {
    const records = [
      ['Alpha Skill 完成第一轮测试。', '2026-06-15', 'Alpha Skill 完成首轮测试', 'Alpha Skill'],
      ['Alpha Skill 修复问题后完成第二轮回归。', '2026-06-16', 'Alpha Skill 完成二轮回归', 'Alpha Skill'],
      ['Beta Skill 完成第一轮测试。', '2026-06-17', 'Beta Skill 完成首轮测试', 'Beta Skill']
    ] as const
    const initial = analysis({
      events: records.map(([quote, date]) => fallbackTestEvent(quote, date))
    })
    const refined = await refineFallbackTimelineAnalysis(initial, refinementOptions(async () => ({
      provider: 'test-provider',
      model: 'test-model',
      externalRunId: null,
      result: analysis({
        events: records.map(([quote, date, title, workItemTitle]) => ({
          title,
          workItemKey: 'provider-reused-one-key',
          workItemTitle,
          eventType: '验证',
          eventDate: date,
          datePrecision: 'day' as const,
          summary: quote,
          confidence: 0.9,
          evidence: [{ quote, blockIndex: null }]
        }))
      })
    })))

    expect(refined.result.events).toHaveLength(3)
    expect(refined.result.events[0]?.workItemKey).toBe(refined.result.events[1]?.workItemKey)
    expect(refined.result.events[2]?.workItemKey).not.toBe(refined.result.events[0]?.workItemKey)
  })

  it('never feeds old fallback identities back to AI and carries a prior chunk refinement forward', async () => {
    const quotes = Array.from({ length: 5 }, (_, index) =>
      `${index === 0 ? 'Alpha Skill 完成第一轮测试。' : `本地兜底记录 ${index + 1}。`}${'数据'.repeat(920)}`
    )
    const requests: Parameters<typeof refineFallbackTimelineAnalysis>[1]['existingWorkItems'][] = []
    let calls = 0
    const refined = await refineFallbackTimelineAnalysis(
      analysis({
        events: quotes.map((quote, index) => fallbackTestEvent(
          quote,
          `2026-06-${String(index + 15).padStart(2, '0')}`
        ))
      }),
      {
        ...refinementOptions(async (request) => {
          requests.push(request.existingWorkItems)
          calls += 1
          if (calls > 1) throw new Error('later chunk intentionally unavailable')
          return {
            provider: 'test-provider',
            model: 'test-model',
            externalRunId: null,
            result: analysis({
              events: [{
                title: 'Alpha Skill 完成首轮测试',
                workItemKey: 'alpha-skill',
                workItemTitle: 'Alpha Skill',
                eventType: '验证',
                eventDate: '2026-06-15',
                datePrecision: 'day',
                summary: quotes[0]!,
                confidence: 0.9,
                evidence: [{ quote: quotes[0]!, blockIndex: null }]
              }]
            })
          }
        }),
        existingWorkItems: [{
          key: 'known-dashboard',
          title: '已识别看板',
          latestDate: '2026-06-14',
          summary: '已完成看板整理。'
        }]
      }
    )

    expect(calls).toBeGreaterThan(1)
    expect(requests[0]).toEqual([
      expect.objectContaining({ key: 'known-dashboard' })
    ])
    expect(requests[0]?.some((item) => quotes.includes(item.key))).toBe(false)
    expect(requests[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'known-dashboard' }),
      expect.objectContaining({ key: 'alphaskill', title: 'Alpha Skill' })
    ]))
    expect(refined.result.events).toHaveLength(5)
  })

  it('keeps every local fallback when refinement fails or is cancelled', async () => {
    const initial = analysis({
      events: [fallbackTestEvent('Alpha Skill 完成第一轮测试。', '2026-06-15')]
    })
    const failed = await refineFallbackTimelineAnalysis(initial, refinementOptions(async () => {
      throw new Error('provider unavailable')
    }))
    const controller = new AbortController()
    controller.abort()
    let cancelledCalls = 0
    const cancelled = await refineFallbackTimelineAnalysis(initial, {
      ...refinementOptions(async () => {
        cancelledCalls += 1
        throw new Error('must not be called')
      }),
      signal: controller.signal
    })

    expect(failed.result.events).toEqual(initial.events)
    expect(cancelled.result.events).toEqual(initial.events)
    expect(cancelledCalls).toBe(0)
  })
})

function fallbackTestEvent(quote: string, eventDate: string): AnalysisResult['events'][number] {
  return {
    title: quote,
    workItemKey: quote,
    workItemTitle: quote,
    eventType: '工作',
    eventDate,
    datePrecision: 'day',
    summary: quote,
    confidence: 0.64,
    evidence: [{ quote, blockIndex: null }]
  }
}

function refinementOptions(
  analyzeRequest: Parameters<typeof refineFallbackTimelineAnalysis>[1]['analyze']
): Parameters<typeof refineFallbackTimelineAnalysis>[1] {
  return {
    sourceItemId: '00000000-0000-4000-8000-000000000001',
    title: '补漏整理',
    fallbackDate: '2026-08-30',
    referenceDate: '2026-08-30',
    existingWorkItems: [],
    analyze: analyzeRequest
  }
}
