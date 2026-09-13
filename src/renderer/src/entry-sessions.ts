import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ImportResult, JobProgressEvent } from '@shared/contracts'

export interface CaptureDraft { title: string; text: string; date: string }
export interface PendingTextItem { id: string; text: string; title: string }
export type BatchPhase = 'compose' | 'processing' | 'review'
export type BatchImportResult = Omit<ImportResult, 'failed'> & {
  failed: Array<ImportResult['failed'][number] & { pendingTextId?: string }>
}

function readDraft<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return validate(value) ? value : fallback
  } catch { return fallback }
}

export function useLocalDraft<T>(key: string, fallback: T, validate: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState(() => readDraft(key, fallback, validate))
  const [storageFailed, setStorageFailed] = useState(false)
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      setStorageFailed(false)
    } catch { setStorageFailed(true) }
  }, [key, value])
  return [value, setValue, storageFailed]
}

const isCaptureDraft = (value: unknown): value is CaptureDraft => {
  const draft = value as CaptureDraft | null
  return Boolean(draft && typeof draft.title === 'string' && typeof draft.text === 'string' && typeof draft.date === 'string' && (!draft.date || /^\d{4}-\d{2}-\d{2}$/.test(draft.date)))
}

export function clearSubmittedDraft(current: CaptureDraft, submitted: CaptureDraft): CaptureDraft {
  return current.title === submitted.title && current.text === submitted.text && current.date === submitted.date
    ? { ...current, title: '', text: '' }
    : current
}

export function useCaptureSession(today: string) {
  const [draft, setDraft, storageFailed] = useLocalDraft('worklens.capture-draft.v1', { title: '', text: '', date: today }, isCaptureDraft)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  return { draft, setDraft, storageFailed, busy, setBusy, generating, setGenerating, retryingId, setRetryingId }
}

interface BatchDraft { pendingTexts: PendingTextItem[]; pasteDraft: string }
const isBatchDraft = (value: unknown): value is BatchDraft => {
  const draft = value as BatchDraft | null
  return Boolean(draft && typeof draft.pasteDraft === 'string' && Array.isArray(draft.pendingTexts) && draft.pendingTexts.length <= 200 && draft.pendingTexts.every(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.text === 'string'))
}

export function useBatchSession() {
  const [draft, setDraft, storageFailed] = useLocalDraft<BatchDraft>('worklens.batch-text-draft.v1', { pendingTexts: [], pasteDraft: '' }, isBatchDraft)
  const [phase, setPhase] = useState<BatchPhase>('compose')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const setPendingTexts: Dispatch<SetStateAction<PendingTextItem[]>> = update => setDraft(current => ({ ...current, pendingTexts: typeof update === 'function' ? update(current.pendingTexts) : update }))
  const setPasteDraft: Dispatch<SetStateAction<string>> = update => setDraft(current => ({ ...current, pasteDraft: typeof update === 'function' ? update(current.pasteDraft) : update }))
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [editingDateId, setEditingDateId] = useState<string | null>(null)
  const [localProgress, setLocalProgress] = useState<JobProgressEvent | null>(null)
  const [importProgress, setImportProgress] = useState<JobProgressEvent | null>(null)
  const [result, setResult] = useState<BatchImportResult | null>(null)
  const cancelRequestedRef = useRef(false)
  return { phase, setPhase, pendingFiles, setPendingFiles, ...draft, setPendingTexts, setPasteDraft, storageFailed, busy, setBusy, cancelling, setCancelling, retryingId, setRetryingId, editingDateId, setEditingDateId, localProgress, setLocalProgress, importProgress, setImportProgress, result, setResult, cancelRequestedRef }
}

export type CaptureSession = ReturnType<typeof useCaptureSession>
export type BatchSession = ReturnType<typeof useBatchSession>
