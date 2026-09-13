// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { WorkItem } from '../../src/shared/contracts'
import { WorkItemEditor } from '../../src/renderer/src/WorkItemEditor'
import { EventsPage } from '../../src/renderer/src/App'

const item = (key: string, title: string, overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: key, key, title, eventType: 'development', firstDate: '2026-08-01', latestDate: '2026-08-01',
  summary: `${title}的最近进展`, confidence: 0.95, evidence: [{ id: `evidence-${key}`, sourceItemId: `source-${key}`, targetType: 'event', targetId: `event-${key}`, quote: `${title}的原文`, blockIndex: 0, startOffset: null, endOffset: null, createdAt: '2026-08-01T00:00:00Z' }],
  sourceItemIds: [`source-${key}`], eventIds: [`event-${key}`], eventCount: 1, updatedAt: '2026-08-01T00:00:00Z', ...overrides
})

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('work item quality and navigation', () => {
  const props = {
    events: [], sources: [], onSelectSource: vi.fn(), onRequestDelete: vi.fn(),
    onChanged: vi.fn().mockResolvedValue(undefined), notify: vi.fn(), fail: vi.fn()
  }

  it('keeps fragments retrievable in review, explains why, and groups category aliases', () => {
    const items = [item('project', '支付模块'), item('fragment', '72%', { confidence: 0.45 }), item('cn', '订单模块', { eventType: '开发' })]
    render(createElement(EventsPage, { ...props, workItems: items }))
    expect(screen.queryByRole('article', { name: '工作事项：72%' })).not.toBeInTheDocument()
    expect(screen.getByText(/已收起 1 个疑似片段/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看并核对' }))
    const fragment = screen.getByRole('article', { name: '工作事项：72%' })
    expect(within(fragment).getByText(/标题仅包含数字、百分比或时间/)).toBeInTheDocument()
    expect(within(fragment).getByText(/AI 对归类的把握较低/)).toBeInTheDocument()
    expect(within(fragment).queryByText(/可信度/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '筛选工作事项类型' }))
    expect(screen.getByRole('option', { name: /开发/ })).toHaveTextContent('3 项')
    expect(screen.queryByRole('option', { name: /development/ })).not.toBeInTheDocument()
  })

  it('reveals and focuses a search target even when the selected category and review filter hide it', async () => {
    const items = [item('project', '支付模块'), item('fragment', '晚上22:07', { eventType: 'meeting', confidence: 0.4 })]
    const handled = vi.fn()
    const view = render(createElement(EventsPage, { ...props, workItems: items }))
    fireEvent.click(screen.getByRole('button', { name: '筛选工作事项类型' }))
    fireEvent.click(screen.getByRole('option', { name: /开发/ }))
    view.rerender(createElement(EventsPage, { ...props, workItems: items, focusedEventId: 'event-fragment', onFocusHandled: handled }))
    const target = await screen.findByRole('article', { name: '工作事项：晚上22:07' })
    await waitFor(() => expect(target).toHaveFocus())
    expect(target).toHaveClass('work-item-focused')
    expect(within(target).getByRole('button', { name: /1 次进展/ })).toHaveAttribute('aria-expanded', 'true')
    expect(handled).toHaveBeenCalledOnce()
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const scrollCount = scroll.mock.calls.length
    view.rerender(createElement(EventsPage, { ...props, workItems: [...items], focusedEventId: 'event-fragment', onFocusHandled: () => undefined }))
    expect(scroll).toHaveBeenCalledTimes(scrollCount)
  })

  it('jumps to the latest visible date while preserving the ascending timeline', () => {
    render(createElement(EventsPage, { ...props, workItems: [item('new', '最新交付', { latestDate: '2026-09-12' }), item('old', '早期交付')] }))
    const cards = screen.getAllByRole('article', { name: /^工作事项：/ })
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['工作事项：早期交付', '工作事项：最新交付'])
    fireEvent.click(screen.getByRole('button', { name: '最近更新' }))
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toHaveAttribute('data-work-item-date', '2026-09-12')
  })

  it('synchronizes the separate library entry with the local view switch', () => {
    const changed = vi.fn()
    const view = render(createElement(EventsPage, { ...props, workItems: [], onSectionChange: changed }))
    fireEvent.click(screen.getByRole('button', { name: '工作资料库' }))
    expect(changed).toHaveBeenCalledWith('library')
    expect(screen.getByText('工作资料库还是空的')).toBeInTheDocument()
    view.rerender(createElement(EventsPage, { ...props, workItems: [], initialSection: 'events', onSectionChange: changed }))
    fireEvent.click(screen.getByRole('button', { name: '工作事项' }))
    expect(changed).toHaveBeenCalledWith('events')
  })
})

describe('work item correction dialogs', () => {
  it('keeps user corrections on failure and retries the trimmed title with a normalized category', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('本地保存失败')).mockResolvedValueOnce(item('project', '支付接口优化'))
    window.worklens = { updateWorkItem: update } as unknown as typeof window.worklens
    const saved = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    render(createElement(WorkItemEditor, { item: item('project', '支付模块'), workItems: [], mode: 'edit', onClose: close, onSaved: saved }))
    fireEvent.change(screen.getByLabelText('事项标题'), { target: { value: '  支付接口优化  ' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'coding' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('本地保存失败')
    expect(screen.getByLabelText('事项标题')).toHaveValue('  支付接口优化  ')
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(update).toHaveBeenLastCalledWith({ workItemKey: 'project', title: '支付接口优化', eventType: '开发' })
    expect(saved).toHaveBeenCalledOnce()
  })

  it('requires an explicit merge target and previews the preserved evidence scope', async () => {
    const source = item('source', '接口联调')
    const target = item('target', '支付模块', { sourceItemIds: ['source-source', 'source-other'], eventIds: ['event-target', 'event-next'], eventCount: 2 })
    const merge = vi.fn().mockResolvedValue(target)
    window.worklens = { mergeWorkItems: merge } as unknown as typeof window.worklens
    render(createElement(WorkItemEditor, { item: source, workItems: [source, target], mode: 'merge', onClose: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined) }))
    expect(screen.getByRole('button', { name: '合并到所选事项' })).toBeDisabled()
    expect(screen.queryByRole('option', { name: /接口联调/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('合并到'), { target: { value: 'target' } })
    expect(screen.getByText(/共 3 次进展 · 2 份来源/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '合并到所选事项' }))
    await waitFor(() => expect(merge).toHaveBeenCalledWith({ sourceWorkItemKey: 'source', targetWorkItemKey: 'target' }))
  })

  it('contains keyboard focus and restores it to the opening control when dismissed', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const view = render(createElement(WorkItemEditor, { item: item('project', '支付模块'), workItems: [], mode: 'edit', onClose: close, onSaved: vi.fn() }))
    expect(screen.getByLabelText('事项标题')).toHaveFocus()
    screen.getByRole('button', { name: '保存修改' }).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭事项编辑' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
