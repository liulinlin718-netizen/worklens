import { z } from 'zod'

export const DatePrecisionSchema = z.enum(['day', 'week', 'month', 'quarter', 'unknown'])
export const DateOriginSchema = z.enum(['explicit', 'inferred', 'manual'])
export const SourceKindSchema = z.enum(['text', 'markdown', 'pdf', 'docx', 'image', 'unknown'])
export const ProcessingStatusSchema = z.enum([
  'queued',
  'processing',
  'review',
  'ready',
  'failed'
])
export const RequirementStatusSchema = z.enum([
  'backlog',
  'planned',
  'in_progress',
  'blocked',
  'done'
])
export const RequirementPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const ProposalKindSchema = z.enum(['source_metadata', 'event', 'requirement', 'summary'])
export const ProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected'])
export const ProviderKindSchema = z.enum([
  'cursor_cli',
  'codex_cli',
  'cursor',
  'openai_compatible'
])

export type DatePrecision = z.infer<typeof DatePrecisionSchema>
export type DateOrigin = z.infer<typeof DateOriginSchema>
export type SourceKind = z.infer<typeof SourceKindSchema>
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>
export type RequirementPriority = z.infer<typeof RequirementPrioritySchema>
export type ProposalKind = z.infer<typeof ProposalKindSchema>
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>
export type ProviderKind = z.infer<typeof ProviderKindSchema>

export interface SourceItem {
  id: string
  title: string
  kind: SourceKind
  rawText: string
  excerpt: string
  businessDate: string | null
  datePrecision: DatePrecision
  dateOrigin: DateOrigin
  status: ProcessingStatus
  error: string | null
  contentHash: string
  assetCount: number
  workDates: string[]
  createdAt: string
  updatedAt: string
}

export interface Asset {
  id: string
  sourceItemId: string
  originalName: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  extractedText: string
  createdAt: string
}

export interface AssetPreview {
  assetId: string
  mimeType: string
  dataUrl: string | null
}

export interface EvidenceLink {
  id: string
  sourceItemId: string
  targetType: 'event' | 'requirement' | 'summary'
  targetId: string
  quote: string
  blockIndex: number | null
  startOffset: number | null
  endOffset: number | null
  createdAt: string
}

export interface WorkEvent {
  id: string
  title: string
  workItemKey: string
  workItemTitle: string
  eventType: string
  eventDate: string | null
  datePrecision: DatePrecision
  summary: string
  sourceItemId: string
  confidence: number
  manualLocked: boolean
  evidence: EvidenceLink[]
  requirementIds: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkItem {
  id: string
  key: string
  title: string
  eventType: string
  firstDate: string | null
  latestDate: string | null
  summary: string
  confidence: number
  evidence: EvidenceLink[]
  sourceItemIds: string[]
  eventIds: string[]
  eventCount: number
  updatedAt: string
}

export interface Requirement {
  id: string
  title: string
  description: string
  status: RequirementStatus
  priority: RequirementPriority
  acceptanceCriteria: string[]
  sourceItemId: string
  confidence: number
  manualLocked: boolean
  evidence: EvidenceLink[]
  eventIds: string[]
  createdAt: string
  updatedAt: string
}

export interface Summary {
  id: string
  scopeType: 'source' | 'day' | 'week' | 'event' | 'requirement'
  scopeId: string
  title: string
  content: string
  highlights: string[]
  version: number
  sourceItemId: string
  createdAt: string
}

export interface DailyBriefImage {
  id: string
  name: string
  dataUrl: string
}

export interface DailyBrief {
  id: string
  workDate: string
  standupDate: string
  title: string
  overview: string
  script: string
  completed: string[]
  inProgress: string[]
  blockers: string[]
  nextSteps: string[]
  images?: DailyBriefImage[]
  sourceItemIds: string[]
  provider: string
  model: string
  createdAt: string
  updatedAt: string
}

export interface AiProposal {
  id: string
  sourceItemId: string
  kind: ProposalKind
  action: 'create' | 'update' | 'merge'
  payload: Record<string, unknown>
  confidence: number
  rationale: string
  status: ProposalStatus
  provider: string
  model: string
  createdAt: string
  reviewedAt: string | null
}

export interface SearchHit {
  entityType: 'source' | 'event' | 'brief'
  entityId: string
  title: string
  excerpt: string
  date: string | null
  rank: number
}

export type KnowledgeEntityType = 'source' | 'event' | 'brief'

export interface KnowledgeContextItem {
  refId: string
  entityType: KnowledgeEntityType
  entityId: string
  title: string
  date: string | null
  content: string
}

export const WorkQuestionMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(12_000)
})
export type WorkQuestionMessage = z.infer<typeof WorkQuestionMessageSchema>

