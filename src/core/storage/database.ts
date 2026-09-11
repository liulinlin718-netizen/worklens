import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import type {
  AiProposal,
  AnalysisResult,
  AppSnapshot,
  Asset,
  DailyBrief,
  DashboardData,
  DateOrigin,
  DatePrecision,
  EvidenceLink,
  KnowledgeContextItem,
  ProcessingStatus,
  ProviderSettings,
  Requirement,
  RequirementPriority,
  RequirementStatus,
  SearchHit,
  SourceItem,
  SourceKind,
  Summary,
  UpdateDailyBriefInput,
  WorkEvent,
  WorkItem
} from '@shared/contracts'
import {
  clampConfidence,
  deriveWorkItemKey,
  excerpt,
  newId,
  normalizeEntityKey,
  normalizeRequirementPriority,
  normalizeRequirementStatus,
  nowIso
} from '@core/domain'

type Row = Record<string, unknown>

const INTERRUPTED_JOB_MESSAGE = '上次整理因应用退出而中断，可重新整理'
const INTERRUPTED_JOB_ERROR = '任务在完成前被中断'
const LEGACY_CURSOR_PROVIDER_MESSAGE =
  'Cursor API 已移除，请连接本机 Cursor、Codex 或外部 API'

export interface CreateSourceRecord {
  title: string
  kind: SourceKind
  rawText: string
  businessDate: string | null
  datePrecision: DatePrecision
  dateOrigin: DateOrigin
  contentHash: string
  status?: ProcessingStatus
}

export interface CreateAssetRecord {
  sourceItemId: string
  originalName: string
  mimeType: string
  byteSize: number
  localPath: string
  width: number | null
  height: number | null
  extractedText: string
  contentHash: string
}

export interface BlockRecord {
  blockIndex: number
  blockType: string
  text: string
  pageNumber: number | null
  startOffset: number | null
  endOffset: number | null
  confidence: number | null
}

export interface ProposalRecord {
  kind: AiProposal['kind']
  action?: AiProposal['action']
  payload: Record<string, unknown>
  confidence: number
  rationale: string
  provider: string
  model: string
}

export interface AssetPathRecord {
  sourceItemId: string
  originalName: string
  localPath: string
}

export interface AssetLocationRecord extends AssetPathRecord {
  id: string
  mimeType: string
}

export interface DeleteSourceRecord {
  title: string
  assetPaths: string[]
  affectedWorkDates: string[]
}

export interface DeleteWorkContentRecord {
  title: string
  deletedCount: number
}

