import { createHash, randomUUID } from 'node:crypto'
import type { DatePrecision, RequirementPriority, RequirementStatus } from '@shared/contracts'

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function contentHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function deriveTitle(text: string, fallback = '未命名记录'): string {
  const normalized = normalizeText(text)
  const firstMeaningfulLine = normalized
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  if (!firstMeaningfulLine) return fallback
  return firstMeaningfulLine.length > 72
    ? `${firstMeaningfulLine.slice(0, 69)}…`
    : firstMeaningfulLine
}

export function excerpt(text: string, maxLength = 180): string {
  const compact = normalizeText(text).replace(/\s+/g, ' ')
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

export function normalizeEntityKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function deriveWorkItemKey(title: string): string {
  const compact = title
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/^(?:已|正在|继续|开始|完成|推进|跟进|处理|修复|优化|新增|实现|解决|等待)+/u, '')
    .replace(/(?:已完成|完成|进展|推进中|进行中|待处理|已上线|已发布|进入测试|问题修复)$/u, '')
  return normalizeEntityKey(compact) || normalizeEntityKey(title)
}

export function clampConfidence(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(1, Math.max(0, number))
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  try {
    return JSON.parse(withoutFence)
  } catch {
    const start = withoutFence.indexOf('{')
    const end = withoutFence.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('AI 返回内容中没有有效 JSON 对象')
    return JSON.parse(withoutFence.slice(start, end + 1))
  }
}

export function inferDateFromText(
  text: string,
  referenceDate = new Date()
): { value: string; precision: DatePrecision; rationale: string } | null {
  const normalized = normalizeText(text)
  const workDates = inferWorkDatesFromText(normalized, referenceDate)
  if (workDates.length === 1) {
    return { value: workDates[0]!, precision: 'day', rationale: `识别到工作日期 ${workDates[0]}` }
  }
  if (workDates.length > 1) return null
  const fullDate = normalized.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/)
  if (fullDate) {
    const [, year, month, day] = fullDate
    const value = toIsoDate(Number(year), Number(month), Number(day))
    if (value) return { value, precision: 'day', rationale: `识别到明确日期 ${fullDate[0]}` }
    return null
  }

  const shortDate = normalized.match(/(?:^|\D)(\d{1,2})月(\d{1,2})日(?:\D|$)/)
  if (shortDate) {
    const value = toIsoDate(referenceDate.getFullYear(), Number(shortDate[1]), Number(shortDate[2]))
    if (value) return { value, precision: 'day', rationale: `识别到月日 ${shortDate[0].trim()}` }
  }

  const month = normalized.match(/\b(20\d{2})[-/.年](\d{1,2})月?\b/)
  if (month) {
    const value = toIsoDate(Number(month[1]), Number(month[2]), 1)
    if (value) return { value, precision: 'month', rationale: `识别到月份 ${month[0]}` }
  }

  return null
}

