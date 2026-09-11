import { randomUUID } from 'node:crypto'
import { utilityProcess } from 'electron'
import { buildChildEnvironment } from '@core/security/child-environment'
import type {
  ParsedFile,
  ParserHostRequest,
  ParserHostResponse,
  ParserRuntime
} from '@core/ingestion/contracts'

export class UtilityParserRuntime implements ParserRuntime {
  constructor(
    private readonly hostScriptPath: string,
    private readonly derivedRoot: string,
    private readonly cacheRoot: string
  ) {}

  parse(
    filePath: string,
    onProgress: (message: string) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<ParsedFile> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('解析任务已取消'))
        return
      }
      const request: ParserHostRequest = {
        id: randomUUID(),
        filePath,
        derivedRoot: this.derivedRoot,
        cacheRoot: this.cacheRoot
      }
      const child = utilityProcess.fork(this.hostScriptPath, [], {
        serviceName: 'WorkLens Parser Host',
        stdio: 'pipe',
        env: parserHostEnvironment()
      })
      let settled = false
      let stderr = ''
      const timer = setTimeout(() => {
        finishReject(new Error('文档解析超时'))
      }, 2 * 60_000)

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
      const abort = (): void => finishReject(new Error('解析任务已取消'))
      signal?.addEventListener('abort', abort, { once: true })

      child.once('spawn', () => child.postMessage(request))
      child.on('message', (rawResponse: unknown) => {
        const response = rawResponse as ParserHostResponse
        if (!response || response.id !== request.id) return
        if (response.type === 'progress') {
          onProgress(response.message)
          return
        }
        if (response.type === 'error') {
          finishReject(new Error(response.error))
          return
        }
        if (settled) return
        settled = true
        cleanup()
        resolve(response.result)
      })
      child.once('exit', (code) => {
        if (settled) return
        const detail = stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''
        finishReject(new Error(`解析进程异常退出（${code}）${detail}`))
      })
    })
  }
}

export function parserHostEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return buildChildEnvironment(source)
}
