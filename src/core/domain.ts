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

const WORK_ITEM_STAGE_PATTERN = /(?:第?[一二三四五六七八九十百0-9]+轮|首轮|多轮|下一轮|初测|复测|回归(?:测试|验证)?)/gu
const WORK_ITEM_PHASE_SUFFIX_PATTERN = /(?:测试|验证|评测|验收|调试|排查|修复|上线|发布|推进|跟进|进展|阶段)$/u

/**
 * Produces a conservative work-item label from source-backed wording. This is
 * intentionally a rewrite, not an inference: it removes conversational status
 * language and reorders a small set of explicit action verbs, but never adds a
 * project, result, owner, or business impact that was not already present.
 */
export function deriveStableWorkItemTitle(text: string, fallback = '工作事项'): string {
  let value = normalizeText(text)
    .split(/\r?\n/u)
    .map((line) => line
      // A pasted link is provenance, not the work identity. Preserve any
      // explicit topic that follows it on the same line; if the line contains
      // only a URL, the next meaningful line becomes the candidate.
      .replace(/^\s*(?:https?:\/\/|www\.)\S+?(?=\s|$)\s*(?:[-—:：,，]\s*)?/iu, '')
      .replace(/^\s*(?:#{1,6}\s*|[-*•▪◦]\s+|\d{1,3}\s*[.):：、]\s*)/u, '')
      // Some pasted daily logs use a bare day/order number before a progress
      // phrase. Only remove the number when the following wording proves that
      // it is structural, so names such as “16 Pro” remain untouched.
      .replace(/^\s*\d{1,3}\s+(?=(?:继续|正在|已经|完成|关注|跟进|处理|修复|优化|测试|验证|帮忙|看一下))/u, '')
      .trim())
    .find(Boolean) ?? ''
  if (!value) return fallback

  value = value
    .replace(/^\s*(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[./月]\d{1,2}日?)\s*[：:、—-]*\s*/u, '')
    .replace(/^[“”"'`]+|[“”"'`]+$/gu, '')
    .replace(/^(?:我(?:们)?(?:今天|昨日|昨天)?(?:主要)?|今天|今日|昨日|昨天|本周|上周|近期|最近)(?:的)?\s*/u, '')
  // A round marker is normally lifecycle noise, but in a source-backed metric
  // such as “首轮时间增加” it identifies which measurement the title refers
  // to. Preserve only that narrow construction; named work testing stages are
  // still removed below as before.
  const preserveRoundMetric = /^(?:第?[一二三四五六七八九十百0-9]+轮|首轮)\s*(?:时间|时长|耗时|用时|延迟)/u.test(value)
  if (!preserveRoundMetric) value = value.replace(WORK_ITEM_STAGE_PATTERN, '')

  // Remove request/conversation framing and progress-only prefixes. Run this
  // to a fixed point because real notes commonly stack them, for example
  // “能不能帮忙看一下上周的 …” or “继续关注 …”. Every replacement only
  // deletes text that was present; it never supplies a missing object/result.
  let previous = ''
  while (value && value !== previous) {
    previous = value
    value = value
      .replace(/^(?:请(?:你)?|麻烦(?:你)?|能不能|能否|是否可以|可不可以|可以|我想(?:请你)?|我想要|我希望|希望|需要|想问(?:一下)?|为什么|怎么|如何)\s*/u, '')
      .replace(/^(?:帮(?:我|忙)?|替我)\s*/u, '')
      .replace(/^(?:看(?:一下|下|一看|看)?(?!板)|确认一下|关注一下)\s*/u, '')
      .replace(/^(?:今天|今日|昨日|昨天|本周|上周|近期|最近)(?:的)?\s*/u, '')
      .replace(/^(?:高优(?:先级)?|中优(?:先级)?|低优(?:先级)?|P[0-3])\s*/iu, '')
      .replace(/^(?:已经|已|正在|继续|开始|完成(?:了)?|推进|跟进|处理|解决|等待|开展|进行|持续(?:关注|跟进)?|关注|关于|另外|还有|然后|接着|这里|还要|再来|再次|先|再)\s*/u, '')
  }

  const action = value.match(/^(测(?:试)?|验证|修复|优化|发布|上线|开发|设计|搭建|构建|梳理|分析|排查|评审|调研|学习|接入|联调|制作|做|定义|填(?:写)?|跑通)\s*(.+)$/u)
  if (action) {
    const actionLabels: Record<string, string> = {
      测: '测试',
      测试: '测试',
      验证: '验证',
      修复: '修复',
      优化: '优化',
      发布: '发布',
      上线: '上线',
      开发: '开发',
      设计: '设计',
      搭建: '搭建',
      构建: '构建',
      梳理: '梳理',
      分析: '分析',
      排查: '排查',
      评审: '评审',
      调研: '调研',
      学习: '学习',
      接入: '接入',
      联调: '联调',
      制作: '制作',
      做: '',
      定义: '定义',
      填: '填',
      填写: '填写',
      跑通: '跑通'
    }
    const object = action[2]!
      .replace(/^(?:一下|一遍|一下子)\s*/u, '')
      .replace(/(?:一下|一遍|看看|吧|了|呢)\s*$/u, '')
      .trim()
    if (object.length >= 2) value = `${object}${actionLabels[action[1]!] ?? action[1]!}`
  }

  value = value
    .replace(/有(?:较|比较|相对)?(?:明显|显著|一定程度)?(?=(?:增加|增长|上升|下降|减少|提升|降低))/gu, '')
    .replace(/[?？]\s*$/u, '')
    .replace(/\s*(?:是否|能否|可不可以|有没有)(?:符合预期|可以|可行|正常|没问题|通过|完成)?(?:吗|呢)?\s*$/u, '')
    .replace(/\s*(?:继续|再)?(?:帮忙|帮我)?(?:看一下|看下|看一看|看看|关注一下|关注|跟进一下|跟进)\s*$/u, '')
    // Interrogative glue is not part of a durable identity. Removing it keeps
    // the explicit object/theme on both sides without turning a question into
    // an asserted outcome.
    .replace(/(?:能不能|能否|是否|可不可以|怎么)(?=\S)/gu, '')
    .replace(/[。！？!?；;]+.*$/u, '')
    .replace(/(?:已经|已)?(?:完成|进行中|推进中|待处理|已上线|已发布)\s*$/u, '')
    .replace(/(?:各种|各类|一些)(?=(?:数据|case|案例|情况|问题))/giu, '')
    .replace(/(统一性|一致性|兼容性|稳定性)(?:很好|较好|良好|不错|好|正常|符合预期)\s*$/u, '$1')
    .replace(/\s*[：:]\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!value) return fallback

  // A trailing “进行继续升级 / 继续复测” is lifecycle state when the
  // preceding text already contains a distinctive technical identity. Strip
  // the whole tail instead of turning it into the permanent item name.
  const withoutConversationalPhase = value
    .replace(/\s*(?:进行)?(?:继续|持续|再次|再)+(?:升级|优化|测试|验证|复测|回归(?:测试|验证)?|修复|跟进|关注)?\s*$/u, '')
    .trim()
  const conversationalIdentityKey = normalizeEntityKey(withoutConversationalPhase)
  const conversationalHanIdentity = withoutConversationalPhase.replace(/[^\p{Script=Han}]/gu, '')
  const conversationalNamedObject = /(?:[\p{L}\p{N}._-]+\s+){0,5}(?:skill|agent|mcp|api|sdk|ui)\b/iu.test(withoutConversationalPhase)
  if (
    withoutConversationalPhase
    && (conversationalNamedObject || conversationalHanIdentity.length >= 4 || (!conversationalHanIdentity && conversationalIdentityKey.length >= 6))
  ) value = withoutConversationalPhase
  value = value
    .replace(/(?:看一下|看下|看一看|看看)/gu, '')
    .replace(/继续(?!教育)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()

  // Testing, fixing, and release wording describes a timeline stage, not the
  // durable work item. Remove it only when a sufficiently specific object is
  // left; this avoids collapsing broad labels such as “页面测试” into “页面”.
  const withoutTransientPhase = value.replace(WORK_ITEM_PHASE_SUFFIX_PATTERN, '').trim()
  const identityKey = normalizeEntityKey(withoutTransientPhase)
  const hanIdentity = withoutTransientPhase.replace(/[^\p{Script=Han}]/gu, '')
  const hasNamedTechnicalObject = /(?:[\p{L}\p{N}._-]+\s+){0,5}(?:skill|agent|mcp|api|sdk|ui)\b/iu.test(withoutTransientPhase)
  if (
    withoutTransientPhase
    && (hasNamedTechnicalObject || hanIdentity.length >= 4 || (!hanIdentity && identityKey.length >= 6))
  ) value = withoutTransientPhase

  const rawClauses = value
    .split(/[,，；;]/u)
    .map((part) => part
      .replace(/^(?:另外|还有|然后|接着|同时|并且|再)\s*/u, '')
      .replace(/(?:各种|各类|一些)(?=(?:数据|case|案例|情况|问题))/giu, '')
      .replace(/(统一性|一致性|兼容性|稳定性)(?:很好|较好|良好|不错|好|正常|符合预期)\s*$/u, '$1')
      .trim())
    .filter((part) => part.length >= 4)
  const bareMetricValuePattern = /^(?:平均|均值|中位数|大约|约|约为)?\s*(?:来到了?|达到|达到了?|为|是)?\s*[+-]?\d+(?:\.\d+)?\s*(?:ms|msec|s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hour|hours|%|秒|分钟|小时|天|次|个|条|份)(?:左右|上下)?$/iu
  const removedBareMetricValue = rawClauses.some((part) => bareMetricValuePattern.test(part))
  const clauses = rawClauses.filter((part) => !bareMetricValuePattern.test(part))
  const namedClauses = clauses.filter((part) =>
    /(?:skill|agent|mcp|api|sdk|ui)\b/iu.test(part)
    || /(?:项目|模块|系统|页面|接口|能力|功能)/u.test(part)
    || /[A-Za-z][A-Za-z0-9._-]{2,}/u.test(part)
  )
  const clausePool = namedClauses.length
    ? namedClauses
    : value.length > 36 || removedBareMetricValue
      ? clauses
      : []
  const concise = clausePool
    .sort((left, right) => left.length - right.length)[0] ?? value
  return concise.length > 36 ? `${concise.slice(0, 35)}…` : concise
}

export function deriveWorkItemKey(title: string): string {
  const stableTitle = deriveStableWorkItemTitle(title, title)
  const compact = stableTitle
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(WORK_ITEM_STAGE_PATTERN, '')
    .replace(/^(?:已|正在|继续|开始|完成|推进|跟进|处理|新增|实现|解决|等待|持续关注)+/u, '')
    .replace(/(?:已完成|完成|进行中|待处理|进入测试)$/u, '')
    .trim()
  const withoutPhase = compact.replace(WORK_ITEM_PHASE_SUFFIX_PATTERN, '').trim()
  const phaseFreeKey = normalizeEntityKey(withoutPhase)
  const hasEnoughIdentity = /[\p{Script=Han}]/u.test(withoutPhase)
    ? phaseFreeKey.length >= 3
    : phaseFreeKey.length >= 5
  return hasEnoughIdentity
    ? phaseFreeKey
    : normalizeEntityKey(compact) || normalizeEntityKey(title)
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
