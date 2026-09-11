import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import {
  AnalysisResultSchema,
  KnowledgeAnswerResultSchema,
  type CodexCliStatus,
  type ModelInfo
} from '@shared/contracts'
import { coerceAnalysisPayload, parseJsonObject } from '@core/domain'
import type {
  AnalysisRequest,
  AnalysisResponse,
  GenerationProvider,
  KnowledgeQuestionRequest,
  KnowledgeQuestionResponse,
  ProviderCapabilities,
  ProviderConfiguration
} from '@core/ai/contracts'
import { ProviderError } from '@core/ai/contracts'
import { buildChildEnvironment } from '@core/security/child-environment'
import {
  buildKnowledgePrompt,
  buildPrompt,
  formatKnowledgeContext
} from '@core/ai/providers/cursor-cli'

const MAX_STDOUT_BYTES = 12 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 12 * 1024 * 1024
const CODEX_TIMEOUT_MS = 10 * 60_000

interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

interface CodexCommand {
  binaryPath: string
  label: string
}

interface AppServerResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export class CodexCliProvider implements GenerationProvider {
  readonly id = 'codex_cli'
  readonly capabilities: ProviderCapabilities = {
    vision: false,
    structuredOutput: true,
    streaming: false,
    agentRuntime: true
  }

  constructor(private readonly configuration: ProviderConfiguration) {}

