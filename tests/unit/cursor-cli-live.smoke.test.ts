import { describe, expect, it } from 'vitest'
import { CursorCliProvider, getCursorCliStatus } from '@core/ai/providers/cursor-cli'

const runLive = process.env.RUN_LIVE_CLI === '1'

describe.runIf(runLive)('Cursor CLI live smoke', () => {
  it(
    'lists models and analyzes sample meeting notes',
    async () => {
      const status = await getCursorCliStatus()
      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(true)

      const provider = new CursorCliProvider({
        kind: 'cursor_cli',
        model: 'auto',
        apiKey: '',
        baseUrl: ''
      })

      const models = await provider.listModels()
      expect(models.length).toBeGreaterThan(0)
      expect(models.some((model) => model.id === 'auto')).toBe(true)

      const response = await provider.analyze({
        sourceItemId: '00000000-0000-4000-8000-000000000001',
        title: '会议纪要',
        text: `会议纪要 - 2026-07-10
主题：WorkLens 每日工作汇报

决策：
1. 7月18日前完成 Cursor CLI 免 API Key 分析通路
2. 导出需支持 Markdown 与 PDF
3. OCR 图片识别仍在进行，等待真实截图验证

待办：
- 明天计划：上传会议纪要后检查早会逐字稿
`,
        businessDate: null,
        referenceDate: '2026-07-16',
        existingWorkItems: []
      })

      expect(response.provider).toBe('cursor_cli')
      expect(response.result.summary.content.length).toBeGreaterThan(0)
      expect(response.result.events.length).toBeGreaterThan(0)
      expect(response.result.standup.script.length).toBeGreaterThan(0)
    },
    240_000
  )
})
