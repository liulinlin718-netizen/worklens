import { createWriteStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { ZipArchive, type ArchiverError } from 'archiver'
import { format } from 'date-fns'
import type {
  AppSnapshot,
  DailyBrief,
  ExportRequest,
  SourceItem,
  WorkEvent
} from '@shared/contracts'
import { escapeCsv, safeFileName } from '@core/domain'
import { WorkLensDatabase } from '@core/storage/database'

export interface ExportBundle {
  snapshot: AppSnapshot
  generatedAt: string
  filters: {
    fromDate: string | null
    toDate: string | null
  }
}

export class ExportService {
  constructor(private readonly database: WorkLensDatabase) {}

  getBundle(request: ExportRequest): ExportBundle {
    return {
      snapshot: filterSnapshot(this.database.getSnapshot(), request),
      generatedAt: new Date().toISOString(),
      filters: {
        fromDate: request.fromDate ?? null,
        toDate: request.toDate ?? null
      }
    }
  }

  async writeTextExport(
    request: ExportRequest,
    targetPath: string,
    format: 'markdown' | 'csv'
  ): Promise<void> {
    const bundle = this.getBundle(request)
    const content = format === 'markdown' ? buildMarkdown(bundle) : buildDailyBriefsCsv(bundle)
    await writeAtomic(targetPath, content)
  }

  async writeZip(request: ExportRequest, targetPath: string): Promise<void> {
    const bundle = this.getBundle(request)
    const isFullBackup = !request.fromDate && !request.toDate && request.includeAttachments
    if (isFullBackup) this.database.checkpoint()
    await mkdir(dirname(targetPath), { recursive: true })
    const temporaryPath = `${targetPath}.${process.pid}.tmp`
    const output = createWriteStream(temporaryPath, { mode: 0o600 })
    const archive = new ZipArchive({ zlib: { level: 9 } })

    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
      archive.on('warning', (error: ArchiverError) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject(error)
      })
      archive.on('error', reject)
      archive.pipe(output)
      archive.append(
        JSON.stringify(
          {
            format: 'worklens-backup',
            version: 1,
            generatedAt: bundle.generatedAt,
            fullBackup: isFullBackup,
            containsSecrets: false
          },
          null,
          2
        ),
        { name: 'manifest.json' }
      )
      archive.append(JSON.stringify(bundle, null, 2), { name: 'worklens-data.json' })
      archive.append(buildMarkdown(bundle), { name: 'worklens-report.md' })
      archive.append(buildDailyBriefsCsv(bundle), { name: 'daily-briefs.csv' })
      if (isFullBackup) {
        archive.file(this.database.filePath, { name: 'database/worklens.sqlite' })
      }

      if (request.includeAttachments) {
        const includedSourceIds = new Set(bundle.snapshot.sources.map((source) => source.id))
        for (const asset of this.database.listAssets()) {
          if (!includedSourceIds.has(asset.sourceItemId)) continue
          const extension = extname(asset.originalName)
          const name = `${safeFileName(asset.originalName.replace(extension, ''))}-${asset.sourceItemId.slice(0, 8)}${extension}`
          archive.file(asset.localPath, { name: `attachments/${name}` })
        }
      }
      void archive.finalize()
    })
    await rename(temporaryPath, targetPath)
  }
}

export function filterSnapshot(snapshot: AppSnapshot, request: ExportRequest): AppSnapshot {
  const inRange = (value: string | null): boolean => {
    if (!value) return !request.fromDate && !request.toDate
    const date = value.slice(0, 10)
    return (!request.fromDate || date >= request.fromDate) && (!request.toDate || date <= request.toDate)
  }
  const sources = snapshot.sources.filter((source) => inRange(source.businessDate ?? source.createdAt))
  const sourceIds = new Set(sources.map((source) => source.id))
  const events = snapshot.events.filter(
    (event) => sourceIds.has(event.sourceItemId) || inRange(event.eventDate ?? event.createdAt)
  )
  const dailyBriefs = snapshot.dailyBriefs.filter((brief) => inRange(brief.workDate))
  return {
    ...snapshot,
    sources,
    events,
    dailyBriefs,
    dashboard: {
      ...snapshot.dashboard,
      totals: {
        sources: sources.length,
        events: events.length,
        dailyBriefs: dailyBriefs.length,
        processing: sources.filter((source) => ['queued', 'processing'].includes(source.status)).length
      },
      latestBrief: dailyBriefs[0] ?? null
    }
  }
}

