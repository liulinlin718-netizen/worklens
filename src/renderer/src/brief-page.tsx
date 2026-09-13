import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type ReactNode } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronRight, Clipboard, Copy, History, LoaderCircle, RefreshCw, Save, X } from 'lucide-react'
import type { DailyBrief, DailyBriefImage, DailyBriefVersion, SourceItem } from '@shared/contracts'
import { acknowledgeBriefSave, ensureBriefDraft, getBriefDraft, isBriefDraftDirty, makeBriefDraft, subscribeBriefDrafts, updateBriefDraft } from './brief-drafts'
import './brief-page.css'

const MAX_IMAGES = 6
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
interface BriefsPageProps {
  briefs: DailyBrief[]
  sources: SourceItem[]
  selectedDate: string
  setSelectedDate: (date: string) => void
  onChanged: () => Promise<void>
  notify: (message: string) => void
  fail: (error: unknown) => void
  session?: ReturnType<typeof useBriefOperationSession>
  aiReady?: boolean
  onOpenSettings?: () => void
}

export function useBriefOperationSession() {
  const [processingDate, setProcessingDate] = useState<string | null>(null)
  const [savingDate, setSavingDate] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ date: string; kind: 'save' | 'generate' | 'version'; message: string } | null>(null)
  return { processingDate, setProcessingDate, savingDate, setSavingDate, operationError, setOperationError }
}

