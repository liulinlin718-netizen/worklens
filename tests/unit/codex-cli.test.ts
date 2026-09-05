import { describe, expect, it } from 'vitest'
import {
  codexCommandCandidates,
  formatCodexPlanLabel,
  parseCodexModelList,
  parseThreadId
} from '@core/ai/providers/codex-cli'

describe('Codex CLI integration helpers', () => {
  it('discovers native Codex executables in Windows user and npm locations', () => {
    const candidates = codexCommandCandidates(
      'win32',
      {
        PATH: 'C:\\Tools;D:\\Codex',
        APPDATA: 'C:\\Users\\Lin\\AppData\\Roaming',
        WORKLENS_CODEX_PATH: 'C:\\Custom\\codex.exe'
      },
      'C:\\Users\\Lin'
    )

    expect(candidates[0]).toBe('C:\\Custom\\codex.exe')
    expect(candidates.some((candidate) => candidate
      .replaceAll('\\', '/')
      .endsWith('codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe'))).toBe(true)
    expect(candidates.every((candidate) => candidate.toLowerCase().endsWith('.exe'))).toBe(true)
  })

  it('maps app-server model metadata without hard-coding model ids', () => {
    expect(
      parseCodexModelList({
        data: [
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true },
          { model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', hidden: false },
          { id: 'internal-model', displayName: 'Internal', hidden: true }
        ]
      })
    ).toEqual([
      { id: 'auto', name: '自动选择（Codex 推荐）' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }
    ])
  })

  it('extracts the ephemeral run id from Codex JSONL events', () => {
    expect(
      parseThreadId(
        '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}\n{"type":"turn.started"}\n'
      )
    ).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53')
  })

  it('returns a safe auto fallback for malformed app-server payloads', () => {
    expect(parseCodexModelList(null)).toEqual([
      { id: 'auto', name: '自动选择（Codex 推荐）' }
    ])
  })

  it('formats account plan values for display without changing the protocol value', () => {
    expect(formatCodexPlanLabel('pro')).toBe('Pro')
    expect(formatCodexPlanLabel('plus')).toBe('Plus')
    expect(formatCodexPlanLabel('customPlan')).toBe('Customplan')
  })
})
