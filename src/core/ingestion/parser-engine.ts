import { createRequire } from 'node:module'
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas, DOMMatrix, DOMPoint, ImageData, Path2D } from '@napi-rs/canvas'
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas'
import { fileTypeFromBuffer } from 'file-type'
import mammoth from 'mammoth'
import sharp from 'sharp'
import { createWorker, OEM } from 'tesseract.js'
import type { SourceKind } from '@shared/contracts'
import { contentHash, normalizeText } from '@core/domain'
import type { BlockRecord } from '@core/storage/database'
import type { ParsedFile, ParserRuntime } from '@core/ingestion/contracts'

const require = createRequire(import.meta.url)
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_PDF_PAGES = 100
const MAX_SCANNED_PDF_OCR_PAGES = 30
const MAX_IMAGE_PIXELS = 40_000_000

interface LanguageDataPackage {
  code: string
  gzip: boolean
  langPath: string
}

export class LocalParserEngine implements ParserRuntime {
  constructor(
    private readonly derivedRoot: string,
    private readonly cacheRoot: string
  ) {}

  async parse(
    filePath: string,
    onProgress: (message: string) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<ParsedFile> {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('解析目标必须是普通文件')
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 25 MB 限制')
    await Promise.all([
      mkdir(this.derivedRoot, { recursive: true }),
      mkdir(this.cacheRoot, { recursive: true })
    ])
    const buffer = await readFile(filePath)
    const detected = await fileTypeFromBuffer(buffer.subarray(0, Math.min(buffer.byteLength, 8_192)))
    const extension = extname(filePath).toLowerCase()
    const mimeType = detected?.mime ?? mimeFromExtension(extension)
    throwIfAborted(signal)

    if (mimeType === 'text/plain' || extension === '.txt') {
      return textResult('text', mimeType, normalizeText(buffer.toString('utf8')))
    }
    if (mimeType === 'text/markdown' || ['.md', '.markdown'].includes(extension)) {
      return textResult('markdown', 'text/markdown', normalizeText(buffer.toString('utf8')))
    }
    if (mimeType === 'application/pdf' || extension === '.pdf') {
      return this.parsePdf(buffer, onProgress, signal)
    }
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      extension === '.docx'
    ) {
      return this.parseDocx(buffer)
    }
    if (mimeType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.tiff'].includes(extension)) {
      return this.parseImage(buffer, mimeType, onProgress, signal)
    }
    throw new Error(`暂不支持 ${mimeType || extension || '未知'} 格式`)
  }

