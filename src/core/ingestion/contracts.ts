import type { SourceKind } from '@shared/contracts'
import type { BlockRecord } from '@core/storage/database'

export interface ParsedFile {
  kind: SourceKind
  mimeType: string
  text: string
  blocks: BlockRecord[]
  width: number | null
  height: number | null
}

export interface ParserRuntime {
  parse(
    filePath: string,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<ParsedFile>
}

export interface ParserHostRequest {
  id: string
  filePath: string
  derivedRoot: string
  cacheRoot: string
}

export type ParserHostResponse =
  | { id: string; type: 'progress'; message: string }
  | { id: string; type: 'result'; result: ParsedFile }
  | { id: string; type: 'error'; error: string }
