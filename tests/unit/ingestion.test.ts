import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, createCanvas, loadImage } from '@napi-rs/canvas'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IngestionService } from '@core/ingestion/parser'
import type { ParserRuntime } from '@core/ingestion/contracts'
import { LocalParserEngine } from '@core/ingestion/parser-engine'
import { WorkLensDatabase } from '@core/storage/database'

describe('IngestionService', () => {
  let directory: string
  let database: WorkLensDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worklens-ingestion-test-'))
    database = new WorkLensDatabase(join(directory, 'worklens.sqlite'))
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it(
    'OCRs an image-only PDF without losing the original',
    async () => {
      const imageCanvas = createCanvas(1_200, 360)
      const imageContext = imageCanvas.getContext('2d')
      imageContext.fillStyle = 'white'
      imageContext.fillRect(0, 0, 1_200, 360)
      imageContext.fillStyle = 'black'
      imageContext.font = '56px sans-serif'
      imageContext.fillText('Agent Memory Review', 70, 140)
      imageContext.fillText('2026-07-15 Retry Required', 70, 240)
      const rasterImage = await loadImage(imageCanvas.toBuffer('image/png'))

      const pdf = new PDFDocument()
      const page = pdf.beginPage(1_200, 360)
      ;(
        page as unknown as {
          drawImage(image: unknown, x: number, y: number, width: number, height: number): void
        }
      ).drawImage(rasterImage, 0, 0, 1_200, 360)
      pdf.endPage()
      const filePath = join(directory, 'scanned-meeting.pdf')
      writeFileSync(filePath, pdf.close())

      const ingestion = new IngestionService(
        database,
        join(directory, 'blobs'),
        join(directory, 'derived'),
        join(directory, 'cache'),
        new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
      )
      const result = await ingestion.importFiles([filePath])

      expect(result.failed).toHaveLength(0)
      expect(result.imported).toHaveLength(1)
      expect(result.imported[0]!.rawText.toLocaleLowerCase()).toContain('agent')
      expect(result.imported[0]!.assetCount).toBe(1)
    },
    60_000
  )

  it(
    'OCRs a directly imported image and infers its work date',
    async () => {
      const imageCanvas = createCanvas(1_300, 380)
      const imageContext = imageCanvas.getContext('2d')
      imageContext.fillStyle = 'white'
      imageContext.fillRect(0, 0, 1_300, 380)
      imageContext.fillStyle = 'black'
      imageContext.font = '58px sans-serif'
      imageContext.fillText('2026-08-17 Batch Image Import', 60, 145)
      imageContext.fillText('Release verification completed', 60, 255)
      const filePath = join(directory, 'work-screenshot.png')
      writeFileSync(filePath, imageCanvas.toBuffer('image/png'))
      const ingestion = new IngestionService(
        database,
        join(directory, 'blobs'),
        join(directory, 'derived'),
        join(directory, 'cache'),
        new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
      )

      const result = await ingestion.importFiles([filePath])

      expect(result.failed).toHaveLength(0)
      expect(result.imported[0]).toMatchObject({ kind: 'image', businessDate: '2026-08-17', assetCount: 1 })
      expect(result.imported[0]!.rawText.toLowerCase()).toContain('batch')
    },
    60_000
  )

  it('infers each file date independently during a mixed-day batch import', async () => {
    const julyPath = join(directory, 'july-work.txt')
    const augustPath = join(directory, 'august-work.md')
    writeFileSync(julyPath, '2026年7月14日\n完成支付接口联调并记录测试结果。')
    writeFileSync(augustPath, '# 登录页改版\n\n2026年8月21日完成登录页发布。')
    const ingestion = new IngestionService(
      database,
      join(directory, 'blobs'),
      join(directory, 'derived'),
      join(directory, 'cache'),
      new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
    )

    const result = await ingestion.importFiles([julyPath, augustPath])

    expect(result.failed).toHaveLength(0)
    expect(result.imported).toHaveLength(2)
    expect(result.imported.map((source) => source.businessDate).sort()).toEqual([
      '2026-07-14',
      '2026-08-21'
    ])
    expect(result.imported.every((source) => source.dateOrigin === 'inferred')).toBe(true)
  })

  it('skips duplicate content without creating another source or asset', async () => {
    const filePath = join(directory, 'duplicate.txt')
    writeFileSync(filePath, '2026年8月22日\n完成批量导入重复检测。')
    const ingestion = new IngestionService(
      database,
      join(directory, 'blobs'),
      join(directory, 'derived'),
      join(directory, 'cache'),
      new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
    )

    const first = await ingestion.importFiles([filePath])
    const second = await ingestion.importFiles([filePath])

    expect(first.imported).toHaveLength(1)
    expect(second.imported).toHaveLength(0)
    expect(second.duplicates).toEqual([
      expect.objectContaining({ fileName: 'duplicate.txt', source: expect.objectContaining({ id: first.imported[0]!.id }) })
    ])
    expect(database.listSources()).toHaveLength(1)
    expect(database.listAssets()).toHaveLength(1)
    const [asset] = database.listSourceAssets(first.imported[0]!.id)
    expect(asset).toMatchObject({
      sourceItemId: first.imported[0]!.id,
      originalName: 'duplicate.txt',
      mimeType: 'text/plain'
    })
    expect(database.getAssetLocation(asset!.id)).toMatchObject({
      id: asset!.id,
      originalName: 'duplicate.txt'
    })
  })

  it('keeps a failed file locally and can retry the same source successfully', async () => {
    const filePath = join(directory, 'retry.txt')
    writeFileSync(filePath, '2026年8月23日\n失败后重试并恢复。')
    let attempts = 0
    const runtime: ParserRuntime = {
      async parse() {
        attempts += 1
        if (attempts === 1) throw new Error('模拟解析器暂时不可用')
        const text = '2026年8月23日\n失败后重试并恢复。'
        return {
          kind: 'text',
          mimeType: 'text/plain',
          text,
          blocks: [{ blockIndex: 0, blockType: 'paragraph', text, pageNumber: null, startOffset: 0, endOffset: text.length, confidence: null }],
          width: null,
          height: null
        }
      }
    }
    const ingestion = new IngestionService(
      database,
      join(directory, 'blobs'),
      join(directory, 'derived'),
      join(directory, 'cache'),
      runtime
    )

    const failed = await ingestion.importFiles([filePath])
    expect(failed.failed[0]).toMatchObject({ fileName: 'retry.txt', error: '模拟解析器暂时不可用' })
    expect(failed.failed[0]!.sourceItemId).toBeTruthy()
    expect(database.getSource(failed.failed[0]!.sourceItemId!).status).toBe('failed')

    const retried = await ingestion.retrySource(failed.failed[0]!.sourceItemId!)
    expect(retried.failed).toHaveLength(0)
    expect(retried.imported[0]).toMatchObject({
      id: failed.failed[0]!.sourceItemId,
      businessDate: '2026-08-23',
      status: 'queued',
      assetCount: 1
    })
    expect(database.listSources()).toHaveLength(1)
    expect(database.listAssets()).toHaveLength(1)
  })

  it('cancels before starting without leaving partial failed records', async () => {
    const filePath = join(directory, 'cancel.txt')
    writeFileSync(filePath, '2026年8月24日\n这份资料不应开始解析。')
    const controller = new AbortController()
    controller.abort()
    const ingestion = new IngestionService(
      database,
      join(directory, 'blobs'),
      join(directory, 'derived'),
      join(directory, 'cache'),
      new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
    )

    const result = await ingestion.importFiles([filePath], undefined, controller.signal)

    expect(result.cancelled).toBe(true)
    expect(result.imported).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(database.listSources()).toHaveLength(0)
  })

  it('enforces the batch count and per-file size limits before parsing', async () => {
    const filePath = join(directory, 'too-large.txt')
    writeFileSync(filePath, 'oversized')
    truncateSync(filePath, 25 * 1024 * 1024 + 1)
    const ingestion = new IngestionService(
      database,
      join(directory, 'blobs'),
      join(directory, 'derived'),
      join(directory, 'cache'),
      new LocalParserEngine(join(directory, 'derived'), join(directory, 'cache'))
    )

    const oversized = await ingestion.importFiles([filePath])

    expect(oversized.failed[0]).toMatchObject({ fileName: 'too-large.txt', error: '文件超过 25 MB 限制', sourceItemId: null })
    await expect(ingestion.importFiles(Array.from({ length: 201 }, () => filePath))).rejects.toThrow('单次最多导入 200 份文件')
    expect(database.listSources()).toHaveLength(0)
  })
})
