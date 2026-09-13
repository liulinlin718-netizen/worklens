// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DailyBrief, DailyBriefVersion, SourceItem, WorkLensApi } from '../../src/shared/contracts'
import { BriefsPage, scriptParagraphs, useBriefOperationSession } from '../../src/renderer/src/brief-page'

let sequence = 0
function fixture(): DailyBrief {
  sequence += 1
  return { id: `brief-${sequence}`, workDate: `2026-10-${String(sequence).padStart(2, '0')}`, standupDate: `2026-11-${String(sequence).padStart(2, '0')}`, title: '工作回顾', overview: '', script: '已完成接口联调。\n\n今天推进发布验证。', images: [], completed: ['接口联调'], inProgress: ['发布验证'], blockers: [], nextSteps: ['上线'], sourceItemIds: [], provider: 'test', model: 'test', createdAt: '2026-09-13T08:00:00Z', updatedAt: '2026-09-13T08:00:00Z' }
}
function props(brief: DailyBrief, all = [brief]) {
  return { briefs: all, sources: [], selectedDate: brief.workDate, setSelectedDate: vi.fn(), onChanged: vi.fn().mockResolvedValue(undefined), notify: vi.fn(), fail: vi.fn() }
}
afterEach(cleanup)
beforeEach(() => {
  Object.defineProperty(window, 'worklens', { configurable: true, value: { listDailyBriefVersions: vi.fn().mockResolvedValue([]), updateDailyBrief: vi.fn(), generateDailyBrief: vi.fn(), acceptDailyBriefVersion: vi.fn(), restoreDailyBriefVersion: vi.fn(), copyText: vi.fn().mockResolvedValue({ message: '已复制' }) } as unknown as WorkLensApi })
})

