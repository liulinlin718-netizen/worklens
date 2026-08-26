import type {
  AnalysisRequest,
  AnalysisResponse,
  KnowledgeQuestionRequest,
  KnowledgeQuestionResponse,
  ProviderConfiguration
} from '@core/ai/contracts'
import type { CodexCliStatus, CursorCliStatus, ModelInfo } from '@shared/contracts'

export interface AiRuntime {
  analyze(
    configuration: ProviderConfiguration,
    request: AnalysisRequest,
    signal?: AbortSignal
  ): Promise<AnalysisResponse>
  answerKnowledgeQuestion(
    configuration: ProviderConfiguration,
    request: KnowledgeQuestionRequest,
    signal?: AbortSignal
  ): Promise<KnowledgeQuestionResponse>
  test(configuration: ProviderConfiguration): Promise<void>
  listModels(configuration: ProviderConfiguration): Promise<ModelInfo[]>
  getCursorCliStatus(): Promise<CursorCliStatus>
  loginCursorCli(): Promise<CursorCliStatus>
  getCodexCliStatus(): Promise<CodexCliStatus>
  loginCodexCli(): Promise<CodexCliStatus>
}

export type AiHostRequest =
  | {
      id: string
      type: 'analyze'
      configuration: ProviderConfiguration
      request: AnalysisRequest
      stateRoot: string
    }
  | {
      id: string
      type: 'test'
      configuration: ProviderConfiguration
      stateRoot: string
    }
  | {
      id: string
      type: 'answer-knowledge-question'
      configuration: ProviderConfiguration
      request: KnowledgeQuestionRequest
      stateRoot: string
    }
  | {
      id: string
      type: 'list-models'
      configuration: ProviderConfiguration
      stateRoot: string
    }
  | {
      id: string
      type: 'cursor-cli-status'
      stateRoot: string
    }
  | {
      id: string
      type: 'cursor-cli-login'
      stateRoot: string
    }
  | {
      id: string
      type: 'codex-cli-status'
      stateRoot: string
    }
  | {
      id: string
      type: 'codex-cli-login'
      stateRoot: string
    }

export type AiHostResponse =
  | {
      id: string
      ok: true
      value:
        | AnalysisResponse
        | KnowledgeQuestionResponse
        | ModelInfo[]
        | CursorCliStatus
        | CodexCliStatus
        | null
    }
  | {
      id: string
      ok: false
      error: {
        message: string
        code: string
        retryable: boolean
      }
    }
