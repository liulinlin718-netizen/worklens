import type {
  AnalysisResult,
  AskWorkQuestionInput,
  CodexCliStatus,
  CursorCliStatus,
  DailyBrief,
  ModelInfo,
  ProviderSettings,
  SaveProviderSettings,
  SourceItem,
  WorkQuestionAnswer
} from '@shared/contracts'
import {
  deriveTitle,
  deriveStableWorkItemTitle,
  deriveWorkItemKey,
  excerpt,
  normalizeEntityKey,
  normalizeText
} from '@core/domain'
import type {
  AnalysisRequest,
  AnalysisResponse,
  ProviderConfiguration
} from '@core/ai/contracts'
import { ProviderError } from '@core/ai/contracts'
import type { AiRuntime } from '@core/ai/host-protocol'
import { SecureSecretStore } from '@core/storage/secure-store'
import { WorkLensDatabase } from '@core/storage/database'

// Keep long work logs in several date-aligned requests. Asking one model call
// to emit hundreds of structured events is both slower and more failure-prone.
const MAX_CHUNK_CHARACTERS = 9_000
const MAX_REFINEMENT_CHUNK_CHARACTERS = 8_000
const LOCAL_FALLBACK_MAX_CONFIDENCE = 0.64

export class AnalysisService {
  constructor(
    private readonly database: WorkLensDatabase,
    private readonly secrets: SecureSecretStore,
    private readonly runtime: AiRuntime
  ) {}

