import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { CaptureTextInput, ImportResult, SourceItem, SourceKind } from '@shared/contracts'
import {
  contentHash,
  deriveTitle,
  inferDateFromText,
  normalizeText
} from '@core/domain'
import {
  WorkLensDatabase,
  type BlockRecord
} from '@core/storage/database'
import type { ParsedFile, ParserRuntime } from '@core/ingestion/contracts'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_BATCH_FILES = 200

interface ImportedFileOutcome {
  source: SourceItem
  duplicate: boolean
}

export class IngestionService {
  constructor(
    private readonly database: WorkLensDatabase,
    private readonly blobRoot: string,
    private readonly derivedRoot: string,
    private readonly cacheRoot: string,
    private readonly parserRuntime: ParserRuntime
  ) {}

  async captureText(input: CaptureTextInput): Promise<SourceItem> {
    const text = normalizeText(input.text)
    const inferred = input.businessDate ? null : inferDateFromText(text)
    const source = this.database.createSource({
      title: input.title || deriveTitle(text),
      kind: 'text',
      rawText: text,
      businessDate: input.businessDate ?? inferred?.value ?? null,
      datePrecision: input.businessDate ? 'day' : (inferred?.precision ?? 'unknown'),
      dateOrigin: input.businessDate ? 'manual' : 'inferred',
      contentHash: contentHash(text),
      status: 'queued'
    })
    this.database.replaceBlocks(source.id, textToBlocks(text))
    return this.database.getSource(source.id)
  }

  async importFiles(
    filePaths: string[],
    onProgress?: (event: { fileName: string; message: string; current: number; total: number }) => void,
    signal?: AbortSignal
  ): Promise<ImportResult> {
    if (filePaths.length > MAX_BATCH_FILES) {
      throw new Error(`单次最多导入 ${MAX_BATCH_FILES} 份文件`)
    }
    const imported: SourceItem[] = []
    const duplicates: ImportResult['duplicates'] = []
    const failed: ImportResult['failed'] = []
    let cancelled = false
    await this.ensureDirectories()

    for (let index = 0; index < filePaths.length; index += 1) {
      if (signal?.aborted) {
        cancelled = true
        break
      }
      const filePath = filePaths[index]!
      const fileName = basename(filePath)
      try {
        const report = (message: string): void =>
          onProgress?.({ fileName, message, current: index + 1, total: filePaths.length })
        report('校验文件')
        const outcome = await this.importFile(filePath, report, signal)
        if (outcome.duplicate) {
          duplicates.push({ fileName, source: outcome.source })
        } else {
          imported.push(outcome.source)
        }
      } catch (error) {
        if (error instanceof ImportCancelledError || signal?.aborted) {
          cancelled = true
          break
        }
        failed.push({
          fileName,
          error: toErrorMessage(error),
          sourceItemId: error instanceof FileImportError ? error.sourceItemId : null
        })
      }
    }
    return { imported, duplicates, failed, cancelled }
  }