  async analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResponse> {
    const commandSpec = await requireCodexCommand()
    const workspace = await mkdtemp(join(tmpdir(), 'worklens-codex-'))
    const resultPath = join(workspace, 'result.json')
    const schemaPath = join(workspace, 'analysis-schema.json')
    await writeFile(schemaPath, JSON.stringify(z.toJSONSchema(AnalysisResultSchema)), {
      encoding: 'utf8',
      mode: 0o600
    })
    try {
      const command = await runCodexExec(
        commandSpec,
        workspace,
        schemaPath,
        resultPath,
        this.configuration.model,
        buildPrompt(request, 'stdin'),
        request.text,
        signal
      )
      const payload = await readStructuredResult(command, resultPath, 'codex_cli_run_failed')
      return {
        result: AnalysisResultSchema.parse(coerceAnalysisPayload(parseJsonObject(payload))),
        provider: this.id,
        model: this.configuration.model || 'auto',
        externalRunId: parseThreadId(command.stdout)
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(
        error instanceof Error ? error.message : String(error),
        false,
        'codex_cli_invalid_response',
        { cause: error }
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  async answerKnowledgeQuestion(
    request: KnowledgeQuestionRequest,
    signal?: AbortSignal
  ): Promise<KnowledgeQuestionResponse> {
    const commandSpec = await requireCodexCommand()
    const workspace = await mkdtemp(join(tmpdir(), 'worklens-codex-knowledge-'))
    const resultPath = join(workspace, 'result.json')
    const schemaPath = join(workspace, 'knowledge-schema.json')
    const knowledgeContext = formatKnowledgeContext(request)
    await writeFile(schemaPath, JSON.stringify(z.toJSONSchema(KnowledgeAnswerResultSchema)), {
      encoding: 'utf8',
      mode: 0o600
    })
    try {
      const command = await runCodexExec(
        commandSpec,
        workspace,
        schemaPath,
        resultPath,
        this.configuration.model,
        buildKnowledgePrompt(request, 'stdin'),
        knowledgeContext,
        signal
      )
      const payload = await readStructuredResult(command, resultPath, 'codex_cli_question_failed')
      return {
        result: KnowledgeAnswerResultSchema.parse(parseJsonObject(payload)),
        provider: 'codex_cli',
        model: this.configuration.model || 'auto',
        externalRunId: parseThreadId(command.stdout)
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(
        error instanceof Error ? error.message : String(error),
        false,
        'codex_cli_question_invalid_response',
        { cause: error }
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  async test(): Promise<void> {
    const status = await getCodexCliStatus()
    if (!status.installed) {
      throw new ProviderError('未安装 Codex CLI', false, 'codex_cli_not_installed')
    }
    if (!status.authenticated) {
      throw new ProviderError('Codex CLI 尚未登录', false, 'codex_cli_not_authenticated')
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const commandSpec = await requireCodexCommand()
    const result = await callCodexAppServer(commandSpec, 'model/list', {
      limit: 100,
      includeHidden: false
    })
    const models = parseCodexModelList(result)
    if (models.length <= 1) {
      throw new ProviderError('Codex 没有返回可用模型', true, 'codex_cli_models_empty')
    }
    return models
  }
}

export async function getCodexCliStatus(): Promise<CodexCliStatus> {
  const commandSpec = await resolveCodexCommand()
  if (!commandSpec) {
    return {
      installed: false,
      authenticated: false,
      binaryPath: null,
      version: null,
      accountLabel: null,
      authMode: null,
      planType: null,
      message: '未安装 Codex CLI'
    }
  }

  let version: string | null = null
  try {
    const versionResult = await runCodex(commandSpec, ['--version'], { timeoutMs: 10_000 })
    version = versionResult.code === 0 ? versionResult.stdout.trim() || null : null
  } catch {
    version = null
  }

  try {
    const raw = await callCodexAppServer(commandSpec, 'account/read', { refreshToken: false })
    const result = asRecord(raw)
    const account = asRecord(result.account)
    const authMode = firstNonEmptyString(account.type) ?? null
    const planType = firstNonEmptyString(account.planType) ?? null
    const accountLabel = firstNonEmptyString(account.email, account.name) ?? null
    const authenticated = Boolean(result.account)
    return {
      installed: true,
      authenticated,
      binaryPath: commandSpec.label,
      version,
      accountLabel,
      authMode,
      planType,
      message: authenticated
        ? `Codex 已连接${planType ? ` · ${formatCodexPlanLabel(planType)}` : ''}`
        : 'Codex 账号尚未登录'
    }
  } catch (error) {
    try {
      const fallback = await runCodex(commandSpec, ['login', 'status'], { timeoutMs: 20_000 })
      const authenticated = fallback.code === 0 && /logged in/i.test(`${fallback.stdout}\n${fallback.stderr}`)
      return {
        installed: true,
        authenticated,
        binaryPath: commandSpec.label,
        version,
        accountLabel: null,
        authMode: authenticated ? 'chatgpt' : null,
        planType: null,
        message: authenticated
          ? 'Codex 已连接'
          : error instanceof Error
            ? error.message
            : String(error)
      }
    } catch {
      return {
        installed: true,
        authenticated: false,
        binaryPath: commandSpec.label,
        version,
        accountLabel: null,
        authMode: null,
        planType: null,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export async function loginCodexCli(): Promise<CodexCliStatus> {
  const commandSpec = await requireCodexCommand()
  const current = await getCodexCliStatus()
  if (current.authenticated) return current
  const result = await runCodex(commandSpec, ['login'], { timeoutMs: 5 * 60_000 })
  if (result.code !== 0) {
    throw new ProviderError(
      result.stderr.trim() || result.stdout.trim() || 'Codex 登录失败',
      false,
      'codex_cli_login_failed'
    )
  }
  const status = await getCodexCliStatus()
  if (!status.authenticated) {
    throw new ProviderError(status.message || 'Codex 登录未完成', false, 'codex_cli_login_incomplete')
  }
  return status
}

export async function resolveCodexCommand(): Promise<CodexCommand | null> {
  const candidates = codexCommandCandidates()

  for (const candidate of Array.from(new Set(candidates))) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      const binaryPath = await realpath(candidate)
      return { binaryPath, label: candidate }
    } catch {
      // Continue to the next official installation location.
    }
  }
  return null
}

export function codexCommandCandidates(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string[] {
  const candidates: Array<string | undefined> = [environment.WORKLENS_CODEX_PATH]
  if (platform === 'win32') {
    candidates.push(
      join(homeDirectory, '.local', 'bin', 'codex.exe'),
      join(homeDirectory, '.codex', 'bin', 'codex.exe')
    )
    if (environment.APPDATA) {
      candidates.push(
        join(
          environment.APPDATA,
          'npm',
          'node_modules',
          '@openai',
          'codex',
          'node_modules',
          '@openai',
          'codex-win32-x64',
          'vendor',
          'x86_64-pc-windows-msvc',
          'codex',
          'codex.exe'
        )
      )
    }
    if (environment.LOCALAPPDATA) {
      candidates.push(join(environment.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe'))
    }
    candidates.push(
      ...String(environment.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, 'codex.exe'))
    )
  } else {
    candidates.push(
      join(homeDirectory, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      ...String(environment.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, 'codex'))
    )
  }
  return Array.from(new Set(candidates.filter((candidate): candidate is string => {
    if (!candidate) return false
    return platform !== 'win32' || candidate.toLowerCase().endsWith('.exe')
  })))
}

export function parseCodexModelList(raw: unknown): ModelInfo[] {
  const result = asRecord(raw)
  const data = Array.isArray(result.data) ? result.data : []
  const discovered = data.flatMap((entry) => {
    const model = asRecord(entry)
    const id = firstNonEmptyString(model.id, model.model)
    if (!id || model.hidden === true) return []
    return [{ id, name: firstNonEmptyString(model.displayName, model.name) ?? id }]
  })
  const unique = Array.from(new Map(discovered.map((model) => [model.id, model])).values())
  return [{ id: 'auto', name: '自动选择（Codex 推荐）' }, ...unique.filter((model) => model.id !== 'auto')]
}

export function formatCodexPlanLabel(planType: string): string {
  const normalized = planType.trim().toLowerCase()
  const labels: Record<string, string> = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu'
  }
  return labels[normalized] ?? (normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}` : '')
}

export function parseThreadId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        return event.thread_id
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return null
}

async function readStructuredResult(
  command: CommandResult,
  resultPath: string,
  errorCode: string
): Promise<string> {
  if (command.code !== 0) {
    throw new ProviderError(
      extractCodexError(command.stdout) || command.stderr.trim() || 'Codex 未返回成功结果',
      command.code !== 2,
      errorCode
    )
  }
  const payload = await readFile(resultPath, 'utf8')
  if (Buffer.byteLength(payload) > MAX_RESULT_BYTES) {
    throw new ProviderError('Codex 结果超过安全限制', false, 'codex_cli_output_limit')
  }
  if (!payload.trim()) {
    throw new ProviderError('Codex 没有返回结构化结果', true, errorCode)
  }
  return payload
}

function runCodexExec(
  commandSpec: CodexCommand,
  workspace: string,
  schemaPath: string,
  resultPath: string,
  model: string,
  prompt: string,
  context: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    resultPath,
    '-C',
    workspace
  ]
  if (model && model !== 'auto') args.push('--model', model)
  args.push(prompt)
  return runCodex(commandSpec, args, {
    cwd: workspace,
    timeoutMs: CODEX_TIMEOUT_MS,
    signal,
    stdin: context
  })
}

async function requireCodexCommand(): Promise<CodexCommand> {
  const commandSpec = await resolveCodexCommand()
  if (!commandSpec) {
    throw new ProviderError(
      '未找到 Codex CLI。请先安装官方 Codex CLI，再返回刷新状态。',
      false,
      'codex_cli_not_installed'
    )
  }
  return commandSpec
}

function callCodexAppServer(
  commandSpec: CodexCommand,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.binaryPath, ['app-server', '--stdio'], {
      env: codexEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdoutBuffer = ''
    let stderr = ''
    let settled = false
    let initialized = false
    const timer = setTimeout(
      () => finishReject(new ProviderError('Codex App Server 响应超时', true, 'codex_app_server_timeout')),
      45_000
    )

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_500)
      killTimer.unref()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      terminate()
    }
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const handleMessage = (message: AppServerResponse): void => {
      if (message.id === 0 && !initialized) {
        if (message.error) {
          finishReject(new ProviderError(message.error.message || 'Codex 初始化失败', true, 'codex_app_server_initialize_failed'))
          return
        }
        initialized = true
        send({ method: 'initialized', params: {} })
        send({ method, id: 1, params })
        return
      }
      if (message.id !== 1) return
      if (message.error) {
        finishReject(new ProviderError(message.error.message || `${method} 调用失败`, true, 'codex_app_server_request_failed'))
        return
      }
      if (settled) return
      settled = true
      cleanup()
      resolve(message.result)
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      if (Buffer.byteLength(stdoutBuffer) > MAX_STDOUT_BYTES) {
        finishReject(new ProviderError('Codex App Server 输出超过安全限制', false, 'codex_cli_output_limit'))
        return
      }
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          handleMessage(JSON.parse(line) as AppServerResponse)
        } catch {
          // Ignore diagnostics that are not protocol messages.
        }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_BYTES)
    })
    child.once('error', (error) => {
      finishReject(new ProviderError('无法启动 Codex App Server', false, 'codex_app_server_spawn_failed', { cause: error }))
    })
    child.once('close', (code) => {
      if (settled) return
      finishReject(new ProviderError(stderr.trim() || `Codex App Server 异常退出（${code ?? 1}）`, true, 'codex_app_server_exit'))
    })

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'worklens', title: 'WorkLens', version: '0.1.3' }
      }
    })
  })
}

function runCodex(
  commandSpec: CodexCommand,
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal; stdin?: string }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProviderError('AI 任务已取消', false, 'cancelled'))
      return
    }
    const child = spawn(commandSpec.binaryPath, args, {
      cwd: options.cwd,
      env: codexEnvironment(),
      shell: false,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin)
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return
      child.kill('SIGINT')
      const terminateTimer = setTimeout(() => child.kill('SIGTERM'), 1_200)
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_500)
      terminateTimer.unref()
      killTimer.unref()
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      terminate()
      reject(error)
    }
    const abort = (): void => finishReject(new ProviderError('AI 任务已取消', false, 'cancelled'))
    const timeout = setTimeout(
      () => finishReject(new ProviderError('Codex CLI 响应超时', true, 'codex_cli_timeout')),
      options.timeoutMs
    )

    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
        finishReject(new ProviderError('Codex CLI 输出超过安全限制', false, 'codex_cli_output_limit'))
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
        finishReject(new ProviderError('Codex CLI 错误输出超过安全限制', false, 'codex_cli_output_limit'))
      }
    })
    child.once('error', (error) => {
      finishReject(new ProviderError('无法启动 Codex CLI', false, 'codex_cli_spawn_failed', { cause: error }))
    })
    child.once('close', (code, signalName) => {
      if (settled) return
      settled = true
      cleanup()
      if (signalName && options.signal?.aborted) {
        reject(new ProviderError('AI 任务已取消', false, 'cancelled'))
        return
      }
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

export function codexEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return buildChildEnvironment(source, { includeCodexHome: true })
}

function extractCodexError(output: string): string {
  let message = ''
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if ((event.type === 'error' || event.type === 'turn.failed') && typeof event.message === 'string') {
        message = event.message
      }
      const error = asRecord(event.error)
      if (typeof error.message === 'string') message = error.message
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return message
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}