  async analyzeWorkDate(
    workDate: string,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<DailyBrief> {
    const sources = this.database.listSourcesForDate(workDate)
    if (!sources.length) throw new Error('这一天还没有可整理的工作内容')
    const brief = await this.analyzeSources(sources, workDate, onProgress, signal)
    if (!brief) throw new Error('资料中没有识别到这个工作日的内容，请先核对日期')
    return brief
  }

  async analyzeSource(
    sourceItemId: string,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<DailyBrief | null> {
    const source = this.database.getSource(sourceItemId)
    const initialBrief = await this.analyzeSources([source], source.businessDate, onProgress, signal)
    const refreshed = this.database.getSource(sourceItemId)
    const related = new Map<string, SourceItem>([[refreshed.id, refreshed]])
    for (const workDate of refreshed.workDates) {
      for (const candidate of this.database.listSourcesForDate(workDate)) related.set(candidate.id, candidate)
    }
    if (related.size <= 1) return initialBrief
    onProgress?.(`发现 ${related.size} 份同日资料，正在重新比对并合并同类工作`)
    return this.analyzeSources(Array.from(related.values()), null, onProgress, signal)
  }

  private async analyzeSources(
    sources: SourceItem[],
    requestedWorkDate: string | null,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<DailyBrief | null> {
    const sourceItemIds = sources.map((source) => source.id)
    const primarySourceId = sourceItemIds[0]!
    const text = sources
      .map((source, index) => `【资料 ${index + 1}：${source.title}】\n${this.database.getSourceText(source.id)}`)
      .join('\n\n')
    if (!text.trim()) throw new Error('这一天的资料没有可分析的文字')

    const settings = await this.getProviderSettings()
    this.assertProviderConnected(settings)
    const configuration = await this.getProviderConfiguration(settings)
    // Do not feed a source's own generated catalog back into its re-analysis:
    // an old weak key/title would otherwise reinforce itself forever. Items
    // that also have evidence from another source remain valid candidates.
    const existingWorkItems = this.database.listWorkItems()
      .filter((item) => item.sourceItemIds.some((sourceId) => !sourceItemIds.includes(sourceId)))
      .slice(0, 200)
      .map((item) => ({
        key: item.key,
        title: deriveStableWorkItemTitle(item.title, item.title),
        latestDate: item.latestDate,
        summary: item.summary
      }))
    const evolvingWorkItems = new Map(existingWorkItems.map((item) => [item.key, item]))
    const chunks = splitText(text, MAX_CHUNK_CHARACTERS)
    const referenceDate = localIsoDate()
    const sourceFallbackDate = preferredSourceFallbackDate(sources, referenceDate)
    const jobId = this.database.createJob(primarySourceId, 'daily_synthesis', '准备合并当日工作')
    const aiRunId = this.database.createAiRun(primarySourceId, settings.kind, settings.model)
    for (const sourceItemId of sourceItemIds) {
      this.database.setSourceStatus(sourceItemId, 'processing')
    }

    try {
      const results: AnalysisResult[] = []
      let responseProvider: string = settings.kind
      let responseModel = settings.model
      for (let index = 0; index < chunks.length; index += 1) {
        const message = `正在合并第 ${index + 1}/${chunks.length} 段工作内容`
        onProgress?.(message)
        this.database.updateJob(jobId, 'running', index / chunks.length, message)
        const response = await this.runtime.analyze(
          configuration,
          {
            sourceItemId: primarySourceId,
            title: requestedWorkDate
              ? `${requestedWorkDate} 工作日报（${sources.length} 份资料）`
              : `跨日期工作资料（${sources.length} 份）`,
            text: chunks[index] ?? '',
            businessDate: requestedWorkDate,
            fallbackDate: sourceFallbackDate,
            referenceDate,
            existingWorkItems: Array.from(evolvingWorkItems.values()).slice(-240)
          },
          signal
        )
        assertGroundedAnalysis(response.result, chunks[index] ?? '')
        results.push(response.result)
        // Later chunks must be able to reuse topics first discovered in earlier
        // chunks. Keys shown to the model are generated by WorkLens from a
        // conservative title rather than trusting a free-form model key.
        for (const event of response.result.events) {
          const title = groundedWorkItemTitleForEvent(event)
          const key = deriveWorkItemKey(title)
          evolvingWorkItems.set(key, {
            key,
            title,
            latestDate: event.eventDate,
            summary: event.summary
          })
        }
        responseProvider = response.provider
        responseModel = response.model
      }

      let merged = materializeTimelineAnalysis(
        mergeAnalysisResults(results),
        sources,
        requestedWorkDate,
        referenceDate
      )
      const refinement = await refineFallbackTimelineAnalysis(merged, {
        sourceItemId: primarySourceId,
        title: requestedWorkDate
          ? `${requestedWorkDate} 工作日报补漏整理`
          : '跨日期工作资料补漏整理',
        fallbackDate: sourceFallbackDate,
        referenceDate,
        existingWorkItems,
        analyze: (request, refinementSignal) => this.runtime.analyze(
          configuration,
          request,
          refinementSignal
        ),
        onProgress,
        signal
      })
      merged = refinement.result
      responseProvider = refinement.provider ?? responseProvider
      responseModel = refinement.model ?? responseModel
      const saveDate = requestedWorkDate
        ?? merged.dailyBriefs[0]?.workDate
        ?? merged.events.find((event) => event.eventDate)?.eventDate
        ?? sourceFallbackDate
      const brief = this.database.saveDailySynthesis(
        sourceItemIds,
        merged,
        responseProvider,
        responseModel,
        saveDate
      )
      this.database.updateJob(jobId, 'finished', 1, brief ? '时间线、工作事项和早会逐字稿已生成' : '时间线和工作事项已整理')
      this.database.finishAiRun(aiRunId, 'finished')
      onProgress?.(brief ? '已按正文工作时间完成归档并生成早会逐字稿' : '已按正文工作时间整理时间线和工作事项')
      return brief
    } catch (error) {
      const message = toErrorMessage(error)
      this.database.updateJob(jobId, 'failed', 1, '日报合并失败', message)
      this.database.finishAiRun(aiRunId, 'error', message)
      for (const sourceItemId of sourceItemIds) {
        this.database.setSourceStatus(sourceItemId, 'failed', message)
      }
      throw error
    }
  }

  async askWorkQuestion(
    input: AskWorkQuestionInput,
    signal?: AbortSignal
  ): Promise<WorkQuestionAnswer> {
    const referenceDate = localIsoDate()
    const context = this.database.findKnowledgeContext(input.question, referenceDate)
    if (!context.length) {
      throw new Error('没有找到符合这个问题的本地工作资料，请换个关键词或日期范围')
    }
    const settings = await this.getProviderSettings()
    this.assertProviderConnected(settings)
    if (settings.kind !== 'cursor_cli' && settings.kind !== 'codex_cli') {
      throw new ProviderError('当前连接的 AI 接口暂不支持工作资料问答', false, 'unsupported_provider')
    }
    const localProvider = settings.kind === 'codex_cli' ? 'codex_cli' : 'cursor_cli'
    const configuration: ProviderConfiguration = {
      kind: localProvider,
      apiKey: '',
      model:
        settings.kind === 'cursor_cli' || settings.kind === 'codex_cli'
          ? settings.model || 'auto'
          : 'auto',
      baseUrl: ''
    }
    const response = await this.runtime.answerKnowledgeQuestion(
      configuration,
      {
        question: input.question,
        history: input.history,
        context,
        referenceDate
      },
      signal
    )
    const contextByRef = new Map(context.map((item) => [item.refId, item]))
    const seen = new Set<string>()
    const citations = response.result.citations.flatMap((citation) => {
      const item = contextByRef.get(citation.refId)
      const key = `${citation.refId}:${citation.quote}`
      if (!item || seen.has(key) || !item.content.includes(citation.quote)) return []
      seen.add(key)
      return [{
        refId: item.refId,
        entityType: item.entityType,
        entityId: item.entityId,
        title: item.title,
        date: item.date,
        quote: citation.quote
      }]
    })
    return {
      answer: response.result.answer,
      citations,
      suggestedQuestions: response.result.suggestedQuestions,
      provider: localProvider,
      model: response.model,
      retrievedCount: context.length
    }
  }

  async getProviderSettings(): Promise<ProviderSettings> {
    const settings = this.database.getProviderSettings()
    return {
      ...settings,
      hasApiKey:
        settings.kind === 'cursor_cli' || settings.kind === 'codex_cli'
          ? false
          : await this.secrets.has(secretKey(settings.kind))
    }
  }

  async saveProviderSettings(input: SaveProviderSettings): Promise<ProviderSettings> {
    if (input.kind === 'openai_compatible' && !input.baseUrl) {
      throw new Error('外部 Provider 需要 Base URL')
    }
    const current = this.database.getProviderSettings()
    if (input.kind === 'openai_compatible' && input.apiKey !== undefined) {
      await this.secrets.set(secretKey(input.kind), input.apiKey)
    }
    const connectionConfigurationUnchanged =
      current.kind === input.kind &&
      current.model === input.model &&
      current.baseUrl === input.baseUrl &&
      input.apiKey === undefined
    this.database.saveProviderSettings({
      kind: input.kind,
      model: input.model,
      baseUrl: input.baseUrl,
      sendImages: input.sendImages,
      autoAnalyze: input.autoAnalyze,
      connected: connectionConfigurationUnchanged ? current.connected : false,
      connectedAt: connectionConfigurationUnchanged ? current.connectedAt : null,
      connectionMessage: connectionConfigurationUnchanged
        ? current.connectionMessage
        : '设置已更新，请连接 AI'
    })
    return this.getProviderSettings()
  }

  async listCursorCliModels(): Promise<ModelInfo[]> {
    return this.runtime.listModels({
      kind: 'cursor_cli',
      apiKey: '',
      model: 'auto',
      baseUrl: ''
    })
  }

  async listCodexCliModels(): Promise<ModelInfo[]> {
    return this.runtime.listModels({
      kind: 'codex_cli',
      apiKey: '',
      model: 'auto',
      baseUrl: ''
    })
  }

  getCursorCliStatus(): Promise<CursorCliStatus> {
    return this.runtime.getCursorCliStatus()
  }

  async loginCursorCli(): Promise<CursorCliStatus> {
    const status = await this.runtime.loginCursorCli()
    if (status.authenticated && this.database.getProviderSettings().kind === 'cursor_cli') {
      this.saveConnectionState(true, status.message || 'Cursor 已连接')
    }
    return status
  }

  getCodexCliStatus(): Promise<CodexCliStatus> {
    return this.runtime.getCodexCliStatus()
  }

  async loginCodexCli(): Promise<CodexCliStatus> {
    const status = await this.runtime.loginCodexCli()
    if (status.authenticated && this.database.getProviderSettings().kind === 'codex_cli') {
      this.saveConnectionState(true, status.message || 'Codex 已连接')
    }
    return status
  }

  async testProvider(): Promise<void> {
    const settings = await this.getProviderSettings()
    try {
      const configuration = await this.getProviderConfiguration(settings)
      await this.runtime.test(configuration)
      if (settings.kind === 'cursor_cli' || settings.kind === 'codex_cli') {
        const referenceDate = localIsoDate()
        const probeText = `${referenceDate}\n完成 WorkLens AI 连接校验，并确认可以读取本次验证正文。`
        const response = await this.runtime.analyze(configuration, {
          sourceItemId: '00000000-0000-4000-8000-000000000000',
          title: 'WorkLens AI 连接校验',
          text: probeText,
          businessDate: referenceDate,
          fallbackDate: referenceDate,
          referenceDate,
          existingWorkItems: []
        })
        assertGroundedAnalysis(response.result, probeText)
      }
      this.saveConnectionState(true, '连接正常')
    } catch (error) {
      this.saveConnectionState(false, toErrorMessage(error))
      throw error
    }
  }

  private assertProviderConnected(settings: ProviderSettings): void {
    if (!settings.connected) {
      throw new ProviderError('未连接 AI，请先在 AI 设置中连接当前接口', false, 'provider_not_connected')
    }
  }

  private saveConnectionState(connected: boolean, message: string): void {
    const settings = this.database.getProviderSettings()
    this.database.saveProviderSettings({
      kind: settings.kind,
      model: settings.model,
      baseUrl: settings.baseUrl,
      sendImages: settings.sendImages,
      autoAnalyze: settings.autoAnalyze,
      connected,
      connectedAt: connected ? new Date().toISOString() : null,
      connectionMessage: message
    })
  }

  private async getProviderConfiguration(
    settings: ProviderSettings
  ): Promise<ProviderConfiguration> {
    if (settings.kind === 'cursor_cli' || settings.kind === 'codex_cli') {
      return {
        kind: settings.kind,
        apiKey: '',
        model: settings.model || 'auto',
        baseUrl: ''
      }
    }
    const apiKey = await this.secrets.get(secretKey(settings.kind))
    if (!apiKey) throw new ProviderError('未连接 AI，请先保存 API Key 并连接当前接口', false, 'provider_not_connected')
    if (!settings.model) throw new Error('请先选择或填写模型')
    return {
      kind: settings.kind,
      apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl
    }
  }
}

export function splitText(text: string, maxCharacters: number): string[] {
  if (text.length <= maxCharacters) return [text]
  const datedUnits = splitAtWorkDateHeadings(text)
  if (datedUnits.length > 1) return packTextUnits(datedUnits, maxCharacters)
  const paragraphs = text.split(/\n{2,}/)
  return packTextUnits(paragraphs, maxCharacters, '\n\n')
}

function splitAtWorkDateHeadings(text: string): string[] {
  const units: string[] = []
  const referenceDate = new Date()
  let current: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (current.length && workDateAtLineStart(line, referenceDate)) {
      units.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) units.push(current.join('\n'))
  return units.filter((unit) => unit.trim())
}

function packTextUnits(
  units: string[],
  maxCharacters: number,
  separator = '\n'
): string[] {
  const chunks: string[] = []
  let current = ''

  for (const unit of units) {
    if (unit.length > maxCharacters) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let index = 0; index < unit.length; index += maxCharacters) {
        chunks.push(unit.slice(index, index + maxCharacters))
      }
      continue
    }
    const candidate = current ? `${current}${separator}${unit}` : unit
    if (candidate.length > maxCharacters) {
      chunks.push(current)
      current = unit
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

const PROVIDER_CONTEXT_FAILURE = /(?:无法|不能|未能|没有办法).{0,40}(?:读取|访问|获得|获取).{0,30}(?:source\.txt|knowledge\.txt|资料正文|原始资料|文件正文)|(?:请|需要).{0,30}(?:提供|开放|允许).{0,30}(?:source\.txt|knowledge\.txt|资料正文|文件读取|只读文件)/iu

export function assertGroundedAnalysis(result: AnalysisResult, sourceText: string): void {
  const source = normalizeText(sourceText)
  if (!source) {
    throw new ProviderError('资料正文为空，无法校验 AI 整理结果', false, 'analysis_source_empty')
  }

  const responseText = normalizeText([
    result.summary.title,
    result.summary.content,
    ...result.summary.highlights,
    ...result.events.flatMap((event) => [
      event.title,
      event.summary,
      ...event.evidence.map((evidence) => evidence.quote)
    ]),
    ...result.dailyBriefs.flatMap((brief) => [
      brief.title,
      brief.overview,
      ...brief.completed,
      ...brief.inProgress,
      ...brief.blockers,
      ...brief.nextSteps,
      brief.script
    ]),
    result.standup.title,
    result.standup.overview,
    ...result.standup.completed,
    ...result.standup.inProgress,
    ...result.standup.blockers,
    ...result.standup.nextSteps,
    result.standup.script
  ].join('\n'))

  if (PROVIDER_CONTEXT_FAILURE.test(responseText) && !PROVIDER_CONTEXT_FAILURE.test(source)) {
    throw new ProviderError(
      'AI 未能读取本次资料正文，请重新连接当前 AI 后重试',
      true,
      'analysis_context_unavailable'
    )
  }
  // An otherwise valid provider response may occasionally omit events for one
  // long chunk. Do not discard the whole re-analysis: the local trusted-text
  // pass below can losslessly materialize dated fallback events, after which
  // the refinement pass gets another chance to improve their semantic titles.
  if (!result.events.length) return

  const grounded = result.events.filter((event) =>
    event.evidence.some((evidence) => {
      const quote = normalizeText(evidence.quote)
      return quote.length >= 2 && source.includes(quote)
    })
  )
  if (!grounded.length) {
    throw new ProviderError(
      `AI 返回了无法在原文中核验的内容：${result.events[0]!.title}`,
      true,
      'analysis_evidence_not_grounded'
    )
  }

  // A large response can contain one paraphrased or otherwise unverifiable
  // evidence quote among many valid events. Rejecting the entire response
  // loses every correctly extracted date and work item. Keep only events with
  // exact source evidence; materializeTimelineAnalysis will conservatively add
  // back any omitted source entries from the local text.
  if (grounded.length !== result.events.length) result.events = grounded
}

export function mergeAnalysisResults(results: AnalysisResult[]): AnalysisResult {
  if (!results.length) throw new ProviderError('AI 没有返回分析结果', false, 'empty_result')
  const sourceDate = results
    .map((result) => result.sourceDate)
    .filter((date): date is NonNullable<AnalysisResult['sourceDate']> => Boolean(date))
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null

  const eventMap = new Map<string, AnalysisResult['events'][number]>()
  for (const event of results.flatMap((result) => result.events)) {
    const workItemKey = normalizeEntityKey(event.workItemKey) || normalizeEntityKey(event.workItemTitle) || normalizeEntityKey(event.title)
    // A work item can have several independent updates on the same day. Only
    // collapse events that describe the same update; workItemKey alone is the
    // cross-date grouping key, not an event-level uniqueness key.
    const eventKey = normalizeEntityKey(event.title)
      || normalizeEntityKey(event.evidence[0]?.quote ?? '')
      || normalizeEntityKey(event.summary)
    const key = `${workItemKey}:${event.eventDate ?? ''}:${eventKey}`
    const existing = eventMap.get(key)
    if (!existing) {
      eventMap.set(key, event)
      continue
    }
    existing.evidence = uniqueEvidence([...existing.evidence, ...event.evidence])
    if (event.summary.length > existing.summary.length) existing.summary = event.summary
    existing.confidence = Math.max(existing.confidence, event.confidence)
    if (!existing.workItemKey && event.workItemKey) existing.workItemKey = event.workItemKey
    if (!existing.workItemTitle && event.workItemTitle) existing.workItemTitle = event.workItemTitle
  }

  const summaries = results.map((result) => result.summary)
  const standups = results.map((result) => result.standup)
  const dailyBriefMap = new Map<string, AnalysisResult['dailyBriefs'][number]>()
  for (const brief of results.flatMap((result) => result.dailyBriefs)) {
    const existing = dailyBriefMap.get(brief.workDate)
    if (!existing) {
      dailyBriefMap.set(brief.workDate, { ...brief })
      continue
    }
    existing.completed = uniqueStrings([...existing.completed, ...brief.completed])
    existing.inProgress = uniqueStrings([...existing.inProgress, ...brief.inProgress])
    existing.blockers = uniqueStrings([...existing.blockers, ...brief.blockers])
    existing.nextSteps = uniqueStrings([...existing.nextSteps, ...brief.nextSteps])
    if (brief.overview.length > existing.overview.length) existing.overview = brief.overview
    if (brief.script.length > existing.script.length) existing.script = brief.script
  }
  const completed = uniqueStrings(standups.flatMap((item) => item.completed))
  const inProgress = uniqueStrings(standups.flatMap((item) => item.inProgress))
  const blockers = uniqueStrings(standups.flatMap((item) => item.blockers))
  const nextSteps = uniqueStrings(standups.flatMap((item) => item.nextSteps))
  const overview = uniqueStrings(standups.map((item) => item.overview)).join('\n')
  return {
    sourceDate,
    events: Array.from(eventMap.values()),
    dailyBriefs: Array.from(dailyBriefMap.values()).sort((a, b) => a.workDate.localeCompare(b.workDate)),
    summary: {
      title: summaries[0]?.title ?? '工作摘要',
      content: summaries.map((summary) => summary.content).filter(Boolean).join('\n\n'),
      highlights: Array.from(new Set(summaries.flatMap((summary) => summary.highlights))).slice(0, 20)
    },
    standup: {
      title: standups[0]?.title ?? '明日早会汇报',
      overview: overview || '当日工作内容已完成合并整理。',
      completed,
      inProgress,
      blockers,
      nextSteps,
      script:
        results.length === 1
          ? standups[0]!.script
          : buildStandupScript(overview, completed, inProgress, blockers, nextSteps)
    }
  }
}

interface DatedSourceSection {
  sourceId: string
  date: string
  text: string
  quote: string
}

interface DatedWorkEntry extends DatedSourceSection {}

/**
 * Ensures non-empty work material always becomes dated timeline content.
 * The model remains responsible for semantic extraction; this pass only resolves
 * missing dates from the source context and supplies a conservative local event
 * when a provider returns an empty event list.
 */
export function materializeTimelineAnalysis(
  result: AnalysisResult,
  sources: SourceItem[],
  requestedWorkDate: string | null,
  referenceDate: string
): AnalysisResult {
  const reference = new Date(`${referenceDate}T12:00:00Z`)
  const explicitSourceDates = uniqueDates(
    sources.flatMap((source) => source.businessDate ? [source.businessDate.slice(0, 10)] : [])
  )
  // Provider dates are not a safe fallback here: a provider can faithfully
  // quote a date from an embedded prompt/example. Use only dates supplied by
  // the user/source metadata, then the source creation date.
  const fallbackDate = requestedWorkDate
    ?? (explicitSourceDates.length === 1 ? explicitSourceDates[0]! : null)
    ?? preferredSourceFallbackDate(sources, referenceDate)
  const sections = sources.flatMap((source) =>
    extractDatedSourceSections(source, reference, fallbackDate)
  )
  const workEntries = uniqueWorkEntries(sections.flatMap(extractWorkEntries))
  // Every section is trusted text produced by the stateful scanner below.
  // Never rescan rawText: it can contain prompt examples with date-shaped data.
  const contentDates = uniqueDates(sections.map((section) => section.date))

  let events = result.events.flatMap((event) => {
    const evidence = event.evidence.filter((item) =>
      evidenceAppearsInTrustedSections(item.quote, sections)
    )
    // assertGroundedAnalysis verifies against the transport payload, which can
    // legitimately include an embedded prompt. Only evidence found in trusted
    // work sections may reach the timeline.
    return evidence.length ? [{ ...event, evidence }] : []
  }).map((event, index) => {
    const evidenceDate = dateForEventEvidence(event, sections)
    if (event.eventDate) {
      return evidenceDate && evidenceDate !== event.eventDate
        ? { ...event, eventDate: evidenceDate, datePrecision: 'day' as const }
        : event
    }
    const briefDate = dateForEventBrief(event, result.dailyBriefs)
    const positionalDate = contentDates.length === 1
      ? contentDates[0]!
      : contentDates.length
        ? contentDates[Math.min(index, contentDates.length - 1)]!
        : fallbackDate
    return {
      ...event,
      eventDate: evidenceDate ?? briefDate ?? positionalDate,
      datePrecision: 'day' as const,
      confidence: evidenceDate || briefDate
        ? event.confidence
        : Math.min(event.confidence, 0.68)
    }
  })

  if (!events.length) {
    events = workEntries.length
      ? workEntries.slice(0, 1_000).map((entry) => fallbackEvent(
          entry.text,
          entry.quote,
          entry.date,
          LOCAL_FALLBACK_MAX_CONFIDENCE
        ))
      : fallbackEventsFromTrustedSections(sections)
  } else {
    // When the model summarizes several comma/list entries into one event,
    // prefer the locally split source entries so the timeline keeps every
    // independent activity without also showing a duplicate composite card.
    const compositeEvents = new Set(events.filter((event) =>
      workEntries.filter((entry) => eventMentionsWorkEntry(event, entry)).length > 1
    ))
    if (compositeEvents.size) events = events.filter((event) => !compositeEvents.has(event))

    for (const entry of workEntries) {
      if (events.some((event) => eventCoversWorkEntry(event, entry))) continue
      events.push(fallbackEvent(entry.text, entry.quote, entry.date, 0.64))
    }
  }

  const coveredDates = new Set(events.flatMap((event) => event.eventDate ? [event.eventDate] : []))
  const sectionsByDate = new Map<string, DatedSourceSection[]>()
  for (const section of sections) {
    const existing = sectionsByDate.get(section.date) ?? []
    existing.push(section)
    sectionsByDate.set(section.date, existing)
  }
  for (const [date, datedSections] of sectionsByDate) {
    if (coveredDates.has(date)) continue
    const content = datedSections.map((section) => section.text).join('\n')
    const quote = datedSections.find((section) => section.quote)?.quote ?? firstMeaningfulQuote(content)
    events.push(fallbackEvent(content, quote, date, 0.64))
    coveredDates.add(date)
  }
  events = canonicalizeWorkItems(events)
  events.sort((a, b) => (a.eventDate ?? '').localeCompare(b.eventDate ?? ''))

  const eventDates = uniqueDates(
    events.flatMap((event) => event.eventDate ? [event.eventDate] : [])
  )
  const providerSourceDate = result.sourceDate?.value
    && eventDates.includes(result.sourceDate.value)
    ? result.sourceDate
    : null
  const sourceDate = providerSourceDate
    ?? (eventDates.length === 1
      ? {
          value: eventDates[0]!,
          precision: 'day' as const,
          confidence: 0.62,
          rationale: '根据正文中的工作时间与事件上下文完成日期分配'
        }
      : null)

  const eventDateSet = new Set(eventDates)
  const dailyBriefs = result.dailyBriefs.filter((brief) => eventDateSet.has(brief.workDate))
  return { ...result, sourceDate, events, dailyBriefs }
}

export interface FallbackRefinementOptions {
  sourceItemId: string
  title: string
  fallbackDate: string
  referenceDate: string
  existingWorkItems: AnalysisRequest['existingWorkItems']
  analyze: (request: AnalysisRequest, signal?: AbortSignal) => Promise<AnalysisResponse>
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

export interface FallbackRefinementResult {
  result: AnalysisResult
  provider: string | null
  model: string | null
}

interface FallbackRefinementChunk {
  text: string
  evidenceKeys: Set<string>
}

/**
 * Gives only locally materialized events a second semantic pass. This is a
 * lossless enhancement: every provider event must point to one exact dated
 * evidence quote, and any omission, error, or cancellation leaves the local
 * event untouched.
 */
export async function refineFallbackTimelineAnalysis(
  result: AnalysisResult,
  options: FallbackRefinementOptions
): Promise<FallbackRefinementResult> {
  const fallbackEvents = result.events.filter(isLocalFallbackEvent)
  if (!fallbackEvents.length) return { result, provider: null, model: null }

  const chunks = buildFallbackRefinementChunks(fallbackEvents)
  if (!chunks.length) return { result, provider: null, model: null }

  let events = [...result.events]
  let refinedAny = false
  let provider: string | null = null
  let model: string | null = null
  const evolvingWorkItems = new Map(
    options.existingWorkItems.map((item) => [item.key, item])
  )
  addIdentifiedWorkItems(evolvingWorkItems, events)

  for (let index = 0; index < chunks.length; index += 1) {
    if (options.signal?.aborted) break
    const chunk = chunks[index]!
    options.onProgress?.(`正在补充整理本地兜底事项 ${index + 1}/${chunks.length}`)
    try {
      const response = await options.analyze({
        mode: 'fallback_refinement',
        sourceItemId: options.sourceItemId,
        title: options.title,
        text: chunk.text,
        businessDate: null,
        fallbackDate: options.fallbackDate,
        referenceDate: options.referenceDate,
        existingWorkItems: Array.from(evolvingWorkItems.values()).slice(-240)
      }, options.signal)
      if (options.signal?.aborted) break
      assertGroundedAnalysis(response.result, chunk.text)
      const refinedEvents = applyFallbackEventRefinements(
        events,
        response.result.events,
        chunk.evidenceKeys
      )
      refinedAny ||= refinedEvents.some((event, eventIndex) => event !== events[eventIndex])
      events = refinedEvents
      addIdentifiedWorkItems(evolvingWorkItems, events)
      provider = response.provider
      model = response.model
    } catch {
      // Refinement is intentionally best-effort. The initial materialization
      // already contains every dated event, so a provider failure must never
      // turn a complete local result into a failed analysis round.
      if (options.signal?.aborted) break
    }
  }

  return {
    result: refinedAny ? { ...result, events: canonicalizeWorkItems(events) } : result,
    provider,
    model
  }
}

function isLocalFallbackEvent(event: TimelineAnalysisEvent): boolean {
  return event.confidence <= LOCAL_FALLBACK_MAX_CONFIDENCE
    && Boolean(event.eventDate)
    && Boolean(event.evidence[0]?.quote.trim())
}

function fallbackEvidenceKey(date: string | null, quote: string): string {
  return `${date ?? ''}\u0000${quote.trim()}`
}

function buildFallbackRefinementChunks(
  events: TimelineAnalysisEvent[]
): FallbackRefinementChunk[] {
  const records = events.flatMap((event, index) => {
    const quote = event.evidence[0]?.quote.trim()
    if (!event.eventDate || !quote) return []
    return [{
      text: `<worklens-fallback-record index="${index + 1}" date="${event.eventDate}">\n<evidence>\n${quote}\n</evidence>\n</worklens-fallback-record>`,
      evidenceKey: fallbackEvidenceKey(event.eventDate, quote)
    }]
  })
  const chunks: FallbackRefinementChunk[] = []
  let texts: string[] = []
  let keys = new Set<string>()
  let length = 0
  const flush = (): void => {
    if (!texts.length) return
    chunks.push({ text: texts.join('\n\n'), evidenceKeys: keys })
    texts = []
    keys = new Set<string>()
    length = 0
  }
  for (const record of records) {
    const separatorLength = texts.length ? 2 : 0
    if (texts.length && length + separatorLength + record.text.length > MAX_REFINEMENT_CHUNK_CHARACTERS) {
      flush()
    }
    texts.push(record.text)
    keys.add(record.evidenceKey)
    length += (texts.length > 1 ? 2 : 0) + record.text.length
  }
  flush()
  return chunks
}

function applyFallbackEventRefinements(
  events: TimelineAnalysisEvent[],
  refinements: TimelineAnalysisEvent[],
  eligibleEvidenceKeys: Set<string>
): TimelineAnalysisEvent[] {
  const replacements = new Map<number, TimelineAnalysisEvent>()
  const candidatesByEvidence = new Map<string, number[]>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (!isLocalFallbackEvent(event)) continue
    for (const evidence of event.evidence) {
      const key = fallbackEvidenceKey(event.eventDate, evidence.quote)
      if (!eligibleEvidenceKeys.has(key)) continue
      const candidates = candidatesByEvidence.get(key) ?? []
      candidates.push(index)
      candidatesByEvidence.set(key, candidates)
    }
  }

  for (const refinement of refinements) {
    if (!refinement.eventDate) continue
    const evidence = refinement.evidence.find((item) => {
      const key = fallbackEvidenceKey(refinement.eventDate, item.quote)
      return eligibleEvidenceKeys.has(key) && (candidatesByEvidence.get(key)?.length ?? 0) > 0
    })
    if (!evidence) continue
    const key = fallbackEvidenceKey(refinement.eventDate, evidence.quote)
    const candidateIndexes = candidatesByEvidence.get(key)!
    const index = candidateIndexes[0]
    if (index === undefined || replacements.has(index)) continue
    const original = events[index]!
    const groundedTitle = normalizeText(refinement.title)
    const stableTitle = deriveStableWorkItemTitle(
      refinement.workItemTitle || refinement.title,
      ''
    )
    if (
      !groundedTitle
      || !isUsableWorkItemTitle(stableTitle)
      || !workItemTitleIsGrounded(groundedTitle, evidence.quote)
      || !workItemTitleIsGrounded(stableTitle, evidence.quote)
    ) continue
    candidateIndexes.shift()
    replacements.set(index, {
      ...original,
      title: groundedTitle,
      workItemKey: normalizeEntityKey(refinement.workItemKey) || deriveWorkItemKey(stableTitle),
      workItemTitle: stableTitle,
      confidence: Math.max(original.confidence, refinement.confidence),
      // Preserve the locally verified date, evidence, summary and type. The
      // second pass is allowed to improve identity, not invent new facts.
      eventDate: original.eventDate,
      datePrecision: original.datePrecision,
      eventType: original.eventType,
      summary: original.summary,
      evidence: original.evidence
    })
  }
  return events.map((event, index) => replacements.get(index) ?? event)
}

function addIdentifiedWorkItems(
  target: Map<string, AnalysisRequest['existingWorkItems'][number]>,
  events: TimelineAnalysisEvent[]
): void {
  for (const event of events) {
    if (isLocalFallbackEvent(event) || !event.workItemKey || !event.workItemTitle) continue
    target.set(event.workItemKey, {
      key: event.workItemKey,
      title: event.workItemTitle,
      latestDate: event.eventDate,
      summary: event.summary
    })
  }
}

function preferredSourceFallbackDate(sources: SourceItem[], referenceDate: string): string {
  const dates = uniqueStrings(sources.flatMap((source) =>
    source.businessDate ? [source.businessDate.slice(0, 10)] : []
  )).sort()
  return dates.at(-1) ?? sources[0]?.createdAt.slice(0, 10) ?? referenceDate
}

function extractDatedSourceSections(
  source: SourceItem,
  referenceDate: Date,
  fallbackDate: string
): DatedSourceSection[] {
  const sections: DatedSourceSection[] = []
  const undatedLines: string[] = []
  let current: { date: string; lines: string[]; quote: string } | null = null
  let inArtifact = false
  let artifactFence: '`' | '~' | null = null
  let artifactOutputSeen = false
  let artifactCanEnd = false
  const flush = (): void => {
    if (!current) return
    // Keep leading whitespace so nested list items remain distinguishable from
    // top-level work entries. Trailing whitespace has no semantic value.
    const text = current.lines.map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n').trim()
    if (text) {
      sections.push({
        sourceId: source.id,
        date: current.date,
        text,
        quote: (current.quote || current.lines.find((line) => line.trim()) || text).trim().slice(0, 2_000)
      })
    }
    current = null
  }

  const lines = source.rawText.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? ''
    const compact = rawLine.trim()
    const marker = workDateAtLineStart(rawLine, referenceDate)

    if (inArtifact) {
      const fence = codeFenceToken(compact)
      if (fence) {
        if (artifactFence === fence && isClosingCodeFence(compact)) {
          artifactFence = null
          artifactCanEnd = true
        } else if (!artifactFence) {
          artifactFence = fence
          artifactCanEnd = false
        }
        continue
      }
      if (isExplicitArtifactEnd(compact)) {
        artifactCanEnd = true
        continue
      }
      if (isEmbeddedPromptBoundary(compact)) {
        artifactOutputSeen ||= isOutputFormatBoundary(compact)
        artifactCanEnd = false
        continue
      }
      if (
        artifactOutputSeen
        && !artifactFence
        && /^(?:[}\]]+[,;]?|[\[{].*[}\]][,;]?|<\/\s*(?:prompt|system|instructions?)\s*>)$/iu.test(compact)
      ) {
        artifactCanEnd = true
        continue
      }
      if (marker && artifactCanEnd && !artifactFence) {
        inArtifact = false
        artifactOutputSeen = false
        artifactCanEnd = false
        const remainder = rawLine.slice(marker.end).replace(/^[\s：:、—-]+/u, '').trim()
        current = {
          date: marker.date,
          lines: remainder ? [remainder] : [],
          quote: remainder ? rawLine.trim() : ''
        }
      }
      // A date-shaped line inside a prompt/example must not reset the parser.
      continue
    }

    const nextNonEmpty = nextNonEmptyLine(lines, index + 1)
    const promptFence = isPromptCodeFenceStart(compact)
      || (isOpeningCodeFence(compact) && Boolean(nextNonEmpty && isEmbeddedPromptBoundary(nextNonEmpty)))
    if (isEmbeddedPromptBoundary(compact) || promptFence) {
      flush()
      inArtifact = true
      artifactFence = promptFence ? codeFenceToken(compact) : null
      artifactOutputSeen = isOutputFormatBoundary(compact)
      artifactCanEnd = false
      continue
    }

    if (marker) {
      flush()
      const remainder = rawLine.slice(marker.end).replace(/^[\s：:、—-]+/u, '').trim()
      current = {
        date: marker.date,
        lines: remainder ? [remainder] : [],
        quote: remainder ? rawLine.trim() : ''
      }
      continue
    }
    if (!compact) continue
    if (current) {
      current.lines.push(rawLine)
      if (!current.quote) current.quote = compact
    } else {
      undatedLines.push(rawLine)
    }
  }
  flush()
  // Preserve ordinary undated notes without ever falling back to the full raw
  // source. Leading metadata is ignored when the source also has dated work.
  if (!sections.length) {
    const text = undatedLines.map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n').trim()
    if (text) {
      sections.push({
        sourceId: source.id,
        date: fallbackDate,
        text,
        quote: firstMeaningfulQuote(text)
      })
    }
  }
  return sections
}

function extractWorkEntries(section: DatedSourceSection): DatedWorkEntry[] {
  const entries: DatedWorkEntry[] = []
  const allLines = section.text.split(/\r?\n/)
  const embeddedArtifactStart = allLines.findIndex(isEmbeddedPromptBoundary)
  const lines = embeddedArtifactStart >= 0 ? allLines.slice(0, embeddedArtifactStart) : allLines
  const explicitLines = lines.filter((line) => isTopLevelWorkListItem(line))
  const candidates = explicitLines.length
    ? explicitLines.map((rawLine) => ({ rawLine, explicit: true }))
    : lines
        .filter((line) => looksLikeStandaloneWorkLine(line))
        .map((rawLine) => ({ rawLine, explicit: false }))

  for (const { rawLine, explicit } of candidates.slice(0, 80)) {
    const cleaned = cleanWorkEntryLine(rawLine)
    if (!cleaned || isWorkSectionHeading(cleaned)) continue
    for (const fragment of splitCompoundWorkLine(cleaned, !explicit)) {
      const text = fragment.trim()
      if (text.length < 2 || isWorkSectionHeading(text)) continue
      entries.push({ ...section, text, quote: text.slice(0, 2_000) })
    }
  }
  return entries
}

function isEmbeddedPromptBoundary(value: string): boolean {
  const compact = value.trim()
  return /^(?:(?:系统(?:提示词?|消息|角色)?|角色|指令|任务说明)\s*[：:]|(?:system(?:\s+(?:prompt|message|role))?|role|persona|instructions?|task)\s*[：:]|你是.{0,100}(?:助手|专家|模型)|(?:you\s+are|act\s+as)\b.{0,100}|(?:筛选|过滤|判断|分类)(?:标准|规则)?\s*[：:]|(?:filter(?:ing)?|screening|classification)\s+(?:criteria|rules?)\s*[：:]|如果用户(?:在对话中)?出现|if\s+(?:the\s+)?user\b|不要把以下|请严格根据|(?:do\s+not|don't)\s+(?:include|treat)|(?:please\s+)?(?:strictly\s+)?(?:use|follow)\s+the\s+following|(?:示例|范例|例子|examples?|few[- ]shot)\s*[：:]|(?:输出格式|响应格式|返回格式|JSON\s*结构|output\s+format|response\s+format|json\s+schema)\s*[：:])/iu.test(compact)
}

function isOutputFormatBoundary(value: string): boolean {
  return /^(?:输出格式|响应格式|返回格式|JSON\s*结构|output\s+format|response\s+format|json\s+schema)\s*[：:]/iu.test(value.trim())
}

function codeFenceToken(value: string): '`' | '~' | null {
  if (/^`{3,}/u.test(value)) return '`'
  if (/^~{3,}/u.test(value)) return '~'
  return null
}

function isOpeningCodeFence(value: string): boolean {
  return /^(?:`{3,}|~{3,})[^`~]*$/u.test(value.trim())
}

function isClosingCodeFence(value: string): boolean {
  return /^(?:`{3,}|~{3,})\s*$/u.test(value.trim())
}

function isPromptCodeFenceStart(value: string): boolean {
  return /^(?:`{3,}|~{3,})\s*(?:prompt|system|instructions?|assistant|json\s*schema)\s*$/iu.test(value.trim())
}

function isExplicitArtifactEnd(value: string): boolean {
  return /^(?:(?:提示词|系统提示|指令|范例|示例)\s*(?:结束|完毕)|(?:end\s+(?:of\s+)?)?(?:prompt|system\s+prompt|instructions?|examples?)\s*(?:end)?|<\/\s*(?:prompt|system|instructions?)\s*>)$/iu.test(value.trim())
}

function nextNonEmptyLine(lines: string[], start: number): string | null {
  for (let index = start; index < lines.length; index += 1) {
    const compact = lines[index]?.trim()
    if (compact) return compact
  }
  return null
}

function isTopLevelWorkListItem(value: string): boolean {
  return /^(?:[-*•▪◦]\s+|\d{1,3}\s*[.):：、]\s*|[（(]\d{1,3}[）)]\s*)/u.test(value)
}

function looksLikeStandaloneWorkLine(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /^\s/u.test(value) || /^https?:\/\//iu.test(trimmed)) return false
  if (trimmed.length > 320 || /^\[(?:图片|image)\]$/iu.test(trimmed)) return false
  return !isWorkSectionHeading(cleanWorkEntryLine(trimmed))
}

function cleanWorkEntryLine(value: string): string {
  return value
    .trim()
    .replace(/^\[(?:x|X| |图片|image)\]\s*/u, '')
    .replace(/^(?:[-*•▪◦]\s+|\d{1,3}\s*[.):：、]\s*|[（(]\d{1,3}[）)]\s*)/u, '')
    .replace(/^(?:今日|当天|昨日|昨天|明日|今天)?(?:工作|进展|计划|任务|待办)(?:内容)?\s*[：:]\s*/u, '')
    .trim()
}

function isWorkSectionHeading(value: string): boolean {
  const compact = value.replace(/[：:。.!！\s]/gu, '')
  return !compact
    || /^(?:图片|截图|今日工作|当天工作|昨日工作|昨天工作|今天计划|明日计划|下一步计划|接下来的任务|接下来的任务确定|工作计划|工作内容|进展|待办)$/u.test(compact)
}

function splitCompoundWorkLine(value: string, allowCommaSplit: boolean): string[] {
  if (!allowCommaSplit) {
    return [value.replace(/[。；;]+$/u, '').trim()].filter(Boolean)
  }
  const inlineNumbered = value
    .split(/\s+(?=\d{1,3}\s*[.):：、])/u)
    .map((part) => cleanWorkEntryLine(part))
    .filter(Boolean)
  const strongParts = inlineNumbered.flatMap((part) =>
    part.split(/[；;]+|(?<=。)(?=\S)/u).map((item) => item.replace(/[。；;]+$/u, '').trim()).filter(Boolean)
  )
  return strongParts.flatMap((part) => {
    if (!allowCommaSplit || part.length > 160) return [part]
    const commaParts = part.split(/[,，]+/u).map((item) => item.trim()).filter(Boolean)
    const shouldSplitCommas = commaParts.length >= 2
      && commaParts.every((item) => item.length >= 2 && item.length <= 64)
      && commaParts.slice(1).every((item) => !/^(?:并|且|和|与|但|已|正在|目前|等待|需要|发现|完成|然后|其中)/u.test(item))
      // A trailing qualitative assessment belongs to the preceding grounded
      // topic; turning it into its own fallback event produces meaningless
      // items such as a bare consistency/result label.
      && commaParts.slice(1).every((item) => !/^(?:统一性|一致性|兼容性|稳定性|效果|表现)(?:很好|较好|良好|不错|好|正常|符合预期)[。.!！]?$/u.test(item))
    return shouldSplitCommas ? commaParts : [part]
  })
}

function uniqueWorkEntries(entries: DatedWorkEntry[]): DatedWorkEntry[] {
  const map = new Map<string, DatedWorkEntry>()
  for (const entry of entries) {
    const key = `${entry.sourceId}:${entry.date}:${normalizeEntityKey(entry.text)}`
    if (!map.has(key)) map.set(key, entry)
  }
  return Array.from(map.values()).slice(0, 1_000)
}

type TimelineAnalysisEvent = AnalysisResult['events'][number]

interface PreparedWorkItemEvent {
  event: TimelineAnalysisEvent
  index: number
  title: string
  derivedKey: string
  originalKey: string
  anchors: NamedWorkAnchor[]
  themeCores: string[]
  providerTitleExactlyGroundedLocally: boolean
  providerClaim: GroundedProviderWorkItemClaim | null
}

interface GroundedProviderWorkItemClaim {
  identity: string
  title: string
  anchors: NamedWorkAnchor[]
}

interface WorkItemGroupDraft {
  group: PreparedWorkItemEvent[]
  context: string
  title: string
}

type NamedWorkAnchorKind = 'technical' | 'scope' | 'product'

interface NamedWorkAnchor {
  key: string
  kind: NamedWorkAnchorKind
}

/**
 * Keeps timeline events independent while assigning a stable, source-grounded
 * work-item identity to related stages. The merge is deliberately
 * conservative: an exact normalized topic, a compatible model key, or the
 * same explicit named tool/Skill plus lifecycle-only wording is required.
 */
export function canonicalizeWorkItems(events: TimelineAnalysisEvent[]): TimelineAnalysisEvent[] {
  if (!events.length) return events
  const prepared: PreparedWorkItemEvent[] = events.map((event, index) => {
    const title = groundedWorkItemTitleForEvent(event)
    const context = event.evidence.map((item) => item.quote).join('\n')
    const providerTitle = deriveStableWorkItemTitle(event.workItemTitle, '')
    const providerTitleKey = normalizeEntityKey(providerTitle)
    const providerTitleExactlyGroundedLocally = isUsableWorkItemTitle(providerTitle)
      && Boolean(providerTitleKey)
      && event.evidence.some((item) => normalizeEntityKey(item.quote).includes(providerTitleKey))
    // Summary is descriptive evidence context, not stable identity. Letting it
    // contribute themes turns incidental status words into cross-event joins.
    const anchorCandidates = [title, event.workItemTitle, event.title]
    const anchors = groundedNamedWorkAnchors(anchorCandidates, context)
    // Ungrounded provider/event titles may still be useful phrasing candidates
    // at group-title selection time, but must not manufacture a shared theme.
    // Context-omitted follow-ups are handled by the explicit provider claim.
    const themeCandidates = anchorCandidates.filter((candidate) => {
      const stableCandidate = deriveStableWorkItemTitle(candidate, '')
      return isUsableWorkItemTitle(stableCandidate)
        && workItemTitleIsGrounded(stableCandidate, context)
    })
    const themeCores = Array.from(new Set(themeCandidates
      .map((candidate) => workItemThemeCore(candidate, anchors))
      .filter(Boolean)))
    return {
      event,
      index,
      title,
      derivedKey: deriveWorkItemKey(title),
      originalKey: normalizeEntityKey(event.workItemKey),
      anchors,
      themeCores: mostSpecificWorkItemThemes(themeCores),
      providerTitleExactlyGroundedLocally,
      providerClaim: null
    }
  })
  assignGroundedProviderWorkItemClaims(prepared)
  // Use complete-link grouping instead of transitive union-find. A bridge event
  // that resembles A in one phrase and C in another must not pull unrelated A
  // and C into one ever-growing work item.
  const groups: PreparedWorkItemEvent[][] = []
  const groupingOrder = [...prepared].sort(comparePreparedWorkItemsForGrouping)
  for (const item of groupingOrder) {
    const compatibleGroup = groups.find((group) =>
      group.every((member) => workItemEventsBelongTogether(member, item))
    )
    if (compatibleGroup) compatibleGroup.push(item)
    else groups.push([item])
  }
  const initialGroupDrafts: WorkItemGroupDraft[] = groups.map((group) => {
    const context = group.flatMap(({ event }) => event.evidence.map((item) => item.quote)).join('\n')
    const candidates = group.flatMap(({ event, title }) => [
      { value: event.workItemTitle, confidence: event.confidence, preferred: true },
      { value: title, confidence: event.confidence, preferred: false },
      { value: event.title, confidence: event.confidence, preferred: false }
    ])
    const title = selectCanonicalWorkItemTitle(candidates, context)
      ?? group.map(({ title }) => title).sort((a, b) => a.length - b.length)[0]!
    return { group, context, title }
  })
  const groupDrafts = mergeExactGroundedWorkItemDrafts(initialGroupDrafts)
  const titleCounts = new Map<string, number>()
  for (const draft of groupDrafts) {
    const key = normalizeEntityKey(draft.title)
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }

  const assignments = new Map<number, { key: string; title: string }>()
  const usedKeys = new Set<string>()
  for (const draft of groupDrafts) {
    const { group, context } = draft
    const selectedTitleKey = normalizeEntityKey(draft.title)
    const title = (titleCounts.get(selectedTitleKey) ?? 0) > 1
      ? selectSpecificGroundedGroupTitle(group, context, draft.title) ?? draft.title
      : draft.title
    const baseKey = deriveWorkItemKey(title)
    const eventIdentity = normalizeEntityKey(group[0]!.event.title).slice(0, 40)
      || `event${group[0]!.index}`
    let key = isDistinctiveWorkItemIdentity(baseKey, title)
      ? baseKey
      : `${baseKey}${eventIdentity}`
    // Different semantic groups may still normalize to the same compact key.
    // Never let that collision recreate title drift inside one displayed item.
    // Real stages of the same work have already been unioned above.
    let collisionIndex = 2
    while (usedKeys.has(key)) {
      key = `${baseKey}${eventIdentity}${collisionIndex}`
      collisionIndex += 1
    }
    usedKeys.add(key)
    for (const item of group) assignments.set(item.index, { key, title })
  }

  return prepared.map(({ event, index }) => {
    const assignment = assignments.get(index)!
    return { ...event, workItemKey: assignment.key, workItemTitle: assignment.title }
  })
}

/**
 * Rejoins a narrow class of groups that providers split by changing keys
 * between action stages. The shared canonical title must be distinctive and
 * literally present in both groups' evidence, neither group may have a more
 * specific grounded title, and every named anchor must remain conflict-free.
 * This intentionally does not merge on display-title equality alone.
 */
function mergeExactGroundedWorkItemDrafts(
  drafts: WorkItemGroupDraft[]
): WorkItemGroupDraft[] {
  const merged: WorkItemGroupDraft[] = []
  for (const draft of drafts) {
    const target = merged.find((candidate) => exactGroundedDraftsBelongTogether(candidate, draft))
    if (!target) {
      merged.push({ ...draft, group: [...draft.group] })
      continue
    }
    target.group.push(...draft.group)
    target.context = `${target.context}\n${draft.context}`
    const specificTitle = selectSpecificGroundedGroupTitle(
      target.group,
      target.context,
      target.title
    )
    if (specificTitle) target.title = specificTitle
  }
  return merged
}

function exactGroundedDraftsBelongTogether(
  left: WorkItemGroupDraft,
  right: WorkItemGroupDraft
): boolean {
  const titleKey = normalizeEntityKey(left.title)
  if (!titleKey || titleKey !== normalizeEntityKey(right.title)) return false
  const baseKey = deriveWorkItemKey(left.title)
  if (!isDistinctiveWorkItemIdentity(baseKey, left.title)) return false
  if (!normalizeEntityKey(left.context).includes(titleKey)) return false
  if (!normalizeEntityKey(right.context).includes(titleKey)) return false
  const anchorsCompatible = left.group.every((leftItem) => right.group.every((rightItem) =>
    !namedWorkAnchorsConflict(leftItem.anchors, rightItem.anchors)
  ))
  if (!anchorsCompatible) return false

  const leftSpecific = selectSpecificGroundedGroupTitle(left.group, left.context, left.title)
  const rightSpecific = selectSpecificGroundedGroupTitle(right.group, right.context, right.title)
  if (!leftSpecific || !rightSpecific) return true

  // Two explicit sub-themes must normally stay separate even if a provider
  // assigned the same broad label. Permit the repair only with an additional
  // source-grounded signal: overlapping evidence, lifecycle-only residues, or
  // a shared technical/scope anchor that is independent of the broad title.
  // This keeps e.g. “素材生成” and “素材下载” apart under a broad product label.
  if (workItemDraftContextsOverlap(left.context, right.context)) return true
  if ([...left.group, ...right.group].every((item) =>
    hasOnlyOperationalTechnicalThemes(item.themeCores)
  )) return true
  const sharedAnchor = strongestSharedNamedAnchor(
    left.group.flatMap((item) => item.anchors),
    right.group.flatMap((item) => item.anchors)
  )
  return Boolean(
    sharedAnchor
    && sharedAnchor.kind !== 'product'
    && !titleKey.includes(sharedAnchor.key)
  )
}

function workItemDraftContextsOverlap(leftContext: string, rightContext: string): boolean {
  const leftKey = normalizeEntityKey(leftContext)
  const rightKey = normalizeEntityKey(rightContext)
  if (!leftKey || !rightKey) return false
  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey
  const longer = leftKey.length > rightKey.length ? leftKey : rightKey
  return shorter.length >= 8 && longer.includes(shorter)
}

function workItemEventsBelongTogether(
  left: PreparedWorkItemEvent,
  right: PreparedWorkItemEvent
): boolean {
  const leftKey = left.derivedKey
  const rightKey = right.derivedKey
  if (namedWorkAnchorsConflict(left.anchors, right.anchors)) return false

  const sharedNamedAnchor = strongestSharedNamedAnchor(left.anchors, right.anchors)
  const compatibleThemes = workItemThemesAreCompatible(left.themeCores, right.themeCores)
  const hasGroundedIdentity = left.themeCores.length > 0
    || right.themeCores.length > 0
    || Boolean(sharedNamedAnchor)
  if (
    leftKey === rightKey
    && isDistinctiveWorkItemIdentity(leftKey, left.title)
    && isDistinctiveWorkItemIdentity(rightKey, right.title)
    && compatibleThemes
    && hasGroundedIdentity
  ) return true

  // Provider keys are the only identity that naturally crosses model chunks.
  // Trust a reused key once the grounded title/anchor checks show that it is
  // not a generic bucket and does not join two explicitly different objects.
  if (
    left.originalKey
    && left.originalKey === right.originalKey
    && !isGenericProviderWorkItemKey(left.originalKey)
    && compatibleThemes
    && hasGroundedIdentity
  ) return true

  // An exact source-grounded canonical title can unite action-only stages
  // under one non-generic provider identity even when incidental words such
  // as “查看…数据” make the theme residues differ. This is deliberately scoped
  // to the same provider key; equal display titles alone never merge groups.
  if (
    left.originalKey
    && left.originalKey === right.originalKey
    && !isGenericProviderWorkItemKey(left.originalKey)
    && normalizeEntityKey(left.title) === normalizeEntityKey(right.title)
    && isDistinctiveWorkItemIdentity(leftKey, left.title)
    && titleIsExactlyGroundedInEvent(left.title, left.event)
    && titleIsExactlyGroundedInEvent(right.title, right.event)
  ) return true

  if (
    left.originalKey
    && left.originalKey === right.originalKey
    && !isGenericProviderWorkItemKey(left.originalKey)
    && sharedNamedAnchor?.kind === 'technical'
    && (!left.themeCores.length || !right.themeCores.length)
  ) return true

  // Providers often omit the full work-item name from a follow-up sentence
  // ("补充记忆回放验收清单") while retaining one stable key/title. Carry that
  // identity only when the title is grounded by another evidence quote in the
  // same claim and at least one side is truly context-omitted. If both quotes
  // explicitly name a broad title, incompatible sub-themes still stay apart.
  if (groundedProviderClaimCarriesContext(left, right)) return true

  if (!sharedNamedAnchor) return false
  if (compatibleThemes) return true

  // A named technical object may legitimately move from an undifferentiated
  // test into a call/fix/regression stage. Keep those stages together, while
  // refusing to use the same Skill/Agent name as a bridge between two
  // unrelated, substantive sub-features.
  if (sharedNamedAnchor.kind === 'technical' || sharedNamedAnchor.kind === 'scope') {
    const leftOperational = hasOnlyOperationalTechnicalThemes(left.themeCores)
    const rightOperational = hasOnlyOperationalTechnicalThemes(right.themeCores)
    return leftOperational || rightOperational
  }
  return false
}

function assignGroundedProviderWorkItemClaims(items: PreparedWorkItemEvent[]): void {
  const candidates = new Map<string, PreparedWorkItemEvent[]>()
  for (const item of items) {
    const providerTitle = deriveStableWorkItemTitle(item.event.workItemTitle, '')
    const providerTitleKey = normalizeEntityKey(providerTitle)
    if (
      !item.originalKey
      || isGenericProviderWorkItemKey(item.originalKey)
      || !providerTitleKey
      || !isUsableWorkItemTitle(providerTitle)
    ) continue
    const identity = `${item.originalKey}\u0000${providerTitleKey}`
    const members = candidates.get(identity) ?? []
    members.push(item)
    candidates.set(identity, members)
  }

  for (const [identity, members] of candidates) {
    if (members.length < 2 || !members.some((item) => item.providerTitleExactlyGroundedLocally)) continue
    const title = deriveStableWorkItemTitle(members[0]!.event.workItemTitle, '')
    const context = members.flatMap(({ event }) => event.evidence.map((item) => item.quote)).join('\n')
    const anchors = groundedNamedWorkAnchors([title], context)
    const claim: GroundedProviderWorkItemClaim = { identity, title, anchors }
    for (const member of members) {
      if (!namedWorkAnchorsConflict(member.anchors, anchors)) member.providerClaim = claim
    }
  }
}

function groundedProviderClaimCarriesContext(
  left: PreparedWorkItemEvent,
  right: PreparedWorkItemEvent
): boolean {
  const claim = left.providerClaim
  if (!claim || claim.identity !== right.providerClaim?.identity) return false
  if (left.providerTitleExactlyGroundedLocally && right.providerTitleExactlyGroundedLocally) return false
  if (!left.providerTitleExactlyGroundedLocally && !right.providerTitleExactlyGroundedLocally) {
    if (!left.event.eventDate || left.event.eventDate !== right.event.eventDate) return false
  }
  return !namedWorkAnchorsConflict(claim.anchors, left.anchors)
    && !namedWorkAnchorsConflict(claim.anchors, right.anchors)
}

function titleIsExactlyGroundedInEvent(title: string, event: TimelineAnalysisEvent): boolean {
  const titleKey = normalizeEntityKey(title)
  return Boolean(titleKey)
    && event.evidence.some((item) => normalizeEntityKey(item.quote).includes(titleKey))
}

function comparePreparedWorkItemsForGrouping(
  left: PreparedWorkItemEvent,
  right: PreparedWorkItemEvent
): number {
  const leftSpecificity = Math.max(0, ...left.themeCores.map((theme) => theme.length))
  const rightSpecificity = Math.max(0, ...right.themeCores.map((theme) => theme.length))
  if (leftSpecificity !== rightSpecificity) return rightSpecificity - leftSpecificity
  const leftAnchors = left.anchors.map(namedWorkAnchorIdentity).sort().join('|')
  const rightAnchors = right.anchors.map(namedWorkAnchorIdentity).sort().join('|')
  const anchorOrder = leftAnchors.localeCompare(rightAnchors)
  if (anchorOrder) return anchorOrder
  const leftThemes = [...left.themeCores].sort().join('|')
  const rightThemes = [...right.themeCores].sort().join('|')
  const themeOrder = leftThemes.localeCompare(rightThemes)
  if (themeOrder) return themeOrder
  const dateOrder = (left.event.eventDate ?? '').localeCompare(right.event.eventDate ?? '')
  if (dateOrder) return dateOrder
  const titleOrder = normalizeEntityKey(left.event.title).localeCompare(normalizeEntityKey(right.event.title))
  return titleOrder || left.index - right.index
}

function selectSpecificGroundedGroupTitle(
  group: PreparedWorkItemEvent[],
  context: string,
  broadTitle: string
): string | null {
  const anchors = Array.from(new Map(group
    .flatMap((item) => item.anchors)
    .map((anchor) => [`${anchor.kind}:${anchor.key}`, anchor])).values())
  const broadKey = normalizeEntityKey(broadTitle)
  const broadThemes = mostSpecificWorkItemThemes([
    workItemThemeCore(broadTitle, anchors)
  ].filter(Boolean))
  const broadSpecificity = Math.max(0, ...broadThemes.map((theme) => theme.length))
  const candidates = new Map<string, { title: string; specificity: number; confidence: number }>()
  for (const item of group) {
    const rawCandidates = [
      item.event.title,
      item.event.workItemTitle,
      ...item.event.evidence.map((evidence) => evidence.quote)
    ]
    for (const rawCandidate of rawCandidates) {
      const title = deriveStableWorkItemTitle(rawCandidate, '')
      const key = normalizeEntityKey(title)
      if (!key || key === broadKey || !isUsableWorkItemTitle(title)) continue
      if (!workItemTitleIsGrounded(title, context)) continue
      const themes = mostSpecificWorkItemThemes([
        workItemThemeCore(title, anchors)
      ].filter(Boolean))
      const specificity = Math.max(0, ...themes.map((theme) => theme.length))
      const extendsBroadTitle = broadKey.length >= 3
        && key.includes(broadKey)
        && key.length >= broadKey.length + 2
      if (specificity <= broadSpecificity && !extendsBroadTitle) continue
      const existing = candidates.get(key)
      if (!existing || specificity > existing.specificity || item.event.confidence > existing.confidence) {
        candidates.set(key, { title, specificity, confidence: item.event.confidence })
      }
    }
  }
  return Array.from(candidates.values())
    .sort((left, right) =>
      right.specificity - left.specificity
      || right.confidence - left.confidence
      || left.title.length - right.title.length
      || normalizeEntityKey(left.title).localeCompare(normalizeEntityKey(right.title)))
    [0]?.title ?? null
}

function groundedWorkItemTitleForEvent(event: TimelineAnalysisEvent): string {
  const context = event.evidence.map((item) => item.quote).join('\n')
  // A provider item title is a candidate, not an override. It can be fully
  // grounded yet still be a conversational or overly broad phrase. Let the
  // event title and verbatim evidence compete so a more specific, equally
  // grounded object wins without adding facts beyond the source.
  const candidates = [
    { value: event.workItemTitle, confidence: event.confidence, preferred: true },
    { value: event.title, confidence: event.confidence, preferred: false },
    ...event.evidence.map((item) => ({ value: item.quote, confidence: event.confidence, preferred: false }))
  ]
  return selectCanonicalWorkItemTitle(candidates, context)
    ?? deriveStableWorkItemTitle(event.evidence[0]?.quote || event.title, '工作事项')
}

function selectCanonicalWorkItemTitle(
  candidates: Array<{ value: string; confidence: number; preferred: boolean }>,
  context: string
): string | null {
  const unique = new Map<string, { title: string; confidence: number; preferred: boolean; count: number }>()
  for (const candidate of candidates) {
    const title = deriveStableWorkItemTitle(candidate.value, '')
    if (!isUsableWorkItemTitle(title) || !workItemTitleIsGrounded(title, context)) continue
    const key = normalizeEntityKey(title)
    const existing = unique.get(key)
    if (existing) {
      existing.count += 1
      existing.confidence = Math.max(existing.confidence, candidate.confidence)
      existing.preferred ||= candidate.preferred
    } else {
      unique.set(key, {
        title,
        confidence: candidate.confidence,
        preferred: candidate.preferred,
        count: 1
      })
    }
  }
  return Array.from(unique.values())
    .sort((left, right) => workItemTitleScore(right) - workItemTitleScore(left))[0]?.title ?? null
}

function workItemTitleScore(candidate: {
  title: string
  confidence: number
  preferred: boolean
  count: number
}): number {
  const length = Array.from(candidate.title).length
  let score = candidate.confidence * 20 + Math.min(candidate.count, 4) * 5
  if (length >= 6 && length <= 24) score += 24
  else if (length <= 32) score += 12
  else score -= 18
  if (candidate.preferred) score += 4
  if (namedWorkAnchors(candidate.title).length) score += 8
  if (/[,，；;。！？!?]|(?:一下|看看|吧|呢)$/u.test(candidate.title)) score -= 18
  if (/^(?:我|我们|今天|昨日|昨天|继续|正在|完成|看一下|把)/u.test(candidate.title)) score -= 20
  if (/(?:完成(?!度|率)|开始|进入|正在|继续)/u.test(candidate.title)) score -= 10
  return score
}

function isUsableWorkItemTitle(title: string): boolean {
  const length = Array.from(title).length
  if (length < 3 || length > 36) return false
  if (/^(?:工作|任务|事项|当日工作|日常工作|相关工作|项目工作|功能开发|问题处理)$/u.test(title)) return false
  if (/[?？]|(?:如果|是否|为什么|怎么办)/u.test(title)) return false
  return !/^(?:我|我们|今天|昨日|昨天|继续|正在|完成|看一下|把)/u.test(title)
}

function workItemTitleIsGrounded(title: string, context: string): boolean {
  const titleKey = normalizeEntityKey(title)
  const contextKey = normalizeEntityKey(context)
  if (!titleKey || !contextKey) return false
  if (contextKey.includes(titleKey)) return true

  // Outcome-like words cannot be introduced merely as a nicer sounding title.
  const assertedOutcomes = title.match(/保证|成功|解决|增长|改善|通过|领先|提升/gu) ?? []
  if (assertedOutcomes.some((word) => !context.includes(word))) return false

  const latinTokens = title
    .toLocaleLowerCase('zh-CN')
    .match(/[a-z][a-z0-9._-]{1,}/gu) ?? []
  if (latinTokens.some((token) => !context.toLocaleLowerCase('zh-CN').includes(token))) return false

  const chinese = title.replace(/[^\p{Script=Han}]/gu, '')
  if (!chinese) return latinTokens.length > 0
  if (chinese.length <= 2) return context.includes(chinese)
  const grams = Array.from({ length: chinese.length - 1 }, (_, index) => chinese.slice(index, index + 2))
  const supported = grams.filter((gram) => context.includes(gram)).length
  return supported >= Math.max(1, Math.ceil(grams.length * 0.45))
}

function namedWorkAnchors(title: string): string[] {
  return namedWorkAnchorDetails(title).map((anchor) => anchor.key)
}

function groundedNamedWorkAnchors(candidates: string[], context: string): NamedWorkAnchor[] {
  const contextKey = normalizeEntityKey(context)
  const anchors = new Map<string, NamedWorkAnchor>()
  for (const candidate of candidates) {
    for (const anchor of namedWorkAnchorDetails(candidate)) {
      // A model-authored title can suggest how to phrase an identity, but the
      // actual proper name must occur verbatim (after normalization) in the
      // evidence. This prevents a plausible-sounding project from becoming a
      // cross-chunk merge key without source support.
      if (!contextKey.includes(anchor.key)) continue
      const existing = anchors.get(anchor.key)
      if (!existing || namedWorkAnchorRank(anchor.kind) > namedWorkAnchorRank(existing.kind)) {
        anchors.set(anchor.key, anchor)
      }
    }
  }
  return Array.from(anchors.values())
}

function namedWorkAnchorDetails(title: string): NamedWorkAnchor[] {
  const anchors = new Map<string, NamedWorkAnchor>()
  const add = (prefix: string, suffix: string, kind: NamedWorkAnchorKind): void => {
    const normalizedPrefix = normalizeWorkAnchorPrefix(prefix)
    const prefixKey = normalizeEntityKey(normalizedPrefix)
    const hanPrefix = normalizedPrefix.replace(/[^\p{Script=Han}]/gu, '')
    const hasEnoughIdentity = hanPrefix
      ? hanPrefix.length >= 2
      : prefixKey.length >= 3
    if (!hasEnoughIdentity || /^(?:当前|现有|相关|这个|该项|默认|通用|generic|current|default)$/iu.test(prefixKey)) return
    const key = normalizeEntityKey(`${normalizedPrefix}${suffix}`)
    if (!key) return
    const existing = anchors.get(key)
    if (!existing || namedWorkAnchorRank(kind) > namedWorkAnchorRank(existing.kind)) {
      anchors.set(key, { key, kind })
    }
  }

  const technicalPattern = /((?:[a-z0-9][a-z0-9._-]*(?:\s+[a-z0-9._-]+){0,5}|[\p{Script=Han}]{1,18})(?:\s*的)?)\s*(skill|agent|mcp|api|sdk|ui)\b/giu
  for (const match of title.matchAll(technicalPattern)) {
    add(match[1] ?? '', match[2] ?? '', 'technical')
  }

  const scopePattern = /((?:[a-z0-9][a-z0-9._-]*(?:\s+[a-z0-9._-]+){0,4}|[\p{Script=Han}]{1,18})(?:\s*的)?)\s*(项目|模块|页面|页|看板|流程|链路|接口|引擎|组件|功能|能力|端)/giu
  for (const match of title.matchAll(scopePattern)) {
    add(match[1] ?? '', match[2] ?? '', 'scope')
  }

  // A product token is weaker than an explicit “X Skill/X 模块” anchor. It is
  // useful only together with a matching grounded theme (for example,
  // discover + 埋点), never by itself.
  const technicalKeys = Array.from(anchors.values())
    .filter((anchor) => anchor.kind === 'technical')
    .map((anchor) => anchor.key)
  const productStopWords = /^(?:skill|skills|agent|api|sdk|mcp|ui|app|web|page|project|module|feature|work|task|item|test|testing|verify|validation|review|fix|repair|release|deploy|deployment|update|new|latest|current|main|backend|frontend)$/iu
  for (const match of title.matchAll(/[a-z][a-z0-9._-]{2,}/giu)) {
    const token = normalizeEntityKey(match[0])
    if (!token || productStopWords.test(token)) continue
    if (technicalKeys.some((key) => key.includes(token))) continue
    anchors.set(token, { key: token, kind: 'product' })
  }
  return Array.from(anchors.values())
}

function normalizeWorkAnchorPrefix(prefix: string): string {
  let value = prefix.normalize('NFKC').trim().replace(/的\s*$/u, '')
  let previous = ''
  while (value && value !== previous) {
    previous = value
    value = value
      .replace(/^(?:我(?:们)?|今天|现在|目前|当前|本次|这次|整体|继续|正在|已经|已|关于|对于|上线的|新的?|再)\s*/u, '')
      .replace(/^(?:梳理|测试|验证|修复|优化|发布|上线|评测|调试|排查|推进|跟进|分析|学习|查看|看看|看一下|测|做|开发|设计|制作|补充|完善)(?:了|一下)?\s*/u, '')
      .replace(/^(?:(?:the|a|an|new|current|test|testing|verify|fix|repair|review|release|deploy|update)\s+)+/iu, '')
      .trim()
  }
  return value.replace(/的\s*$/u, '').trim()
}

function namedWorkAnchorRank(kind: NamedWorkAnchorKind): number {
  return kind === 'technical' ? 3 : kind === 'scope' ? 2 : 1
}

function strongestSharedNamedAnchor(
  left: NamedWorkAnchor[],
  right: NamedWorkAnchor[]
): NamedWorkAnchor | null {
  const rightKeys = new Set(right.map(namedWorkAnchorIdentity))
  return left
    .filter((anchor) => rightKeys.has(namedWorkAnchorIdentity(anchor)))
    .sort((a, b) => namedWorkAnchorRank(b.kind) - namedWorkAnchorRank(a.kind) || b.key.length - a.key.length)[0]
    ?? null
}

function namedWorkAnchorsConflict(left: NamedWorkAnchor[], right: NamedWorkAnchor[]): boolean {
  for (const kind of ['technical', 'scope', 'product'] as const) {
    const leftKeys = new Set(left.filter((anchor) => anchor.kind === kind).map(namedWorkAnchorIdentity))
    const rightKeys = new Set(right.filter((anchor) => anchor.kind === kind).map(namedWorkAnchorIdentity))
    if (!leftKeys.size || !rightKeys.size) continue
    const sharedKeys = new Set(Array.from(leftKeys).filter((key) => rightKeys.has(key)))
    if (!sharedKeys.size) return true
    // A shared umbrella must not hide two different leaf identities, e.g.
    // “Platform Skill + Alpha Skill” versus “Platform Skill + Beta Skill”.
    const leftOnly = Array.from(leftKeys).filter((key) => !sharedKeys.has(key))
    const rightOnly = Array.from(rightKeys).filter((key) => !sharedKeys.has(key))
    if (leftOnly.length && rightOnly.length) return true
  }
  return false
}

function namedWorkAnchorIdentity(anchor: NamedWorkAnchor): string {
  if (anchor.kind !== 'scope') return anchor.key
  return anchor.key.replace(/(?:功能|能力)$/u, '能力')
}

function workItemThemeCore(title: string, anchors: NamedWorkAnchor[]): string {
  let key = normalizeEntityKey(title)
  for (const anchor of [...anchors].sort((a, b) => b.key.length - a.key.length)) {
    key = key.replaceAll(anchor.key, '')
  }
  return key
    .replace(/补埋(?:点)?/gu, '埋点')
    .replace(/第?[一二三四五六七八九十百0-9]+轮|首轮|多轮|下一轮|初测|复测|回归(?:测试|验证)?/gu, '')
    .replace(/(?:testing|test|verification|verify|validation|regression|fixing|fixed|fix|repair|release|deploy(?:ment)?|iteration|round|stage)/giu, '')
    .replace(/(?:测试|验证|评测|验收|调试|排查|修复|异常|问题|故障|优化|升级|迭代|改版|上线|发布|部署|推进|跟进|进展|阶段|开始|完成|继续|正在|进行|开展|处理|解决|等待|尝试|重试|复现|修改|补充|新增|实现|交给前端|看一下|看看|情况|状态|结果|关于|对于|目前|现在|整体|一下|已经|以及|并且|然后|的|了|与|和|并|再)/gu, '')
}

function mostSpecificWorkItemThemes(themes: string[]): string[] {
  return themes.filter((theme) => !themes.some((candidate) =>
    candidate.length > theme.length && candidate.includes(theme)
  ))
}

function workItemThemesAreCompatible(left: string[], right: string[]): boolean {
  if (!left.length && !right.length) return true
  if (!left.length || !right.length) return false
  return left.some((leftTheme) => right.some((rightTheme) => {
    if (leftTheme === rightTheme) return true
    const shorter = leftTheme.length <= rightTheme.length ? leftTheme : rightTheme
    const longer = leftTheme.length > rightTheme.length ? leftTheme : rightTheme
    return shorter.length >= 4
      && longer.includes(shorter)
      && shorter.length / longer.length >= 0.65
  }))
}

function hasOnlyOperationalTechnicalThemes(themes: string[]): boolean {
  if (!themes.length) return true
  return themes.every((theme) => /^(?:(?:调用|触发|运行|使用|接入|联调|兼容|效果|性能|质量|稳定性|可用性|错误|bug|case))+$/iu.test(theme))
}

function isGenericProviderWorkItemKey(key: string): boolean {
  return /^(?:work|task|item|dailywork|dailyitems?|generic(?:test|work|item)?|misc|other|project|feature|issue|test|validation|unknown|untitled)$/u.test(key)
}

function isDistinctiveWorkItemIdentity(key: string, title: string): boolean {
  if (!key || /^(?:工作|任务|事项|测试|验证|优化|开发|问题|处理|skill|agent)$/u.test(key)) return false
  if (namedWorkAnchors(title).length) return true
  const withoutGeneric = key.replace(/(?:工作|任务|事项|测试|验证|优化|开发|问题|处理|推进|跟进)/gu, '')
  return /[\p{Script=Han}]/u.test(withoutGeneric)
    ? withoutGeneric.length >= 3
    : withoutGeneric.length >= 5
}

function eventCoversWorkEntry(
  event: AnalysisResult['events'][number],
  entry: DatedWorkEntry
): boolean {
  if (event.eventDate !== entry.date) return false
  const entryKey = normalizeEntityKey(entry.text)
  if (entryKey.length < 2) return false
  if (eventEvidenceDirectlyCoversWorkEntry(event, entry)) return true
  const candidates = [event.title, event.summary]
    .map(normalizeEntityKey)
    .filter((value) => value.length >= 2)
  return candidates.some((candidate) => {
    if (candidate === entryKey) return true
    if (entryKey.includes(candidate)) {
      return candidate.length >= Math.max(4, Math.floor(entryKey.length * 0.45))
    }
    if (candidate.includes(entryKey)) {
      return candidate.length <= Math.max(entryKey.length + 8, Math.floor(entryKey.length * 1.35))
    }
    return false
  })
}

function eventEvidenceDirectlyCoversWorkEntry(
  event: AnalysisResult['events'][number],
  entry: DatedWorkEntry
): boolean {
  if (event.eventDate !== entry.date) return false
  const entryKey = normalizeEntityKey(entry.text)
  if (entryKey.length < 4) return false
  return event.evidence.some((item) => normalizeEntityKey(item.quote).includes(entryKey))
}

/**
 * Composite model summaries do not always quote every entry they combine. A
 * common response cites the first list item as evidence while its title or
 * summary also names the second and third items. Treat those textual mentions
 * as coverage for composite detection, while keeping the stricter
 * eventCoversWorkEntry matcher for ordinary AI/local de-duplication.
 */
function eventMentionsWorkEntry(
  event: AnalysisResult['events'][number],
  entry: DatedWorkEntry
): boolean {
  if (event.eventDate !== entry.date) return false
  if (eventEvidenceDirectlyCoversWorkEntry(event, entry)) return true
  const entryKey = normalizeEntityKey(entry.text)
  if (entryKey.length < 4) return false
  return [event.title, event.summary]
    .map(normalizeEntityKey)
    .filter((value) => value.length >= 4)
    .some((candidate) => candidate.includes(entryKey))
}

function workDateAtLineStart(
  rawLine: string,
  referenceDate: Date
): { date: string; end: number } | null {
  const parseAfterPrefix = (prefix: string): { date: string; end: number } | null => {
    const value = rawLine.slice(prefix.length)
    const full = value.match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u)
    if (full) {
      if (/^\s*(?:[-~～至到]|\.\.)\s*\d/u.test(value.slice(full[0].length))) return null
      const date = safeIsoDate(Number(full[1]), Number(full[2]), Number(full[3]))
      return date ? { date, end: prefix.length + full[0].length } : null
    }
    const short = value.match(/^(\d{1,2})月(\d{1,2})日?/u)
    if (short) {
      if (/^\s*(?:[-~～至到]|\.\.)\s*\d/u.test(value.slice(short[0].length))) return null
      const date = safeIsoDate(referenceDate.getUTCFullYear(), Number(short[1]), Number(short[2]))
      return date ? { date, end: prefix.length + short[0].length } : null
    }
    const compact = value.match(/^(\d{1,2})[./](\d{1,2})(?!\d)/u)
    if (compact) {
      if (/^\s*(?:[-~～至到]|\.\.)\s*\d/u.test(value.slice(compact[0].length))) return null
      const date = safeIsoDate(referenceDate.getUTCFullYear(), Number(compact[1]), Number(compact[2]))
      return date ? { date, end: prefix.length + compact[0].length } : null
    }
    return null
  }