export class WorkLensDatabase {
  private readonly db: DatabaseSync

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        raw_text TEXT NOT NULL DEFAULT '',
        business_date TEXT,
        date_precision TEXT NOT NULL DEFAULT 'unknown',
        date_origin TEXT NOT NULL DEFAULT 'inferred',
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        content_hash TEXT NOT NULL,
        manual_locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_date ON source_items(business_date DESC);
      CREATE INDEX IF NOT EXISTS idx_sources_hash ON source_items(content_hash);
      CREATE INDEX IF NOT EXISTS idx_sources_status ON source_items(status);

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        local_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        extracted_text TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source_item_id);

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        text TEXT NOT NULL,
        page_number INTEGER,
        start_offset INTEGER,
        end_offset INTEGER,
        confidence REAL,
        created_at TEXT NOT NULL,
        UNIQUE(source_item_id, block_index)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_source ON blocks(source_item_id, block_index);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        entity_key TEXT NOT NULL,
        title TEXT NOT NULL,
        work_item_key TEXT NOT NULL DEFAULT '',
        work_item_title TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL,
        event_date TEXT,
        date_precision TEXT NOT NULL DEFAULT 'unknown',
        summary TEXT NOT NULL,
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        confidence REAL NOT NULL DEFAULT 0,
        manual_locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date DESC);
      CREATE INDEX IF NOT EXISTS idx_events_key ON events(entity_key);

      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        entity_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'medium',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        confidence REAL NOT NULL DEFAULT 0,
        manual_locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
      CREATE INDEX IF NOT EXISTS idx_requirements_key ON requirements(entity_key);

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        highlights_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope_type, scope_id, version DESC);

      CREATE TABLE IF NOT EXISTS daily_briefs (
        id TEXT PRIMARY KEY,
        work_date TEXT NOT NULL UNIQUE,
        standup_date TEXT NOT NULL,
        title TEXT NOT NULL,
        overview TEXT NOT NULL,
        script TEXT NOT NULL,
        completed_json TEXT NOT NULL DEFAULT '[]',
        in_progress_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        next_steps_json TEXT NOT NULL DEFAULT '[]',
        images_json TEXT NOT NULL DEFAULT '[]',
        source_item_ids_json TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_briefs_date ON daily_briefs(work_date DESC);

      CREATE TABLE IF NOT EXISTS evidence_links (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        block_index INTEGER,
        start_offset INTEGER,
        end_offset INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_target ON evidence_links(target_type, target_id);

      CREATE TABLE IF NOT EXISTS entity_relations (
        id TEXT PRIMARY KEY,
        from_type TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        UNIQUE(from_type, from_id, to_type, to_id, relation_type)
      );
      CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_type, from_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_type, to_id);

      CREATE TABLE IF NOT EXISTS ai_proposals (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON ai_proposals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_proposals_source ON ai_proposals(source_item_id);

      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_type, entity_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_item_id TEXT REFERENCES source_items(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_runs (
        id TEXT PRIMARY KEY,
        source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        external_run_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));

      UPDATE ai_proposals
      SET status = 'rejected', reviewed_at = COALESCE(reviewed_at, datetime('now'))
      WHERE status = 'pending';
      UPDATE source_items SET status = 'ready' WHERE status = 'review';
    `)

    const dailyBriefColumns = this.db.prepare('PRAGMA table_info(daily_briefs)').all() as Row[]
    if (!dailyBriefColumns.some((column) => String(column.name) === 'images_json')) {
      this.db.exec("ALTER TABLE daily_briefs ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'")
    }
    this.db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'))")

    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all() as Row[]
    if (!eventColumns.some((column) => String(column.name) === 'work_item_key')) {
      this.db.exec("ALTER TABLE events ADD COLUMN work_item_key TEXT NOT NULL DEFAULT ''")
    }
    if (!eventColumns.some((column) => String(column.name) === 'work_item_title')) {
      this.db.exec("ALTER TABLE events ADD COLUMN work_item_title TEXT NOT NULL DEFAULT ''")
    }
    this.db.exec(`
      UPDATE events SET work_item_key = entity_key WHERE work_item_key = '';
      UPDATE events SET work_item_title = title WHERE work_item_title = '';
      CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_key, event_date DESC);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));
    `)

    this.migrateLegacyCursorProviderSettings()

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
          entity_type UNINDEXED,
          entity_id UNINDEXED,
          title,
          body,
          tokenize = 'trigram'
        );
      `)
    } catch {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
          entity_type UNINDEXED,
          entity_id UNINDEXED,
          title,
          body,
          tokenize = 'unicode61'
        );
      `)
    }

    this.recoverInterruptedWork()
  }

  private migrateLegacyCursorProviderSettings(): void {
    const applied = this.db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = 5')
      .get()
    if (applied) return

    this.transaction(() => {
      const stored = this.getSetting('provider')
      const value = stored ? parseRecord(stored) : {}
      if (value.kind === 'cursor') {
        this.setSetting('provider', {
          kind: 'cursor_cli',
          model: 'auto',
          baseUrl: '',
          sendImages: value.sendImages === true,
          autoAnalyze: value.autoAnalyze !== false,
          connected: false,
          connectedAt: null,
          connectionMessage: LEGACY_CURSOR_PROVIDER_MESSAGE
        })
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'))"
        )
        .run()
    })
  }

  private recoverInterruptedWork(): void {
    const time = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // No analysis worker survives an application restart. Keeping existing
      // synthesized data while returning the source to ready makes an
      // interrupted source immediately retryable instead of leaving it stuck
      // as "processing" forever. This also covers secondary sources included
      // in a multi-source synthesis because jobs only store the primary source.
      this.db
        .prepare("UPDATE source_items SET status = 'ready', error = NULL, updated_at = ? WHERE status = 'processing'")
        .run(time)
      this.db
        .prepare(`
          UPDATE jobs
          SET status = 'failed', message = ?, error = ?, updated_at = ?
          WHERE status = 'running'
        `)
        .run(INTERRUPTED_JOB_MESSAGE, INTERRUPTED_JOB_ERROR, time)
      this.db
        .prepare(`
          UPDATE ai_runs
          SET status = 'error', error = ?, finished_at = ?
          WHERE status = 'running'
        `)
        .run(INTERRUPTED_JOB_ERROR, time)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(FULL)')
  }

  createSource(input: CreateSourceRecord): SourceItem {
    const existing = this.db
      .prepare('SELECT id FROM source_items WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(input.contentHash) as Row | undefined
    if (existing) return this.getSource(String(existing.id))

    const id = newId()
    const createdAt = nowIso()
    this.db
      .prepare(`
        INSERT INTO source_items(
          id, title, kind, raw_text, business_date, date_precision, date_origin,
          status, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.kind,
        input.rawText,
        input.businessDate,
        input.datePrecision,
        input.dateOrigin,
        input.status ?? 'queued',
        input.contentHash,
        createdAt,
        createdAt
      )
    this.upsertSearch('source', id, input.title, input.rawText)
    return this.getSource(id)
  }

  getSource(id: string): SourceItem {
    const row = this.db
      .prepare(`
        SELECT s.*, COUNT(a.id) AS asset_count
        FROM source_items s
        LEFT JOIN assets a ON a.source_item_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `)
      .get(id) as Row | undefined
    if (!row) throw new Error('记录不存在')
    return this.withSourceWorkDates(mapSource(row))
  }

  findSourceByContentHash(contentHash: string): SourceItem | null {
    const row = this.db
      .prepare(`
        SELECT s.*, COUNT(a.id) AS asset_count
        FROM source_items s
        LEFT JOIN assets a ON a.source_item_id = s.id
        WHERE s.content_hash = ?
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 1
      `)
      .get(contentHash) as Row | undefined
    return row ? this.withSourceWorkDates(mapSource(row)) : null
  }

  getSourceText(id: string): string {
    const row = this.db.prepare('SELECT raw_text FROM source_items WHERE id = ?').get(id) as
      | Row
      | undefined
    if (!row) throw new Error('记录不存在')
    return String(row.raw_text ?? '')
  }

  listSources(): SourceItem[] {
    return (
      this.db
        .prepare(`
          SELECT s.*, COUNT(a.id) AS asset_count
          FROM source_items s
          LEFT JOIN assets a ON a.source_item_id = s.id
          GROUP BY s.id
          ORDER BY COALESCE(s.business_date, substr(s.created_at, 1, 10)) DESC, s.created_at DESC
        `)
        .all() as Row[]
    ).map(mapSource).map((source) => this.withSourceWorkDates(source))
  }

  listSourcesForDate(workDate: string): SourceItem[] {
    return (
      this.db
        .prepare(`
          SELECT s.*, COUNT(a.id) AS asset_count
          FROM source_items s
          LEFT JOIN assets a ON a.source_item_id = s.id
          WHERE s.business_date = ?
             OR s.id IN (
               SELECT e.source_item_id FROM events e WHERE e.event_date = ?
               UNION
               SELECT l.source_item_id
               FROM evidence_links l
               JOIN events e ON l.target_type = 'event' AND l.target_id = e.id
               WHERE e.event_date = ?
             )
          GROUP BY s.id
          ORDER BY s.created_at ASC, s.rowid ASC
        `)
        .all(workDate, workDate, workDate) as Row[]
    ).map(mapSource).map((source) => this.withSourceWorkDates(source))
  }

  private withSourceWorkDates(source: SourceItem): SourceItem {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT e.event_date AS work_date
        FROM events e
        LEFT JOIN evidence_links l
          ON l.target_type = 'event' AND l.target_id = e.id
        WHERE e.event_date IS NOT NULL
          AND (e.source_item_id = ? OR l.source_item_id = ?)
        ORDER BY e.event_date
      `)
      .all(source.id, source.id) as Row[]
    return {
      ...source,
      workDates: rows.map((row) => String(row.work_date)).filter(Boolean)
    }
  }

  setSourceStatus(id: string, status: ProcessingStatus, error: string | null = null): void {
    this.db
      .prepare('UPDATE source_items SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, nowIso(), id)
  }

  updateSourceDate(
    id: string,
    businessDate: string | null,
    precision: DatePrecision,
    origin: DateOrigin
  ): void {
    const current = this.db
      .prepare('SELECT manual_locked FROM source_items WHERE id = ?')
      .get(id) as Row | undefined
    if (!current || Number(current.manual_locked) === 1) return
    this.db
      .prepare(`
        UPDATE source_items
        SET business_date = ?, date_precision = ?, date_origin = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(businessDate, precision, origin, nowIso(), id)
  }

  setSourceDateManually(id: string, businessDate: string): SourceItem {
    const result = this.db
      .prepare(`
        UPDATE source_items
        SET business_date = ?, date_precision = 'day', date_origin = 'manual',
            manual_locked = 1, status = 'queued', error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(businessDate, nowIso(), id)
    if (!result.changes) throw new Error('记录不存在')
    return this.getSource(id)
  }

  refreshImportedSource(id: string, input: CreateSourceRecord): SourceItem {
    const result = this.db
      .prepare(`
        UPDATE source_items
        SET title = ?, kind = ?, raw_text = ?, business_date = ?, date_precision = ?,
            date_origin = ?, status = 'queued', error = NULL, manual_locked = 0, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.title,
        input.kind,
        input.rawText,
        input.businessDate,
        input.datePrecision,
        input.dateOrigin,
        nowIso(),
        id
      )
    if (!result.changes) throw new Error('记录不存在')
    this.upsertSearch('source', id, input.title, input.rawText)
    return this.getSource(id)
  }

  addAsset(input: CreateAssetRecord): Asset {
    const id = newId()
    const createdAt = nowIso()
    this.db
      .prepare(`
        INSERT INTO assets(
          id, source_item_id, original_name, mime_type, byte_size, local_path,
          width, height, extracted_text, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.sourceItemId,
        input.originalName,
        input.mimeType,
        input.byteSize,
        input.localPath,
        input.width,
        input.height,
        input.extractedText,
        input.contentHash,
        createdAt
      )
    return {
      id,
      sourceItemId: input.sourceItemId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      width: input.width,
      height: input.height,
      extractedText: input.extractedText,
      createdAt
    }
  }

  refreshAssetExtraction(
    sourceItemId: string,
    input: Pick<CreateAssetRecord, 'mimeType' | 'width' | 'height' | 'extractedText'>
  ): void {
    this.db
      .prepare(`
        UPDATE assets
        SET mime_type = ?, width = ?, height = ?, extracted_text = ?
        WHERE source_item_id = ?
      `)
      .run(input.mimeType, input.width, input.height, input.extractedText, sourceItemId)
  }

  replaceBlocks(sourceItemId: string, blocks: BlockRecord[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM blocks WHERE source_item_id = ?').run(sourceItemId)
      const statement = this.db.prepare(`
        INSERT INTO blocks(
          id, source_item_id, block_index, block_type, text, page_number,
          start_offset, end_offset, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const block of blocks) {
        statement.run(
          newId(),
          sourceItemId,
          block.blockIndex,
          block.blockType,
          block.text,
          block.pageNumber,
          block.startOffset,
          block.endOffset,
          block.confidence,
          nowIso()
        )
      }
    })
  }

  listAssets(): AssetPathRecord[] {
    return (this.db
      .prepare('SELECT source_item_id, original_name, local_path FROM assets ORDER BY created_at')
      .all() as Row[]).map((row) => ({
      sourceItemId: String(row.source_item_id),
      originalName: String(row.original_name),
      localPath: String(row.local_path)
    }))
  }

  listSourceAssets(sourceItemId: string): Asset[] {
    return (this.db
      .prepare(`
        SELECT id, source_item_id, original_name, mime_type, byte_size, width, height, extracted_text, created_at
        FROM assets
        WHERE source_item_id = ?
        ORDER BY created_at
      `)
      .all(sourceItemId) as Row[]).map(mapAsset)
  }

  getAssetLocation(assetId: string): AssetLocationRecord {
    const row = this.db
      .prepare(`
        SELECT id, source_item_id, original_name, mime_type, local_path
        FROM assets
        WHERE id = ?
      `)
      .get(assetId) as Row | undefined
    if (!row) throw new Error('附件不存在')
    return {
      id: String(row.id),
      sourceItemId: String(row.source_item_id),
      originalName: String(row.original_name),
      mimeType: String(row.mime_type),
      localPath: String(row.local_path)
    }
  }

  getPrimaryAssetPath(sourceItemId: string): AssetPathRecord | null {
    const row = this.db
      .prepare(`
        SELECT source_item_id, original_name, local_path
        FROM assets
        WHERE source_item_id = ?
        ORDER BY created_at
        LIMIT 1
      `)
      .get(sourceItemId) as Row | undefined
    return row
      ? {
          sourceItemId: String(row.source_item_id),
          originalName: String(row.original_name),
          localPath: String(row.local_path)
        }
      : null
  }

  deleteSource(sourceItemId: string): DeleteSourceRecord {
    const source = this.getSource(sourceItemId)
    const assetPaths = (this.db
      .prepare('SELECT local_path FROM assets WHERE source_item_id = ?')
      .all(sourceItemId) as Row[]).map((row) => String(row.local_path))
    const affectedWorkDates = new Set(source.workDates)
    if (source.businessDate) affectedWorkDates.add(source.businessDate)
    this.transaction(() => {
      this.removeGeneratedEventContributions([sourceItemId], affectedWorkDates)
      const briefs = this.db.prepare('SELECT id, work_date, source_item_ids_json FROM daily_briefs').all() as Row[]
      for (const brief of briefs) {
        const sourceIds = parseStringArray(String(brief.source_item_ids_json))
        if (!sourceIds.includes(sourceItemId)) continue
        const id = String(brief.id)
        affectedWorkDates.add(String(brief.work_date))
        this.db.prepare("DELETE FROM search_index WHERE entity_type = 'brief' AND entity_id = ?").run(id)
        this.db.prepare('DELETE FROM daily_briefs WHERE id = ?').run(id)
      }
      const requirements = this.db
        .prepare('SELECT id FROM requirements WHERE source_item_id = ?')
        .all(sourceItemId) as Row[]
      for (const requirement of requirements) {
        const id = String(requirement.id)
        this.db.prepare("DELETE FROM evidence_links WHERE target_type = 'requirement' AND target_id = ?").run(id)
        this.db.prepare("DELETE FROM entity_relations WHERE (from_type = 'requirement' AND from_id = ?) OR (to_type = 'requirement' AND to_id = ?)").run(id, id)
        this.db.prepare("DELETE FROM search_index WHERE entity_type = 'requirement' AND entity_id = ?").run(id)
      }
      this.db.prepare('DELETE FROM requirements WHERE source_item_id = ?').run(sourceItemId)
      const summaries = this.db.prepare('SELECT id FROM summaries WHERE source_item_id = ?').all(sourceItemId) as Row[]
      for (const summary of summaries) {
        const id = String(summary.id)
        this.db.prepare("DELETE FROM evidence_links WHERE target_type = 'summary' AND target_id = ?").run(id)
        this.db.prepare("DELETE FROM search_index WHERE entity_type = 'summary' AND entity_id = ?").run(id)
      }
      this.db.prepare('DELETE FROM summaries WHERE source_item_id = ?').run(sourceItemId)
      this.db.prepare('DELETE FROM revisions WHERE entity_id = ?').run(sourceItemId)
      this.db.prepare("DELETE FROM search_index WHERE entity_type = 'source' AND entity_id = ?").run(sourceItemId)
      this.db.prepare('DELETE FROM source_items WHERE id = ?').run(sourceItemId)
    })
    return { title: source.title, assetPaths, affectedWorkDates: Array.from(affectedWorkDates).sort() }
  }

  deleteWorkEvent(eventId: string): DeleteWorkContentRecord {
    const row = this.db
      .prepare('SELECT id, title FROM events WHERE id = ?')
      .get(eventId) as Row | undefined
    if (!row) throw new Error('这条工作内容不存在或已被删除')
    this.transaction(() => this.deleteEventRow(eventId))
    return { title: String(row.title), deletedCount: 1 }
  }

  deleteWorkItem(workItemKey: string): DeleteWorkContentRecord {
    const rows = this.db
      .prepare(`
        SELECT id, COALESCE(NULLIF(work_item_title, ''), title) AS title
        FROM events
        WHERE work_item_key = ?
        ORDER BY COALESCE(event_date, created_at) DESC, updated_at DESC
      `)
      .all(workItemKey) as Row[]
    if (!rows.length) throw new Error('这个工作事项不存在或已被删除')
    this.transaction(() => {
      for (const row of rows) this.deleteEventRow(String(row.id))
    })
    return { title: String(rows[0]!.title), deletedCount: rows.length }
  }

  listEvents(): WorkEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY event_date DESC, rowid ASC').all() as Row[]
    return rows.map((row) =>
      mapEvent(
        row,
        this.listEvidence('event', String(row.id)),
        this.listRelatedIds('event', String(row.id), 'requirement')
      )
    )
  }

  listWorkItems(events: readonly WorkEvent[] = this.listEvents()): WorkItem[] {
    const groups = new Map<string, WorkEvent[]>()
    for (const event of events) {
      const key = event.workItemKey || deriveWorkItemKey(event.workItemTitle || event.title)
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    return Array.from(groups, ([key, events]) => {
      const ordered = [...events].sort((a, b) =>
        (b.eventDate ?? b.updatedAt).localeCompare(a.eventDate ?? a.updatedAt) ||
        b.updatedAt.localeCompare(a.updatedAt)
      )
      const latest = ordered[0]!
      const dated = ordered.map((event) => event.eventDate).filter((date): date is string => Boolean(date)).sort()
      const evidence = Array.from(
        new Map(ordered.flatMap((event) => event.evidence).map((item) => [`${item.sourceItemId}:${item.quote}`, item])).values()
      )
      return {
        id: key,
        key,
        title: selectStableWorkItemTitle(ordered),
        eventType: latest.eventType,
        firstDate: dated[0] ?? null,
        latestDate: dated.at(-1) ?? null,
        summary: latest.summary,
        confidence: Math.max(...ordered.map((event) => event.confidence)),
        evidence,
        sourceItemIds: Array.from(new Set(evidence.map((item) => item.sourceItemId))),
        eventIds: ordered.map((event) => event.id),
        eventCount: ordered.length,
        updatedAt: ordered.map((event) => event.updatedAt).sort().at(-1) ?? latest.updatedAt
      }
    }).sort((a, b) => (b.latestDate ?? b.updatedAt).localeCompare(a.latestDate ?? a.updatedAt))
  }

  listRequirements(): Requirement[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM requirements
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 updated_at DESC
      `)
      .all() as Row[]
    return rows.map((row) =>
      mapRequirement(
        row,
        this.listEvidence('requirement', String(row.id)),
        this.listRelatedIds('requirement', String(row.id), 'event')
      )
    )
  }

  listSummaries(): Summary[] {
    return (this.db
      .prepare('SELECT * FROM summaries ORDER BY created_at DESC LIMIT 200')
      .all() as Row[]).map(mapSummary)
  }

  listDailyBriefs(): DailyBrief[] {
    return (this.db
      .prepare('SELECT * FROM daily_briefs ORDER BY work_date DESC LIMIT 365')
      .all() as Row[]).map(mapDailyBrief)
  }

  getDailyBrief(workDate: string): DailyBrief | null {
    const row = this.db
      .prepare('SELECT * FROM daily_briefs WHERE work_date = ?')
      .get(workDate) as Row | undefined
    return row ? mapDailyBrief(row) : null
  }

  updateDailyBrief(input: UpdateDailyBriefInput): DailyBrief {
    const row = this.db
      .prepare('SELECT * FROM daily_briefs WHERE id = ?')
      .get(input.briefId) as Row | undefined
    if (!row) throw new Error('找不到要修改的逐字稿')
    const before = mapDailyBrief(row)
    const updatedAt = nowIso()
    this.transaction(() => {
      this.db
        .prepare('UPDATE daily_briefs SET script = ?, images_json = ?, updated_at = ? WHERE id = ?')
        .run(input.script, JSON.stringify(input.images), updatedAt, input.briefId)
      this.addRevision('brief', input.briefId, 'user', before, { ...before, script: input.script, images: input.images, updatedAt })
      this.upsertSearch('brief', input.briefId, before.title, [before.overview, input.script, ...before.completed, ...before.inProgress, ...before.nextSteps].join('\n'))
    })
    return this.getDailyBrief(before.workDate)!
  }

  saveDailySynthesis(
    sourceItemIds: string[],
    result: AnalysisResult,
    provider: string,
    model: string,
    workDate: string
  ): DailyBrief | null {
    const uniqueSourceIds = Array.from(new Set(sourceItemIds))
    if (!uniqueSourceIds.length) throw new Error('日报至少需要一条原始资料')
    const primarySourceId = uniqueSourceIds[0]!
    const savedBriefDates: string[] = []
    const sourcePlaceholders = uniqueSourceIds.map(() => '?').join(', ')
    const requestedDateIsExplicit = Number((this.db
      .prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${sourcePlaceholders}) AND business_date = ?`)
      .get(...uniqueSourceIds, workDate) as Row).count) > 0

    this.transaction(() => {
      this.removeGeneratedEventContributions(uniqueSourceIds)
      const representativeEventsByDate = new Map<string, AnalysisResult['events'][number]>()
      for (const event of result.events) {
        if (event.eventDate && !representativeEventsByDate.has(event.eventDate)) {
          representativeEventsByDate.set(event.eventDate, event)
        }
        const payload: Record<string, unknown> = {
          ...event,
          eventDate: event.eventDate,
          datePrecision: event.eventDate ? event.datePrecision : 'unknown'
        }
        const eventId = this.createOrMergeEvent(primarySourceId, payload)
        if (Array.isArray(payload.evidence)) {
          for (const candidate of payload.evidence) {
            const evidenceSourceId = this.resolveEvidenceSourceId(uniqueSourceIds, candidate)
            this.addEvidenceCandidates(evidenceSourceId, 'event', eventId, [candidate])
          }
        }
      }
      // Merging normally preserves one event for every recognized date. Keep a
      // transactional postcondition as a safety net: a provider/local fallback
      // date must never disappear from the timeline because of an unexpected
      // merge collision with pre-existing work-item history.
      for (const [eventDate, event] of representativeEventsByDate) {
        if (this.hasSourceEventForDate(uniqueSourceIds, eventDate)) continue
        const payload: Record<string, unknown> = {
          ...event,
          eventDate,
          datePrecision: 'day'
        }
        const eventId = this.insertEventRow(primarySourceId, payload)
        if (Array.isArray(payload.evidence)) {
          for (const candidate of payload.evidence) {
            const evidenceSourceId = this.resolveEvidenceSourceId(uniqueSourceIds, candidate)
            this.addEvidenceCandidates(evidenceSourceId, 'event', eventId, [candidate])
          }
        }
      }
      const eventDates = Array.from(new Set(result.events.map((event) => event.eventDate).filter((date): date is string => Boolean(date)))).sort()
      const modelBriefs = new Map(result.dailyBriefs.map((brief) => [brief.workDate, brief]))
      const datedBriefs = eventDates.length
        ? eventDates.map((date) =>
            modelBriefs.get(date)
            ?? (eventDates.length === 1
              ? { workDate: date, ...result.standup }
              : fallbackStandupForEvents(date, result.events.filter((event) => event.eventDate === date)))
          )
        : requestedDateIsExplicit
          ? [{ workDate, ...result.standup }]
          : []
      for (const brief of datedBriefs) {
        this.saveDailyBriefRow(uniqueSourceIds, brief, provider, model)
        savedBriefDates.push(brief.workDate)
      }
      for (const sourceItemId of uniqueSourceIds) {
        this.setSourceStatus(sourceItemId, 'ready')
      }
    })
    const returnDate = savedBriefDates.includes(workDate) ? workDate : savedBriefDates[0]
    return returnDate ? this.getDailyBrief(returnDate) : null
  }

  private saveDailyBriefRow(
    sourceItemIds: string[],
    brief: AnalysisResult['dailyBriefs'][number],
    provider: string,
    model: string
  ): void {
    const existing = this.db
      .prepare('SELECT id, created_at FROM daily_briefs WHERE work_date = ?')
      .get(brief.workDate) as Row | undefined
    const id = existing ? String(existing.id) : newId()
    const createdAt = existing ? String(existing.created_at) : nowIso()
    const updatedAt = nowIso()
    this.db
      .prepare(`
        INSERT INTO daily_briefs(
          id, work_date, standup_date, title, overview, script,
          completed_json, in_progress_json, blockers_json, next_steps_json,
          source_item_ids_json, provider, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_date) DO UPDATE SET
          standup_date = excluded.standup_date,
          title = excluded.title,
          overview = excluded.overview,
          script = excluded.script,
          completed_json = excluded.completed_json,
          in_progress_json = excluded.in_progress_json,
          blockers_json = excluded.blockers_json,
          next_steps_json = excluded.next_steps_json,
          source_item_ids_json = excluded.source_item_ids_json,
          provider = excluded.provider,
          model = excluded.model,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        brief.workDate,
        nextWorkday(brief.workDate),
        brief.title,
        brief.overview,
        brief.script,
        JSON.stringify(brief.completed),
        JSON.stringify(brief.inProgress),
        JSON.stringify(brief.blockers),
        JSON.stringify(brief.nextSteps),
        JSON.stringify(sourceItemIds),
        provider,
        model,
        createdAt,
        updatedAt
      )
    this.upsertSearch(
      'brief',
      id,
      brief.title,
      [brief.overview, brief.script, ...brief.completed, ...brief.inProgress, ...brief.blockers, ...brief.nextSteps].join('\n')
    )
  }

  clearDailySynthesisForDate(workDate: string): void {
    this.transaction(() => {
      this.removeGeneratedEventsForDate(workDate)
      const row = this.db
        .prepare('SELECT id FROM daily_briefs WHERE work_date = ?')
        .get(workDate) as Row | undefined
      if (row) {
        this.db
          .prepare("DELETE FROM search_index WHERE entity_type = 'brief' AND entity_id = ?")
          .run(String(row.id))
        this.db.prepare('DELETE FROM daily_briefs WHERE id = ?').run(String(row.id))
      }
    })
  }

  listProposals(status: AiProposal['status'] | 'all' = 'pending'): AiProposal[] {
    const rows = (
      status === 'all'
        ? this.db.prepare('SELECT * FROM ai_proposals ORDER BY created_at DESC LIMIT 500').all()
        : this.db
            .prepare('SELECT * FROM ai_proposals WHERE status = ? ORDER BY created_at ASC LIMIT 500')
            .all(status)
    ) as Row[]
    return rows.map(mapProposal)
  }

  addProposals(sourceItemId: string, proposals: ProposalRecord[]): AiProposal[] {
    const statement = this.db.prepare(`
      INSERT INTO ai_proposals(
        id, source_item_id, kind, action, payload_json, confidence, rationale,
        status, provider, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `)
    const created: AiProposal[] = []
    this.transaction(() => {
      this.db
        .prepare("UPDATE ai_proposals SET status = 'rejected', reviewed_at = ? WHERE source_item_id = ? AND status = 'pending'")
        .run(nowIso(), sourceItemId)
      for (const proposal of proposals) {
        const id = newId()
        const createdAt = nowIso()
        statement.run(
          id,
          sourceItemId,
          proposal.kind,
          proposal.action ?? 'create',
          JSON.stringify(proposal.payload),
          clampConfidence(proposal.confidence),
          proposal.rationale,
          proposal.provider,
          proposal.model,
          createdAt
        )
        created.push({
          id,
          sourceItemId,
          kind: proposal.kind,
          action: proposal.action ?? 'create',
          payload: proposal.payload,
          confidence: clampConfidence(proposal.confidence),
          rationale: proposal.rationale,
          status: 'pending',
          provider: proposal.provider,
          model: proposal.model,
          createdAt,
          reviewedAt: null
        })
      }
      this.setSourceStatus(sourceItemId, proposals.length ? 'review' : 'ready')
    })
    return created
  }

  reviewProposal(
    proposalId: string,
    accepted: boolean,
    edits: Record<string, unknown> = {}
  ): void {
    this.transaction(() => {
      this.reviewProposalInTransaction(proposalId, accepted, edits)
    })
  }

  acceptAllPendingProposals(): number {
    const pending = this.listProposals('pending')
    if (!pending.length) return 0
    this.transaction(() => {
      for (const proposal of pending) {
        this.reviewProposalInTransaction(proposal.id, true)
      }
    })
    return pending.length
  }

  private reviewProposalInTransaction(
    proposalId: string,
    accepted: boolean,
    edits: Record<string, unknown> = {}
  ): void {
    const row = this.db.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(proposalId) as
      | Row
      | undefined
    if (!row) throw new Error('AI 建议不存在')
    if (String(row.status) !== 'pending') throw new Error('AI 建议已经处理')

    const sourceItemId = String(row.source_item_id)
    const before = parseRecord(String(row.payload_json))
    const payload = { ...before, ...edits }
    let targetId = sourceItemId

    if (accepted) {
      switch (String(row.kind)) {
        case 'source_metadata':
          this.updateSourceDate(
            sourceItemId,
            nullableString(payload.value),
            asDatePrecision(payload.precision),
            'inferred'
          )
          break
        case 'event':
          targetId = this.createOrMergeEvent(sourceItemId, payload)
          this.addEvidenceCandidates(sourceItemId, 'event', targetId, payload.evidence)
          this.linkEventToRequirements(targetId, sourceItemId)
          break
        case 'requirement':
          targetId = this.createOrMergeRequirement(sourceItemId, payload)
          this.addEvidenceCandidates(sourceItemId, 'requirement', targetId, payload.evidence)
          this.linkRequirementToEvents(targetId, sourceItemId)
          break
        case 'summary':
          targetId = this.createSummary(sourceItemId, payload)
          this.addEvidenceCandidates(sourceItemId, 'summary', targetId, payload.evidence)
          break
        default:
          throw new Error('不支持的 AI 建议类型')
      }
    }

    this.db
      .prepare('UPDATE ai_proposals SET status = ?, payload_json = ?, reviewed_at = ? WHERE id = ?')
      .run(accepted ? 'accepted' : 'rejected', JSON.stringify(payload), nowIso(), proposalId)
    this.addRevision(
      String(row.kind),
      targetId,
      'human_review',
      before,
      accepted ? payload : { rejected: true }
    )
    this.refreshSourceReviewStatus(sourceItemId)
  }

  updateRequirementStatus(id: string, status: RequirementStatus): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as Row | undefined
      if (!row) throw new Error('需求不存在')
      const before = mapRequirement(
        row,
        this.listEvidence('requirement', id),
        this.listRelatedIds('requirement', id, 'event')
      )
      this.db
        .prepare(`
          UPDATE requirements
          SET status = ?, manual_locked = 1, updated_at = ?
          WHERE id = ?
        `)
        .run(status, nowIso(), id)
      const afterRow = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as Row
      const after = mapRequirement(
        afterRow,
        this.listEvidence('requirement', id),
        this.listRelatedIds('requirement', id, 'event')
      )
      this.addRevision('requirement', id, 'human', before, after)
      this.upsertSearch('requirement', id, after.title, `${after.description}\n${after.acceptanceCriteria.join('\n')}`)
    })
  }

  search(query: string, entityTypes: string[] = []): SearchHit[] {
    const normalized = query.trim()
    if (!normalized) return []
    const filters = new Set(entityTypes.length ? entityTypes : ['source', 'event', 'brief'])
    let rows: Row[]

    if (Array.from(normalized).length < 3) {
      const like = `%${normalized.replace(/[%_]/g, '\\$&')}%`
      rows = this.db
        .prepare(`
          SELECT entity_type, entity_id, title, substr(body, 1, 220) AS result_excerpt, 0 AS rank
          FROM search_index
          WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
          LIMIT 50
        `)
        .all(like, like) as Row[]
    } else {
      const safeQuery = `"${normalized.replace(/"/g, '""')}"`
      try {
        rows = this.db
          .prepare(`
            SELECT entity_type, entity_id, title,
                   snippet(search_index, 3, '', '', ' … ', 24) AS result_excerpt,
                   bm25(search_index) AS rank
            FROM search_index
            WHERE search_index MATCH ?
            ORDER BY rank
            LIMIT 50
          `)
          .all(safeQuery) as Row[]
      } catch {
        rows = []
      }
    }

    return rows
      .filter((row) => filters.has(String(row.entity_type)))
      .map((row) => ({
        entityType: String(row.entity_type) as SearchHit['entityType'],
        entityId: String(row.entity_id),
        title: String(row.title),
        excerpt: String(row.result_excerpt ?? ''),
        date: this.getEntityDate(String(row.entity_type), String(row.entity_id)),
        rank: Number(row.rank ?? 0)
      }))
  }

  findKnowledgeContext(
    question: string,
    referenceDate: string,
    maxItems = 40
  ): KnowledgeContextItem[] {
    const terms = extractKnowledgeTerms(question)
    const dateRange = inferQuestionDateRange(question, referenceDate)
    const candidates: KnowledgeContextItem[] = []

    for (const source of this.listSources()) {
      const workDates = source.workDates.length
        ? source.workDates
        : source.businessDate
          ? [source.businessDate]
          : [null]
      for (const workDate of workDates) {
        candidates.push({
          refId: `source:${source.id}`,
          entityType: 'source',
          entityId: source.id,
          title: source.title,
          date: workDate,
          content: source.rawText
        })
      }
    }
    for (const brief of this.listDailyBriefs()) {
      candidates.push({
        refId: `brief:${brief.id}`,
        entityType: 'brief',
        entityId: brief.id,
        title: brief.title,
        date: brief.workDate,
        content: [
          brief.overview,
          `已完成：${brief.completed.join('；') || '无明确记录'}`,
          `进行中：${brief.inProgress.join('；') || '无明确记录'}`,
          `阻塞：${brief.blockers.join('；') || '无明确记录'}`,
          `下一步：${brief.nextSteps.join('；') || '无明确记录'}`,
          `早会稿：${brief.script}`
        ].join('\n')
      })
    }
    const eventRows = this.db
      .prepare(`
        SELECT id, title, event_type, event_date, summary, created_at
        FROM events
        ORDER BY COALESCE(event_date, substr(created_at, 1, 10)) DESC, created_at DESC
        LIMIT 2000
      `)
      .all() as Row[]
    for (const row of eventRows) {
      const id = String(row.id)
      candidates.push({
        refId: `event:${id}`,
        entityType: 'event',
        entityId: id,
        title: String(row.title),
        date: row.event_date ? String(row.event_date).slice(0, 10) : null,
        content: `${String(row.event_type)}：${String(row.summary)}`
      })
    }

    const scored = candidates
      .map((item) => ({ item, score: scoreKnowledgeItem(item, terms, dateRange) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score || (b.item.date ?? '').localeCompare(a.item.date ?? ''))

    const selected = scored.length
      ? scored
      : dateRange
        ? []
        : candidates
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
          .slice(0, Math.min(maxItems, 16))
          .map((item) => ({ item, score: 0 }))
    const result: KnowledgeContextItem[] = []
    const includedRefIds = new Set<string>()
    let totalCharacters = 0
    for (const { item } of selected) {
      if (result.length >= maxItems || totalCharacters >= 72_000) break
      if (includedRefIds.has(item.refId)) continue
      const perItemLimit = item.entityType === 'source' ? 7_000 : item.entityType === 'brief' ? 4_500 : 2_000
      const content = clipKnowledgeContent(item.content, terms, perItemLimit)
      if (!content.trim()) continue
      if (totalCharacters + content.length > 72_000 && result.length) continue
      result.push({ ...item, content })
      includedRefIds.add(item.refId)
      totalCharacters += content.length
    }
    return result
  }

  getSnapshot(): AppSnapshot {
    const sources = this.listSources()
    const events = this.listEvents()
    const workItems = this.listWorkItems(events)
    const dailyBriefs = this.listDailyBriefs()
    return {
      sources,
      events,
      workItems,
      dailyBriefs,
      dashboard: buildDashboard(sources, events, dailyBriefs)
    }
  }

  getProviderSettings(): ProviderSettings {
    const stored = this.getSetting('provider')
    const value = stored ? parseRecord(stored) : {}
    const legacyCursorProvider = value.kind === 'cursor'
    const kind: ProviderSettings['kind'] =
      value.kind === 'openai_compatible' ||
      value.kind === 'cursor_cli' ||
      value.kind === 'codex_cli'
        ? value.kind
        : 'cursor_cli'
    const supportedProvider =
      value.kind === 'openai_compatible' ||
      value.kind === 'cursor_cli' ||
      value.kind === 'codex_cli'
    return {
      kind,
      model:
        !legacyCursorProvider && typeof value.model === 'string' && value.model
          ? value.model
          : kind === 'cursor_cli' || kind === 'codex_cli'
            ? 'auto'
            : '',
      baseUrl:
        !legacyCursorProvider && typeof value.baseUrl === 'string' ? value.baseUrl : '',
      hasApiKey: false,
      sendImages: value.sendImages === true,
      autoAnalyze: value.autoAnalyze !== false,
      connected: supportedProvider && value.connected === true,
      connectedAt:
        supportedProvider && typeof value.connectedAt === 'string' ? value.connectedAt : null,
      connectionMessage:
        legacyCursorProvider
          ? LEGACY_CURSOR_PROVIDER_MESSAGE
          : typeof value.connectionMessage === 'string' && value.connectionMessage
            ? value.connectionMessage
            : '未连接 AI'
    }
  }

  saveProviderSettings(
    settings: Omit<ProviderSettings, 'hasApiKey' | 'connected' | 'connectedAt' | 'connectionMessage'> &
      Partial<Pick<ProviderSettings, 'connected' | 'connectedAt' | 'connectionMessage'>>
  ): void {
    const current = this.getProviderSettings()
    const sameProvider = current.kind === settings.kind
    this.setSetting('provider', {
      ...settings,
      connected: settings.connected ?? (sameProvider ? current.connected : false),
      connectedAt: settings.connectedAt === undefined
        ? (sameProvider ? current.connectedAt : null)
        : settings.connectedAt,
      connectionMessage: settings.connectionMessage === undefined
        ? (sameProvider ? current.connectionMessage : '未连接 AI')
        : settings.connectionMessage
    })
  }

  createJob(sourceItemId: string, jobType: string, message: string): string {
    const id = newId()
    const time = nowIso()
    this.db
      .prepare(`
        INSERT INTO jobs(id, source_item_id, job_type, status, progress, message, created_at, updated_at)
        VALUES (?, ?, ?, 'running', 0, ?, ?, ?)
      `)
      .run(id, sourceItemId, jobType, message, time, time)
    return id
  }

  updateJob(
    id: string,
    status: 'running' | 'finished' | 'failed',
    progress: number,
    message: string,
    error: string | null = null
  ): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, progress = ?, message = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, Math.min(1, Math.max(0, progress)), message, error, nowIso(), id)
  }

  createAiRun(sourceItemId: string, provider: string, model: string): string {
    const id = newId()
    this.db
      .prepare(`
        INSERT INTO ai_runs(id, source_item_id, provider, model, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `)
      .run(id, sourceItemId, provider, model, nowIso())
    return id
  }

  finishAiRun(id: string, status: 'finished' | 'error', error: string | null = null): void {
    this.db
      .prepare('UPDATE ai_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, error, nowIso(), id)
  }

  private createOrMergeEvent(sourceItemId: string, payload: Record<string, unknown>): string {
    const title = String(payload.title ?? '').trim()
    if (!title) throw new Error('事件标题不能为空')
    const key = normalizeEntityKey(title)
    const workItemTitle = String(payload.workItemTitle ?? '').trim() || title
    const workItemKey = normalizeEntityKey(String(payload.workItemKey ?? '')) || deriveWorkItemKey(workItemTitle)
    const eventDate = nullableString(payload.eventDate)
    const existing = this.db
      .prepare('SELECT * FROM events WHERE work_item_key = ? AND entity_key = ? AND COALESCE(event_date, ?) = COALESCE(?, ?) LIMIT 1')
      .get(workItemKey, key, eventDate ?? '', eventDate, eventDate ?? '') as Row | undefined
    const summary = String(payload.summary ?? '').trim()
    const time = nowIso()
    if (existing) {
      const id = String(existing.id)
      if (Number(existing.manual_locked) !== 1) {
        const mergedSummary =
          String(existing.summary).length >= summary.length ? String(existing.summary) : summary
        this.db
          .prepare(`
            UPDATE events
            SET title = ?, work_item_title = ?, event_type = ?, event_date = COALESCE(event_date, ?), date_precision = ?,
                summary = ?, confidence = MAX(confidence, ?), updated_at = ?
            WHERE id = ?
          `)
          .run(
            title,
            workItemTitle,
            String(payload.eventType ?? '其他'),
            eventDate,
            asDatePrecision(payload.datePrecision),
            mergedSummary,
            clampConfidence(payload.confidence),
            time,
            id
          )
      }
      this.upsertSearch('event', id, title, summary)
      return id
    }

    return this.insertEventRow(sourceItemId, payload)
  }

  private insertEventRow(sourceItemId: string, payload: Record<string, unknown>): string {
    const title = String(payload.title ?? '').trim()
    if (!title) throw new Error('事件标题不能为空')
    const key = normalizeEntityKey(title)
    const workItemTitle = String(payload.workItemTitle ?? '').trim() || title
    const workItemKey = normalizeEntityKey(String(payload.workItemKey ?? '')) || deriveWorkItemKey(workItemTitle)
    const eventDate = nullableString(payload.eventDate)
    const summary = String(payload.summary ?? '').trim()
    const time = nowIso()
    const id = newId()
    this.db
      .prepare(`
        INSERT INTO events(
          id, entity_key, title, work_item_key, work_item_title, event_type, event_date, date_precision, summary,
          source_item_id, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        key,
        title,
        workItemKey,
        workItemTitle,
        String(payload.eventType ?? '其他'),
        eventDate,
        asDatePrecision(payload.datePrecision),
        summary,
        sourceItemId,
        clampConfidence(payload.confidence),
        time,
        time
      )
    this.upsertSearch('event', id, title, summary)
    return id
  }

  private hasSourceEventForDate(sourceItemIds: string[], eventDate: string): boolean {
    if (!sourceItemIds.length) return false
    const placeholders = sourceItemIds.map(() => '?').join(', ')
    const row = this.db
      .prepare(`
        SELECT 1
        FROM events e
        LEFT JOIN evidence_links l
          ON l.target_type = 'event' AND l.target_id = e.id
        WHERE e.event_date = ?
          AND (e.source_item_id IN (${placeholders}) OR l.source_item_id IN (${placeholders}))
        LIMIT 1
      `)
      .get(eventDate, ...sourceItemIds, ...sourceItemIds) as Row | undefined
    return Boolean(row)
  }

  private removeGeneratedEventsForDate(workDate: string): void {
    const rows = this.db
      .prepare('SELECT id FROM events WHERE event_date = ? AND manual_locked = 0')
      .all(workDate) as Row[]
    for (const row of rows) {
      this.deleteEventRow(String(row.id))
    }
  }

  private removeGeneratedEventContributions(
    sourceItemIds: string[],
    affectedDates = new Set<string>()
  ): void {
    if (!sourceItemIds.length) return
    const placeholders = sourceItemIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`
        SELECT DISTINCT e.id, e.event_date, e.source_item_id
        FROM events e
        LEFT JOIN evidence_links l
          ON l.target_type = 'event' AND l.target_id = e.id
        WHERE e.source_item_id IN (${placeholders}) OR l.source_item_id IN (${placeholders})
      `)
      .all(...sourceItemIds, ...sourceItemIds) as Row[]
    this.db
      .prepare(`DELETE FROM evidence_links WHERE target_type = 'event' AND source_item_id IN (${placeholders})`)
      .run(...sourceItemIds)
    for (const row of rows) {
      const eventId = String(row.id)
      if (row.event_date) affectedDates.add(String(row.event_date))
      const remaining = this.db
        .prepare("SELECT source_item_id FROM evidence_links WHERE target_type = 'event' AND target_id = ? ORDER BY created_at LIMIT 1")
        .get(eventId) as Row | undefined
      if (!remaining) {
        this.deleteEventRow(eventId)
        continue
      }
      if (sourceItemIds.includes(String(row.source_item_id))) {
        this.db.prepare('UPDATE events SET source_item_id = ?, updated_at = ? WHERE id = ?')
          .run(String(remaining.source_item_id), nowIso(), eventId)
      }
    }
  }

  private deleteEventRow(eventId: string): void {
    this.db.prepare("DELETE FROM evidence_links WHERE target_type = 'event' AND target_id = ?").run(eventId)
    this.db
      .prepare("DELETE FROM entity_relations WHERE (from_type = 'event' AND from_id = ?) OR (to_type = 'event' AND to_id = ?)")
      .run(eventId, eventId)
    this.db.prepare("DELETE FROM search_index WHERE entity_type = 'event' AND entity_id = ?").run(eventId)
    this.db.prepare('DELETE FROM events WHERE id = ?').run(eventId)
  }

  private createOrMergeRequirement(sourceItemId: string, payload: Record<string, unknown>): string {
    const title = String(payload.title ?? '').trim()
    if (!title) throw new Error('需求标题不能为空')
    const key = normalizeEntityKey(title)
    const existing = this.db
      .prepare('SELECT * FROM requirements WHERE entity_key = ? LIMIT 1')
      .get(key) as Row | undefined
    const description = String(payload.description ?? '').trim()
    const criteria = Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.map(String).filter(Boolean).slice(0, 20)
      : []
    const time = nowIso()
    if (existing) {
      const id = String(existing.id)
      if (Number(existing.manual_locked) !== 1) {
        const previousDescription = String(existing.description)
        const mergedDescription =
          previousDescription.length >= description.length ? previousDescription : description
        const previousCriteria = parseStringArray(String(existing.acceptance_criteria_json))
        const mergedCriteria = Array.from(new Set([...previousCriteria, ...criteria]))
        this.db
          .prepare(`
            UPDATE requirements
            SET description = ?, acceptance_criteria_json = ?, confidence = MAX(confidence, ?),
                updated_at = ?
            WHERE id = ?
          `)
          .run(
            mergedDescription,
            JSON.stringify(mergedCriteria),
            clampConfidence(payload.confidence),
            time,
            id
          )
      }
      this.upsertSearch('requirement', id, title, `${description}\n${criteria.join('\n')}`)
      return id
    }

    const id = newId()
    this.db
      .prepare(`
        INSERT INTO requirements(
          id, entity_key, title, description, status, priority, acceptance_criteria_json,
          source_item_id, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        key,
        title,
        description,
        normalizeRequirementStatus(payload.status),
        normalizeRequirementPriority(payload.priority),
        JSON.stringify(criteria),
        sourceItemId,
        clampConfidence(payload.confidence),
        time,
        time
      )
    this.upsertSearch('requirement', id, title, `${description}\n${criteria.join('\n')}`)
    return id
  }

  private createSummary(sourceItemId: string, payload: Record<string, unknown>): string {
    const id = newId()
    const highlights = Array.isArray(payload.highlights)
      ? payload.highlights.map(String).filter(Boolean).slice(0, 20)
      : []
    const versionRow = this.db
      .prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM summaries WHERE scope_type = 'source' AND scope_id = ?
      `)
      .get(sourceItemId) as Row
    this.db
      .prepare(`
        INSERT INTO summaries(
          id, scope_type, scope_id, title, content, highlights_json,
          version, source_item_id, created_at
        ) VALUES (?, 'source', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        sourceItemId,
        String(payload.title ?? '工作摘要'),
        String(payload.content ?? ''),
        JSON.stringify(highlights),
        Number(versionRow.next_version ?? 1),
        sourceItemId,
        nowIso()
      )
    this.upsertSearch(
      'summary',
      id,
      String(payload.title ?? '工作摘要'),
      `${String(payload.content ?? '')}\n${highlights.join('\n')}`
    )
    return id
  }

  private addEvidenceCandidates(
    sourceItemId: string,
    targetType: 'event' | 'requirement' | 'summary',
    targetId: string,
    candidates: unknown
  ): void {
    if (!Array.isArray(candidates)) return
    const insert = this.db.prepare(`
      INSERT INTO evidence_links(
        id, source_item_id, target_type, target_id, quote, block_index,
        start_offset, end_offset, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const candidate of candidates.slice(0, 10)) {
      if (!candidate || typeof candidate !== 'object') continue
      const value = candidate as Record<string, unknown>
      const quote = String(value.quote ?? '').trim()
      if (!quote) continue
      insert.run(
        newId(),
        sourceItemId,
        targetType,
        targetId,
        quote,
        typeof value.blockIndex === 'number' ? value.blockIndex : null,
        typeof value.startOffset === 'number' ? value.startOffset : null,
        typeof value.endOffset === 'number' ? value.endOffset : null,
        nowIso()
      )
    }
  }

  private resolveEvidenceSourceId(sourceItemIds: string[], candidate: unknown): string {
    const fallbackSourceId = sourceItemIds[0]!
    if (!candidate || typeof candidate !== 'object') return fallbackSourceId
    const quote = String((candidate as Record<string, unknown>).quote ?? '').trim()
    if (!quote) return fallbackSourceId
    return (
      sourceItemIds.find((sourceItemId) => this.getSourceText(sourceItemId).includes(quote)) ??
      fallbackSourceId
    )
  }

  private listEvidence(
    targetType: 'event' | 'requirement' | 'summary',
    targetId: string
  ): EvidenceLink[] {
    return (this.db
      .prepare('SELECT * FROM evidence_links WHERE target_type = ? AND target_id = ? ORDER BY created_at')
      .all(targetType, targetId) as Row[]).map(mapEvidence)
  }

  private linkEventToRequirements(eventId: string, sourceItemId: string): void {
    const requirements = this.db
      .prepare(`
        SELECT DISTINCT id FROM requirements
        WHERE source_item_id = ?
           OR id IN (
             SELECT target_id FROM evidence_links
             WHERE source_item_id = ? AND target_type = 'requirement'
           )
      `)
      .all(sourceItemId, sourceItemId) as Row[]
    for (const requirement of requirements) {
      this.addRelation('event', eventId, 'requirement', String(requirement.id), sourceItemId)
    }
  }

  private linkRequirementToEvents(requirementId: string, sourceItemId: string): void {
    const events = this.db
      .prepare(`
        SELECT DISTINCT id FROM events
        WHERE source_item_id = ?
           OR id IN (
             SELECT target_id FROM evidence_links
             WHERE source_item_id = ? AND target_type = 'event'
           )
      `)
      .all(sourceItemId, sourceItemId) as Row[]
    for (const event of events) {
      this.addRelation('event', String(event.id), 'requirement', requirementId, sourceItemId)
    }
  }

  private addRelation(
    fromType: 'event',
    fromId: string,
    toType: 'requirement',
    toId: string,
    sourceItemId: string
  ): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO entity_relations(
          id, from_type, from_id, to_type, to_id, relation_type, source_item_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'supports', ?, ?)
      `)
      .run(newId(), fromType, fromId, toType, toId, sourceItemId, nowIso())
  }

  private listRelatedIds(
    entityType: 'event' | 'requirement',
    entityId: string,
    targetType: 'event' | 'requirement'
  ): string[] {
    const rows = this.db
      .prepare(`
        SELECT to_id AS related_id
        FROM entity_relations
        WHERE from_type = ? AND from_id = ? AND to_type = ?
        UNION
        SELECT from_id AS related_id
        FROM entity_relations
        WHERE to_type = ? AND to_id = ? AND from_type = ?
      `)
      .all(entityType, entityId, targetType, entityType, entityId, targetType) as Row[]
    return rows.map((row) => String(row.related_id))
  }

  private refreshSourceReviewStatus(sourceItemId: string): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM ai_proposals WHERE source_item_id = ? AND status = 'pending'")
      .get(sourceItemId) as Row
    if (Number(row.count) === 0) this.setSourceStatus(sourceItemId, 'ready')
  }

  private addRevision(
    entityType: string,
    entityId: string,
    actor: string,
    before: unknown,
    after: unknown
  ): void {
    this.db
      .prepare(`
        INSERT INTO revisions(id, entity_type, entity_id, actor, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newId(),
        entityType,
        entityId,
        actor,
        JSON.stringify(before ?? null),
        JSON.stringify(after ?? null),
        nowIso()
      )
  }

  private upsertSearch(entityType: string, entityId: string, title: string, body: string): void {
    this.db
      .prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
      .run(entityType, entityId)
    this.db
      .prepare('INSERT INTO search_index(entity_type, entity_id, title, body) VALUES (?, ?, ?, ?)')
      .run(entityType, entityId, title, body)
  }

  private getEntityDate(entityType: string, entityId: string): string | null {
    if (entityType === 'source') {
      const row = this.db
        .prepare(`
          SELECT COALESCE(
            MAX(e.event_date),
            (SELECT business_date FROM source_items WHERE id = ?)
          ) AS value
          FROM events e
          LEFT JOIN evidence_links l
            ON l.target_type = 'event' AND l.target_id = e.id
          WHERE e.event_date IS NOT NULL
            AND (e.source_item_id = ? OR l.source_item_id = ?)
        `)
        .get(entityId, entityId, entityId) as Row | undefined
      return row?.value ? String(row.value).slice(0, 10) : null
    }
    const tableAndColumn: Record<string, [string, string]> = {
      event: ['events', 'event_date'],
      brief: ['daily_briefs', 'work_date']
    }
    const entry = tableAndColumn[entityType]
    if (!entry) return null
    const [table, column] = entry
    const row = this.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(entityId) as
      | Row
      | undefined
    return row?.value ? String(row.value).slice(0, 10) : null
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | Row
      | undefined
    return row ? String(row.value_json) : null
  }

  private setSetting(key: string, value: unknown): void {
    this.db
      .prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), nowIso())
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

interface WorkItemTitleCandidate {
  title: string
  normalized: string
  eventIds: Set<string>
  primaryEventIds: Set<string>
  highConfidenceEventIds: Set<string>
  maxConfidence: number
}

/**
 * Work-item identity is deliberately left to workItemKey. This selector only
 * stabilizes the label shown for an already-grouped item: a late, low-confidence
 * local fallback must not replace a shorter title that was repeatedly produced
 * by grounded, higher-confidence events.
 */
function selectStableWorkItemTitle(events: readonly WorkEvent[]): string {
  const candidates = new Map<string, WorkItemTitleCandidate>()
  const evidenceText = normalizeEntityKey(
    events.flatMap((event) => event.evidence.map((item) => item.quote)).join('\n')
  )

  const addCandidate = (
    rawTitle: string,
    event: WorkEvent,
    kind: 'workItem' | 'event' | 'evidence'
  ): void => {
    const title = cleanWorkItemTitleCandidate(rawTitle, kind)
    const normalized = normalizeEntityKey(title)
    if (!title || !normalized) return
    const candidate = candidates.get(normalized) ?? {
      title,
      normalized,
      eventIds: new Set<string>(),
      primaryEventIds: new Set<string>(),
      highConfidenceEventIds: new Set<string>(),
      maxConfidence: 0
    }
    // Prefer the more concise display form when punctuation/casing variants
    // normalize to the same logical candidate.
    if (title.length < candidate.title.length) candidate.title = title
    candidate.eventIds.add(event.id)
    if (kind === 'workItem') candidate.primaryEventIds.add(event.id)
    if (event.confidence > 0.68) candidate.highConfidenceEventIds.add(event.id)
    candidate.maxConfidence = Math.max(candidate.maxConfidence, event.confidence)
    candidates.set(normalized, candidate)
  }

  for (const event of events) {
    addCandidate(event.workItemTitle || event.title, event, 'workItem')
    addCandidate(event.title, event, 'event')
    for (const evidence of event.evidence.slice(0, 2)) {
      addCandidate(evidence.quote, event, 'evidence')
    }
  }

  const ranked = Array.from(candidates.values()).map((candidate) => ({
    candidate,
    support: workItemTitleEvidenceSupport(candidate.normalized, evidenceText),
    score: scoreWorkItemTitleCandidate(candidate, evidenceText)
  })).sort((left, right) =>
    right.score - left.score
    || right.candidate.primaryEventIds.size - left.candidate.primaryEventIds.size
    || right.support - left.support
    || left.candidate.title.length - right.candidate.title.length
    || left.candidate.normalized.localeCompare(right.candidate.normalized, 'zh-CN')
  )

  return ranked[0]?.candidate.title
    ?? cleanWorkItemTitleCandidate(events[0]?.workItemTitle || events[0]?.title || '工作事项', 'workItem')
    ?? '工作事项'
}

function cleanWorkItemTitleCandidate(
  value: string,
  kind: 'workItem' | 'event' | 'evidence'
): string {
  let title = value
    .normalize('NFKC')
    .replace(/^[\s“”"'‘’《》【】\[\]()（）]+|[\s“”"'‘’《》【】\[\]()（）]+$/gu, '')
    .trim()
  if (kind !== 'workItem') {
    title = title
      .replace(/^(?:今天|昨日|昨天|本日|当日)?(?:已|正在|继续|开始|完成了?|推进|跟进|开展|着手|计划|准备|看一下|看看|把)\s*/u, '')
      .trim()
  }
  const firstSentence = title.split(/[。！？；;]/u)[0]?.trim()
  if (firstSentence) title = firstSentence
  return title.replace(/^[,，:：、\s]+|[,，:：、\s]+$/gu, '').trim().slice(0, 120)
}

function scoreWorkItemTitleCandidate(
  candidate: WorkItemTitleCandidate,
  evidenceText: string
): number {
  const title = candidate.title
  const length = Array.from(title).length
  const support = workItemTitleEvidenceSupport(candidate.normalized, evidenceText)
  let score = 0

  score += candidate.primaryEventIds.size * 20
  score += candidate.eventIds.size * 8
  score += Math.max(0, candidate.eventIds.size - 1) * 26
  score += candidate.highConfidenceEventIds.size * 18
  score += candidate.maxConfidence * 12
  score += support >= 0.72 ? 44 : support >= 0.48 ? 28 : support >= 0.3 ? 8 : -55

  if (length >= 4 && length <= 24) score += 20
  if (length < 3) score -= 30
  if (length > 28) score -= (length - 28) * 3
  if (length > 48) score -= 45
  if (/[。！？?；;]/u.test(title) || (length > 18 && /[,，:：]/u.test(title))) score -= 38
  if (/^(?:今天|昨日|昨天|明天|已|正在|继续|完成|看一下|看看|把|请|需要|想要|做一个)/u.test(title)) score -= 42
  if (/(?:今天|昨天|明天|上周|本周|下周|目前|当前|继续推进|进行中|待处理|等待)$/u.test(title)) score -= 28
  if (!candidate.highConfidenceEventIds.size && candidate.maxConfidence <= 0.68) score -= 30

  return score
}

function workItemTitleEvidenceSupport(title: string, evidenceText: string): number {
  if (!title || !evidenceText) return 0
  if (evidenceText.includes(title)) return 1

  // Proper names, versions and numbers are high-risk invention points. If one
  // is absent from the exact evidence, the candidate cannot be considered well
  // grounded even when some generic Chinese characters overlap.
  const tokens = title.match(/[a-z][a-z0-9_-]{1,}|\d+(?:\.\d+)*/giu) ?? []
  if (tokens.some((token) => !evidenceText.includes(normalizeEntityKey(token)))) return 0

  const units = new Set<string>()
  for (let index = 0; index < title.length - 1; index += 1) {
    units.add(title.slice(index, index + 2))
  }
  if (!units.size) return evidenceText.includes(title) ? 1 : 0
  const matches = Array.from(units).filter((unit) => evidenceText.includes(unit)).length
  return matches / units.size
}

function mapSource(row: Row): SourceItem {
  const rawText = String(row.raw_text ?? '')
  return {
    id: String(row.id),
    title: String(row.title),
    kind: String(row.kind) as SourceKind,
    rawText,
    excerpt: excerpt(rawText),
    businessDate: nullableString(row.business_date),
    datePrecision: asDatePrecision(row.date_precision),
    dateOrigin: asDateOrigin(row.date_origin),
    status: String(row.status) as ProcessingStatus,
    error: nullableString(row.error),
    contentHash: String(row.content_hash),
    assetCount: Number(row.asset_count ?? 0),
    workDates: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapAsset(row: Row): Asset {
  return {
    id: String(row.id),
    sourceItemId: String(row.source_item_id),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    extractedText: String(row.extracted_text ?? ''),
    createdAt: String(row.created_at)
  }
}

function mapEvent(row: Row, evidence: EvidenceLink[], requirementIds: string[]): WorkEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    workItemKey: String(row.work_item_key ?? row.entity_key),
    workItemTitle: String(row.work_item_title ?? row.title),
    eventType: String(row.event_type),
    eventDate: nullableString(row.event_date),
    datePrecision: asDatePrecision(row.date_precision),
    summary: String(row.summary),
    sourceItemId: String(row.source_item_id),
    confidence: clampConfidence(row.confidence),
    manualLocked: Number(row.manual_locked) === 1,
    evidence,
    requirementIds,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapRequirement(row: Row, evidence: EvidenceLink[], eventIds: string[]): Requirement {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    status: normalizeRequirementStatus(row.status),
    priority: normalizeRequirementPriority(row.priority),
    acceptanceCriteria: parseStringArray(String(row.acceptance_criteria_json)),
    sourceItemId: String(row.source_item_id),
    confidence: clampConfidence(row.confidence),
    manualLocked: Number(row.manual_locked) === 1,
    evidence,
    eventIds,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapSummary(row: Row): Summary {
  return {
    id: String(row.id),
    scopeType: String(row.scope_type) as Summary['scopeType'],
    scopeId: String(row.scope_id),
    title: String(row.title),
    content: String(row.content),
    highlights: parseStringArray(String(row.highlights_json)),
    version: Number(row.version),
    sourceItemId: String(row.source_item_id),
    createdAt: String(row.created_at)
  }
}

function mapDailyBrief(row: Row): DailyBrief {
  return {
    id: String(row.id),
    workDate: String(row.work_date),
    standupDate: String(row.standup_date),
    title: String(row.title),
    overview: String(row.overview),
    script: String(row.script),
    completed: parseStringArray(String(row.completed_json)),
    inProgress: parseStringArray(String(row.in_progress_json)),
    blockers: parseStringArray(String(row.blockers_json)),
    nextSteps: parseStringArray(String(row.next_steps_json)),
    images: parseDailyBriefImages(String(row.images_json ?? '[]')),
    sourceItemIds: parseStringArray(String(row.source_item_ids_json)),
    provider: String(row.provider),
    model: String(row.model),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapProposal(row: Row): AiProposal {
  return {
    id: String(row.id),
    sourceItemId: String(row.source_item_id),
    kind: String(row.kind) as AiProposal['kind'],
    action: String(row.action) as AiProposal['action'],
    payload: parseRecord(String(row.payload_json)),
    confidence: clampConfidence(row.confidence),
    rationale: String(row.rationale ?? ''),
    status: String(row.status) as AiProposal['status'],
    provider: String(row.provider),
    model: String(row.model),
    createdAt: String(row.created_at),
    reviewedAt: nullableString(row.reviewed_at)
  }
}

function mapEvidence(row: Row): EvidenceLink {
  return {
    id: String(row.id),
    sourceItemId: String(row.source_item_id),
    targetType: String(row.target_type) as EvidenceLink['targetType'],
    targetId: String(row.target_id),
    quote: String(row.quote),
    blockIndex: nullableNumber(row.block_index),
    startOffset: nullableNumber(row.start_offset),
    endOffset: nullableNumber(row.end_offset),
    createdAt: String(row.created_at)
  }
}

function buildDashboard(
  sources: SourceItem[],
  events: WorkEvent[],
  dailyBriefs: DailyBrief[]
): DashboardData {
  const eventTypeMap = new Map<string, number>()
  for (const event of events) eventTypeMap.set(event.eventType, (eventTypeMap.get(event.eventType) ?? 0) + 1)
  const eventTypes = Array.from(eventTypeMap, ([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)

  const activityMap = new Map<string, { sources: number; events: number }>()
  const add = (date: string | null, key: 'sources' | 'events'): void => {
    if (!date) return
    const day = date.slice(0, 10)
    const current = activityMap.get(day) ?? { sources: 0, events: 0 }
    current[key] += 1
    activityMap.set(day, current)
  }
  sources.forEach((source) => {
    const workDates = source.workDates.length
      ? source.workDates
      : source.businessDate
        ? [source.businessDate]
        : []
    workDates.forEach((workDate) => add(workDate, 'sources'))
  })
  events.forEach((event) => add(event.eventDate, 'events'))

  return {
    totals: {
      sources: sources.length,
      events: events.length,
      dailyBriefs: dailyBriefs.length,
      processing: sources.filter((source) => ['queued', 'processing'].includes(source.status)).length
    },
    eventTypes,
    activity: Array.from(activityMap, ([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30),
    latestBrief: dailyBriefs[0] ?? null
  }
}

function nextWorkday(value: string): string {
  const date = new Date(`${value}T12:00:00Z`)
  do {
    date.setUTCDate(date.getUTCDate() + 1)
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return date.toISOString().slice(0, 10)
}

function fallbackStandupForEvents(
  workDate: string,
  events: AnalysisResult['events']
): AnalysisResult['dailyBriefs'][number] {
  const isBlocker = (value: string): boolean => /问题|风险|阻塞|block|issue/i.test(value)
  const isPlan = (value: string): boolean => /计划|下一步|待办|plan|todo/i.test(value)
  const blockers = events.filter((event) => isBlocker(event.eventType)).map((event) => event.summary)
  const nextSteps = events.filter((event) => isPlan(event.eventType)).map((event) => event.summary)
  const completed = events
    .filter((event) => !isBlocker(event.eventType) && !isPlan(event.eventType))
    .map((event) => event.summary)
  const overview = events.map((event) => event.summary).join('；') || '当日工作内容已整理完成。'
  return {
    workDate,
    title: `${workDate} 早会汇报`,
    overview,
    completed,
    inProgress: [],
    blockers,
    nextSteps,
    script: [
      '大家早上好，下面同步一下当天的工作进展。',
      overview,
      blockers.length ? `当前风险或需要协助：${blockers.join('；')}。` : '目前没有明显阻塞。',
      nextSteps.length ? `接下来计划：${nextSteps.join('；')}。` : '',
      '以上是我的工作同步，谢谢。'
    ].filter(Boolean).join('\n\n')
  }
}

export interface QuestionDateRange {
  from: string
  to: string
}

export function inferQuestionDateRange(
  question: string,
  referenceDate: string
): QuestionDateRange | null {
  const reference = new Date(`${referenceDate}T12:00:00Z`)
  if (Number.isNaN(reference.getTime())) return null
  const explicitDay = question.match(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/)
  if (explicitDay) {
    const value = isoDate(Number(explicitDay[1]), Number(explicitDay[2]), Number(explicitDay[3]))
    return value ? { from: value, to: value } : null
  }
  const shortDay = question.match(/(?<!\d)(\d{1,2})月(\d{1,2})日/)
  if (shortDay) {
    const value = isoDate(reference.getUTCFullYear(), Number(shortDay[1]), Number(shortDay[2]))
    return value ? { from: value, to: value } : null
  }
  const explicitMonth = question.match(/(20\d{2})[年\/-](\d{1,2})月?/) 
  if (explicitMonth) return monthRange(Number(explicitMonth[1]), Number(explicitMonth[2]))
  const shortMonth = question.match(/(?<!\d)(\d{1,2})月/)
  if (shortMonth) return monthRange(reference.getUTCFullYear(), Number(shortMonth[1]))

  const recentDays = question.match(/(?:最近|过去)(\d{1,3})天/)
  if (recentDays) {
    const days = Math.min(366, Math.max(1, Number(recentDays[1])))
    return { from: shiftDate(referenceDate, -(days - 1)), to: referenceDate }
  }
  if (question.includes('前天')) {
    const value = shiftDate(referenceDate, -2)
    return { from: value, to: value }
  }
  if (question.includes('昨天')) {
    const value = shiftDate(referenceDate, -1)
    return { from: value, to: value }
  }
  if (question.includes('今天')) return { from: referenceDate, to: referenceDate }
  if (question.includes('上个月')) {
    const previous = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1))
    return monthRange(previous.getUTCFullYear(), previous.getUTCMonth() + 1)
  }
  if (question.includes('本月') || question.includes('这个月')) {
    return monthRange(reference.getUTCFullYear(), reference.getUTCMonth() + 1)
  }
  if (question.includes('上周')) return weekRange(referenceDate, -1)
  if (question.includes('本周') || question.includes('这周')) return weekRange(referenceDate, 0)
  if (question.includes('去年')) {
    return { from: `${reference.getUTCFullYear() - 1}-01-01`, to: `${reference.getUTCFullYear() - 1}-12-31` }
  }
  if (question.includes('今年')) {
    return { from: `${reference.getUTCFullYear()}-01-01`, to: referenceDate }
  }
  return null
}

export function extractKnowledgeTerms(question: string): string[] {
  let value = question.toLowerCase()
  value = value.replace(/20\d{2}[年\/-]\d{1,2}(?:[月\/-]\d{1,2}日?)?/g, ' ')
  value = value.replace(/\d{1,3}(?:天|周|个月|月)/g, ' ')
  const fillers = [
    '请帮我看看', '请帮我', '帮我看看', '我想问一下', '我想问', '想了解一下',
    '最近', '过去', '过往', '本月', '这个月', '上个月', '本周', '这周', '上周',
    '今年', '去年', '今天', '昨天', '前天', '工作相关', '工作内容', '工作中',
    '做了哪些', '做了什么', '有哪些', '有什么', '怎么样', '如何', '是否', '关于',
    '相关的', '相关', '请问', '一下', '我在', '我的', '我', '的', '了', '吗', '呢'
  ]
  for (const filler of fillers) value = value.replaceAll(filler, ' ')
  const terms = new Set<string>()
  for (const token of value.match(/[a-z0-9][a-z0-9._/-]{1,}/g) ?? []) terms.add(token)
  for (const run of value.match(/\p{Script=Han}{2,}/gu) ?? []) {
    if (run.length <= 12) terms.add(run)
    for (let size = Math.min(4, run.length); size >= 2; size -= 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        terms.add(run.slice(index, index + size))
      }
    }
  }
  const stopTerms = new Set(['工作', '内容', '事情', '项目中', '什么', '哪些', '情况', '进行', '负责'])
  return Array.from(terms)
    .filter((term) => term.length >= 2 && !stopTerms.has(term))
    .sort((a, b) => b.length - a.length)
    .slice(0, 20)
}

function scoreKnowledgeItem(
  item: KnowledgeContextItem,
  terms: string[],
  dateRange: QuestionDateRange | null
): number {
  if (dateRange && (!item.date || item.date < dateRange.from || item.date > dateRange.to)) {
    return Number.NEGATIVE_INFINITY
  }
  const title = item.title.toLowerCase()
  const content = item.content.toLowerCase()
  let matches = 0
  let score = dateRange ? 40 : 0
  for (const term of terms) {
    const titleMatch = title.includes(term)
    const bodyMatch = content.includes(term)
    if (!titleMatch && !bodyMatch) continue
    matches += 1
    score += term.length * (titleMatch ? 6 : 2)
  }
  if (terms.length && !matches) return Number.NEGATIVE_INFINITY
  score += item.entityType === 'brief' ? 7 : item.entityType === 'source' ? 5 : 3
  return score
}

function clipKnowledgeContent(content: string, terms: string[], limit: number): string {
  if (content.length <= limit) return content
  const lower = content.toLowerCase()
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
  const matchIndex = indexes.length ? Math.min(...indexes) : 0
  const start = Math.max(0, matchIndex - Math.floor(limit / 3))
  const clipped = content.slice(start, start + limit)
  return `${start ? '…' : ''}${clipped}${start + limit < content.length ? '…' : ''}`
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null
  return date.toISOString().slice(0, 10)
}

function monthRange(year: number, month: number): QuestionDateRange | null {
  const from = isoDate(year, month, 1)
  if (!from) return null
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from, to: isoDate(year, month, last)! }
}

function weekRange(referenceDate: string, offset: number): QuestionDateRange {
  const reference = new Date(`${referenceDate}T12:00:00Z`)
  const weekday = reference.getUTCDay() || 7
  const monday = shiftDate(referenceDate, -(weekday - 1) + offset * 7)
  return { from: monday, to: shiftDate(monday, 6) }
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function asDatePrecision(value: unknown): DatePrecision {
  const allowed: DatePrecision[] = ['day', 'week', 'month', 'quarter', 'unknown']
  return allowed.includes(value as DatePrecision) ? (value as DatePrecision) : 'unknown'
}

function asDateOrigin(value: unknown): DateOrigin {
  const allowed: DateOrigin[] = ['explicit', 'inferred', 'manual']
  return allowed.includes(value as DateOrigin) ? (value as DateOrigin) : 'inferred'
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseDailyBriefImages(value: string): NonNullable<DailyBrief['images']> {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const candidate = item as Record<string, unknown>
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.dataUrl !== 'string') return []
      return [{ id: candidate.id, name: candidate.name, dataUrl: candidate.dataUrl }]
    })
  } catch {
    return []
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
