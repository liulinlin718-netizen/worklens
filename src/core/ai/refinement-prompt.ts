import type { AnalysisRequest } from '@core/ai/contracts'

/** Extra rules for the lossless second pass over locally materialized events. */
export function fallbackRefinementInstructions(request: AnalysisRequest): string {
  if (request.mode !== 'fallback_refinement') return ''
  return `
本次是“本地兜底事件补漏整理”，不是重新提取整份资料。正文中的每个 <worklens-fallback-record> 都对应一个已经保留的事件：
- 对每个 record 最多返回一个 event；不得合并两个 record，也不得把一个 record 拆成多个 event。无法可靠命名时可以不返回该 record，WorkLens 会保留本地原结果。
- eventDate 必须完全等于 record 的 date；evidence.quote 必须逐字复制该 record 内 <evidence> 的完整内容，不能缩写、改写或引用标签。
- 只改进 event.title、workItemTitle 与 workItemKey。event.title 要保留当次动作或阶段；workItemTitle 是跨日期稳定名词短语。
- 优先复用“已有工作事项”中明确属于同一具名对象和核心主题的 key/title。同一个 Skill、项目或模块的多轮测试、修复、复测、回归应复用同一事项；不同具名 Skill、项目或模块绝不能合并。
- 标题中的每个具体对象、范围、动作和结果都必须能在该 record 的 evidence 中直接找到；不得补充 evidence 未表达的对象、目的、影响或结论。
- 不要根据这些 record 重写 dailyBriefs、summary 或 standup；这些字段只需返回满足 JSON 结构的中性占位内容。
`
}