export function BriefsPage({ briefs, sources, selectedDate, setSelectedDate, onChanged, notify, fail, session, aiReady = true, onOpenSettings }: BriefsPageProps): ReactNode {
  const localSession = useBriefOperationSession()
  const { processingDate, setProcessingDate, savingDate, setSavingDate, operationError, setOperationError } = session ?? localSession
  const busy = processingDate !== null
  const saving = savingDate !== null
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [showHistory, setShowHistory] = useState(true)
  const [dateMenuOpen, setDateMenuOpen] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [versions, setVersions] = useState<{ briefId: string; items: DailyBriefVersion[] } | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const dateMenuRef = useRef<HTMLDivElement>(null)
  const versionRequest = useRef(0)
  const brief = briefs.find((item) => item.workDate === selectedDate) ?? null
  const storedDraft = useSyncExternalStore(subscribeBriefDrafts, () => getBriefDraft(selectedDate))
  const fallbackDraft = useMemo(() => makeBriefDraft(selectedDate, brief), [selectedDate, brief])
  const draft = storedDraft ?? fallbackDraft
  const dirty = isBriefDraftDirty(draft)
  const conflict = dirty && brief !== null && draft.baseUpdatedAt !== brief.updatedAt
  const sourceCount = sources.filter((source) => workDates(source).includes(selectedDate)).length
  const availableDates = Array.from(new Set([selectedDate, ...briefs.map((item) => item.workDate), ...sources.flatMap(workDates)])).sort((a, b) => b.localeCompare(a))
  const currentVersions = versions?.briefId === brief?.id ? versions?.items ?? [] : []
  const selectedVersion = currentVersions.find((item) => item.versionId === selectedVersionId) ?? currentVersions.find((item) => item.versionId === brief?.pendingAiVersionId) ?? currentVersions[0]
  const error = operationError?.date === selectedDate ? operationError : null

  useEffect(() => { ensureBriefDraft(selectedDate, brief) }, [selectedDate, brief])
  useEffect(() => {
    const close = (event: PointerEvent): void => { if (!dateMenuRef.current?.contains(event.target as Node)) setDateMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  const loadVersions = async (): Promise<void> => {
    if (!brief) return
    const request = ++versionRequest.current
    setLoadingVersions(true)
    try {
      const items = await window.worklens.listDailyBriefVersions(brief.id)
      if (versionRequest.current === request) setVersions({ briefId: brief.id, items })
    } catch (error) {
      if (versionRequest.current === request) setOperationError({ date: selectedDate, kind: 'version', message: messageOf(error) })
    } finally { if (versionRequest.current === request) setLoadingVersions(false) }
  }
  useEffect(() => {
    versionRequest.current += 1
    setSelectedVersionId(null)
    if (showVersions && brief) void loadVersions()
    return () => { versionRequest.current += 1 }
  }, [brief?.id, brief?.updatedAt, brief?.pendingAiVersionId, showVersions])

  const changeScript = (script: string): void => updateBriefDraft(selectedDate, draft, (current) => ({ ...current, script, revision: current.revision + 1 }))
  const changeImages = (change: (images: DailyBriefImage[]) => DailyBriefImage[]): void => updateBriefDraft(selectedDate, draft, (current) => ({ ...current, images: change(current.images), revision: current.revision + 1 }))

  const generate = async (): Promise<void> => {
    if (!aiReady || busy || saving) return
    const date = selectedDate
    setProcessingDate(date)
    setOperationError(null)
    try {
      // Protect a local revision before AI processing can update the stored brief.
      if (brief && dirty) {
        const submitted = getBriefDraft(date) ?? draft
        const updated = await window.worklens.updateDailyBrief({ briefId: brief.id, script: submitted.script, images: submitted.images, expectedUpdatedAt: brief.updatedAt })
        updateBriefDraft(date, submitted, (current) => acknowledgeBriefSave(current, submitted, updated))
      }
      const result = await window.worklens.generateDailyBrief(date)
      await onChanged()
      notify(result.message)
    } catch (error) {
      setOperationError({ date, kind: 'generate', message: messageOf(error) })
      await onChanged().catch(() => {})
    } finally { setProcessingDate(null) }
  }
  const saveBrief = async (): Promise<void> => {
    if (!brief || !draft.script.trim() || saving) return
    const date = selectedDate
    const submitted = getBriefDraft(date) ?? draft
    setSavingDate(date)
    setOperationError(null)
    try {
      const updated = await window.worklens.updateDailyBrief({ briefId: brief.id, script: submitted.script, images: submitted.images, expectedUpdatedAt: conflict ? brief.updatedAt : submitted.baseUpdatedAt ?? undefined })
      updateBriefDraft(date, submitted, (current) => acknowledgeBriefSave(current, submitted, updated))
      await onChanged()
      if (showVersions) void loadVersions()
      notify('逐字稿已保存；人工修改会保留，AI 新稿可单独比较')
    } catch (error) {
      setOperationError({ date, kind: 'save', message: messageOf(error) })
      await onChanged().catch(() => {})
    } finally { setSavingDate(null) }
  }
  const applyVersion = async (): Promise<void> => {
    if (!brief || !selectedVersion || dirty || saving || busy) return
    const date = selectedDate
    const submitted = getBriefDraft(date) ?? draft
    setSavingDate(date)
    setOperationError(null)
    try {
      const input = { briefId: brief.id, versionId: selectedVersion.versionId, expectedUpdatedAt: brief.updatedAt }
      const isCandidate = selectedVersion.versionId === brief.pendingAiVersionId
      const updated = await (isCandidate ? window.worklens.acceptDailyBriefVersion(input) : window.worklens.restoreDailyBriefVersion(input))
      updateBriefDraft(date, submitted, (current) => acknowledgeBriefSave(current, submitted, updated))
      await onChanged()
      await loadVersions()
      notify(isCandidate ? '已采用 AI 新版本，原稿可从版本记录恢复' : '已恢复所选版本，替换前的稿件仍保留在版本记录中')
    } catch (error) {
      setOperationError({ date, kind: 'version', message: messageOf(error) })
      await onChanged().catch(() => {})
    } finally { setSavingDate(null) }
  }
  const copy = async (): Promise<void> => {
    try { notify((await window.worklens.copyText(draft.script)).message) } catch (error) { fail(error) }
  }
  const pasteImages = async (event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file))
    if (!files.length) return
    if (files.some((file) => !IMAGE_TYPES.has(file.type))) { fail(new Error('暂不支持这种图片格式，请粘贴 PNG、JPG、WebP 或 GIF 图片')); return }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) { fail(new Error('单张图片不能超过 5 MB，请压缩后再粘贴')); return }
    const date = selectedDate
    try {
      const images = await Promise.all(files.slice(0, MAX_IMAGES).map(async (file, index) => ({ id: crypto.randomUUID(), name: file.name || `粘贴图片-${index + 1}`, dataUrl: await readImage(file) })))
      let added = 0
      updateBriefDraft(date, draft, (current) => {
        const accepted = images.slice(0, MAX_IMAGES - current.images.length)
        added = accepted.length
        return { ...current, images: [...current.images, ...accepted], revision: current.revision + 1 }
      })
      notify(added ? `已加入 ${added} 张图片，随草稿暂存；保存修改后加入正式稿` : `逐字稿最多保存 ${MAX_IMAGES} 张图片，请先移除一张`)
    } catch (error) { fail(error) }
  }

  return <div className={`brief-layout brief-experience ${showHistory ? '' : 'history-collapsed'}`}>
    {showHistory && <aside className="brief-history panel" aria-label="早会稿日期历史">
      <div className="panel-header"><div><h2>日报历史</h2><p>{briefs.length} 个工作日</p></div></div>
      <div className="brief-history-list">{briefs.map((item) => <button key={item.id} className={item.workDate === selectedDate ? 'active' : ''} onClick={() => setSelectedDate(item.workDate)}><div><strong>{friendlyDate(item.workDate)}</strong><span>{item.title}</span></div><small>{getBriefDraft(item.workDate) && isBriefDraftDirty(getBriefDraft(item.workDate)!) ? '有草稿' : `${item.sourceItemIds.length} 份资料`}</small><ChevronRight size={15} /></button>)}{!briefs.length && <div className="history-empty">生成日报后会保存在这里</div>}</div>
    </aside>}
    <section className="brief-main">
      <div className="brief-toolbar">
        <button className="text-button brief-history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}><History size={15} />{showHistory ? '收起历史' : '展开历史'}</button>
        <div className={`brief-date-menu ${dateMenuOpen ? 'open' : ''}`} ref={dateMenuRef}><button className="brief-date-trigger" aria-label="选择工作日期" aria-haspopup="listbox" aria-expanded={dateMenuOpen} onClick={() => setDateMenuOpen((open) => !open)}><CalendarDays size={15} /><span><strong>工作日期 · {friendlyDate(selectedDate)}</strong><small>{selectedDate}</small></span><ChevronDown size={14} /></button>{dateMenuOpen && <div className="brief-date-popover" role="listbox" aria-label="工作日期">{availableDates.map((date) => <button key={date} className={date === selectedDate ? 'selected' : ''} role="option" aria-selected={date === selectedDate} onClick={() => { setSelectedDate(date); setDateMenuOpen(false) }}><span><strong>{friendlyDate(date)}</strong><small>{date} · {sources.filter((source) => workDates(source).includes(date)).length} 份资料</small></span>{date === selectedDate && <Check size={14} />}</button>)}</div>}</div>
        <span>{sourceCount} 份原始资料</span>
        <button className="secondary-button" disabled={busy || saving || !sourceCount || !aiReady || (dirty && !draft.script.trim())} onClick={() => void generate()}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{busy ? '正在整理' : brief ? dirty ? '保存草稿并重新生成' : '重新生成' : '生成早会稿'}</button>
        {brief && <button className="secondary-button" disabled={saving || busy || !draft.script.trim() || !dirty} onClick={() => void saveBrief()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{saving ? '正在保存' : conflict ? '将草稿保存为新版本' : '保存修改'}</button>}
        {brief && <button className="primary-button" disabled={!draft.script.trim()} onClick={() => void copy()}><Copy size={15} />复制逐字稿</button>}
      </div>
      {!aiReady && <div className="brief-notice">AI 尚未连接，已保存的稿件仍可阅读和编辑。{onOpenSettings && <button className="text-button" onClick={onOpenSettings}>连接 AI</button>}</div>}
      {busy && <div className="brief-notice" role="status">正在整理 {processingDate} 的资料，完成后可查看新稿。当前草稿会保留。</div>}
      {error && <div className="brief-notice warning" role="alert"><span>{error.message}</span><button className="text-button" disabled={busy || saving} onClick={() => void (error.kind === 'save' ? saveBrief() : error.kind === 'generate' ? generate() : loadVersions())}>{error.kind === 'version' ? '刷新版本' : '重试'}</button></div>}
      {brief ? <>
        <div className="brief-draft-status" role="status"><span>{savingDate === selectedDate ? '正在保存当前版本…' : dirty ? draft.persistenceError ? '有未提交修改 · 草稿暂存失败' : draft.persisted ? '有未提交修改 · 草稿已自动保存在本机' : '有未提交修改 · 正在暂存草稿…' : brief.manualLocked ? '人工稿已保存 · AI 整理将生成独立版本' : '已保存'}</span><button className="text-button" aria-expanded={showVersions} onClick={() => setShowVersions((value) => !value)}>版本记录{brief.pendingAiVersionId ? ' · 有 AI 新稿' : ''}</button></div>
        {draft.persistenceError && <div className="brief-notice warning" role="alert">{draft.persistenceError}</div>}
        {conflict && <div className="brief-notice warning">已保存的稿件有更新，当前草稿已保留。可展开版本记录比较；“将草稿保存为新版本”会保留旧稿供恢复。</div>}
        {brief.pendingAiVersionId && !showVersions && <div className="brief-notice"><span>资料已重新整理，AI 新稿正在等待采用；当前人工稿已保留。</span><button className="text-button" onClick={() => setShowVersions(true)}>比较新稿</button></div>}
        {showVersions && <section className="brief-versions panel" aria-label="稿件版本比较">
          <div className="brief-version-head"><h3>比较与恢复版本</h3><button className="text-button" disabled={loadingVersions} onClick={() => void loadVersions()}>刷新</button></div>
          {loadingVersions ? <p role="status">正在读取版本…</p> : currentVersions.length ? <>
            <label className="brief-version-select">选择版本<select aria-label="选择稿件版本" value={selectedVersion?.versionId ?? ''} onChange={(event) => setSelectedVersionId(event.target.value)}>{currentVersions.map((version) => <option value={version.versionId} key={version.versionId}>{version.isCurrent ? '当前已保存 · ' : ''}{version.versionId === brief.pendingAiVersionId ? '待采用 AI 新稿' : version.kind === 'ai' ? 'AI 稿' : version.kind === 'manual' ? '人工稿' : '恢复版本'} · {formatTimestamp(version.savedAt)}</option>)}</select></label>
            {selectedVersion && <><div className="brief-version-comparison"><div><h4>{dirty ? '当前本地草稿' : '当前稿件'}</h4><VersionContent script={draft.script} images={draft.images} /></div><div><h4>{selectedVersion.versionId === brief.pendingAiVersionId ? 'AI 新稿' : '所选版本'}</h4><VersionContent script={selectedVersion.script} images={selectedVersion.images ?? []} /></div></div><div className="brief-version-actions"><p>{dirty ? '请先保存当前修改，再采用或恢复版本。' : '采用或恢复后，替换前的稿件仍保留在版本记录中。'}</p><button className="secondary-button" disabled={dirty || saving || busy || selectedVersion.isCurrent} onClick={() => void applyVersion()}>{selectedVersion.versionId === brief.pendingAiVersionId ? '采用 AI 新稿' : selectedVersion.isCurrent ? '当前版本' : '恢复此版本'}</button></div></>}
          </> : <p>尚无版本记录。保存修改或重新生成后会在这里保留版本。</p>}
        </section>}
        <article className="standup-script-card">
          <div className="script-card-head"><div><div className="eyebrow"><Clipboard size={14} />早会使用日期 · {brief.standupDate}</div><h2>{brief.title}</h2><p>工作日期 · {brief.workDate}　依据 {brief.sourceItemIds.length} 份工作资料</p></div><span>{Math.max(1, Math.ceil(draft.script.replace(/\s/g, '').length / 260))} 分钟</span></div>
          <div className="brief-reading-controls"><div role="group" aria-label="稿件显示模式"><button className={mode === 'read' ? 'active' : ''} aria-pressed={mode === 'read'} onClick={() => setMode('read')}>阅读模式</button><button className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑稿件</button></div><span>{dirty ? '正在展示本地草稿' : '可直接照着念'}</span></div>
          <div className={`script-paper ${mode === 'edit' ? 'editing' : 'reading'}`}>
            {mode === 'edit' ? <><textarea aria-label="逐字稿正文" aria-describedby="script-paste-hint" value={draft.script} onChange={(event) => changeScript(event.target.value)} onPaste={(event) => void pasteImages(event)} maxLength={50_000} /><div className="script-paste-hint" id="script-paste-hint"><Clipboard size={13} /><span>文字和图片按工作日期自动暂存；点击“保存修改”加入正式稿。可粘贴最多 {MAX_IMAGES} 张图片。</span><strong>{draft.images.length}/{MAX_IMAGES}</strong></div></> : <div aria-label="逐字稿阅读正文">{scriptParagraphs(draft.script).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>}
            {draft.images.length > 0 && <div className="script-image-grid">{draft.images.map((image) => <figure key={image.id}><img src={image.dataUrl} alt={image.name} /><figcaption>{image.name}</figcaption>{mode === 'edit' && <button type="button" aria-label={`移除图片 ${image.name}`} onClick={() => changeImages((images) => images.filter((item) => item.id !== image.id))}><X size={14} /></button>}</figure>)}</div>}
          </div>
          <div className="script-meta"><span>{brief.provider} · {brief.model}</span><span>保存于 {formatTimestamp(brief.updatedAt)}</span></div>
        </article>
        <div className="brief-section-grid three"><BriefSection tone="green" title="已经完成" items={brief.completed} empty="没有识别到明确完成项" /><BriefSection tone="violet" title="正在推进" items={brief.inProgress} empty="没有识别到进行中事项" /><BriefSection tone="amber" title="下一步计划" items={brief.nextSteps} empty="没有识别到后续计划" /></div>
      </> : <div className="brief-empty panel"><Clipboard size={34} /><h2>{sourceCount ? '这一天还没有生成早会稿' : '先记录这一天的工作'}</h2><p>{sourceCount ? '点击“生成早会稿”，系统会合并这一天的全部资料。' : '通过每日记录输入文字，或在批量上传中导入文件，然后回来生成。'}</p></div>}
    </section>
  </div>
}

function BriefSection({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: string }): ReactNode {
  return <section className={`brief-section ${tone}`}><div><span className="section-dot" /><h3>{title}</h3><b>{items.length}</b></div>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{empty}</p>}</section>
}
function VersionContent({ script, images }: { script: string; images: DailyBriefImage[] }): ReactNode {
  return <><div className="brief-version-text">{scriptParagraphs(script).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>{images.length > 0 && <div className="brief-version-images">{images.map((image) => <img key={image.id} src={image.dataUrl} alt={image.name} />)}</div>}</>
}
export function scriptParagraphs(script: string): string[] {
  return script.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean).flatMap((paragraph) => {
    if (paragraph.length <= 180) return [paragraph]
    // Break only at Chinese sentence endings; decimal values and URL punctuation stay intact.
    const sentences = paragraph.match(/.*?[。！？]+[”’」』）】]*|.+$/gu) ?? [paragraph]
    const groups: string[] = []
    let current = ''
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 180) { groups.push(current); current = '' }
      current += sentence
    }
    if (current) groups.push(current)
    return groups
  })
}
function workDates(source: SourceItem): string[] { return source.workDates.length ? source.workDates : source.businessDate ? [source.businessDate.slice(0, 10)] : [] }
function friendlyDate(date: string): string { return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日` }
function formatTimestamp(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取剪贴板中的图片')); reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板中的图片')); reader.readAsDataURL(file) })
}
