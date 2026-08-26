import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkLensDatabase } from '@core/storage/database'

describe('5,000 item local workspace performance', () => {
  let directory: string
  let database: WorkLensDatabase

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-performance-'))
    database = new WorkLensDatabase(join(directory, 'performance.sqlite'))
    for (let index = 0; index < 5_000; index += 1) {
      database.createSource({
        title: `Agent 工作记录 ${index}`,
        kind: 'text',
        rawText:
          index === 4_321
            ? '游戏 Agent 长期记忆召回评审与失败重试方案'
            : `第 ${index} 条产品工作内容与会议纪要`,
        businessDate: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
        datePrecision: 'day',
        dateOrigin: 'manual',
        contentHash: `performance-${index}`,
        status: 'ready'
      })
    }
  }, 30_000)

  afterAll(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps full-text search below the MVP p95 target', () => {
    const durations: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now()
      const results = database.search('长期记忆召回')
      durations.push(performance.now() - startedAt)
      expect(results[0]?.title).toBe('Agent 工作记录 4321')
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1] ?? Infinity
    expect(p95).toBeLessThan(300)
  })

  it('loads the timeline dataset below one second', () => {
    const startedAt = performance.now()
    expect(database.listSources()).toHaveLength(5_000)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  it('retrieves focused Q&A context below one second', () => {
    const startedAt = performance.now()
    const context = database.findKnowledgeContext(
      '2026年7月长期记忆召回评审做了什么？',
      '2026-08-25'
    )
    expect(context[0]?.title).toBe('Agent 工作记录 4321')
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })
})