export function buildMarkdown(bundle: ExportBundle): string {
  const { snapshot } = bundle
  const lines = [
    '# WorkLens 工作报告',
    '',
    `> 生成时间：${format(new Date(bundle.generatedAt), 'yyyy-MM-dd HH:mm')}`,
    `> 范围：${bundle.filters.fromDate ?? '不限'} 至 ${bundle.filters.toDate ?? '不限'}`,
    '',
    '## 总览',
    '',
    `- 原始资料：${snapshot.sources.length}`,
    `- 事件：${snapshot.events.length}`,
    `- 工作事项：${snapshot.events.length}`,
    `- 日报与早会稿：${snapshot.dailyBriefs.length}`,
    ''
  ]

  if (snapshot.dailyBriefs.length) {
    lines.push('## 早会逐字稿', '')
    for (const brief of snapshot.dailyBriefs) lines.push(...dailyBriefMarkdown(brief))
  }

  lines.push('## 时间线', '')
  for (const source of snapshot.sources) lines.push(...sourceMarkdown(source))

  lines.push('## 事件', '')
  for (const event of snapshot.events) lines.push(...eventMarkdown(event))

  return `${lines.join('\n').trim()}\n`
}

export function buildDailyBriefsCsv(bundle: ExportBundle): string {
  const rows = [
    ['工作日期', '早会日期', '标题', '概览', '已完成', '进行中', '风险与协助', '下一步', '逐字稿', '资料数', '更新时间'],
    ...bundle.snapshot.dailyBriefs.map((brief) => [
      brief.workDate,
      brief.standupDate,
      brief.title,
      brief.overview,
      brief.completed,
      brief.inProgress,
      brief.blockers,
      brief.nextSteps,
      brief.script,
      brief.sourceItemIds.length,
      brief.updatedAt
    ])
  ]
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`
}

export function buildPrintHtml(bundle: ExportBundle): string {
  const markdown = buildMarkdown(bundle)
  const content = markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`
      if (line.startsWith('> ')) return `<p class="meta">${escapeHtml(line.slice(2))}</p>`
      if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`
      return line ? `<p>${escapeHtml(line)}</p>` : '<div class="space"></div>'
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>WorkLens 工作报告</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body { color: #1d2433; font: 14px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
    h1 { font-size: 28px; margin: 0 0 24px; }
    h2 { font-size: 20px; margin: 28px 0 10px; border-bottom: 1px solid #dfe3ea; padding-bottom: 6px; }
    h3 { font-size: 16px; margin: 20px 0 6px; }
    p { margin: 5px 0; white-space: pre-wrap; }
    li { margin: 3px 0 3px 18px; }
    .meta { color: #6b7280; }
    .space { height: 8px; }
  </style>
</head>
<body>${content}</body>
</html>`
}

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, targetPath)
}

function sourceMarkdown(source: SourceItem): string[] {
  return [
    `### ${source.businessDate ?? source.createdAt.slice(0, 10)} · ${source.title}`,
    '',
    `类型：${source.kind} · 状态：${source.status}`,
    '',
    source.excerpt,
    ''
  ]
}

function eventMarkdown(event: WorkEvent): string[] {
  const lines = [
    `### ${event.eventDate ?? '日期未定'} · ${event.title}`,
    '',
    `类型：${event.eventType} · 置信度：${Math.round(event.confidence * 100)}%`,
    '',
    event.summary,
    ''
  ]
  if (event.evidence.length) {
    lines.push('证据：', ...event.evidence.map((evidence) => `- “${evidence.quote}”`), '')
  }
  return lines
}

function dailyBriefMarkdown(brief: DailyBrief): string[] {
  const lines = [
    `### ${brief.standupDate} 早会 · 汇报 ${brief.workDate} 的工作`,
    '',
    brief.script,
    '',
    `工作概览：${brief.overview}`,
    ''
  ]
  if (brief.completed.length) lines.push('已完成：', ...brief.completed.map((item) => `- ${item}`), '')
  if (brief.inProgress.length) lines.push('进行中：', ...brief.inProgress.map((item) => `- ${item}`), '')
  if (brief.blockers.length) lines.push('风险与协助：', ...brief.blockers.map((item) => `- ${item}`), '')
  if (brief.nextSteps.length) lines.push('下一步：', ...brief.nextSteps.map((item) => `- ${item}`), '')
  return lines
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character
  )
}
