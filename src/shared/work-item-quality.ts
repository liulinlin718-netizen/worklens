import type { WorkItem } from './contracts'

// Only known equivalent labels are folded together; custom categories stay intact.
const CATEGORY_ALIASES: Record<string, string> = {
  development: '开发', coding: '开发', implementation: '开发', engineering: '开发',
  research: '研究', investigation: '研究', 研发调研: '研究',
  meeting: '会议', discussion: '沟通', communication: '沟通',
  design: '设计', review: '评审', testing: '测试', test: '测试', qa: '测试',
  bugfix: '问题修复', bug: '问题', fix: '问题修复', debugging: '问题排查', bugfollowup: '问题跟进',
  planning: '规划', plan: '规划', delivery: '交付', release: '发布',
  deployment: '部署', documentation: '文档', docs: '文档',
  decision: '决策', requirement: '需求', issue: '问题', blocker: '问题', problem: '问题',
  milestone: '里程碑', completed: '完成', completion: '完成',
  work: '工作', analysis: '分析', learning: '学习', publishing: '发布', verification: '验证',
  conclusion: '结论', sharing: '分享', creation: '创作',
  progress: '进展', update: '进展', task: '任务', other: '其他', misc: '其他'
}

export function normalizeWorkItemCategory(category: string): string {
  const value = category.trim()
  return (CATEGORY_ALIASES[value.toLowerCase().replace(/[\s_-]+/g, '')] ?? value) || '其他'
}

export function isWorkItemFragmentTitle(title: string): boolean {
  const value = title.trim().replace(/[。.!！]+$/, '')
  return !value || /^[\d\s.,，:%％+\-/]+$/.test(value) ||
    /^(?:(?:今天|昨天|上午|下午|晚上|凌晨|中午)\s*)?\d{1,2}[:：]\d{2}(?::\d{2})?$/.test(value) ||
    /^(?:上午|下午|晚上|凌晨|中午)?\s*\d{1,2}点(?:\d{1,2}分)?$/.test(value)
}

export function getWorkItemReviewReasons(item: Pick<WorkItem, 'title' | 'confidence' | 'evidence' | 'latestDate'>): string[] {
  const reasons: string[] = []
  if (isWorkItemFragmentTitle(item.title)) reasons.push('标题仅包含数字、百分比或时间，可能是提取碎片')
  if (item.confidence < 0.7) reasons.push('AI 对归类的把握较低，请核对原文')
  if (!item.evidence.length) reasons.push('缺少可直接核对的原文引用')
  if (!item.latestDate) reasons.push('工作日期尚未确认，请核对并补充资料日期')
  return reasons
}