  private async parsePdf(
    buffer: Buffer,
    onProgress: (message: string) => void,
    signal?: AbortSignal
  ): Promise<ParsedFile> {
    installPdfDomGlobals()
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
        require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      ).href
    }
    const documentOptions = {
      data: new Uint8Array(buffer),
      enableScripting: false,
      useSystemFonts: true,
      CanvasFactory: NapiCanvasFactory
    }
    const loadingTask = pdfjs.getDocument(documentOptions)
    const document = await loadingTask.promise
    if (document.numPages > MAX_PDF_PAGES) {
      await loadingTask.destroy()
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页限制`)
    }

    const blocks: BlockRecord[] = []
    const pages: string[] = []
    let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null
    let scannedPageCount = 0
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        throwIfAborted(signal)
        onProgress(`提取 PDF 第 ${pageNumber}/${document.numPages} 页`)
        const page = await document.getPage(pageNumber)
        const content = await page.getTextContent()
        let text = normalizeText(
          content.items
            .filter((item): item is typeof item & { str: string } => 'str' in item)
            .map((item) => item.str)
            .join(' ')
        )
        let confidence: number | null = null
        if (!text) {
          scannedPageCount += 1
          if (scannedPageCount > MAX_SCANNED_PDF_OCR_PAGES) {
            throw new Error(`扫描 PDF 最多支持 ${MAX_SCANNED_PDF_OCR_PAGES} 页 OCR`)
          }
          onProgress(`OCR 扫描页 ${pageNumber}/${document.numPages}`)
          ocrWorker ??= await this.createOcrWorker()
          const viewport = page.getViewport({ scale: 2 })
          const pixelScale = Math.min(
            1,
            Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, viewport.width * viewport.height))
          )
          const renderViewport =
            pixelScale < 1 ? page.getViewport({ scale: 2 * pixelScale }) : viewport
          const canvas = createCanvas(
            Math.max(1, Math.ceil(renderViewport.width)),
            Math.max(1, Math.ceil(renderViewport.height))
          )
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport: renderViewport,
            background: 'rgb(255,255,255)'
          }).promise
          const ocrResult = await ocrWorker.recognize(canvas.toBuffer('image/png'))
          text = normalizeText(ocrResult.data.text)
          confidence = Number.isFinite(ocrResult.data.confidence)
            ? ocrResult.data.confidence / 100
            : null
        }
        pages.push(text)
        blocks.push({
          blockIndex: blocks.length,
          blockType: confidence === null ? 'page' : 'ocr_page',
          text,
          pageNumber,
          startOffset: null,
          endOffset: null,
          confidence
        })
      }
    } finally {
      if (ocrWorker) await ocrWorker.terminate()
      await loadingTask.destroy()
    }
    const text = normalizeText(pages.join('\n\n'))
    if (!text) throw new Error('PDF 中没有识别到可整理文字')
    return {
      kind: 'pdf',
      mimeType: 'application/pdf',
      text,
      blocks,
      width: null,
      height: null
    }
  }

  private async parseDocx(buffer: Buffer): Promise<ParsedFile> {
    const result = await mammoth.extractRawText({ buffer })
    const text = normalizeText(result.value)
    if (!text) throw new Error('DOCX 没有可提取文字')
    return textResult(
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      text
    )
  }

  private async parseImage(
    buffer: Buffer,
    mimeType: string,
    onProgress: (message: string) => void,
    signal?: AbortSignal
  ): Promise<ParsedFile> {
    const image = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS })
    const metadata = await image.metadata()
    const width = metadata.width ?? null
    const height = metadata.height ?? null
    if (width && height && width * height > MAX_IMAGE_PIXELS) throw new Error('图片像素尺寸过大')
    throwIfAborted(signal)

    const normalizedImage = await image
      .rotate()
      .resize({ width: 3_000, height: 3_000, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    const derivedHash = contentHash(normalizedImage)
    await writeIfMissing(join(this.derivedRoot, `${derivedHash}.png`), normalizedImage)

    onProgress('本地 OCR 识别')
    const worker = await this.createOcrWorker()
    try {
      throwIfAborted(signal)
      const result = await worker.recognize(normalizedImage)
      const text = normalizeText(result.data.text)
      if (!text) throw new Error('图片中没有识别到文字')
      const confidence = Number.isFinite(result.data.confidence) ? result.data.confidence / 100 : null
      return {
        kind: 'image',
        mimeType: mimeType || 'image/png',
        text,
        blocks: [
          {
            blockIndex: 0,
            blockType: 'ocr',
            text,
            pageNumber: null,
            startOffset: 0,
            endOffset: text.length,
            confidence
          }
        ],
        width,
        height
      }
    } finally {
      await worker.terminate()
    }
  }

  private async createOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
    const language = require('@tesseract.js-data/chi_sim') as LanguageDataPackage
    return createWorker(language.code, OEM.LSTM_ONLY, {
      langPath: language.langPath,
      gzip: language.gzip,
      cachePath: join(this.cacheRoot, 'tesseract')
    })
  }
}

function installPdfDomGlobals(): void {
  const globals = globalThis as Record<string, unknown>
  globals.DOMMatrix ??= DOMMatrix
  globals.DOMPoint ??= DOMPoint
  globals.ImageData ??= ImageData
  globals.Path2D ??= Path2D
}

class NapiCanvasFactory {
  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    if (width <= 0 || height <= 0) throw new Error('PDF 画布尺寸无效')
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height))
    return { canvas, context: canvas.getContext('2d') }
  }

  reset(
    canvasAndContext: { canvas: Canvas },
    width: number,
    height: number
  ): void {
    if (!canvasAndContext.canvas || width <= 0 || height <= 0) throw new Error('PDF 画布无法重置')
    canvasAndContext.canvas.width = Math.ceil(width)
    canvasAndContext.canvas.height = Math.ceil(height)
  }

  destroy(canvasAndContext: { canvas: Canvas | null; context: SKRSContext2D | null }): void {
    if (!canvasAndContext.canvas) return
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

function textResult(kind: SourceKind, mimeType: string, text: string): ParsedFile {
  if (!text) throw new Error('文件没有可提取文字')
  return {
    kind,
    mimeType,
    text,
    blocks: textToBlocks(text),
    width: null,
    height: null
  }
}

function textToBlocks(text: string): BlockRecord[] {
  let offset = 0
  return normalizeText(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const startOffset = text.indexOf(block, offset)
      const safeStart = startOffset === -1 ? offset : startOffset
      offset = safeStart + block.length
      return {
        blockIndex: index,
        blockType: /^#{1,6}\s/.test(block) ? 'heading' : 'paragraph',
        text: block,
        pageNumber: null,
        startOffset: safeStart,
        endOffset: safeStart + block.length,
        confidence: null
      }
    })
}

function mimeFromExtension(extension: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.tiff': 'image/tiff'
  }
  return map[extension] ?? 'application/octet-stream'
}

async function writeIfMissing(target: string, data: Buffer): Promise<void> {
  try {
    await access(target)
  } catch {
    await writeFile(target, data, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('解析任务已取消')
}
