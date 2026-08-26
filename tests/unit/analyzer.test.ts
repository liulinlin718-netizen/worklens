import { describe, expect, it } from 'vitest'
import type { AnalysisResult } from '@shared/contracts'
import { mergeAnalysisResults, splitText } from '@core/ai/analyzer'

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sourceDate: null,
    events: [],
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

describe('analysis orchestration', () => {
  it('splits long input on paragraph boundaries', () => {
    const chunks = splitText('第一段\n\n第二段很长\n\n第三段', 10)
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true)
    expect(chunks.join('\n\n')).toContain('第一段')
  })

  it('deduplicates entities while preserving evidence', () => {
    const merged = mergeAnalysisResults([
      analysis({
        events: [
          {
            title: '登录页改版',
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
})