  const structuralPrefix = rawLine.match(/^\s*(?:(?:[-*•])\s*)?(?:#{1,6}\s*)?/u)?.[0] ?? ''
  const direct = parseAfterPrefix(structuralPrefix)
  if (direct) return direct
  const numberedPrefix = rawLine.match(/^\s*\d+[.)、]\s*(?:#{1,6}\s*)?/u)?.[0]
  return numberedPrefix ? parseAfterPrefix(numberedPrefix) : null
}

function safeIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null
  return date.toISOString().slice(0, 10)
}

function dateForEventEvidence(
  event: AnalysisResult['events'][number],
  sections: DatedSourceSection[]
): string | null {
  const quotes = event.evidence.map((item) => normalizeText(item.quote)).filter(Boolean)
  for (const section of sections) {
    const sectionText = normalizeText(`${section.quote}\n${section.text}`)
    if (quotes.some((quote) => sectionText.includes(quote))) {
      return section.date
    }
  }
  return null
}

function evidenceAppearsInTrustedSections(
  quote: string,
  sections: DatedSourceSection[]
): boolean {
  const needle = normalizeText(quote)
  if (needle.length < 2) return false
  return sections.some((section) =>
    normalizeText(`${section.quote}\n${section.text}`).includes(needle)
  )
}

function dateForEventBrief(
  event: AnalysisResult['events'][number],
  briefs: AnalysisResult['dailyBriefs']
): string | null {
  const needles = [event.title, event.summary, ...event.evidence.map((item) => item.quote)]
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= 4)
  for (const brief of briefs) {
    const haystack = normalizeText([
      brief.title,
      brief.overview,
      ...brief.completed,
      ...brief.inProgress,
      ...brief.blockers,
      ...brief.nextSteps,
      brief.script
    ].join('\n'))
    if (needles.some((needle) => haystack.includes(needle) || needle.includes(haystack))) {
      return brief.workDate
    }
  }
  return null
}

function fallbackEventsFromTrustedSections(
  sections: DatedSourceSection[]
): AnalysisResult['events'] {
  return sections.slice(0, 300).map((section) => fallbackEvent(
    section.text,
    section.quote,
    section.date,
    LOCAL_FALLBACK_MAX_CONFIDENCE
  ))
}

function fallbackEvent(
  content: string,
  quote: string,
  date: string,
  confidence: number,
  preferredTitle?: string
): AnalysisResult['events'][number] {
  const compact = normalizeText(content)
  const title = deriveTitle(preferredTitle || compact, '工作内容')
  const workItemTitle = deriveStableWorkItemTitle(title, title)
  return {
    title,
    workItemKey: deriveWorkItemKey(workItemTitle),
    workItemTitle,
    eventType: inferEventType(compact),
    eventDate: date,
    datePrecision: 'day',
    summary: excerpt(compact, 1_200) || title,
    confidence,
    evidence: [{ quote: (quote || compact).slice(0, 2_000), blockIndex: null }]
  }
}

function firstMeaningfulQuote(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 2_000) ?? text.trim().slice(0, 2_000)
}

