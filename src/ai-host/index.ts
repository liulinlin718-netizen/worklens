import type {
  AnalysisResponse,
  GenerationProvider,
  KnowledgeQuestionResponse
} from '@core/ai/contracts'
import { ProviderError } from '@core/ai/contracts'
import type { AiHostRequest, AiHostResponse } from '@core/ai/host-protocol'
import {
  CursorCliProvider,
  getCursorCliStatus,
  loginCursorCli
} from '@core/ai/providers/cursor-cli'
import {
  CodexCliProvider,
  getCodexCliStatus,
  loginCodexCli
} from '@core/ai/providers/codex-cli'
import { CursorProvider } from '@core/ai/providers/cursor'
import { OpenAiCompatibleProvider } from '@core/ai/providers/openai-compatible'
import type { CodexCliStatus, CursorCliStatus, ModelInfo } from '@shared/contracts'

const hostPort = process.parentPort
if (!hostPort) throw new Error('AI Host 必须由 Electron utilityProcess 启动')

hostPort.on('message', (event) => {
  void handleRequest(event.data as AiHostRequest)
})

async function handleRequest(request: AiHostRequest): Promise<void> {
  try {
    let value:
      | AnalysisResponse
      | KnowledgeQuestionResponse
      | ModelInfo[]
      | CursorCliStatus
      | CodexCliStatus
      | null = null
    if (request.type === 'cursor-cli-status') {
      value = await getCursorCliStatus()
    } else if (request.type === 'cursor-cli-login') {
      value = await loginCursorCli()
    } else if (request.type === 'codex-cli-status') {
      value = await getCodexCliStatus()
    } else if (request.type === 'codex-cli-login') {
      value = await loginCodexCli()
    } else {
      const provider = createProvider(request)
      if (request.type === 'analyze') {
        value = await provider.analyze(request.request)
      } else if (request.type === 'answer-knowledge-question') {
        if (!provider.answerKnowledgeQuestion) {
          throw new ProviderError('当前 Provider 不支持工作资料问答', false, 'unsupported_operation')
        }
        value = await provider.answerKnowledgeQuestion(request.request)
      } else if (request.type === 'test') {
        await provider.test()
      } else {
        value = provider.listModels ? await provider.listModels() : []
      }
    }
    post({
      id: request.id,
      ok: true,
      value
    })
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            error instanceof Error ? error.message : String(error),
            false,
            'host_error',
            { cause: error }
          )
    post({
      id: request.id,
      ok: false,
      error: {
        message: providerError.message,
        code: providerError.code,
        retryable: providerError.retryable
      }
    })
  }
}

function createProvider(request: AiHostRequest): GenerationProvider {
  if (!('configuration' in request)) {
    throw new ProviderError('AI Host 请求缺少 Provider 配置', false, 'host_invalid_request')
  }
  if (request.configuration.kind === 'cursor_cli') {
    return new CursorCliProvider(request.configuration)
  }
  if (request.configuration.kind === 'codex_cli') {
    return new CodexCliProvider(request.configuration)
  }
  if (request.configuration.kind === 'cursor') {
    return new CursorProvider(request.configuration, request.stateRoot)
  }
  return new OpenAiCompatibleProvider(request.configuration)
}

function post(response: AiHostResponse): void {
  hostPort.postMessage(response)
  setTimeout(() => process.exit(0), 20)
}
