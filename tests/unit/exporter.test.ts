import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '@shared/contracts'
import {
  buildMarkdown,
  buildDailyBriefsCsv,
  filterSnapshot,
  type ExportBundle
} from '@core/export/exporter'

const snapshot: AppSnapshot = {
  sources: [
    {
      id: 'source-1',
      title: '七月评审',
      kind: 'text',
      rawText: '评审内容',
      excerpt: '评审内容',
      businessDate: '2026-07-15',
      datePrecision: 'day',
      dateOrigin: 'manual',
      status: 'ready',
      error: null,
      contentHash: 'hash',
      assetCount: 0,
      createdAt: '2026-07-15T08:00:00.000Z',
      updatedAt: '2026-07-15T08:00:00.000Z'
    }
  ],
  events: [],
  dailyBriefs: [
    {
      id: 'brief-1',
      workDate: '2026-07-15',
      standupDate: '2026-07-16',
      title: '=危险公式',
      overview: '完成安全导出',
      script: '大家早上好，昨天完成了安全导出。',
      completed: ['CSV 不执行公式'],
      inProgress: [],
      blockers: [],
      nextSteps: ['继续验证'],
      sourceItemIds: ['source-1'],
      provider: 'test',
      model: 'test-model',
      createdAt: '2026-07-15T08:00:00.000Z',
      updatedAt: '2026-07-15T08:00:00.000Z'
    }
  ],
  dashboard: {
    totals: { sources: 1, events: 0, dailyBriefs: 1, processing: 0 },
    eventTypes: [],
    activity: [],
    latestBrief: null
  }
}

const bundle: ExportBundle = {
  snapshot,
  generatedAt: '2026-07-15T10:00:00.000Z',
  filters: { fromDate: null, toDate: null }
}

describe('exporters', () => {
  it('filters exports by business date', () => {
    expect(
      filterSnapshot(snapshot, {
        format: 'markdown',
        fromDate: '2026-07-16',
        toDate: null,
        includeAttachments: false
      }).sources
    ).toHaveLength(0)
  })

  it('renders traceable markdown sections', () => {
    const markdown = buildMarkdown(bundle)
    expect(markdown).toContain('# WorkLens 工作报告')
    expect(markdown).toContain('## 早会逐字稿')
    expect(markdown).toContain('CSV 不执行公式')
  })

  it('adds a BOM and neutralizes spreadsheet formulas', () => {
    const csv = buildDailyBriefsCsv(bundle)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain("'=危险公式")
  })
})
