import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { WorkItem } from '@shared/contracts'
import { normalizeWorkItemCategory } from '@shared/work-item-quality'
import './work-item-experience.css'

interface WorkItemEditorProps {
  item: WorkItem
  workItems: WorkItem[]
  mode: 'edit' | 'merge'
  onClose: () => void
  onSaved: (item: WorkItem, message: string) => Promise<void>
}

export function WorkItemEditor({ item, workItems, mode, onClose, onSaved }: WorkItemEditorProps): ReactNode {
  const [title, setTitle] = useState(item.title)
  const [category, setCategory] = useState(normalizeWorkItemCategory(item.eventType))
  const [targetKey, setTargetKey] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const initialFocusRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy
  const candidates = workItems.filter((candidate) => candidate.key !== item.key)
  const target = candidates.find((candidate) => candidate.key === targetKey)
  const matches = candidates.filter((candidate) => candidate.key === targetKey || `${candidate.title} ${normalizeWorkItemCategory(candidate.eventType)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const categories = Array.from(new Set(['进展', '会议', '交付', '问题修复', '决策', '需求', ...workItems.map((candidate) => normalizeWorkItemCategory(candidate.eventType))]))

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    initialFocusRef.current?.focus()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) onCloseRef.current()
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) {
        event.preventDefault()
        dialogRef.current?.focus()
      } else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busyRef.current) return
    if (mode === 'edit' && (!title.trim() || !category.trim())) {
      setError('请填写事项标题和分类。')
      return
    }
    if (mode === 'merge' && !target) {
      setError('请选择要合并到的工作事项。')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const updated = mode === 'edit'
        ? await window.worklens.updateWorkItem({ workItemKey: item.key, title: title.trim(), eventType: normalizeWorkItemCategory(category) })
        : await window.worklens.mergeWorkItems({ sourceWorkItemKey: item.key, targetWorkItemKey: target!.key })
      await onSaved(updated, mode === 'edit' ? '事项标题和分类已保存' : '事项已合并，历史进展与来源均已保留')
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作未完成，请重试。')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return <div className="work-item-editor-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="work-item-editor" role="dialog" aria-modal="true" aria-labelledby="work-item-editor-title" aria-describedby="work-item-editor-description" aria-busy={busy} tabIndex={-1}>
      <header><h3 id="work-item-editor-title">{mode === 'edit' ? '修改工作事项' : '合并工作事项'}</h3><button type="button" className="icon-button" aria-label="关闭事项编辑" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <p id="work-item-editor-description">{mode === 'edit' ? '保存人工校正后的标题和分类，保留原始资料与历史进展。' : '将当前事项的全部历史进展、来源和证据归入所选事项，保留目标事项的标题与分类。'}</p>
      <form onSubmit={(event) => void submit(event)}>
        {mode === 'edit' ? <>
          <label htmlFor="work-item-title-input">事项标题<input ref={initialFocusRef} id="work-item-title-input" value={title} maxLength={120} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
          <label htmlFor="work-item-category-input">分类<input id="work-item-category-input" list="work-item-category-options" value={category} maxLength={40} disabled={busy} onChange={(event) => setCategory(event.target.value)} /><datalist id="work-item-category-options">{categories.map((value) => <option value={value} key={value} />)}</datalist></label>
        </> : <>
          <div className="work-item-merge-current"><span>当前事项</span><strong>{item.title}</strong><small>{item.eventCount} 次进展 · {item.sourceItemIds.length} 份来源</small></div>
          <label htmlFor="work-item-merge-search">查找目标事项<input ref={initialFocusRef} id="work-item-merge-search" value={search} placeholder="输入事项标题或分类" disabled={busy} onChange={(event) => setSearch(event.target.value)} /></label>
          <label htmlFor="work-item-merge-target">合并到<select id="work-item-merge-target" value={targetKey} disabled={busy} onChange={(event) => setTargetKey(event.target.value)}><option value="">请选择工作事项</option>{matches.map((candidate) => <option value={candidate.key} key={candidate.key}>{candidate.title} · {normalizeWorkItemCategory(candidate.eventType)}</option>)}</select></label>
          {!matches.length && <p className="work-item-editor-hint">没有匹配的事项，请换一个关键词。</p>}
          {target && <div className="work-item-merge-preview"><span>合并后保留</span><strong>{target.title}</strong><p>{target.summary}</p><small>{normalizeWorkItemCategory(target.eventType)} · 共 {new Set([...item.eventIds, ...target.eventIds]).size} 次进展 · {new Set([...item.sourceItemIds, ...target.sourceItemIds]).size} 份来源</small></div>}
        </>}
        {error && <p className="work-item-editor-error" role="alert">{error}</p>}
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || (mode === 'merge' && !target)}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? '正在保存' : mode === 'edit' ? '保存修改' : '合并到所选事项'}</button></footer>
      </form>
    </section>
  </div>
}