function inferEventType(text: string): string {
  if (/阻塞|卡点|失败|异常|问题|风险|等待权限/u.test(text)) return '问题'
  if (/评审|review/u.test(text)) return '评审'
  if (/测试|验证|验收/u.test(text)) return '验证'
  if (/发布|上线|交付|完成/u.test(text)) return '交付'
  if (/会议|沟通|同步|讨论/u.test(text)) return '会议'
  if (/调研|分析|研究/u.test(text)) return '调研'
  if (/决定|决策|确认方案/u.test(text)) return '决策'
  return '工作'
}

function uniqueEvidence<T extends { quote: string }>(values: T[]): T[] {
  return Array.from(new Map(values.map((value) => [value.quote, value])).values()).slice(0, 50)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 30)
}

function uniqueDates(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}

function buildStandupScript(
  overview: string,
  completed: string[],
  inProgress: string[],
  blockers: string[],
  nextSteps: string[]
): string {
  return [
    '大家早上好，我来同步一下昨天的工作和今天的计划。',
    overview,
    completed.length ? `昨天已经完成的部分有：${completed.join('；')}。` : '',
    inProgress.length ? `目前还在推进的工作有：${inProgress.join('；')}。` : '',
    blockers.length
      ? `当前有这些风险或需要协助的地方：${blockers.join('；')}。`
      : '目前没有明显阻塞。',
    nextSteps.length ? `今天计划继续推进：${nextSteps.join('；')}。` : '',
    '以上是我的工作同步，谢谢。'
  ].filter(Boolean).join('\n\n')
}

function secretKey(kind: 'openai_compatible'): string {
  return `provider:${kind}:api-key`
}

function localIsoDate(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