  async retrySource(
    sourceItemId: string,
    onProgress?: (event: { fileName: string; message: string; current: number; total: number }) => void,
    signal?: AbortSignal
  ): Promise<ImportResult> {
    const source = this.database.getSource(sourceItemId)
    if (source.status !== 'failed') {
      return {
        imported: [],
        duplicates: [{ fileName: source.title, source }],
        failed: [],
        cancelled: false
      }
    }
    const asset = this.database.getPrimaryAssetPath(sourceItemId)
    if (!asset) throw new Error('失败记录缺少原始附件，无法重试')
    await this.ensureDirectories()
    const temporaryDirectory = await mkdtemp(join(this.cacheRoot, 'retry-'))
    const retryPath = join(temporaryDirectory, basename(asset.originalName))
    try {
      await copyFile(asset.localPath, retryPath)
      return await this.importFiles([retryPath], onProgress, signal)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private async importFile(
    filePath: string,
    onProgress: (message: string) => void,
    signal?: AbortSignal
  ): Promise<ImportedFileOutcome> {
    if (signal?.aborted) throw new ImportCancelledError()
    const stat = await lstat(filePath)
    if (stat.isSymbolicLink()) throw new Error('不允许导入符号链接')
    if (!stat.isFile()) throw new Error('所选路径不是文件')
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 25 MB 限制')

    const canonicalPath = await realpath(filePath)
    const buffer = await readFile(canonicalPath)
    const hash = contentHash(buffer)
    const existing = this.database.findSourceByContentHash(hash)
    if (existing && existing.status !== 'failed') {
      onProgress('文件已存在，已跳过重复导入')
      return { source: existing, duplicate: true }
    }
    const blobPath = join(this.blobRoot, hash)
    await copyIfMissing(canonicalPath, blobPath)
    onProgress(existing ? '重新解析失败文件' : '解析内容')

    let parsed: ParsedFile
    try {
      parsed = await this.parserRuntime.parse(canonicalPath, onProgress, signal)
    } catch (error) {
      if (signal?.aborted) throw new ImportCancelledError()
      const failedSource = existing ?? this.database.createSource({
        title: basename(filePath),
        kind: kindFromExtension(extname(filePath)),
        rawText: '',
        businessDate: null,
        datePrecision: 'unknown',
        dateOrigin: 'inferred',
        contentHash: hash,
        status: 'failed'
      })
      if (!existing || existing.assetCount === 0) {
        this.database.addAsset({
          sourceItemId: failedSource.id,
          originalName: basename(filePath),
          mimeType: 'application/octet-stream',
          byteSize: buffer.byteLength,
          localPath: blobPath,
          width: null,
          height: null,
          extractedText: '',
          contentHash: hash
        })
      }
      this.database.setSourceStatus(failedSource.id, 'failed', toErrorMessage(error))
      throw new FileImportError(toErrorMessage(error), failedSource.id)
    }

    const inferred = inferDateFromText(parsed.text)
    const sourceRecord = {
      title: deriveTitle(parsed.text, basename(filePath)),
      kind: parsed.kind,
      rawText: parsed.text,
      businessDate: inferred?.value ?? null,
      datePrecision: inferred?.precision ?? 'unknown',
      dateOrigin: 'inferred',
      contentHash: hash,
      status: 'queued'
    } satisfies Parameters<WorkLensDatabase['createSource']>[0]
    const source = existing
      ? this.database.refreshImportedSource(existing.id, sourceRecord)
      : this.database.createSource(sourceRecord)
    if (existing) {
      this.database.refreshAssetExtraction(source.id, {
        mimeType: parsed.mimeType,
        width: parsed.width,
        height: parsed.height,
        extractedText: parsed.text
      })
    } else {
      this.database.addAsset({
        sourceItemId: source.id,
        originalName: basename(filePath),
        mimeType: parsed.mimeType,
        byteSize: buffer.byteLength,
        localPath: blobPath,
        width: parsed.width,
        height: parsed.height,
        extractedText: parsed.text,
        contentHash: hash
      })
    }
    this.database.replaceBlocks(source.id, parsed.blocks)
    onProgress(existing ? '重试成功' : '导入完成')
    return { source: this.database.getSource(source.id), duplicate: false }
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.blobRoot, { recursive: true }),
      mkdir(this.derivedRoot, { recursive: true }),
      mkdir(this.cacheRoot, { recursive: true })
    ])
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

function kindFromExtension(extension: string): SourceKind {
  const mime = mimeFromExtension(extension.toLowerCase())
  if (mime === 'text/plain') return 'text'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.includes('wordprocessingml')) return 'docx'
  if (mime.startsWith('image/')) return 'image'
  return 'unknown'
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  try {
    await access(target)
  } catch {
    await copyFile(source, target)
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class FileImportError extends Error {
  constructor(message: string, readonly sourceItemId: string) {
    super(message)
    this.name = 'FileImportError'
  }
}

class ImportCancelledError extends Error {
  constructor() {
    super('导入已取消')
    this.name = 'ImportCancelledError'
  }
}
