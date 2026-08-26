import type {
  AnalysisResult,
  AskWorkQuestionInput,
  CodexCliStatus,
  CursorCliStatus,
  DailyBrief,
  ModelInfo,
  ProviderSettings,
  SaveProviderSettings,
  WorkQuestionAnswer
} from '@shared/contracts'
import { normalizeEntityKey } from '@core/domain'
import type { ProviderConfiguration } from '@core/ai/contracts'
import { ProviderError } from '@core/ai/contracts'
import type { AiRuntime } from '@core/ai/host-protocol'
import { SecureSecretStore } from '@core/storage/secure-store'
import { WorkLensDatabase } from '@core/storage/database'

const MAX_CHUNK_CHARACTERS = 36_000

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
    const sourceItemIds = sources.map((source) => source.id)
    const primarySourceId = sourceItemIds[0]!
    const text = sources
      .map((source, index) => `【资料 ${index + 1}：${source.title}】\n${this.database.getSourceText(source.id)}`)
      .join('\n\n')
    if (!text.trim()) throw new Error('这一天的资料没有可分析的文字')

    const settings = await this.getProviderSettings()
    const configuration = await this.getProviderConfiguration(settings)
    const chunks = splitText(text, MAX_CHUNK_CHARACTERS)
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
            title: `${workDate} 工作日报（${sources.length} 份资料）`,
            text: chunks[index] ?? '',
            businessDate: workDate,
            referenceDate: new Date().toISOString().slice(0, 10)
          },
          signal
        )
        results.push(response.result)
        responseProvider = response.provider
        responseModel = response.model
      }

      const merged = mergeAnalysisResults(results)
      const brief = this.database.saveDailySynthesis(
        sourceItemIds,
        merged,
        responseProvider,
        responseModel,
        workDate
      )
      this.database.updateJob(jobId, 'finished', 1, '早会逐字稿已生成')
      this.database.finishAiRun(aiRunId, 'finished')
      onProgress?.('明日早会逐字稿已生成')
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

  async analyzeSource(
    sourceItemId: string,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<DailyBrief> {
    const source = this.database.getSource(sourceItemId)
    return this.analyzeWorkDate(
      (source.businessDate ?? source.createdAt).slice(0, 10),
      onProgress,
      signal
    )
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
    if (settings.kind === 'cursor' && !(await this.secrets.has(secretKey('cursor')))) {
      return {
        ...settings,
        kind: 'cursor_cli',
        model: 'auto',
        baseUrl: '',
        hasApiKey: false
      }
    }
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
    if (input.apiKey !== undefined) await this.secrets.set(secretKey(input.kind), input.apiKey)
    this.database.saveProviderSettings({
      kind: input.kind,
      model: input.model,
      baseUrl: input.baseUrl,
      sendImages: input.sendImages,
      autoAnalyze: input.autoAnalyze
    })
    return this.getProviderSettings()
  }

  async listCursorModels(): Promise<ModelInfo[]> {
    const settings = await this.getProviderSettings()
    const apiKey = await this.secrets.get(secretKey('cursor'))
    if (!apiKey) throw new Error('请先保存 Cursor API Key')
    return this.runtime.listModels({
      kind: 'cursor',
      apiKey,
      model: settings.kind === 'cursor' && settings.model ? settings.model : 'auto',
      baseUrl: ''
    })
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

  loginCursorCli(): Promise<CursorCliStatus> {
    return this.runtime.loginCursorCli()
  }

  getCodexCliStatus(): Promise<CodexCliStatus> {
    return this.runtime.getCodexCliStatus()
  }

  loginCodexCli(): Promise<CodexCliStatus> {
    return this.runtime.loginCodexCli()
  }

  async testProvider(): Promise<void> {
    const settings = await this.getProviderSettings()
    await this.runtime.test(await this.getProviderConfiguration(settings))
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
    if (!apiKey) throw new Error('请先在设置中保存 API Key')
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
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let index = 0; index < paragraph.length; index += maxCharacters) {
        chunks.push(paragraph.slice(index, index + maxCharacters))
      }
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxCharacters) {
      chunks.push(current)
      current = paragraph
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

export function mergeAnalysisResults(results: AnalysisResult[]): AnalysisResult {
  if (!results.length) throw new ProviderError('AI 没有返回分析结果', false, 'empty_result')
  const sourceDate = results
    .map((result) => result.sourceDate)
    .filter((date): date is NonNullable<AnalysisResult['sourceDate']> => Boolean(date))
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null

  const eventMap = new Map<string, AnalysisResult['events'][number]>()
  for (const event of results.flatMap((result) => result.events)) {
    const key = `${normalizeEntityKey(event.title)}:${event.eventDate ?? ''}`
    const existing = eventMap.get(key)
    if (!existing) {
      eventMap.set(key, event)
      continue
    }
    existing.evidence = uniqueEvidence([...existing.evidence, ...event.evidence])
    if (event.summary.length > existing.summary.length) existing.summary = event.summary
    existing.confidence = Math.max(existing.confidence, event.confidence)
  }

  const summaries = results.map((result) => result.summary)
  const standups = results.map((result) => result.standup)
  const completed = uniqueStrings(standups.flatMap((item) => item.completed))
  const inProgress = uniqueStrings(standups.flatMap((item) => item.inProgress))
  const blockers = uniqueStrings(standups.flatMap((item) => item.blockers))
  const nextSteps = uniqueStrings(standups.flatMap((item) => item.nextSteps))
  const overview = uniqueStrings(standups.map((item) => item.overview)).join('\n')
  return {
    sourceDate,
    events: Array.from(eventMap.values()),
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

function uniqueEvidence<T extends { quote: string }>(values: T[]): T[] {
  return Array.from(new Map(values.map((value) => [value.quote, value])).values()).slice(0, 10)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 30)
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

function secretKey(kind: ProviderSettings['kind']): string {
  return `provider:${kind}:api-key`
}

function localIsoDate(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