export const AskWorkQuestionInputSchema = z.object({
  question: z.string().trim().min(2).max(1_000),
  history: z.array(WorkQuestionMessageSchema).max(8).default([])
})
export type AskWorkQuestionInput = z.infer<typeof AskWorkQuestionInputSchema>

export const KnowledgeAnswerResultSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  citations: z
    .array(
      z.object({
        refId: z.string().trim().min(1).max(200),
        quote: z.string().trim().min(1).max(2_000)
      })
    )
    .max(12)
    .default([]),
  suggestedQuestions: z.array(z.string().trim().min(2).max(200)).max(4).default([])
})
export type KnowledgeAnswerResult = z.infer<typeof KnowledgeAnswerResultSchema>

export interface WorkQuestionCitation {
  refId: string
  entityType: KnowledgeEntityType
  entityId: string
  title: string
  date: string | null
  quote: string
}

export interface WorkQuestionAnswer {
  answer: string
  citations: WorkQuestionCitation[]
  suggestedQuestions: string[]
  provider: 'cursor_cli' | 'codex_cli'
  model: string
  retrievedCount: number
}

export interface DashboardData {
  totals: {
    sources: number
    events: number
    dailyBriefs: number
    processing: number
  }
  eventTypes: Array<{ name: string; value: number }>
  activity: Array<{ date: string; sources: number; events: number }>
  latestBrief: DailyBrief | null
}

export interface AppSnapshot {
  sources: SourceItem[]
  events: WorkEvent[]
  workItems: WorkItem[]
  dailyBriefs: DailyBrief[]
  dashboard: DashboardData
}

export const CaptureTextInputSchema = z.object({
  title: z.string().trim().max(160).optional().default(''),
  text: z.string().trim().min(1).max(500_000),
  businessDate: z.iso.date().nullable().optional().default(null)
})
export type CaptureTextInput = z.infer<typeof CaptureTextInputSchema>

export const UpdateSourceDateInputSchema = z.object({
  sourceItemId: z.string().uuid(),
  businessDate: z.iso.date()
})
export type UpdateSourceDateInput = z.infer<typeof UpdateSourceDateInputSchema>

export const DailyBriefImageSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(240),
  dataUrl: z.string().max(7_500_000).regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/)
})

export const UpdateDailyBriefInputSchema = z.object({
  briefId: z.string().uuid(),
  script: z.string().trim().min(1).max(50_000),
  images: z.array(DailyBriefImageSchema).max(6).default([])
})
export type UpdateDailyBriefInput = z.infer<typeof UpdateDailyBriefInputSchema>

export const AnalyzeSourceInputSchema = z.object({
  sourceItemId: z.string().uuid()
})

export const ReviewProposalInputSchema = z.object({
  proposalId: z.string().uuid(),
  edits: z.record(z.string(), z.unknown()).optional()
})
export type ReviewProposalInput = z.infer<typeof ReviewProposalInputSchema>

export const SearchInputSchema = z.object({
  query: z.string().trim().max(200),
  entityTypes: z
    .array(z.enum(['source', 'event', 'brief']))
    .optional()
    .default([])
})
export type SearchInput = z.infer<typeof SearchInputSchema>

export const ExportRequestSchema = z.object({
  format: z.enum(['markdown', 'pdf', 'csv', 'zip']),
  fromDate: z.iso.date().nullable().optional().default(null),
  toDate: z.iso.date().nullable().optional().default(null),
  includeAttachments: z.boolean().optional().default(true)
})
export type ExportRequest = z.infer<typeof ExportRequestSchema>

export const ProviderSettingsSchema = z.object({
  kind: ProviderKindSchema,
  model: z.string().trim().max(200).default(''),
  baseUrl: z.string().trim().max(500).default(''),
  hasApiKey: z.boolean().default(false),
  sendImages: z.boolean().default(false),
  autoAnalyze: z.boolean().default(true)
})
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>

export const SaveProviderSettingsSchema = z.object({
  kind: ProviderKindSchema,
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(500).default(''),
  apiKey: z.string().trim().max(1_000).optional(),
  sendImages: z.boolean().default(false),
  autoAnalyze: z.boolean().default(true)
})
export type SaveProviderSettings = z.infer<typeof SaveProviderSettingsSchema>

export const RequirementStatusUpdateSchema = z.object({
  requirementId: z.string().uuid(),
  status: RequirementStatusSchema
})

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string()
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export interface CursorCliStatus {
  installed: boolean
  authenticated: boolean
  binaryPath: string | null
  version: string | null
  accountLabel: string | null
  message: string
}

