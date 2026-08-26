import type { ParserHostRequest, ParserHostResponse } from '@core/ingestion/contracts'
import { LocalParserEngine } from '@core/ingestion/parser-engine'

const hostPort = process.parentPort
if (!hostPort) throw new Error('Parser Host 必须由 Electron utilityProcess 启动')

hostPort.on('message', (event) => {
  void handleRequest(event.data as ParserHostRequest)
})

async function handleRequest(request: ParserHostRequest): Promise<void> {
  try {
    const engine = new LocalParserEngine(request.derivedRoot, request.cacheRoot)
    const result = await engine.parse(request.filePath, (message) =>
      post({ id: request.id, type: 'progress', message })
    )
    post({ id: request.id, type: 'result', result })
  } catch (error) {
    post({
      id: request.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function post(response: ParserHostResponse): void {
  hostPort.postMessage(response)
  if (response.type !== 'progress') setTimeout(() => process.exit(0), 20)
}
