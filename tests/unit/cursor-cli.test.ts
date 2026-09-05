import { describe, expect, it } from 'vitest'
import {
  buildPrompt,
  cursorAgentCommandCandidates,
  parseModelList
} from '@core/ai/providers/cursor-cli'

describe('Cursor CLI model discovery', () => {
  it('discovers only native Cursor Agent executables on Windows', () => {
    const candidates = cursorAgentCommandCandidates(
      'win32',
      {
        PATH: 'C:\\Tools;D:\\Agents',
        LOCALAPPDATA: 'C:\\Users\\Lin\\AppData\\Local',
        WORKLENS_CURSOR_AGENT_PATH: 'C:\\Custom\\agent.exe'
      },
      'C:\\Users\\Lin'
    )

    expect(candidates.some((candidate) => candidate.binaryPath.endsWith('agent.exe'))).toBe(true)
    expect(candidates.some((candidate) => candidate.binaryPath.endsWith('.cmd'))).toBe(false)
    expect(candidates[0]?.binaryPath).toBe('C:\\Custom\\agent.exe')
  })

  it('parses the documented human-readable model list without hard-coding ids', () => {
    const models = parseModelList(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
gpt-5.6-sol-high-fast - GPT-5.6 Sol High Fast

Tip: use --model <id> to switch.
`)

    expect(models).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'gpt-5.6-sol-high-fast', name: 'GPT-5.6 Sol High Fast' }
    ])
  })

  it('ignores unknown lines and ANSI formatting', () => {
    expect(parseModelList('\u001b[32mAvailable models\u001b[0m\nnot a model\n')).toEqual([])
  })

  it('requires every work entry to become a dated event for Cursor and Codex CLI', () => {
    const prompt = buildPrompt({
      sourceItemId: '00000000-0000-4000-8000-000000000001',
      title: '跨日期工作日志',
      text: '6月15日完成登录页；6月16日开始联调；6月17日修复问题。',
      businessDate: null,
      fallbackDate: '2026-08-30',
      referenceDate: '2026-08-30',
      existingWorkItems: []
    })

    expect(prompt).toContain('每条有实质工作内容的记录都必须生成 event')
    expect(prompt).toContain('eventDate 不得为 null')
    expect(prompt).toContain('events 至少返回 1 项')
    expect(prompt).toContain('无明确日期时的最终兜底日期：2026-08-30')
    expect(prompt).toContain('<worklens-source>')
    expect(prompt).toContain('6月15日完成登录页')
    expect(prompt).not.toContain('请读取当前工作目录中的 source.txt')
    expect(prompt).not.toContain('events 可为 []')
  })
})
