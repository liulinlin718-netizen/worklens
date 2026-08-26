import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron as electron } from 'playwright'

const executablePath = resolve(
  process.argv[2] ?? 'release/mac-arm64/WorkLens.app/Contents/MacOS/WorkLens'
)

if (!existsSync(executablePath)) {
  throw new Error(`Packaged app not found: ${executablePath}`)
}

const userData = mkdtempSync(join(tmpdir(), 'worklens-packaged-smoke-'))
const firstBatchFile = join(userData, 'packaged-batch-one.txt')
const secondBatchFile = join(userData, 'packaged-batch-two.md')
writeFileSync(firstBatchFile, '2026年8月20日完成打包应用批量导入验证。')
writeFileSync(secondBatchFile, '# 发布记录\n\n2026年8月22日完成发布说明整理。')
const stubServer = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/v1/models') {
    response.end(JSON.stringify({ data: [{ id: 'packaged-smoke-model' }] }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: 'not found' } }))
})
await new Promise((resolvePromise) => stubServer.listen(0, '127.0.0.1', resolvePromise))
const stubPort = stubServer.address().port
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env
const electronApp = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userData}`],
  env: environment
})

try {
  const window = await electronApp.firstWindow()
  await window.waitForSelector('.app-shell', { state: 'visible', timeout: 15_000 })
  const title = await window.title()
  const versions = await electronApp.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node
  }))
  if (title !== 'WorkLens') throw new Error(`Unexpected app title: ${title}`)
  const [major, minor] = versions.node.split('.').map(Number)
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 13)) {
    throw new Error(`Cursor SDK requires Node 22.13+, packaged app has ${versions.node}`)
  }
  const providerTest = await window.evaluate(async (baseUrl) => {
    await window.worklens.saveProviderSettings({
      kind: 'openai_compatible',
      model: 'packaged-smoke-model',
      baseUrl,
      apiKey: 'packaged-smoke-key',
      sendImages: false,
      autoAnalyze: false
    })
    return window.worklens.testProvider()
  }, `http://127.0.0.1:${stubPort}/v1`)
  if (!providerTest.ok) throw new Error(providerTest.message)
  await window.locator('.quick-entry').filter({ hasText: '批量上传' }).click()
  if (await window.locator('.batch-pick-button').count()) throw new Error('Redundant batch picker is still visible')
  await window.locator('.batch-file-input').setInputFiles([firstBatchFile, secondBatchFile])
  if ((await window.locator('.batch-queue-row').count()) !== 2) throw new Error('Files were not staged before import')
  if ((await window.evaluate(() => window.worklens.getSnapshot())).sources.length !== 0) {
    throw new Error('Selecting files wrote to the database before confirmation')
  }
  await window.getByRole('button', { name: '开始处理 2 项' }).click()
  await window.getByText('2026-08-20', { exact: true }).waitFor({ state: 'visible' })
  await window.getByText('2026-08-22', { exact: true }).waitFor({ state: 'visible' })
  const firstRow = window.locator('.batch-source-row').filter({ hasText: '打包应用批量导入验证' })
  await firstRow.locator('input[type="date"]').fill('2026-08-19')
  await window.getByText('2026-08-19', { exact: true }).waitFor({ state: 'visible' })
  await window.getByRole('button', { name: '再导入一批' }).click()
  await window.locator('.batch-file-input').setInputFiles(firstBatchFile)
  await window.getByRole('button', { name: '开始处理 1 项' }).click()
  await window.getByText('1 份重复资料已跳过').waitFor({ state: 'visible' })
  await window.getByRole('button', { name: '再导入一批' }).click()
  await window.evaluate(() => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '2026年8月23日完成打包应用粘贴验证。')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  if ((await window.evaluate(() => window.worklens.getSnapshot())).sources.length !== 2) {
    throw new Error('Pasting wrote to the database before confirmation')
  }
  await window.getByRole('button', { name: '加入待导入' }).click()
  await window.getByRole('button', { name: '开始处理 1 项' }).click()
  await window.getByText('2026-08-23', { exact: true }).waitFor({ state: 'visible' })
  const batchSnapshot = await window.evaluate(() => window.worklens.getSnapshot())
  if (batchSnapshot.sources.length !== 3) throw new Error('Packaged batch import or paste created unexpected records')
  if (!batchSnapshot.sources.some((source) => source.businessDate === '2026-08-19' && source.dateOrigin === 'manual')) {
    throw new Error('Packaged batch date correction did not persist')
  }
  console.log(
    `PACKAGED_SMOKE_OK electron=${versions.electron} node=${versions.node} aiHost=ready batch=ready`
  )
} finally {
  await electronApp.close()
  await new Promise((resolvePromise, rejectPromise) =>
    stubServer.close((error) => (error ? rejectPromise(error) : resolvePromise()))
  )
  rmSync(userData, { recursive: true, force: true })
}