export interface CodexCliStatus extends CursorCliStatus {
  authMode: string | null
  planType: string | null
}

export const EvidenceCandidateSchema = z.object({
  quote: z.string().trim().min(1).max(2_000),
  blockIndex: z.number().int().nonnegative().nullable().default(null)
})

export const StandupBriefSchema = z.object({
  title: z.string().trim().min(1).max(200),
  overview: z.string().trim().min(1).max(10_000),
  completed: z.array(z.string().trim().min(1).max(1_000)).max(30).default([]),
  inProgress: z.array(z.string().trim().min(1).max(1_000)).max(30).default([]),
  blockers: z.array(z.string().trim().min(1).max(1_000)).max(30).default([]),
  nextSteps: z.array(z.string().trim().min(1).max(1_000)).max(30).default([]),
  script: z.string().trim().min(1).max(20_000)
})

export const DatedStandupBriefSchema = StandupBriefSchema.extend({
  workDate: z.iso.date()
})

export const AnalysisResultSchema = z.object({
  sourceDate: z
    .object({
      value: z.iso.date().nullable(),
      precision: DatePrecisionSchema,
      confidence: z.number().min(0).max(1),
      rationale: z.string().max(1_000)
    })
    .nullable()
    .default(null),
  events: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        workItemKey: z.string().trim().max(160).optional().default(''),
        workItemTitle: z.string().trim().max(200).optional().default(''),
        eventType: z.string().trim().min(1).max(80),
        eventDate: z.iso.date().nullable(),
        datePrecision: DatePrecisionSchema,
        summary: z.string().trim().min(1).max(5_000),
        confidence: z.number().min(0).max(1),
        evidence: z.array(EvidenceCandidateSchema).min(1).max(10)
      })
    )
    .max(300)
    .default([]),
  dailyBriefs: z.array(DatedStandupBriefSchema).max(60).optional().default([]),
  summary: z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(10_000),
    highlights: z.array(z.string().trim().min(1).max(1_000)).max(20).default([])
  }),
  standup: StandupBriefSchema
})
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>

export interface ImportResult {
  imported: SourceItem[]
  duplicates: Array<{ fileName: string; source: SourceItem }>
  failed: Array<{ fileName: string; error: string; sourceItemId: string | null }>
  cancelled: boolean
}

export interface JobProgressEvent {
  sourceItemId: string
  message: string
  jobType: 'import' | 'analysis'
  current?: number
  total?: number
  finished?: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
  path?: string
}

export interface WorkLensApi {
  getSnapshot(): Promise<AppSnapshot>
  listSourceAssets(sourceItemId: string): Promise<Asset[]>
  getAssetPreview(assetId: string): Promise<AssetPreview>
  openAsset(assetId: string): Promise<ActionResult>
  captureText(input: CaptureTextInput): Promise<SourceItem>
  importFiles(): Promise<ImportResult>
  importDroppedFiles(files: File[]): Promise<ImportResult>
  cancelImport(): Promise<ActionResult>
  retryImportSource(sourceItemId: string): Promise<ImportResult>
  deleteSource(sourceItemId: string): Promise<ActionResult>
  deleteWorkEvent(eventId: string): Promise<ActionResult>
  deleteWorkItem(workItemKey: string): Promise<ActionResult>
  updateSourceDate(input: UpdateSourceDateInput): Promise<SourceItem>
  generateDailyBrief(workDate: string): Promise<ActionResult>
  updateDailyBrief(input: UpdateDailyBriefInput): Promise<DailyBrief>
  askWorkQuestion(input: AskWorkQuestionInput): Promise<WorkQuestionAnswer>
  search(input: SearchInput): Promise<SearchHit[]>
  exportData(input: ExportRequest): Promise<ActionResult>
  createBackup(): Promise<ActionResult>
  getProviderSettings(): Promise<ProviderSettings>
  saveProviderSettings(input: SaveProviderSettings): Promise<ProviderSettings>
  listCursorModels(): Promise<ModelInfo[]>
  listCursorCliModels(): Promise<ModelInfo[]>
  getCursorCliStatus(): Promise<CursorCliStatus>
  loginCursorCli(): Promise<CursorCliStatus>
  listCodexCliModels(): Promise<ModelInfo[]>
  getCodexCliStatus(): Promise<CodexCliStatus>
  loginCodexCli(): Promise<CodexCliStatus>
  testProvider(): Promise<ActionResult>
  copyText(text: string): Promise<ActionResult>
  onDataChanged(callback: () => void): () => void
  onJobProgress(callback: (event: JobProgressEvent) => void): () => void
}