export function inferWorkDatesFromText(text: string, referenceDate = new Date()): string[] {
  const normalized = normalizeText(text)
  const dates = new Set<string>()
  const add = (year: number, month: number, day: number): void => {
    const value = toIsoDate(year, month, day)
    if (value) dates.add(value)
  }
  for (const line of normalized.split('\n')) {
    const value = line.replace(/^\s*#{1,6}\s*/, '').trim()
    const full = value.match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s|[（(：:、—-]|$)/)
    if (full) {
      add(Number(full[1]), Number(full[2]), Number(full[3]))
      continue
    }
    const chinese = value.match(/^(\d{1,2})月(\d{1,2})日?(?:\s|[（(：:、—-]|$)/)
    if (chinese) {
      add(referenceDate.getFullYear(), Number(chinese[1]), Number(chinese[2]))
      continue
    }
    const compact = value.match(/^(\d{1,2})[./](\d{1,2})(?:\s|[（(：:、—-]|$)/)
    if (compact) add(referenceDate.getFullYear(), Number(compact[1]), Number(compact[2]))
  }
  return Array.from(dates).sort()
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

export function normalizeRequirementStatus(value: unknown): RequirementStatus {
  const allowed: RequirementStatus[] = ['backlog', 'planned', 'in_progress', 'blocked', 'done']
  if (allowed.includes(value as RequirementStatus)) return value as RequirementStatus
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (allowed.includes(normalized as RequirementStatus)) return normalized as RequirementStatus
  const aliases: Record<string, RequirementStatus> = {
    open: 'backlog',
    todo: 'backlog',
    new: 'backlog',
    pending: 'planned',
    doing: 'in_progress',
    wip: 'in_progress',
    progress: 'in_progress',
    complete: 'done',
    completed: 'done',
    closed: 'done'
  }
  return aliases[normalized] ?? 'backlog'
}

export function normalizeRequirementPriority(value: unknown): RequirementPriority {
  const allowed: RequirementPriority[] = ['low', 'medium', 'high', 'urgent']
  if (allowed.includes(value as RequirementPriority)) return value as RequirementPriority
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  const aliases: Record<string, RequirementPriority> = {
    p0: 'urgent',
    p1: 'high',
    p2: 'medium',
    p3: 'low',
    normal: 'medium',
    critical: 'urgent'
  }
  return aliases[normalized] ?? 'medium'
}

/** Coerce loosely-shaped model JSON into AnalysisResultSchema-compatible data. */
export function coerceAnalysisPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as Record<string, unknown>

  const summary = coerceSummary(input.summary, input) as Record<string, unknown>
  return {
    sourceDate: coerceSourceDate(input.sourceDate),
    events: Array.isArray(input.events)
      ? input.events.map((event) => coerceEvent(event)).filter(Boolean)
      : [],
    dailyBriefs: Array.isArray(input.dailyBriefs)
      ? input.dailyBriefs.map((brief) => coerceDatedStandup(brief)).filter(Boolean)
      : [],
    summary,
    standup: coerceStandup(input.standup, summary)
  }
}

function coerceStandup(value: unknown, summary: Record<string, unknown>): unknown {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  const list = (key: string): string[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .map((item) => firstString(item))
          .filter((item): item is string => Boolean(item))
          .slice(0, 30)
      : []
  const overview =
    firstString(record.overview, record.content, summary.content) ?? '今天的工作内容已整理完成。'
  const completed = list('completed')
  const inProgress = list('inProgress')
  const blockers = list('blockers')
  const nextSteps = list('nextSteps')
  const fallbackLines = [
    '大家早上好，下面同步一下我的工作进展。',
    overview,
    completed.length ? `已完成：${completed.join('；')}。` : '',
    inProgress.length ? `进行中：${inProgress.join('；')}。` : '',
    blockers.length ? `当前风险或需要协助：${blockers.join('；')}。` : '目前没有需要特别同步的阻塞。',
    nextSteps.length ? `接下来计划：${nextSteps.join('；')}。` : '',
    '以上是我的工作同步。'
  ].filter(Boolean)
  return {
    title: firstString(record.title, summary.title) ?? '明日早会汇报',
    overview,
    completed,
    inProgress,
    blockers,
    nextSteps,
    script: firstString(record.script) ?? fallbackLines.join('\n\n')
  }
}

function coerceSourceDate(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'string') {
    const iso = extractIsoDate(value)
    if (!iso) return null
    return {
      value: iso,
      precision: 'day',
      confidence: 0.7,
      rationale: '模型返回了日期字符串'
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const iso = extractIsoDate(record.value ?? record.date ?? record.day)
  return {
    value: iso,
    precision: normalizeDatePrecision(record.precision),
    confidence: clampConfidence(record.confidence ?? 0.7),
    rationale: firstString(record.rationale, record.reason) ?? '模型推断的资料日期'
  }
}

function coerceEvent(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const title = firstString(record.title, record.name)
  const summary = firstString(record.summary, record.description, record.content)
  if (!title || !summary) return null
  return {
    title,
    workItemKey: firstString(record.workItemKey, record.topicKey, record.mergeKey) ?? '',
    workItemTitle: firstString(record.workItemTitle, record.topicTitle) ?? '',
    eventType: firstString(record.eventType, record.type, record.kind) ?? 'meeting',
    eventDate: extractIsoDate(record.eventDate ?? record.date ?? record.day),
    datePrecision: normalizeDatePrecision(record.datePrecision ?? record.precision),
    summary,
    confidence: clampConfidence(record.confidence ?? 0.7),
    evidence: coerceEvidence(record.evidence)
  }
}

function coerceDatedStandup(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const workDate = extractIsoDate(record.workDate ?? record.date)
  if (!workDate) return null
  const summary = {
    title: firstString(record.title) ?? `${workDate} 工作日报`,
    content: firstString(record.overview, record.content) ?? '当日工作内容已整理完成。'
  }
  return { workDate, ...(coerceStandup(record, summary) as Record<string, unknown>) }
}

function coerceRequirement(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const title = firstString(record.title, record.name)
  const description = firstString(record.description, record.summary, record.content)
  if (!title || !description) return null
  const criteria = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria
        .map((item) => firstString(item))
        .filter((item): item is string => Boolean(item))
    : []
  return {
    title,
    description,
    status: normalizeRequirementStatus(record.status),
    priority: normalizeRequirementPriority(record.priority),
    acceptanceCriteria: criteria,
    confidence: clampConfidence(record.confidence ?? 0.7),
    evidence: coerceEvidence(record.evidence)
  }
}

function coerceSummary(value: unknown, root: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.trim()) {
    return {
      title: firstString(root.title) ?? '资料摘要',
      content: value.trim(),
      highlights: []
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      title: '资料摘要',
      content: '未能生成摘要',
      highlights: []
    }
  }
  const record = value as Record<string, unknown>
  const content = firstString(record.content, record.summary, record.text) ?? '未能生成摘要'
  const highlights = Array.isArray(record.highlights)
    ? record.highlights
        .map((item) => firstString(item))
        .filter((item): item is string => Boolean(item))
    : []
  return {
    title: firstString(record.title, root.title) ?? '资料摘要',
    content,
    highlights
  }
}

function coerceEvidence(value: unknown): Array<{ quote: string; blockIndex: number | null }> {
  if (typeof value === 'string' && value.trim()) {
    return [{ quote: value.trim().slice(0, 2_000), blockIndex: null }]
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const quote = firstString((value as Record<string, unknown>).quote)
    return quote ? [{ quote: quote.slice(0, 2_000), blockIndex: null }] : [{ quote: '见原文', blockIndex: null }]
  }
  if (!Array.isArray(value) || value.length === 0) {
    return [{ quote: '见原文', blockIndex: null }]
  }
  const items = value
    .map((item) => {
      if (typeof item === 'string' && item.trim()) {
        return { quote: item.trim().slice(0, 2_000), blockIndex: null }
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const record = item as Record<string, unknown>
      const quote = firstString(record.quote, record.text, record.excerpt)
      if (!quote) return null
      const blockIndex =
        typeof record.blockIndex === 'number' && Number.isFinite(record.blockIndex)
          ? Math.max(0, Math.floor(record.blockIndex))
          : null
      return { quote: quote.slice(0, 2_000), blockIndex }
    })
    .filter((item): item is { quote: string; blockIndex: number | null } => Boolean(item))
    .slice(0, 10)
  return items.length ? items : [{ quote: '见原文', blockIndex: null }]
}

function normalizeDatePrecision(value: unknown): DatePrecision {
  const allowed: DatePrecision[] = ['day', 'week', 'month', 'quarter', 'unknown']
  return allowed.includes(value as DatePrecision) ? (value as DatePrecision) : 'day'
}

function extractIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/)
  return match?.[1] ?? null
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function escapeCsv(value: unknown): string {
  const rawValue = Array.isArray(value) ? value.join('；') : String(value ?? '')
  const stringValue = /^[=+\-@\t\r]/.test(rawValue) ? `'${rawValue}` : rawValue
  if (/[",\r\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`
  return stringValue
}

export function safeFileName(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return cleaned.slice(0, 100) || 'worklens-export'
}
