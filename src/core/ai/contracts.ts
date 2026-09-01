import type {
  AnalysisResult,
  KnowledgeAnswerResult,
  KnowledgeContextItem,
  ModelInfo,
  ProviderKind,
  WorkQuestionMessage
} from '@shared/contracts'

export interface ProviderCapabilities {
  vision: boolean
  structuredOutput: boolean
  streaming: boolean
  agentRuntime: boolean
}

export interface AnalysisRequest {
  mode?: 'initial' | 'fallback_refinement'
  sourceItemId: string
  title: string
  text: string
  businessDate: string | null
  fallbackDate: string
  referenceDate: string
  existingWorkItems: Array<{ key: string; title: string; latestDate: string | null; summary: string }>
}

export interface AnalysisResponse {
  result: AnalysisResult
  provider: string
  model: string
  externalRunId: string | null
}

export interface KnowledgeQuestionRequest {
  question: string
  history: WorkQuestionMessage[]
  context: KnowledgeContextItem[]
  referenceDate: string
}

export interface KnowledgeQuestionResponse {
  result: KnowledgeAnswerResult
  provider: 'cursor_cli' | 'codex_cli'
  model: string
  externalRunId: string | null
}

export interface ProviderConfiguration {
  kind: ProviderKind
  apiKey: string
  model: string
  baseUrl: string
}

export interface GenerationProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResponse>
  answerKnowledgeQuestion?(
    request: KnowledgeQuestionRequest,
    signal?: AbortSignal
  ): Promise<KnowledgeQuestionResponse>
  test(): Promise<void>
  listModels?(): Promise<ModelInfo[]>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code = 'provider_error',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ProviderError'
  }
}
