import type { DailyBrief, DailyBriefImage } from '@shared/contracts'

export interface BriefDraft {
  workDate: string
  briefId: string | null
  script: string
  images: DailyBriefImage[]
  baseScript: string
  baseImages: DailyBriefImage[]
  baseUpdatedAt: string | null
  revision: number
  persistenceError?: string
  persisted?: boolean
}

export function makeBriefDraft(workDate: string, brief: DailyBrief | null): BriefDraft {
  return { workDate, briefId: brief?.id ?? null, script: brief?.script ?? '', images: brief?.images ?? [], baseScript: brief?.script ?? '', baseImages: brief?.images ?? [], baseUpdatedAt: brief?.updatedAt ?? null, revision: 0 }
}

export function isBriefDraftDirty(draft: BriefDraft): boolean {
  return draft.script !== draft.baseScript || JSON.stringify(draft.images) !== JSON.stringify(draft.baseImages)
}

/** Remote refreshes replace clean drafts only. Local text and images always win while dirty. */
export function reconcileBriefDraft(draft: BriefDraft, brief: DailyBrief | null): BriefDraft {
  if (!brief || (draft.briefId === brief.id && draft.baseUpdatedAt === brief.updatedAt)) return draft
  if (draft.briefId === brief.id && draft.baseUpdatedAt && brief.updatedAt < draft.baseUpdatedAt) return draft
  const alreadySaved = draft.script === brief.script && JSON.stringify(draft.images) === JSON.stringify(brief.images ?? [])
  if (isBriefDraftDirty(draft) && !alreadySaved) return draft
  return { ...makeBriefDraft(draft.workDate, brief), revision: draft.revision, persisted: draft.persisted }
}

/** A response acknowledges the submitted revision, never text typed during the request. */
export function acknowledgeBriefSave(current: BriefDraft, submitted: BriefDraft, updated: DailyBrief): BriefDraft {
  const untouched = current.revision === submitted.revision
  return { ...current, briefId: updated.id, script: untouched ? updated.script : current.script, images: untouched ? updated.images ?? [] : current.images, baseScript: updated.script, baseImages: updated.images ?? [], baseUpdatedAt: updated.updatedAt, persistenceError: undefined, persisted: false }
}

const drafts = new Map<string, BriefDraft>()
const listeners = new Set<() => void>()
const loads = new Map<string, Promise<void>>()
const writes = new Map<string, Promise<void>>()
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('浏览器草稿存储不可用')); return }
    const request = indexedDB.open('worklens-brief-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'workDate' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开草稿存储'))
  })
  return database
}

function emit(): void { listeners.forEach((listener) => listener()) }
export function subscribeBriefDrafts(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function getBriefDraft(workDate: string): BriefDraft | undefined { return drafts.get(workDate) }

function persist(draft: BriefDraft): void {
  const task = (writes.get(draft.workDate) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put({ ...draft, persisted: true, persistenceError: undefined })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('草稿保存失败'))
      transaction.onabort = () => reject(transaction.error ?? new Error('草稿保存中断'))
    })
    if (drafts.get(draft.workDate) === draft) {
      drafts.set(draft.workDate, { ...draft, persisted: true, persistenceError: undefined }); emit()
    }
  }).catch(() => {
    if (drafts.get(draft.workDate) === draft) {
      drafts.set(draft.workDate, { ...draft, persisted: false, persistenceError: '草稿暂存失败，当前内容仍保留在本次使用中；请保存修改后再关闭应用。' }); emit()
    }
  })
  writes.set(draft.workDate, task)
}

export function putBriefDraft(draft: BriefDraft): void {
  const next = { ...draft, persisted: false, persistenceError: undefined }
  drafts.set(draft.workDate, next)
  emit()
  persist(next)
}

export function updateBriefDraft(workDate: string, fallback: BriefDraft, change: (current: BriefDraft) => BriefDraft): void {
  putBriefDraft(change(drafts.get(workDate) ?? fallback))
}

export function ensureBriefDraft(workDate: string, brief: DailyBrief | null): void {
  const existing = drafts.get(workDate)
  const initial = existing ? reconcileBriefDraft(existing, brief) : makeBriefDraft(workDate, brief)
  if (initial !== existing) { drafts.set(workDate, initial); emit() }
  if (loads.has(workDate)) {
    if (initial !== existing) persist(initial)
    return
  }
  const task = (async () => {
    try {
      const db = await openDatabase()
      const stored = await new Promise<BriefDraft | undefined>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get(workDate)
        request.onsuccess = () => resolve(request.result as BriefDraft | undefined)
        request.onerror = () => reject(request.error)
      })
      // Edits made while IndexedDB opens take precedence over its older snapshot.
      const current = drafts.get(workDate)
      if (stored && current === initial && typeof stored.script === 'string' && Array.isArray(stored.images)) {
        putBriefDraft(reconcileBriefDraft(stored, brief))
      } else if (current) persist(current)
    } catch {
      const current = drafts.get(workDate)
      if (current) persist(current)
    }
  })()
  loads.set(workDate, task)
}
