import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipArchive } from 'archiver'
import { PDFDocument, createCanvas, loadImage } from '@napi-rs/canvas'
import { _electron as electron, expect, test } from '@playwright/test'

test('keeps daily capture separate and archives a mixed-day batch by content date', async () => {
  test.setTimeout(90_000)
  const userData = mkdtempSync(join(tmpdir(), 'worklens-e2e-'))
  const julyPath = join(userData, 'july-work.txt')
  const augustPath = join(userData, 'august-work.md')
  const docxPath = join(userData, 'desktop-release.docx')
  const pdfPath = join(userData, 'scanned-release.pdf')
  writeFileSync(julyPath, '2026年7月14日完成支付接口联调。')
  writeFileSync(augustPath, '# 登录页改版\n\n2026年8月21日完成登录页发布。')
  await writeDocx(docxPath, '2026年8月19日完成桌面端批量上传开发。')
  const scan = createCanvas(1_300, 380)
  const context = scan.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, 1_300, 380)
  context.fillStyle = 'black'
  context.font = '58px sans-serif'
  context.fillText('2026-08-18 Batch Import PDF', 60, 145)
  context.fillText('Release verification completed', 60, 255)
  const scanImage = await loadImage(scan.toBuffer('image/png'))
  const pdf = new PDFDocument()
  const pdfPage = pdf.beginPage(1_300, 380)
  ;(pdfPage as unknown as { drawImage(image: unknown, x: number, y: number, width: number, height: number): void }).drawImage(scanImage, 0, 0, 1_300, 380)
  pdf.endPage()
  writeFileSync(pdfPath, pdf.close())
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...environment,
      NODE_ENV: 'test'
    }
  })

  try {
    const window = await electronApp.firstWindow()
    window.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`))
    window.on('pageerror', (error) => console.error(`[renderer:error] ${error.message}`))
    await expect(window).toHaveTitle('WorkLens')
    await expect(window.locator('.app-shell')).toBeVisible()
    await expect(window.locator('.quick-entry')).toHaveText(['每日记录', '批量上传'])
    await window.evaluate(() =>
      globalThis.window.worklens.saveProviderSettings({
        kind: 'cursor_cli',
        model: 'auto',
        baseUrl: '',
        sendImages: false,
        autoAnalyze: false
      })
    )
    await window.locator('.quick-entry').filter({ hasText: '每日记录' }).click()
    await window
      .getByPlaceholder(/^例如：/)
      .fill('2026年7月15日完成游戏 Agent 记忆方案评审，需要增加失败重试入口。')
    await window.getByRole('button', { name: '保存并自动整理' }).click()
    await expect(window.getByText('游戏 Agent 记忆方案评审', { exact: false }).first()).toBeVisible()
    await expect(window.getByText('待整理').first()).toBeVisible()

    await window.locator('.quick-entry').filter({ hasText: '批量上传' }).click()
    await expect(window.getByRole('heading', { name: '先把资料放进待导入列表' })).toBeVisible()
    await expect(window.locator('.batch-pick-button')).toHaveCount(0)
    await window.locator('.batch-file-input').setInputFiles([julyPath, augustPath, docxPath, pdfPath])
    await expect(window.locator('.batch-queue-row')).toHaveCount(4)
    expect((await window.evaluate(() => globalThis.window.worklens.getSnapshot())).sources).toHaveLength(1)
    await window.getByRole('button', { name: '开始处理 4 项' }).click()
    await expect(window.getByText('2026-07-14', { exact: true })).toBeVisible()
    await expect(window.getByText('2026-08-18', { exact: true })).toBeVisible()
    await expect(window.getByText('2026-08-19', { exact: true })).toBeVisible()
    await expect(window.getByText('2026-08-21', { exact: true })).toBeVisible()
    const importedDates = await window.evaluate(async () => {
      const snapshot = await globalThis.window.worklens.getSnapshot()
      return snapshot.sources
        .filter((source) => source.title.includes('支付接口') || source.title.includes('登录页'))
        .map((source) => source.businessDate)
        .sort()
    })
    expect(importedDates).toEqual(['2026-07-14', '2026-08-21'])
    const importedKinds = await window.evaluate(async () => {
      const snapshot = await globalThis.window.worklens.getSnapshot()
      return snapshot.sources
        .filter((source) => source.kind === 'docx' || source.kind === 'pdf')
        .map((source) => ({ kind: source.kind, date: source.businessDate, assetCount: source.assetCount }))
    })
    expect(importedKinds).toEqual(expect.arrayContaining([
      { kind: 'docx', date: '2026-08-19', assetCount: 1 },
      { kind: 'pdf', date: '2026-08-18', assetCount: 1 }
    ]))

    const julyRow = window.locator('.batch-source-row').filter({ hasText: '支付接口' })
    await julyRow.locator('input[type="date"]').fill('2026-07-13')
    await expect(window.getByText('2026-07-13', { exact: true })).toBeVisible()
    const correctedSource = (await window.evaluate(() => globalThis.window.worklens.getSnapshot())).sources.find((source) => source.title.includes('支付接口'))
    expect(correctedSource).toMatchObject({ businessDate: '2026-07-13', dateOrigin: 'manual' })

    await window.getByRole('button', { name: '再导入一批' }).click()
    await window.locator('.batch-file-input').setInputFiles(julyPath)
    await window.getByRole('button', { name: '开始处理 1 项' }).click()
    await expect(window.getByText('1 份重复资料已跳过')).toBeVisible()
    expect((await window.evaluate(() => globalThis.window.worklens.getSnapshot())).sources).toHaveLength(5)

    await window.getByRole('button', { name: '再导入一批' }).click()
    await window.evaluate(() => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', '2026年8月24日完成复制粘贴工作记录验证。')
      globalThis.window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    })
    await expect(window.locator('.batch-paste-card textarea')).toHaveValue('2026年8月24日完成复制粘贴工作记录验证。')
    expect((await window.evaluate(() => globalThis.window.worklens.getSnapshot())).sources).toHaveLength(5)
    await window.getByRole('button', { name: '加入待导入' }).click()
    await expect(window.locator('.batch-queue-row')).toHaveCount(1)
    await window.getByRole('button', { name: '开始处理 1 项' }).click()
    await expect(window.getByText('2026-08-24', { exact: true })).toBeVisible()
    const pastedSnapshot = await window.evaluate(() => globalThis.window.worklens.getSnapshot())
    expect(pastedSnapshot.sources).toHaveLength(6)
    expect(pastedSnapshot.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawText: '2026年8月24日完成复制粘贴工作记录验证。', businessDate: '2026-08-24' })
    ]))

    await window.getByRole('button', { name: '完成并查看时间线' }).click()
    await expect(window.getByRole('heading', { name: '7 月 13 日' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '8 月 24 日' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '8 月 21 日' })).toBeVisible()
  } finally {
    await electronApp.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

async function writeDocx(filePath: string, text: string): Promise<void> {
  const output = createWriteStream(filePath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  archive.pipe(output)
  archive.append(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    { name: '[Content_Types].xml' }
  )
  archive.append(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    { name: '_rels/.rels' }
  )
  archive.append(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    { name: 'word/document.xml' }
  )
  const closed = once(output, 'close')
  await archive.finalize()
  await closed
}
