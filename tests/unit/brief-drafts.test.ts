import { describe, expect, it } from 'vitest'
import type { DailyBrief } from '../../src/shared/contracts'
import { acknowledgeBriefSave, isBriefDraftDirty, makeBriefDraft, reconcileBriefDraft } from '../../src/renderer/src/brief-drafts'

const brief: DailyBrief = { id: 'brief', workDate: '2026-09-13', standupDate: '2026-09-14', title: '今日工作', overview: '', script: '原始稿件', images: [], completed: [], inProgress: [], blockers: [], nextSteps: [], sourceItemIds: [], provider: 'test', model: 'test', createdAt: '2026-09-13T08:00:00Z', updatedAt: '2026-09-13T08:00:00Z' }

describe('brief drafts', () => {
  it('preserves local text and pasted images when the remote brief updates', () => {
    const draft = { ...makeBriefDraft(brief.workDate, brief), script: '人工修改', images: [{ id: 'image', name: '说明图', dataUrl: 'data:image/png;base64,test' }], revision: 1 }
    const result = reconcileBriefDraft(draft, { ...brief, script: '重新整理的稿件', updatedAt: '2026-09-13T09:00:00Z' })
    expect(result).toBe(draft)
    expect(isBriefDraftDirty(result)).toBe(true)
    expect(result.baseUpdatedAt).toBe(brief.updatedAt)
  })

  it('refreshes untouched drafts when a new stored version arrives', () => {
    const updated = { ...brief, script: '新生成的稿件', updatedAt: '2026-09-13T09:00:00Z' }
    const result = reconcileBriefDraft(makeBriefDraft(brief.workDate, brief), updated)
    expect(result.script).toBe(updated.script)
    expect(isBriefDraftDirty(result)).toBe(false)
  })

  it('acknowledges only submitted edits while preserving text and images added during saving', () => {
    const submitted = { ...makeBriefDraft(brief.workDate, brief), script: '提交时的修改', revision: 1 }
    const current = { ...submitted, script: '保存等待时继续写的内容', images: [{ id: 'later', name: '保存中粘贴的图', dataUrl: 'data:image/png;base64,later' }], revision: 2 }
    const updated = { ...brief, script: submitted.script, updatedAt: '2026-09-13T09:00:00Z' }
    const result = acknowledgeBriefSave(current, submitted, updated)
    expect(result.script).toBe(current.script)
    expect(result.images).toEqual(current.images)
    expect(result.baseScript).toBe(submitted.script)
    expect(result.baseUpdatedAt).toBe(updated.updatedAt)
    expect(isBriefDraftDirty(result)).toBe(true)
  })

  it('recognizes a saved draft after the renderer closed before acknowledging success', () => {
    const local = { ...makeBriefDraft(brief.workDate, brief), script: '关闭应用前提交的稿件', revision: 1 }
    const result = reconcileBriefDraft(local, { ...brief, script: local.script, updatedAt: '2026-09-13T09:00:00Z' })
    expect(isBriefDraftDirty(result)).toBe(false)
    expect(result.script).toBe(local.script)
  })

  it('ignores stale snapshots that predate the acknowledged saved version', () => {
    const latest = { ...brief, script: '最新保存稿', updatedAt: '2026-09-13T09:00:00Z' }
    const local = makeBriefDraft(brief.workDate, latest)
    expect(reconcileBriefDraft(local, brief)).toBe(local)
  })

  it('marks an unmodified submitted revision clean after success', () => {
    const submitted = { ...makeBriefDraft(brief.workDate, brief), script: '完成修改', revision: 1 }
    const result = acknowledgeBriefSave(submitted, submitted, { ...brief, script: submitted.script, updatedAt: '2026-09-13T09:00:00Z' })
    expect(isBriefDraftDirty(result)).toBe(false)
  })
})
