import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess } from 'electron'
import type {
  AnalysisRequest,
  AnalysisResponse,
  KnowledgeQuestionRequest,
  KnowledgeQuestionResponse,
  ProviderConfiguration
} from '@core/ai/contracts'
import { ProviderError } from '@core/ai/contracts'
import type { AiHostRequest, AiHostResponse, AiRuntime } from '@core/ai/host-protocol'
import type { CodexCliStatus, CursorCliStatus, ModelInfo } from '@shared/contracts'

export class UtilityAiRuntime implements AiRuntime {
  constructor(
    private readonly hostScriptPath: string,
    private readonly stateRoot: string
  ) {}

  async analyze(
    configuration: ProviderConfiguration,
    request: AnalysisRequest,
    signal?: AbortSignal
  ): Promise<AnalysisResponse> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'analyze',
        configuration,
        request,
        stateRoot: this.stateRoot
      },
      signal,
      5 * 60_000
    )
    return value as AnalysisResponse
  }

  async test(configuration: ProviderConfiguration): Promise<void> {
    await this.call(
      {
        id: randomUUID(),
        type: 'test',
        configuration,
        stateRoot: this.stateRoot
      },
      undefined,
      45_000
    )
  }

  async answerKnowledgeQuestion(
    configuration: ProviderConfiguration,
    request: KnowledgeQuestionRequest,
    signal?: AbortSignal
  ): Promise<KnowledgeQuestionResponse> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'answer-knowledge-question',
        configuration,
        request,
        stateRoot: this.stateRoot
      },
      signal,
      5 * 60_000
    )
    return value as KnowledgeQuestionResponse
  }

  async listModels(configuration: ProviderConfiguration): Promise<ModelInfo[]> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'list-models',
        configuration,
        stateRoot: this.stateRoot
      },
      undefined,
      45_000
    )
    return value as ModelInfo[]
  }

  async getCursorCliStatus(): Promise<CursorCliStatus> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'cursor-cli-status',
        stateRoot: this.stateRoot
      },
      undefined,
      30_000
    )
    return value as CursorCliStatus
  }

  async loginCursorCli(): Promise<CursorCliStatus> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'cursor-cli-login',
        stateRoot: this.stateRoot
      },
      undefined,
      5 * 60_000
    )
    return value as CursorCliStatus
  }

  async getCodexCliStatus(): Promise<CodexCliStatus> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'codex-cli-status',
        stateRoot: this.stateRoot
      },
      undefined,
      30_000
    )
    return value as CodexCliStatus
  }

  async loginCodexCli(): Promise<CodexCliStatus> {
    const value = await this.call(
      {
        id: randomUUID(),
        type: 'codex-cli-login',
        stateRoot: this.stateRoot
      },
      undefined,
      5 * 60_000
    )
    return value as CodexCliStatus
  }

  private call(
    request: AiHostRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ProviderError('AI 任务已取消', false, 'cancelled'))
        return
      }

      const child = utilityProcess.fork(this.hostScriptPath, [], {
        serviceName: 'WorkLens AI Host',
        stdio: 'pipe',
        env: sanitizedEnvironment()
      })
      let settled = false
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        finishReject(new ProviderError('AI Host 响应超时', true, 'host_timeout'))
      }, timeoutMs)

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-1_000)
      })

      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        child.removeAllListeners()
        if (child.pid) child.kill()
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const abort = (): void => {
        finishReject(new ProviderError('AI 任务已取消', false, 'cancelled'))
      }

      signal?.addEventListener('abort', abort, { once: true })
      child.once('spawn', () => child.postMessage(request))
      child.on('message', (rawResponse: unknown) => {
        const response = rawResponse as AiHostResponse
        if (!response || response.id !== request.id) return
        if (!response.ok) {
          finishReject(
            new ProviderError(
              response.error.message,
              response.error.retryable,
              response.error.code
            )
          )
          return
        }
        if (settled) return
        settled = true
        cleanup()
        resolve(response.value)
      })
      child.once('exit', (code) => {
        if (settled) return
        const detail = stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''
        finishReject(new ProviderError(`AI Host 异常退出（${code}）${detail}`, true, 'host_exit'))
      })
    })
  }
}

function sanitizedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => Boolean(value) && key !== 'ELECTRON_RUN_AS_NODE')
      .map(([key, value]) => [key, value as string])
  )
}