describe('brief reading and editing', () => {
  it('groups long narratives at complete sentences while preserving short authored paragraphs, URLs and decimals', () => {
    const sentence = '接口平均耗时降至 1.25 秒，验证详情 https://example.test/report?id=1.25&view=full，团队完成了全部发布前的检查，并补充了失败重试记录。'
    const longNarrative = sentence.repeat(5)
    const paragraphs = scriptParagraphs(longNarrative)
    expect(paragraphs.length).toBeGreaterThan(1)
    expect(paragraphs.join('')).toBe(longNarrative)
    expect(paragraphs.every((paragraph) => paragraph.endsWith('。'))).toBe(true)
    expect(paragraphs.every((paragraph) => paragraph.includes('1.25 秒') && paragraph.includes('https://example.test/report?id=1.25&view=full'))).toBe(true)
    expect(scriptParagraphs('短段落保持完整。第二句话。\n\n下一段。')).toEqual(['短段落保持完整。第二句话。', '下一段。'])
  })

  it('defaults to readable paragraphs, distinguishes dates and allows history to collapse', () => {
    const brief = fixture()
    render(createElement(BriefsPage, props(brief)))
    expect(screen.queryByLabelText('逐字稿正文')).toBeNull()
    expect(screen.getByLabelText('逐字稿阅读正文').querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByText(`早会使用日期 · ${brief.standupDate}`)).toBeTruthy()
    expect(screen.getByText(`工作日期 · ${brief.workDate} 依据 0 份工作资料`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起历史' }))
    expect(screen.queryByLabelText('早会稿日期历史')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    expect((screen.getByLabelText('逐字稿正文') as HTMLTextAreaElement).value).toBe(brief.script)
  })

  it('keeps separate drafts when switching dates and when leaving and reopening the page', async () => {
    const first = fixture(), second = fixture()
    const view = render(createElement(BriefsPage, props(first, [first, second])))
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '第一天未提交的人工修改' } })
    view.rerender(createElement(BriefsPage, props(second, [first, second])))
    expect((screen.getByLabelText('逐字稿正文') as HTMLTextAreaElement).value).toBe(second.script)
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '第二天未提交的修改' } })
    view.rerender(createElement(BriefsPage, props(first, [first, second])))
    expect((screen.getByLabelText('逐字稿正文') as HTMLTextAreaElement).value).toBe('第一天未提交的人工修改')
    view.unmount()
    render(createElement(BriefsPage, props(second, [first, second])))
    expect(screen.getByLabelText('逐字稿阅读正文').textContent).toBe('第二天未提交的修改')
    await act(async () => {})
  })

  it('preserves input added while save is pending, including after a date switch', async () => {
    const first = fixture(), second = fixture()
    let resolveSave!: (value: DailyBrief) => void
    vi.mocked(window.worklens.updateDailyBrief).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve }))
    const view = render(createElement(BriefsPage, props(first, [first, second])))
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '本次提交' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '等待保存时又补充了内容' } })
    view.rerender(createElement(BriefsPage, props(second, [first, second])))
    await act(async () => resolveSave({ ...first, script: '本次提交', updatedAt: '2026-09-13T09:00:00Z' }))
    expect((screen.getByLabelText('逐字稿正文') as HTMLTextAreaElement).value).toBe(second.script)
    view.rerender(createElement(BriefsPage, props(first, [first, second])))
    expect((screen.getByLabelText('逐字稿正文') as HTMLTextAreaElement).value).toBe('等待保存时又补充了内容')
  })

  it('keeps pending save state when the page unmounts so it cannot be submitted twice', async () => {
    const brief = fixture()
    let resolveSave!: (value: DailyBrief) => void
    vi.mocked(window.worklens.updateDailyBrief).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve }))
    function Harness() {
      const session = useBriefOperationSession()
      const [visible, setVisible] = useState(true)
      return createElement('div', null,
        createElement('button', { onClick: () => setVisible((value) => !value) }, '切换页面'),
        visible && createElement(BriefsPage, { ...props(brief), session }))
    }
    render(createElement(Harness))
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '待保存人工稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }))
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }))
    expect((screen.getByRole('button', { name: '正在保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.worklens.updateDailyBrief).toHaveBeenCalledTimes(1)
    await act(async () => resolveSave({ ...brief, script: '待保存人工稿', updatedAt: '2026-09-13T09:00:00Z' }))
    expect(screen.getByLabelText('逐字稿阅读正文').textContent).toBe('待保存人工稿')
    expect(screen.queryByRole('button', { name: '正在保存' })).toBeNull()
  })

  it('keeps AI generation state across navigation and copies the current draft in reading mode', async () => {
    const brief = fixture()
    let resolveGeneration!: (value: { ok: boolean; message: string }) => void
    vi.mocked(window.worklens.generateDailyBrief).mockImplementation(() => new Promise((resolve) => { resolveGeneration = resolve }))
    function Harness() {
      const session = useBriefOperationSession()
      const [visible, setVisible] = useState(true)
      return createElement('div', null,
        createElement('button', { onClick: () => setVisible((value) => !value) }, '切换页面'),
        visible && createElement(BriefsPage, { ...props(brief), session, sources: [{ id: 'source', workDates: [brief.workDate] } as SourceItem] }))
    }
    render(createElement(Harness))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }))
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }))
    expect((screen.getByRole('button', { name: '正在整理' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.worklens.generateDailyBrief).toHaveBeenCalledTimes(1)
    await act(async () => resolveGeneration({ ok: true, message: '已整理' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '复制这份最新草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '阅读模式' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制逐字稿' })))
    expect(window.worklens.copyText).toHaveBeenCalledWith('复制这份最新草稿')
  })

  it('compares AI candidates and adopts them without losing the current version', async () => {
    const brief = { ...fixture(), manualLocked: true, pendingAiVersionId: 'candidate' }
    const candidate: DailyBriefVersion = { ...brief, script: 'AI 新的整理内容', versionId: 'candidate', kind: 'ai', savedAt: '2026-09-13T09:00:00Z', isCurrent: false }
    vi.mocked(window.worklens.listDailyBriefVersions).mockResolvedValue([candidate])
    vi.mocked(window.worklens.acceptDailyBriefVersion).mockResolvedValue({ ...brief, script: candidate.script, pendingAiVersionId: null, updatedAt: '2026-09-13T09:00:01Z' })
    render(createElement(BriefsPage, props(brief)))
    fireEvent.click(screen.getByRole('button', { name: '比较新稿' }))
    await screen.findByText('AI 新的整理内容')
    fireEvent.click(screen.getByRole('button', { name: '采用 AI 新稿' }))
    await waitFor(() => expect(window.worklens.acceptDailyBriefVersion).toHaveBeenCalledWith({ briefId: brief.id, versionId: 'candidate', expectedUpdatedAt: brief.updatedAt }))
    await act(async () => {})
  })

  it('requires local edits to be saved before replacing the draft with a version', async () => {
    const brief = { ...fixture(), pendingAiVersionId: 'candidate-dirty' }
    vi.mocked(window.worklens.listDailyBriefVersions).mockResolvedValue([{ ...brief, versionId: 'candidate-dirty', kind: 'ai', savedAt: brief.updatedAt, isCurrent: false }])
    render(createElement(BriefsPage, props(brief)))
    fireEvent.click(screen.getByRole('button', { name: '编辑稿件' }))
    fireEvent.change(screen.getByLabelText('逐字稿正文'), { target: { value: '尚未保存的人工稿' } })
    fireEvent.click(screen.getByRole('button', { name: '比较新稿' }))
    const adopt = await screen.findByRole('button', { name: '采用 AI 新稿' }) as HTMLButtonElement
    expect(adopt.disabled).toBe(true)
    expect(screen.getByText('请先保存当前修改，再采用或恢复版本。')).toBeTruthy()
  })
})
