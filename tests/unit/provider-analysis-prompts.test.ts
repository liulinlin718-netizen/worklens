import { describe, expect, it } from 'vitest'
import type { AnalysisRequest } from '@core/ai/contracts'
import { buildPrompt as buildCliPrompt } from '@core/ai/providers/cursor-cli'
import { buildPrompt as buildCursorPrompt } from '@core/ai/providers/cursor'
import { buildPrompt as buildOpenAiCompatiblePrompt } from '@core/ai/providers/openai-compatible'

const request: AnalysisRequest = {
  sourceItemId: '00000000-0000-4000-8000-000000000001',
  title: '跨日期工作日志',
  text: '6月15日对 Alpha Skill 做首轮测试。\n6月16日修复后完成回归。',
  businessDate: null,
  fallbackDate: '2026-08-30',
  referenceDate: '2026-08-30',
  existingWorkItems: [
    {
      key: 'alpha-skill',
      title: 'Alpha Skill 运行能力',
      latestDate: '2026-06-15',
      summary: '已完成首轮验证。'
    }
  ]
}

const prompts = [
  ['Cursor CLI', buildCliPrompt(request, 'inline')],
  ['Codex CLI', buildCliPrompt(request, 'stdin')],
  ['Cursor SDK', buildCursorPrompt(request)],
  ['OpenAI compatible', buildOpenAiCompatiblePrompt(request)]
] as const

const refinementRequest: AnalysisRequest = {
  ...request,
  mode: 'fallback_refinement',
  text: '<worklens-fallback-record index="1" date="2026-06-15">\n<evidence>\nAlpha Skill 完成首轮测试。\n</evidence>\n</worklens-fallback-record>'
}

const refinementPrompts = [
  ['Cursor CLI', buildCliPrompt(refinementRequest, 'inline')],
  ['Codex CLI', buildCliPrompt(refinementRequest, 'stdin')],
  ['Cursor SDK', buildCursorPrompt(refinementRequest)],
  ['OpenAI compatible', buildOpenAiCompatiblePrompt(refinementRequest)]
] as const

describe('analysis provider title and grouping prompts', () => {
  it.each(prompts)('%s separates stage event titles from stable grounded work-item titles', (_name, prompt) => {
    expect(prompt).toContain('event.title 写“明确对象 + 当次动作或结果”')
    expect(prompt).toContain('workItemTitle 是跨日期聚合时显示的稳定事项名')
    expect(prompt).toContain('每个有实际含义的对象或范围都必须能在这些依据中找到')
    expect(prompt).toContain('不得杜撰项目名、模块名、目标、结果或影响')
    expect(prompt).toContain('缺少明确对象时不要猜测')
  })

  it.each(prompts)('%s groups only stages that share an explicit named work anchor', (_name, prompt) => {
    expect(prompt).toContain('同一个具名 Skill、项目或模块的设计、不同轮次测试、修复、复测和回归属于同一事项')
    expect(prompt).toContain('复用同一个 workItemKey 和 workItemTitle')
    expect(prompt).toContain('不同具名 Skill、项目或模块必须分开')
    expect(prompt).toContain('不能因为都出现“Skill、页面、功能、测试、修复、优化、工作”等泛词就合并')
    expect(prompt).toContain('多个已有事项都可能匹配或证据不足时，不得猜测合并')
  })

  it.each(prompts)('%s excludes dates, transient state and sentence-like text from workItemTitle', (_name, prompt) => {
    expect(prompt).toContain('workItemTitle 不得包含日期')
    expect(prompt).toContain('“今天、昨天、本周”等时间词')
    expect(prompt).toContain('“继续、正在、完成、已上线、测试通过、修复中”等当次阶段或状态词')
    expect(prompt).toContain('不得照抄完整句子、请求语气或多项工作清单')
    expect(prompt).toContain('阶段动作只放在 event.title 和 summary 中')
  })

  it.each(refinementPrompts)('%s makes fallback refinement lossless and evidence-exact', (_name, prompt) => {
    expect(prompt).toContain('本地兜底事件补漏整理')
    expect(prompt).toContain('不得合并两个 record')
    expect(prompt).toContain('evidence.quote 必须逐字复制')
    expect(prompt).toContain('不同具名 Skill、项目或模块绝不能合并')
    expect(prompt).toContain('无法可靠命名时可以不返回该 record')
  })
})
