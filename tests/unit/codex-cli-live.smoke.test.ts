import { describe, expect, it } from 'vitest'
import { CodexCliProvider, getCodexCliStatus } from '@core/ai/providers/codex-cli'

const runLive = process.env.RUN_CODEX_LIVE === '1'

describe.runIf(runLive)('Codex CLI live smoke', () => {
  it(
    'reads account and models through app-server, then returns structured analysis',
    async () => {
      const status = await getCodexCliStatus()
      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(true)

      const provider = new CodexCliProvider({
        kind: 'codex_cli',
        model: 'auto',
        apiKey: '',
        baseUrl: ''
      })
      const models = await provider.listModels()
      expect(models.length).toBeGreaterThan(1)
      expect(models[0]?.id).toBe('auto')

      const sourceText = '2026-08-26 完成 Codex 本机接入，并开始验证日报生成。'
      const response = await provider.analyze({
        sourceItemId: '00000000-0000-4000-8000-000000000001',
        title: '工作记录',
        text: sourceText,
        businessDate: '2026-08-26',
        fallbackDate: '2026-08-26',
        referenceDate: '2026-08-26',
        existingWorkItems: []
      })
      expect(response.provider).toBe('codex_cli')
      expect(response.externalRunId).toBeTruthy()
      expect(response.result.events.length).toBeGreaterThan(0)
      expect(response.result.events.some((event) => event.eventDate === '2026-08-26')).toBe(true)
      expect(response.result.events.every((event) =>
        event.evidence.some((evidence) => sourceText.includes(evidence.quote))
      )).toBe(true)
      expect(JSON.stringify(response.result)).not.toMatch(/无法.*读取.*source\.txt/)
      expect(response.result.summary.content.length).toBeGreaterThan(0)
      expect(response.result.standup.script.length).toBeGreaterThan(0)
    },
    240_000
  )
})
