import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction
} from 'react'
import {
  Activity,
  Archive,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Clock3,
  Copy,
  Database,
  Download,
  FileText,
  Inbox,
  LayoutDashboard,
  Library,
  ListFilter,
  LoaderCircle,
  LogIn,
  MessageCircleQuestion,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timeline,
  Trash2,
  Upload,
  X,
  XCircle
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from 'recharts'
import type {
  AppSnapshot,
  Asset,
  AssetPreview,
  CodexCliStatus,
  CursorCliStatus,
  DailyBrief,
  ExportRequest,
  ImportResult,
  JobProgressEvent,
  ProviderSettings,
  SaveProviderSettings,
  SearchHit,
  SourceItem,
  WorkQuestionAnswer,
  WorkQuestionCitation,
  WorkQuestionMessage,
  WorkEvent,
  WorkItem
} from '@shared/contracts'
import { getTimelineHistoryWindow } from './timeline-window'
import { BriefsPage, useBriefOperationSession } from './brief-page'
import { getWorkItemReviewReasons, isWorkItemFragmentTitle, normalizeWorkItemCategory } from '@shared/work-item-quality'
import { WorkItemEditor } from './WorkItemEditor'
import { clearSubmittedDraft, useBatchSession, useCaptureSession, type BatchImportResult, type BatchSession, type CaptureSession } from './entry-sessions'
import './entry-experience.css'

type NavKey = 'dashboard' | 'capture' | 'batch' | 'briefs' | 'ask' | 'timeline' | 'events' | 'library' | 'export' | 'settings'

interface WorkChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  answer?: WorkQuestionAnswer
}

type BatchPhase = 'compose' | 'processing' | 'review'

interface PendingTextItem {
  id: string
  text: string
  title: string
}

type PendingWorkContentDeletion =
  | { kind: 'event'; event: WorkEvent }
  | { kind: 'workItem'; item: WorkItem }

const BATCH_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'tiff'
])
const MAX_BATCH_ITEMS = 200
const MAX_BATCH_FILE_BYTES = 25 * 1024 * 1024

const EMPTY_SNAPSHOT: AppSnapshot = {
  sources: [],
  events: [],
  workItems: [],
  dailyBriefs: [],
  dashboard: {
    totals: { sources: 0, events: 0, dailyBriefs: 0, processing: 0 },
    eventTypes: [],
    activity: [],
    latestBrief: null
  }
}

const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: typeof Inbox }> = [
  { key: 'dashboard', label: '工作看板', icon: LayoutDashboard },
  { key: 'capture', label: '每日记录', icon: Plus },
  { key: 'batch', label: '批量上传', icon: Upload },
  { key: 'briefs', label: '早会逐字稿', icon: Clipboard },
  { key: 'timeline', label: '工作时间线', icon: Timeline },
  { key: 'events', label: '工作事项', icon: BriefcaseBusiness },
  { key: 'library', label: '工作资料库', icon: Library },
  { key: 'ask', label: '问工作资料', icon: MessageCircleQuestion },
  { key: 'export', label: '导出与备份', icon: Download },
  { key: 'settings', label: 'AI 设置', icon: Settings }
]

const IS_MAC_PLATFORM = navigator.platform.toLowerCase().includes('mac')
const DESKTOP_PLATFORM_CLASS = IS_MAC_PLATFORM
  ? 'platform-darwin'
  : navigator.platform.toLowerCase().includes('win')
    ? 'platform-win32'
    : 'platform-linux'
const SHORTCUT_MODIFIER = IS_MAC_PLATFORM ? '⌘' : 'Ctrl+'

export function App(): ReactNode {
  const [activeNav, setActiveNav] = useState<NavKey>('dashboard')
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)
  const [progress, setProgress] = useState<JobProgressEvent | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedSource, setSelectedSource] = useState<SourceItem | null>(null)
  const [activeBriefDate, setActiveBriefDate] = useState(todayLocal())
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null)
  const [focusRevision, setFocusRevision] = useState(0)
  const [provider, setProvider] = useState<ProviderSettings | null>(null)
  const captureSession = useCaptureSession(todayLocal())
  const batchSession = useBatchSession()
  const briefSession = useBriefOperationSession()
  const [askBusy, setAskBusy] = useState(false)
  const askRequestRef = useRef(0)
  const [searchLoading, setSearchLoading] = useState(false)
  const [resumingAnalysis, setResumingAnalysis] = useState(false)
  const [retryingSourceId, setRetryingSourceId] = useState<string | null>(null)
  const [workChat, setWorkChat] = useState<WorkChatEntry[]>([])
  const [pendingWorkContentDeletion, setPendingWorkContentDeletion] = useState<PendingWorkContentDeletion | null>(null)
  const [deletingWorkContent, setDeletingWorkContent] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const snapshotRequest = useRef(0)

  const loadSnapshot = useCallback(async () => {
    const request = ++snapshotRequest.current
    try {
      const next = await window.worklens.getSnapshot()
      if (request !== snapshotRequest.current) return
      setSnapshot(next)
      setActiveBriefDate((current) =>
        next.dailyBriefs.some((brief) => brief.workDate === current)
          ? current
          : (next.dailyBriefs[0]?.workDate ?? current)
      )
    } catch (error) {
      showError(setToast, error)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadProvider = useCallback(async () => {
    try { setProvider(await window.worklens.getProviderSettings()) }
    catch (error) { showError(setToast, error) }
  }, [])

  useEffect(() => {
    void loadSnapshot()
    void loadProvider()
    const removeDataListener = window.worklens.onDataChanged(() => { void loadSnapshot(); void loadProvider() })
    const removeProgressListener = window.worklens.onJobProgress((event) => {
      setProgress(event)
      if (event.jobType === 'import') batchSession.setImportProgress(event)
    })
    return () => {
      removeDataListener()
      removeProgressListener()
    }
  }, [loadSnapshot, loadProvider])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        setSearchOpen(true)
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setActiveNav('capture')
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3_500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    let cancelled = false
    setSearchResults([])
    setSearchLoading(Boolean(searchQuery.trim()))
    const timer = window.setTimeout(async () => {
      if (!searchQuery.trim()) {
        setSearchResults([])
        return
      }
      try {
        const results = await window.worklens.search({ query: searchQuery, entityTypes: [] })
        if (!cancelled) setSearchResults(results)
      } catch (error) {
        if (!cancelled) showError(setToast, error)
      } finally {
        if (!cancelled) setSearchLoading(false)
      }
    }, 220)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [searchQuery])

  const navigate = (key: NavKey): void => {
    setFocusedEventId(null)
    setActiveNav(key)
    setSearchOpen(false)
  }
  const openWorkLibrary = (): void => {
    navigate('library')
  }
  const openEvent = (id: string): void => {
    if (!snapshot.workItems.some(item => item.eventIds.includes(id))) {
      setToast({ message: '这条事项已被更新或移除，请重新搜索最新内容', tone: 'error' })
      return
    }
    setFocusedEventId(id)
    setFocusRevision(value => value + 1)
    setActiveNav('events')
    setSearchOpen(false)
  }
  const openBrief = (workDate: string): void => {
    setActiveBriefDate(workDate)
    navigate('briefs')
  }
  const openSearchResult = (result: SearchHit): void => {
    if (result.entityType === 'brief') {
      const brief = snapshot.dailyBriefs.find(brief => brief.id === result.entityId)
      if (!brief) { setToast({ message: '这份早会稿已被更新或移除，请重新搜索', tone: 'error' }); return }
      openBrief(brief.workDate)
    }
    if (result.entityType === 'event') openEvent(result.entityId)
    if (result.entityType === 'source') {
      const source = snapshot.sources.find((source) => source.id === result.entityId)
      if (!source) { setToast({ message: '这份原始资料已被移除，请重新搜索', tone: 'error' }); return }
      setSelectedSource(source)
      navigate('library')
    }
    setSearchOpen(false)
  }
  const openWorkCitation = (citation: WorkQuestionCitation): void => {
    if (citation.entityType === 'source') {
      const source = snapshot.sources.find((source) => source.id === citation.entityId)
      if (!source) { setToast({ message: '引用的原始资料已被移除', tone: 'error' }); return }
      setSelectedSource(source)
      return
    }
    if (citation.entityType === 'brief') {
      const brief = snapshot.dailyBriefs.find(brief => brief.id === citation.entityId)
      if (!brief) { setToast({ message: '引用的早会稿已被更新或移除', tone: 'error' }); return }
      openBrief(brief.workDate)
      return
    }
    openEvent(citation.entityId)
  }
  const notify = (message: string): void => setToast({ message, tone: 'success' })
  const fail = (error: unknown): void => showError(setToast, error)
  const pendingSources = snapshot.sources.filter(source => source.status === 'queued' || source.status === 'failed')
  const retrySource = async (source: SourceItem): Promise<void> => {
    if (!provider?.connected) { setSelectedSource(null); navigate('settings'); return }
    if (retryingSourceId) return
    setRetryingSourceId(source.id)
    try {
      if (source.rawText.trim()) await window.worklens.reanalyzeSource(source.id)
      else {
        const result = await window.worklens.retryImportSource(source.id)
        if (result.failed.length) throw new Error(result.failed[0]!.error)
        if (result.imported.some(item => item.status === 'queued')) await window.worklens.reanalyzeSource(source.id)
      }
      notify('资料整理完成，可查看对应早会稿')
    } catch (error) { fail(error) }
    finally { await loadSnapshot(); setRetryingSourceId(null) }
  }
  const resumeAnalysis = async (): Promise<void> => {
    if (resumingAnalysis || !provider?.connected) return
    const ids = pendingSources.map(source => source.id)
    setResumingAnalysis(true)
    let failures = 0
    try {
      for (const id of ids) {
        try {
          const result = await window.worklens.retryImportSource(id)
          if (result.failed.length) failures += 1
          else if (result.imported.some(source => source.status === 'queued')) await window.worklens.reanalyzeSource(id)
        } catch { failures += 1 }
        await loadSnapshot()
      }
      if (failures) fail(new Error(`本轮整理结束，${failures} 份仍需处理，可在资料库查看原因并重试`))
      else notify('待整理资料已处理完成，可查看对应早会稿')
    } finally { setResumingAnalysis(false) }
  }
  const deleteSource = async (source: SourceItem): Promise<void> => {
    try {
      const result = await window.worklens.deleteSource(source.id)
      setSelectedSource(null)
      await loadSnapshot()
      notify(result.message)
    } catch (error) {
      fail(error)
    }
  }
  const deleteWorkContent = async (): Promise<void> => {
    if (!pendingWorkContentDeletion) return
    setDeletingWorkContent(true)
    try {
      const result = pendingWorkContentDeletion.kind === 'event'
        ? await window.worklens.deleteWorkEvent(pendingWorkContentDeletion.event.id)
        : await window.worklens.deleteWorkItem(pendingWorkContentDeletion.item.key)
      setPendingWorkContentDeletion(null)
      await loadSnapshot()
      notify(result.message)
    } catch (error) {
      fail(error)
    } finally {
      setDeletingWorkContent(false)
    }
  }

  return (
    <div className={`app-shell ${DESKTOP_PLATFORM_CLASS}`}>
      <aside className="sidebar">
        <div className="window-drag-region" />
        <div className="brand">
          <div className="brand-mark"><img src="./worklens-mark.svg" alt="" aria-hidden="true" /></div>
          <div><strong>WorkLens</strong><span>每天工作，清晰汇报</span></div>
        </div>
        <div className="quick-entry-grid">
          <button className={`quick-entry ${activeNav === 'capture' ? 'active' : ''}`} onClick={() => navigate('capture')} title={`每日记录（${SHORTCUT_MODIFIER}N）`}><Plus size={16} /><span>每日记录</span></button>
          <button className={`quick-entry ${activeNav === 'batch' ? 'active' : ''}`} onClick={() => navigate('batch')}><Upload size={16} /><span>批量上传</span></button>
        </div>
        <nav>
          <div className="primary-nav-stack" aria-label="主要工作入口">
            {NAV_ITEMS.filter((item) => ['dashboard', 'briefs', 'timeline', 'events', 'library'].includes(item.key)).map((item) => (
              <NavButton key={item.key} item={item} active={activeNav === item.key} onClick={() => navigate(item.key)} />
            ))}
          </div>
          <AskNavButton active={activeNav === 'ask'} onClick={() => navigate('ask')} />
          <p className="nav-section-label nav-section-spaced">工具</p>
          {NAV_ITEMS.filter((item) => ['export', 'settings'].includes(item.key)).map((item) => (
            <NavButton key={item.key} item={item} active={activeNav === item.key} onClick={() => navigate(item.key)} />
          ))}
        </nav>
        <div className="local-status">
          <div className="status-dot" />
          <div><strong>原始内容保存在本机</strong><span>整理时才发送给所选 AI</span></div>
          <ShieldCheck size={17} />
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="window-drag-region topbar-drag" />
          <div className="page-heading">
            <h1>{NAV_ITEMS.find((item) => item.key === activeNav)?.label}</h1>
            <span>{pageSubtitle(activeNav)}</span>
          </div>
          <div className={`global-search ${searchOpen ? 'open' : ''}`}>
            <Search size={16} />
            <input
              ref={searchRef}
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(true) }}
              placeholder="搜索日报、工作事项和原始记录"
              aria-label="全局搜索"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setSearchOpen(false)
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  document.querySelector<HTMLButtonElement>('.search-popover button[data-search-result]')?.focus()
                }
                if (event.key === 'Enter' && !searchLoading && searchResults[0]) openSearchResult(searchResults[0])
              }}
            />
            <kbd>{SHORTCUT_MODIFIER}K</kbd>
            {searchOpen && searchQuery && (
              <SearchPopover query={searchQuery} results={searchResults} loading={searchLoading} onClose={() => setSearchOpen(false)} onOpen={openSearchResult} />
            )}
          </div>
        </header>

        {progress && (
          <div className={`progress-banner ${progress.finished ? 'finished' : ''} ${progress.outcome ?? ''}`} role={progress.outcome === 'error' ? 'alert' : 'status'}>
            {progress.finished ? progress.outcome === 'error' || progress.outcome === 'waiting' ? <CircleAlert size={15} /> : <CheckCircle2 size={15} /> : <LoaderCircle size={15} className="spin" />}<span>{progress.message}</span>
            {progress.current && progress.total ? <small>{progress.current} / {progress.total}</small> : null}
            <button onClick={() => setProgress(null)} aria-label="关闭进度"><X size={14} /></button>
          </div>
        )}
        {batchSession.phase !== 'compose' && activeNav !== 'batch' && <div className="session-return" role="status"><Upload size={15} /><span>{batchSession.busy ? '批量资料正在后台处理，切换页面不会中断' : '本批资料处理结果已保留，可继续校对'}</span><button className="text-button" onClick={() => navigate('batch')}>{batchSession.busy ? '查看进度' : '查看本批结果'}</button></div>}

        <main className="content">
          {loading ? <LoadingState /> : (
            <>
              {activeNav === 'dashboard' && <Dashboard snapshot={snapshot} navigate={navigate} openBrief={openBrief} onSelectSource={setSelectedSource} />}
              {activeNav === 'capture' && (
                <CapturePage session={captureSession} provider={provider} openSettings={() => navigate('settings')} briefs={snapshot.dailyBriefs} sources={snapshot.sources} onSelect={setSelectedSource} onChanged={loadSnapshot} openBrief={openBrief} notify={notify} fail={fail} />
              )}
              {activeNav === 'batch' && (
                <BatchUploadPage session={batchSession} provider={provider} openSettings={() => navigate('settings')} snapshot={snapshot} progress={batchSession.importProgress} onSelect={setSelectedSource} onChanged={loadSnapshot} openTimeline={() => navigate('timeline')} openLibrary={openWorkLibrary} notify={notify} fail={fail} />
              )}
              {activeNav === 'briefs' && (
                <BriefsPage session={briefSession} aiReady={Boolean(provider?.connected)} onOpenSettings={() => navigate('settings')} briefs={snapshot.dailyBriefs} sources={snapshot.sources} selectedDate={activeBriefDate} setSelectedDate={setActiveBriefDate} onChanged={loadSnapshot} notify={notify} fail={fail} />
              )}
              {activeNav === 'ask' && (
                <AskWorkPage busy={askBusy} setBusy={setAskBusy} requestRef={askRequestRef} snapshot={snapshot} entries={workChat} setEntries={setWorkChat} onOpenCitation={openWorkCitation} fail={fail} />
              )}
              {activeNav === 'timeline' && <TimelinePage snapshot={snapshot} onSelect={setSelectedSource} onRequestDelete={(event) => setPendingWorkContentDeletion({ kind: 'event', event })} />}
              {(activeNav === 'events' || activeNav === 'library') && <EventsPage key={`${activeNav}:${focusRevision}`} focusedEventId={focusedEventId} onSectionChange={(section) => navigate(section === 'library' ? 'library' : 'events')} workItems={snapshot.workItems} events={snapshot.events} sources={snapshot.sources} initialSection={activeNav === 'library' ? 'library' : 'events'} onSelectSource={setSelectedSource} onRequestDelete={(item) => setPendingWorkContentDeletion({ kind: 'workItem', item })} onChanged={loadSnapshot} notify={notify} fail={fail} />}
              {activeNav === 'export' && <ExportPage snapshot={snapshot} notify={notify} fail={fail} />}
              {activeNav === 'settings' && <SettingsPage pendingCount={pendingSources.length} resumingAnalysis={resumingAnalysis} onResume={() => void resumeAnalysis()} onProviderChanged={loadProvider} notify={notify} fail={fail} />}
            </>
          )}
        </main>
      </section>

      {selectedSource && <SourceDrawer source={snapshot.sources.find(source => source.id === selectedSource.id) ?? selectedSource} retrying={Boolean(retryingSourceId)} aiReady={Boolean(provider?.connected)} onRetry={source => void retrySource(source)} onOpenBrief={date => { setSelectedSource(null); openBrief(date) }} onClose={() => setSelectedSource(null)} onDelete={deleteSource} />}
      {pendingWorkContentDeletion && <DeleteWorkContentDialog deletion={pendingWorkContentDeletion} busy={deletingWorkContent} onCancel={() => setPendingWorkContentDeletion(null)} onConfirm={() => void deleteWorkContent()} />}
      {toast && <Toast message={toast.message} tone={toast.tone} />}
    </div>
  )
}

function DeleteWorkContentDialog({ deletion, busy, onCancel, onConfirm }: { deletion: PendingWorkContentDeletion; busy: boolean; onCancel: () => void; onConfirm: () => void }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const isEvent = deletion.kind === 'event'
  const title = isEvent ? deletion.event.title : deletion.item.title
  useEffect(() => {
    cancelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onCancel])
  return <div className="delete-confirm-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
    <section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-work-content-title" aria-describedby="delete-work-content-description">
      <div className="delete-confirm-icon"><Trash2 size={20} /></div>
      <h3 id="delete-work-content-title">{isEvent ? '删除这条时间线内容？' : '删除这个工作事项？'}</h3>
      <p id="delete-work-content-description">{isEvent ? '只会删除这条整理后的工作内容及其关联证据；原始资料和日报不会被删除。' : `将删除该事项下的 ${deletion.item.eventCount} 条历史工作内容及其关联证据；原始资料和日报不会被删除。`}</p>
      <strong>{title}</strong>
      <div><button ref={cancelRef} className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{busy ? '正在删除' : '确认删除'}</button></div>
    </section>
  </div>
}

function Dashboard({ snapshot, navigate, openBrief, onSelectSource }: { snapshot: AppSnapshot; navigate: (key: NavKey) => void; openBrief: (date: string) => void; onSelectSource: (source: SourceItem) => void }): ReactNode {
  const { dashboard } = snapshot
  const todaySources = snapshot.sources.filter((source) => sourceHasWorkDate(source, todayLocal()))
  const recentSources = [...snapshot.sources]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4)
  const cards = [
    { label: '今日记录', value: todaySources.length, note: '文字与文件统一合并', icon: FileText, tone: 'violet', destination: 'capture' as NavKey },
    { label: '已生成日报', value: dashboard.totals.dailyBriefs, note: '每个工作日保留一版', icon: Clipboard, tone: 'green', destination: 'briefs' as NavKey },
    { label: '工作事项', value: snapshot.workItems.length, note: '同类进展跨日期合并', icon: BriefcaseBusiness, tone: 'amber', destination: 'events' as NavKey }
  ]

  return (
    <div className="page-stack">
      <section className="hero-card standup-hero">
        <div>
          <div className="eyebrow"><Sparkles size={14} />明早说什么，今天就准备好</div>
          <h2>{greeting()}，把今天做过的事交给 WorkLens</h2>
          <p>随手记录或批量上传，系统会按工作日去重合并，生成一份可以直接照着念的早会逐字稿。</p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => navigate('capture')}><Plus size={17} />每日记录</button>
        </div>
      </section>

      <section className="metric-grid">
        {cards.map((card) => {
          const Icon = card.icon
          return <button className="metric-card metric-card-link" key={card.label} onClick={() => navigate(card.destination)}><span className="metric-card-enter">进入 <ArrowRight size={12} /></span><div className={`metric-icon ${card.tone}`}><Icon size={19} /></div><div><span>{card.label}</span><strong>{card.value}</strong><small>{card.note}</small></div></button>
        })}
      </section>

      <section className="dashboard-grid">
        <Panel title="工作记录趋势" subtitle="最近 30 天的原始记录与合并事项" action={<span className="legend-note"><i />记录 <i className="event" />事项</span>}>
          {dashboard.activity.length ? (
            <div className="chart-area"><ResponsiveContainer width="100%" height="100%"><AreaChart data={dashboard.activity}>
              <defs><linearGradient id="sourceGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6558d3" stopOpacity={0.28} /><stop offset="95%" stopColor="#6558d3" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid vertical={false} stroke="#ece8df" /><XAxis dataKey="date" tickFormatter={(value) => value.slice(5)} tickLine={false} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} /><ChartTooltip />
              <Area type="monotone" dataKey="sources" stroke="#6558d3" strokeWidth={2} fill="url(#sourceGradient)" />
              <Area type="monotone" dataKey="events" stroke="#54a894" strokeWidth={2} fill="transparent" />
            </AreaChart></ResponsiveContainer></div>
          ) : <ChartEmpty />}
        </Panel>
        <Panel title="接下来要推进" subtitle="从最新日报提取的下一步计划">
          {dashboard.latestBrief?.nextSteps.length ? (
            <div className="next-step-list">{dashboard.latestBrief.nextSteps.slice(0, 5).map((item, index) => <div key={item}><span>{String(index + 1).padStart(2, '0')}</span><p>{item}</p></div>)}</div>
          ) : <EmptyInline icon={<CheckCircle2 size={20} />} title="暂时没有待推进事项" text="生成日报后，这里会汇总明确的下一步计划。" />}
        </Panel>
      </section>

      <section className="dashboard-grid lower">
        <Panel title="最新早会逐字稿" subtitle={dashboard.latestBrief ? `${dashboard.latestBrief.standupDate} 早会使用` : '等待第一份日报'} action={dashboard.latestBrief && <button className="text-button" onClick={() => openBrief(dashboard.latestBrief!.workDate)}>打开完整稿 <ArrowRight size={14} /></button>}>
          {dashboard.latestBrief ? <div className="script-preview"><div className="summary-date"><Clipboard size={16} /></div><div><h3>{dashboard.latestBrief.title}</h3><p>{dashboard.latestBrief.script}</p><div className="chip-row"><span className="soft-chip">{dashboard.latestBrief.completed.length} 项完成</span><span className="soft-chip">{dashboard.latestBrief.inProgress.length} 项进行中</span><span className="soft-chip">{dashboard.latestBrief.blockers.length} 项风险</span></div></div></div> : <EmptyInline icon={<Bot size={20} />} title="还没有早会稿" text="记录今天的工作，系统会自动生成明早可以直接念的逐字稿。" />}
        </Panel>
        <Panel title="最近工作资料" subtitle={recentSources.length ? `最近更新的 ${recentSources.length} 份原始资料` : '还没有可查看的资料'}>
          <div className="recent-source-list">
            {recentSources.map((source) => (
              <button className="recent-source-row" key={source.id} onClick={() => onSelectSource(source)}>
                <div className={`file-kind ${source.kind}`}><FileText size={15} /></div>
                <div><strong>{source.title}</strong><span>上传于 {formatTimestamp(source.createdAt)} · {source.kind.toUpperCase()}</span></div>
                <StatusPill status={source.status} />
                <ChevronRight size={14} />
              </button>
            ))}
            {!recentSources.length && <EmptyInline icon={<Library size={20} />} title="还没有工作资料" text="记录或上传工作内容后，最近资料会显示在这里。" />}
          </div>
        </Panel>
      </section>
    </div>
  )
}

function AiReadiness({ provider, onOpenSettings }: { provider: ProviderSettings | null; onOpenSettings: () => void }): ReactNode {
  return <section className={`ai-readiness ${provider?.connected ? 'connected' : ''}`} role="status"><Bot size={18} /><div><strong>{!provider ? '正在读取 AI 状态' : !provider.connected ? 'AI 尚未连接，仍可先保存工作记录' : provider.autoAnalyze ? 'AI 已连接，保存后会自动整理' : 'AI 已连接，自动整理已关闭'}</strong><small>{!provider?.connected ? '连接后可继续整理已保存资料，无需重复上传。' : provider.autoAnalyze ? '原文先保存在本机，整理完成后可查看早会稿。' : '原文照常保存，需要时可手动开始整理。'}</small></div><button className="text-button" onClick={onOpenSettings}>{provider?.connected ? 'AI 设置' : '连接 AI'}</button></section>
}

export function CapturePage({ session, provider, openSettings, briefs, sources, onSelect, onChanged, openBrief, notify, fail }: { session: CaptureSession; provider: ProviderSettings | null; openSettings: () => void; briefs: DailyBrief[]; sources: SourceItem[]; onSelect: (source: SourceItem) => void; onChanged: () => Promise<void>; openBrief: (date: string) => void; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const { draft, setDraft, storageFailed, busy, setBusy, generating, setGenerating, retryingId, setRetryingId } = session
  const { title, text, date } = draft
  const setTitle = (title: string): void => setDraft(current => ({ ...current, title }))
  const setText = (text: string): void => setDraft(current => ({ ...current, text }))
  const setDate = (date: string): void => setDraft(current => ({ ...current, date }))
  const autoAnalyze = Boolean(provider?.connected && provider.autoAnalyze)
  const visibleSources = sources.filter((source) => sourceHasWorkDate(source, date))
  const hasBrief = briefs.some(brief => brief.workDate === date)
  const processing = visibleSources.some(source => source.status === 'processing')

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!text.trim() || busy) return
    const submitted = { ...draft }
    setBusy(true)
    try {
      await window.worklens.captureText({ title: submitted.title.trim(), text: submitted.text.trim(), businessDate: submitted.date, deferAnalysis: true })
      setDraft(current => clearSubmittedDraft(current, submitted))
      await onChanged()
      notify(autoAnalyze ? '原文已保存，AI 将在后台整理；可以继续记录' : '原文已保存，可在下方继续整理')
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const generate = async (): Promise<void> => {
    if (!provider?.connected || generating) return
    const workDate = date
    setGenerating(true)
    try {
      const result = await window.worklens.generateDailyBrief(workDate)
      await onChanged()
      notify(result.message)
      openBrief(workDate)
    } catch (error) {
      fail(error)
      await onChanged()
    } finally {
      setGenerating(false)
    }
  }
  const retry = async (source: SourceItem): Promise<void> => {
    if (!provider?.connected || retryingId) return
    setRetryingId(source.id)
    try {
      await window.worklens.reanalyzeSource(source.id)
      await onChanged()
      notify('整理完成，可以查看对应早会稿')
    } catch (error) { fail(error); await onChanged() }
    finally { setRetryingId(null) }
  }

  return (
    <div className="page-stack">
      <AiReadiness provider={provider} onOpenSettings={openSettings} />
      <section className="capture-card">
        <form onSubmit={(event) => void submit(event)}>
          <div className="capture-header">
            <div>
              <div className="eyebrow"><Plus size={14} />每日记录</div>
              <h2>先记下来，不必整理格式</h2>
              <p>进展、会议、沟通、结果、卡点和明天计划都可以混在一起写，系统会自动归并。</p>
            </div>
          </div>
          <div className="capture-date-row">
            <label className="date-control"><CalendarDays size={15} /><span>工作日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="工作日期" /></label>
            <span>这一天的所有记录与文件会合并成同一份日报</span>
          </div>
          <input className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给这条记录起个标题（可选）" maxLength={160} />
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={'例如：\n今天完成了登录页改版并上线测试环境；下午和销售确认了客户反馈。\n数据接口还差权限，正在等后端同事处理。\n明天准备完成联调并整理发布说明。'} maxLength={500_000} />
          <div className="capture-footer">
            <span className={`privacy-copy ${storageFailed ? 'draft-storage-error' : ''}`} role="status"><Database size={14} />{storageFailed ? '草稿暂时无法写入本机，请先保存记录再关闭应用' : text || title ? '草稿已保存在本机，切换页面后可继续' : '原文保存在本机，AI 生成内容不会覆盖它'}</span>
            <button className="primary-button" disabled={!text.trim() || busy || !date}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{busy ? '正在保存原文' : autoAnalyze ? '保存并自动整理' : '保存记录'}</button>
          </div>
        </form>
      </section>

      <section className="panel source-panel">
        <div className="panel-header">
          <div><h2>{date} 的原始资料</h2><p>{visibleSources.length} 条记录，将被合并为一份早会稿</p></div>
          <div className="source-panel-actions">{hasBrief && <button className="primary-button" onClick={() => openBrief(date)}><Clipboard size={15} />查看早会稿</button>}<button className="secondary-button" disabled={generating || processing || Boolean(retryingId) || !provider?.connected || !visibleSources.length} onClick={() => void generate()}>{generating ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{generating ? '正在整理' : hasBrief ? '重新生成当日日报' : '整理当日资料'}</button></div>
        </div>
        <div className="source-table">
          <div className="source-table-head daily"><span>资料</span><span>类型</span><span>状态</span><span>录入时间</span></div>
          {visibleSources.map((source) => (
            <div className="source-table-row daily" key={source.id}>
              <button className="source-title-cell" onClick={() => onSelect(source)}><div className={`file-kind ${source.kind}`}><FileText size={16} /></div><div><strong>{source.title}</strong><span>{source.excerpt || '未提取到文字'}</span></div></button>
              <span className="kind-label">{source.kind.toUpperCase()}</span>
              <div className="source-processing-state"><StatusPill status={source.status} />{(source.status === 'failed' || source.status === 'queued') && <><small>{source.error || (provider?.connected ? '原文已保存，等待整理' : '原文已保存，连接 AI 后可整理')}</small><button className="text-button" disabled={Boolean(retryingId) || generating} onClick={() => provider?.connected ? void retry(source) : openSettings()}>{retryingId === source.id ? '整理中…' : !provider?.connected ? '连接 AI' : source.status === 'failed' ? '重试整理' : '开始整理'}</button></>}</div>
              <span>{formatTimestamp(source.createdAt)}</span>
            </div>
          ))}
          {!visibleSources.length && <EmptyState icon={<Inbox size={28} />} title="这一天还没有工作记录" text="从上方写几句话，保存后会自动归入这一天。" />}
        </div>
      </section>
    </div>
  )
}

function BatchUploadPage({ session, provider, openSettings, snapshot, progress, onSelect, onChanged, openTimeline, openLibrary, notify, fail }: { session: BatchSession; provider: ProviderSettings | null; openSettings: () => void; snapshot: AppSnapshot; progress: JobProgressEvent | null; onSelect: (source: SourceItem) => void; onChanged: () => Promise<void>; openTimeline: () => void; openLibrary: () => void; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const { phase, setPhase, pendingFiles, setPendingFiles, pendingTexts, setPendingTexts, pasteDraft, setPasteDraft, busy, setBusy, cancelling, setCancelling, retryingId, setRetryingId, editingDateId, setEditingDateId, localProgress, setLocalProgress, result, setResult, cancelRequestedRef, storageFailed } = session
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pasteInputRef = useRef<HTMLTextAreaElement>(null)
  const pendingCount = pendingFiles.length + pendingTexts.length
  const pendingBytes = pendingFiles.reduce((sum, file) => sum + file.size, 0)
  const phaseIndex = phase === 'compose' ? 0 : phase === 'processing' ? 1 : 2
  const groups = useMemo(() => {
    const grouped = new Map<string, SourceItem[]>()
    for (const imported of result?.imported ?? []) {
      const source = snapshot.sources.find((item) => item.id === imported.id) ?? imported
      const dates = source.workDates.length ? source.workDates : source.businessDate ? [source.businessDate] : ['pending']
      for (const date of dates) grouped.set(date, [...(grouped.get(date) ?? []), source])
    }
    return Array.from(grouped, ([date, sources]) => ({ date, sources })).sort((a, b) => {
      if (a.date === 'pending') return 1
      if (b.date === 'pending') return -1
      return b.date.localeCompare(a.date)
    })
  }, [result, snapshot.sources])
  const activeFailures = (result?.failed ?? []).filter(failure => !failure.sourceItemId || snapshot.sources.find(source => source.id === failure.sourceItemId)?.status !== 'ready')
  const failedSourceIds = new Set(activeFailures.flatMap((item) => item.sourceItemId ? [item.sourceItemId] : []))
  const failedCount = activeFailures.length + (result?.imported.filter(source => !failedSourceIds.has(source.id) && (snapshot.sources.find(item => item.id === source.id) ?? source).status === 'failed').length ?? 0)
  const fallbackCount = result?.imported.filter((source) => {
    if (failedSourceIds.has(source.id)) return false
    const current = snapshot.sources.find((item) => item.id === source.id) ?? source
    return !current.workDates.length && !current.businessDate
  }).length ?? 0
  const waitingCount = result?.imported.filter(source => (snapshot.sources.find(item => item.id === source.id) ?? source).status === 'queued').length ?? 0

  const addFiles = (files: File[]): void => {
    if (!files.length || phase !== 'compose' || busy) return
    const existingKeys = new Set(pendingFiles.map(batchFileKey))
    const accepted: File[] = []
    const duplicateNames: string[] = []
    const invalidNames: string[] = []
    const oversizedNames: string[] = []
    for (const file of files) {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!BATCH_FILE_EXTENSIONS.has(extension)) {
        invalidNames.push(file.name)
        continue
      }
      if (file.size > MAX_BATCH_FILE_BYTES) {
        oversizedNames.push(file.name)
        continue
      }
      const key = batchFileKey(file)
      if (existingKeys.has(key)) {
        duplicateNames.push(file.name)
        continue
      }
      existingKeys.add(key)
      accepted.push(file)
    }
    const available = Math.max(0, MAX_BATCH_ITEMS - pendingCount)
    const withinLimit = accepted.slice(0, available)
    if (withinLimit.length) setPendingFiles((current) => [...current, ...withinLimit])
    const messages: string[] = []
    if (invalidNames.length) messages.push(`${invalidNames.length} 份格式不支持`)
    if (oversizedNames.length) messages.push(`${oversizedNames.length} 份超过 25 MB`)
    if (accepted.length > available) messages.push(`本批最多 ${MAX_BATCH_ITEMS} 项`)
    if (messages.length) fail(new Error(messages.join('；')))
    else if (duplicateNames.length) notify(`${duplicateNames.length} 份文件已在待处理列表中`)
  }

  const addPastedText = (): void => {
    const text = pasteDraft.trim()
    if (!text) return
    if (pendingCount >= MAX_BATCH_ITEMS) {
      fail(new Error(`每批最多添加 ${MAX_BATCH_ITEMS} 项资料`))
      return
    }
    if (pendingTexts.some((item) => item.text === text)) {
      notify('这段文字已经在待处理列表中')
      return
    }
    setPendingTexts((current) => [
      ...current,
      { id: messageId(), text, title: pastedTextTitle(text) }
    ])
    setPasteDraft('')
  }

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      if (busy || phase !== 'compose') return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length) {
        event.preventDefault()
        addFiles(files)
        return
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text.trim()) return
      event.preventDefault()
      setPasteDraft(text.slice(0, 500_000))
      window.requestAnimationFrame(() => pasteInputRef.current?.focus())
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [busy, phase, pendingCount, pendingFiles, pendingTexts])

  const startBatch = async (): Promise<void> => {
    if (!pendingCount || busy) return
    const files = [...pendingFiles]
    const texts = [...pendingTexts]
    const total = files.length + texts.length
    const knownSourceIds = new Set(snapshot.sources.map((source) => source.id))
    const savedTextIds = new Set<string>()
    let next: BatchImportResult = { imported: [], duplicates: [], failed: [], cancelled: false }
    cancelRequestedRef.current = false
    setResult(null)
    session.setImportProgress(null)
    setPhase('processing')
    setBusy(true)
    setCancelling(false)
    setLocalProgress({ sourceItemId: '', jobType: 'import', message: '正在准备资料', current: 0, total })
    try {
      if (files.length) {
        const fileResult = await window.worklens.importDroppedFiles(files)
        next = mergeImportResults(next, fileResult)
        for (const source of [...fileResult.imported, ...fileResult.duplicates.map((item) => item.source)]) {
          knownSourceIds.add(source.id)
        }
      }
      if (!next.cancelled && !cancelRequestedRef.current) {
        for (let index = 0; index < texts.length; index += 1) {
          if (cancelRequestedRef.current) break
          const item = texts[index]!
          const current = files.length + index + 1
          setLocalProgress({ sourceItemId: '', jobType: 'import', message: `${provider?.connected && provider.autoAnalyze ? '正在保存并整理粘贴内容' : '正在保存粘贴内容'} · ${item.title}`, current, total })
          try {
            const source = await window.worklens.captureText({ title: '', text: item.text, businessDate: null })
            savedTextIds.add(item.id)
            if (knownSourceIds.has(source.id)) next.duplicates.push({ fileName: item.title, source })
            else {
              next.imported.push(source)
              knownSourceIds.add(source.id)
            }
            if (source.status === 'failed') next.failed.push({ fileName: item.title, error: source.error || '原文已保存，但 AI 整理失败', sourceItemId: source.id })
          } catch (error) {
            next.failed.push({ fileName: item.title, error: displayErrorMessage(error), sourceItemId: null, pendingTextId: item.id })
          }
        }
      }
      if (cancelRequestedRef.current) next.cancelled = true
      const latestProvider = await window.worklens.getProviderSettings()
      if (latestProvider.autoAnalyze && !latestProvider.connected && next.imported.some((source) => source.status === 'queued')) {
        next.analysisSkipped = '未连接 AI，资料已保存但未整理'
      } else if (!latestProvider.autoAnalyze && next.imported.some(source => source.status === 'queued')) {
        next.analysisSkipped = '资料已保存，自动整理当前已关闭，可在结果中手动开始整理'
      }
      setResult(next)
      await onChanged()
      if (!next.cancelled) {
        setPendingFiles([])
      }
      setPendingTexts(current => current.filter(item => !savedTextIds.has(item.id)))
      setPhase('review')
      if (next.cancelled) notify('已停止处理；完成的资料已保留，待处理列表仍在')
      else if (next.analysisSkipped) notify(next.analysisSkipped)
      else if (next.failed.length) notify(`处理完成：新增 ${next.imported.length} 项，${next.failed.length} 项需要处理`)
      else if (next.imported.length) notify(`已归档 ${next.imported.length} 项资料`)
      else notify('这批资料都已存在，没有重复写入')
    } catch (error) {
      fail(error)
      setPhase('compose')
    } finally {
      setBusy(false)
      setCancelling(false)
      setLocalProgress(null)
    }
  }

  const cancelImport = async (): Promise<void> => {
    cancelRequestedRef.current = true
    setCancelling(true)
    try {
      const response = await window.worklens.cancelImport()
      notify(response.ok ? response.message : '将在当前内容保存后停止处理')
    } catch (error) {
      fail(error)
    }
  }

  const retryFailure = async (sourceItemId: string): Promise<void> => {
    if (busy || retryingId) return
    setRetryingId(sourceItemId)
    setBusy(true)
    try {
      const next = await window.worklens.retryImportSource(sourceItemId)
      setResult((current) => mergeImportResults(
        current ? { ...current, failed: current.failed.filter((item) => item.sourceItemId !== sourceItemId) } : null,
        next
      ))
      await onChanged()
      if (next.failed.length) fail(new Error(next.failed[0]!.error))
      else if (next.imported.some(source => source.status === 'queued')) {
        await window.worklens.reanalyzeSource(sourceItemId)
        await onChanged()
        notify('整理完成，可查看对应早会稿')
      } else if (next.imported.length) notify('整理完成，可查看对应早会稿')
    } catch (error) {
      const source = snapshot.sources.find(item => item.id === sourceItemId) ?? result?.imported.find(item => item.id === sourceItemId)
      setResult(current => mergeImportResults(current, { imported: [], duplicates: [], cancelled: false, failed: [{ fileName: source?.title ?? '工作资料', sourceItemId, error: displayErrorMessage(error) }] }))
      fail(error)
      await onChanged()
    } finally {
      setBusy(false)
      setRetryingId(null)
    }
  }

  const retryTextFailure = async (pendingTextId: string): Promise<void> => {
    const item = pendingTexts.find(text => text.id === pendingTextId)
    if (!item || busy || retryingId) return
    setRetryingId(pendingTextId)
    setBusy(true)
    try {
      const source = await window.worklens.captureText({ title: '', text: item.text, businessDate: null, deferAnalysis: true })
      setResult(current => mergeImportResults(current ? { ...current, failed: current.failed.filter(failure => failure.pendingTextId !== pendingTextId) } : null, {
        imported: [source], duplicates: [], cancelled: false, failed: source.status === 'failed' ? [{ fileName: item.title, error: source.error || '原文已保存，但 AI 整理失败', sourceItemId: source.id }] : []
      }))
      setPendingTexts(current => current.filter(text => text.id !== pendingTextId))
      await onChanged()
      notify('粘贴原文已保存，可在本批结果中继续查看整理状态')
    } catch (error) {
      setResult(current => current ? { ...current, failed: current.failed.map(failure => failure.pendingTextId === pendingTextId ? { ...failure, error: displayErrorMessage(error) } : failure) } : current)
      fail(error)
    } finally {
      setBusy(false)
      setRetryingId(null)
    }
  }

  const updateDate = async (source: SourceItem, businessDate: string): Promise<void> => {
    if (!businessDate || sourceWorkDates(source).includes(businessDate)) return
    setEditingDateId(source.id)
    try {
      const updated = await window.worklens.updateSourceDate({ sourceItemId: source.id, businessDate })
      setResult((current) => current ? {
        ...current,
        imported: current.imported.map((item) => item.id === updated.id ? updated : item),
        duplicates: current.duplicates.map((item) => item.source.id === updated.id ? { ...item, source: updated } : item)
      } : current)
      await onChanged()
      notify(`已将资料调整到 ${businessDate}，对应日报会重新整理`)
    } catch (error) {
      fail(error)
    } finally {
      setEditingDateId(null)
    }
  }

  const resetForNextBatch = (): void => {
    setResult(null)
    setPhase('compose')
    setCancelling(false)
    cancelRequestedRef.current = false
  }

  const activeProgress = progress?.jobType === 'import' && !progress.finished
    ? progress
    : localProgress
  const readingFiles = activeProgress?.current !== undefined && activeProgress?.total !== undefined

  return (
    <div className="batch-page page-stack">
      <AiReadiness provider={provider} onOpenSettings={openSettings} />
      {storageFailed && <p className="draft-storage-error" role="alert">文字草稿暂时无法写入本机，请处理或复制保存后再关闭应用。</p>}
      <section className="batch-flow-header panel">
        <div>
          <div className="eyebrow"><Upload size={14} />跨日期批量导入</div>
          <h2>{phase === 'compose' ? '先把资料放进待处理列表' : phase === 'processing' ? '正在逐项解析处理' : '检查这批资料的归档结果'}</h2>
          <p>{phase === 'compose' ? '选择文件、拖入资料或粘贴文字；确认列表无误后再开始，不会一选中就写入。' : phase === 'processing' ? '先保存原文，再由 AI 整理；切换页面后可以回来继续查看。' : '原文保存和 AI 整理状态分别显示；待整理或失败项可直接继续处理。'}</p>
        </div>
        <div className="batch-stepper" aria-label="批量上传进度">
          {['添加资料', '解析处理', '校对结果'].map((label, index) => <div className={`${index === phaseIndex ? 'active' : ''} ${index < phaseIndex ? 'completed' : ''}`} key={label}><span>{index < phaseIndex ? <Check size={12} /> : index + 1}</span><strong>{label}</strong></div>)}
        </div>
      </section>

      {phase === 'compose' && (
        <section className="batch-intake panel">
          <div className="panel-header"><div><h2>添加工作资料</h2><p>文件和粘贴文字会先暂存在下面，点击“开始处理”后才写入本地工作库</p></div><span className="batch-capacity">{pendingCount} / {MAX_BATCH_ITEMS} 项</span></div>
          <div className="batch-intake-grid">
            <section
              className={`batch-dropzone ${dragActive ? 'drag-active' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false) }}
              onDrop={(event) => { event.preventDefault(); setDragActive(false); addFiles(Array.from(event.dataTransfer.files)) }}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInputRef.current?.click() } }}
              role="button"
              tabIndex={0}
            >
              <input ref={fileInputRef} className="batch-file-input" type="file" multiple accept=".txt,.md,.markdown,.pdf,.docx,.png,.jpg,.jpeg,.webp,.tiff" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
              <div className="batch-file-cloud"><FileText size={27} /><Upload size={16} /></div>
              <div><h3>{dragActive ? '松开，加入待处理列表' : '拖入文件或点击选择'}</h3><p>支持 TXT、Markdown、PDF、DOCX 和常见图片</p></div>
              <div className="format-chips"><span>最多 200 项</span><span>单份 25 MB</span></div>
            </section>
            <section className="batch-paste-card">
              <div><div className="batch-paste-icon"><Clipboard size={17} /></div><div><h3>粘贴复制的工作文字</h3><p>可直接按 {SHORTCUT_MODIFIER}V，粘贴后还能检查和修改</p></div></div>
              <textarea ref={pasteInputRef} value={pasteDraft} onChange={(event) => setPasteDraft(event.target.value)} placeholder={'例如：\n2026年8月25日完成登录页改版，接口权限仍在等待。'} maxLength={500_000} />
              <div className="batch-paste-footer"><span>{pasteDraft.trim().length.toLocaleString()} 字</span><button className="secondary-button" disabled={!pasteDraft.trim() || pendingCount >= MAX_BATCH_ITEMS} onClick={addPastedText}><Plus size={14} />加入待处理</button></div>
            </section>
          </div>

          <div className={`batch-queue ${pendingCount ? 'has-items' : ''}`}>
            <div className="batch-queue-head"><div><strong>待处理列表</strong><span>{pendingCount ? `${pendingFiles.length} 份文件 · ${pendingTexts.length} 段文字 · ${formatFileSize(pendingBytes)}` : '添加后可在这里确认和移除，不会立即写入'}</span></div>{pendingCount > 0 && <button className="ghost-button compact danger" onClick={() => { setPendingFiles([]); setPendingTexts([]) }}>清空列表</button>}</div>
            {pendingCount ? <div className="batch-queue-list">
              {pendingFiles.map((file) => <div className="batch-queue-row" key={batchFileKey(file)}><div className="file-kind"><FileText size={15} /></div><div><strong>{file.name}</strong><span>{batchFileType(file)} · {formatFileSize(file.size)}</span></div><button aria-label={`移除 ${file.name}`} onClick={() => setPendingFiles((current) => current.filter((item) => batchFileKey(item) !== batchFileKey(file)))}><X size={14} /></button></div>)}
              {pendingTexts.map((item) => <div className="batch-queue-row" key={item.id}><div className="file-kind text"><Clipboard size={15} /></div><div><strong>{item.title}</strong><span>粘贴文字 · {item.text.length.toLocaleString()} 字</span></div><button aria-label={`移除 ${item.title}`} onClick={() => setPendingTexts((current) => current.filter((value) => value.id !== item.id))}><X size={14} /></button></div>)}
            </div> : <div className="batch-queue-empty"><Inbox size={21} /><span>还没有待处理资料</span></div>}
            <div className="batch-queue-footer"><span><Database size={14} />开始后逐项解析，重复内容会自动跳过</span><button className="primary-button" disabled={!pendingCount} onClick={() => void startBatch()}><Sparkles size={15} />{pendingCount ? `开始处理 ${pendingCount} 项` : '开始处理'}</button></div>
          </div>
        </section>
      )}

      {phase === 'processing' && (
        <section className="batch-processing panel" aria-live="polite">
          <div className="batch-processing-orbit"><LoaderCircle className="spin" size={30} /></div>
          <h2>正在整理这批资料</h2>
          <p>{activeProgress?.message ?? '正在准备解析…'}</p>
          {readingFiles ? <><div className="batch-processing-count">{activeProgress.current}<span>/ {activeProgress.total}</span></div><div className="batch-progress-track"><span style={{ width: `${Math.max(4, (activeProgress.current ?? 0) / Math.max(1, activeProgress.total ?? 1) * 100)}%` }} /></div></> : <div className="batch-analysis-phase"><CheckCircle2 size={16} />原文已保存 · 正在进行 AI 整理</div>}
          <small>可以切换到其他页面，返回后进度和结果仍会保留；关闭应用会中断未完成处理。</small>
          <button className="secondary-button danger" disabled={cancelling} onClick={() => void cancelImport()}>{cancelling ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}{cancelling ? '正在停止' : '停止处理'}</button>
        </section>
      )}

      {phase === 'review' && result && (
        <>
          {result.cancelled && <div className="batch-cancel-note"><CircleAlert size={15} /><span>这批处理已停止，已完成的资料已经保留；待处理列表也仍在，可以返回后继续。</span></div>}
          <section className="batch-summary panel">
            <div><span>原文已保存</span><strong>{result.imported.length}</strong><small>份新增资料</small></div>
            <div><span>归档工作日</span><strong>{groups.length}</strong><small>个日期</small></div>
            <div><span>重复跳过</span><strong>{result.duplicates.length}</strong><small>不会重复入库</small></div>
            <div className={failedCount || fallbackCount ? 'warn' : ''}><span>需要留意</span><strong>{failedCount + fallbackCount}</strong><small>{failedCount} 份失败 · {fallbackCount} 份待理解</small></div>
          </section>

          <section className="batch-results panel">
            <div className="panel-header"><div><h2>本次归档结果</h2><p>{waitingCount ? `${waitingCount} 份原文已保存、尚待 AI 整理；可以在下方开始整理` : '查看各项的保存与整理状态；日期仍可手动修正'}</p></div><div className="batch-result-actions"><button className="secondary-button" disabled={busy} onClick={resetForNextBatch}>{result.cancelled || pendingCount ? '返回待处理列表' : '再导入一批'}</button><button className="primary-button" onClick={waitingCount || failedCount ? openLibrary : openTimeline}><Timeline size={15} />{waitingCount || failedCount ? '查看已保存资料' : '完成并查看时间线'}</button></div></div>
            {fallbackCount > 0 && <div className="batch-review-warning"><CircleAlert size={15} /><span>{fallbackCount} 项尚未完成正文时间理解；系统会优先读取资料中的工作时间，AI 连接异常时可重新整理或手动补充日期。</span></div>}
            <div className="batch-date-groups">
              {groups.map((group) => (
                <section className="batch-date-group" key={group.date}>
                  <div className="batch-date-heading"><div className="batch-date-icon"><CalendarDays size={15} /></div><div><strong>{group.date === 'pending' ? '工作日期待识别' : group.date}</strong><span>{group.date === 'pending' ? '等待按正文内容分配' : `${friendlyDate(group.date)} · ${group.sources.length} 份资料`}</span></div><small>{group.sources.every(source => source.status === 'ready') ? '已完成整理' : '查看下方处理状态'}</small></div>
                  <div className="batch-source-list">
                    {group.sources.map((source) => (
                      <div className="batch-source-row" key={source.id}>
                        <div className="batch-source-status"><StatusPill status={source.status} />{(source.status === 'queued' || source.status === 'failed') && <>{source.error && <small>{source.error}</small>}<button className="text-button" disabled={busy} onClick={() => provider?.connected ? void retryFailure(source.id) : openSettings()}>{provider?.connected ? source.status === 'failed' ? '重试整理' : '开始整理' : '连接 AI 后整理'}</button></>}</div>
                        <button className="batch-source-open" onClick={() => onSelect(source)}><div className={`file-kind ${source.kind}`}><FileText size={15} /></div><div><strong>{source.title}</strong><span>{source.excerpt || '未提取到文字'}</span></div><ChevronRight size={15} /></button>
                        <div className="batch-date-editor"><span className={`date-origin-badge ${source.workDates.length || source.businessDate ? '' : 'fallback'} ${source.dateOrigin === 'manual' ? 'manual' : ''}`}>{source.dateOrigin === 'manual' ? '手动修正' : source.workDates.length > 1 ? `识别 ${source.workDates.length} 个工作日` : source.workDates.length === 1 || source.businessDate ? '正文识别' : '等待理解'}</span>{source.workDates.length <= 1 && <label><span>整份资料工作日</span><input type="date" aria-label={`${source.title}整份资料工作日`} value={source.businessDate ?? source.workDates[0] ?? ''} disabled={editingDateId === source.id} onChange={(event) => void updateDate(source, event.target.value)} /></label>}{source.workDates.length > 1 && <span className="batch-multi-date-note">多日内容已逐条归类</span>}{editingDateId === source.id && <LoaderCircle className="spin" size={14} />}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {!result.imported.length && <EmptyState icon={<Upload size={27} />} title="这次没有新增资料" text="重复文件已安全跳过；失败文件可以在下方直接重试。" />}
            </div>

            {result.duplicates.length > 0 && <div className="batch-duplicates"><div><CheckCircle2 size={15} /><strong>{result.duplicates.length} 份重复资料已跳过</strong><span>数据库中的原记录保持不变</span></div>{result.duplicates.map((item, index) => <button key={`${item.source.id}:${item.fileName}:${index}`} onClick={() => onSelect(item.source)}><div><strong>{item.fileName}</strong><span>{item.source.workDates.length ? `涉及工作日 ${formatWorkDateRange(item.source.workDates)}` : '等待理解工作时间'} · {item.source.title}</span></div><ChevronRight size={14} /></button>)}</div>}

            {activeFailures.length > 0 && <div className="batch-failures"><div><CircleAlert size={15} /><strong>{activeFailures.length} 份资料需要处理</strong></div>{activeFailures.map((item, index) => <div className="batch-failure-row" key={`${item.pendingTextId ?? item.sourceItemId ?? item.fileName}:${index}`}><div><strong>{item.fileName}</strong><span>{item.error}</span>{item.pendingTextId && <small>粘贴原文已保留在待处理列表</small>}</div>{item.pendingTextId ? <button className="secondary-button" disabled={busy} onClick={() => void retryTextFailure(item.pendingTextId!)}>{retryingId === item.pendingTextId ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{retryingId === item.pendingTextId ? '正在保存' : '重新保存'}</button> : item.sourceItemId ? <button className="secondary-button" disabled={busy} onClick={() => void retryFailure(item.sourceItemId!)}>{retryingId === item.sourceItemId ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}重新解析</button> : <small>请确认格式和文件大小后重新选择</small>}</div>)}</div>}
          </section>
        </>
      )}

      {phase !== 'processing' && <section className="batch-library-note"><Database size={17} /><div><strong>当前本地工作库已有 {snapshot.sources.length} 份资料</strong><span>原文件与解析文字都保存在本机；批量上传不会覆盖已有内容。</span></div><button className="text-button" onClick={openLibrary}>进入工作资料库 <ArrowRight size={13} /></button></section>}
    </div>
  )
}

function mergeImportResults(current: BatchImportResult | null, next: BatchImportResult): BatchImportResult {
  if (!current) return next
  const imported = new Map(current.imported.map((source) => [source.id, source]))
  for (const source of next.imported) imported.set(source.id, source)
  const duplicates = new Map(current.duplicates.map((item) => [`${item.source.id}:${item.fileName}`, item]))
  for (const item of next.duplicates) duplicates.set(`${item.source.id}:${item.fileName}`, item)
  const failed = new Map(current.failed.map((item) => [item.pendingTextId ?? item.sourceItemId ?? item.fileName, item]))
  for (const item of next.failed) failed.set(item.pendingTextId ?? item.sourceItemId ?? item.fileName, item)
  return {
    imported: Array.from(imported.values()),
    duplicates: Array.from(duplicates.values()),
    failed: Array.from(failed.values()),
    cancelled: current.cancelled || next.cancelled,
    analysisSkipped: next.analysisSkipped ?? current.analysisSkipped ?? null
  }
}

function AskWorkPage({ busy, setBusy, requestRef, snapshot, entries, setEntries, onOpenCitation, fail }: { busy: boolean; setBusy: Dispatch<SetStateAction<boolean>>; requestRef: { current: number }; snapshot: AppSnapshot; entries: WorkChatEntry[]; setEntries: Dispatch<SetStateAction<WorkChatEntry[]>>; onOpenCitation: (citation: WorkQuestionCitation) => void; fail: (error: unknown) => void }): ReactNode {
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const examples = ['上个月我主要完成了哪些工作？', '最近两周有哪些重要交付和阻塞？', '我在登录页改版上做过哪些事情？']

  useEffect(() => {
    const thread = threadRef.current
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  }, [entries, busy])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const question = draft.trim()
    if (!question || busy) return
    const request = ++requestRef.current
    const history: WorkQuestionMessage[] = entries
      .slice(-8)
      .map((entry) => ({ role: entry.role, content: entry.content }))
    const userEntry: WorkChatEntry = { id: messageId(), role: 'user', content: question }
    setEntries((current) => [...current, userEntry])
    setDraft('')
    setBusy(true)
    try {
      const answer = await window.worklens.askWorkQuestion({ question, history })
      if (request !== requestRef.current) return
      setEntries((current) => [...current, { id: messageId(), role: 'assistant', content: answer.answer, answer }])
    } catch (error) {
      if (request === requestRef.current) fail(error)
    } finally {
      if (request === requestRef.current) setBusy(false)
    }
  }

  const latestAnswer = [...entries].reverse().find((entry) => entry.answer)?.answer
  return (
    <div className="knowledge-layout">
      <section className="knowledge-chat panel">
        <div className="knowledge-chat-head">
          <div className="knowledge-avatar"><MessageCircleQuestion size={20} /></div>
          <div><h2>向我的工作资料提问</h2><p>先在本地检索相关记录，再由当前选择的本机 AI 基于命中内容回答</p></div>
          <span className="local-ai-badge"><span />本机 AI</span>
          {entries.length > 0 && <button className="ghost-button compact" disabled={busy} onClick={() => { requestRef.current += 1; setEntries([]) }}>清空会话</button>}
        </div>

        <div ref={threadRef} className={`knowledge-thread ${entries.length ? 'has-messages' : ''}`}>
          {!entries.length && (
            <div className="knowledge-welcome">
              <div className="knowledge-orbit"><Database size={28} /><Sparkles size={15} /></div>
              <h2>过往工作，现在可以直接问</h2>
              <p>可以按日期、项目、事项或关键词提问。回答只使用数据库中检索到的工作内容，并附上可回看的来源。</p>
              <div className="question-examples">
                {examples.map((question) => <button key={question} onClick={() => setDraft(question)}>{question}<ArrowRight size={14} /></button>)}
              </div>
            </div>
          )}
          {entries.map((entry) => entry.role === 'user' ? (
            <div className="chat-row user" key={entry.id}><div className="chat-bubble user-bubble">{entry.content}</div></div>
          ) : (
            <div className="chat-row assistant" key={entry.id}>
              <div className="assistant-avatar"><Bot size={16} /></div>
              <article className="answer-card">
                <div className="answer-copy">{entry.content.split(/\n+/).map((paragraph, index) => <p key={`${entry.id}:${index}`}>{paragraph}</p>)}</div>
                {entry.answer?.citations.length ? (
                  <div className="answer-sources">
                    <div className="answer-section-label"><FileText size={13} />回答依据</div>
                    <div className="citation-grid">
                      {entry.answer.citations.map((citation, index) => (
                        <button key={`${citation.refId}:${index}`} onClick={() => onOpenCitation(citation)}>
                          <span className={`citation-kind ${citation.entityType}`}>{citation.entityType === 'source' ? '原始记录' : citation.entityType === 'brief' ? '日报' : '事项'}</span>
                          <strong>{citation.title}</strong><small>{citation.date ?? '日期未知'}</small>
                          <q>{citation.quote}</q>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : <div className="no-citation-note"><CircleAlert size={13} />这次回答没有可验证的逐字引用，请缩小问题范围后重试。</div>}
                {entry.answer?.suggestedQuestions.length ? <div className="followup-row">{entry.answer.suggestedQuestions.map((question) => <button key={question} onClick={() => setDraft(question)}>{question}</button>)}</div> : null}
                {entry.answer && <div className="answer-meta">检索 {entry.answer.retrievedCount} 条本地资料 · {entry.answer.model}</div>}
              </article>
            </div>
          ))}
          {busy && <div className="chat-row assistant"><div className="assistant-avatar"><Bot size={16} /></div><div className="answer-thinking"><LoaderCircle className="spin" size={16} /><div><strong>正在查找相关工作记录</strong><span>命中内容将交给当前选择的本机 AI 整理回答</span></div></div></div>}
        </div>

        <form className="knowledge-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="例如：上个月我在支付项目上完成了什么？" maxLength={1000} rows={2} />
          <div className="composer-footer"><button className="primary-button" disabled={busy || draft.trim().length < 2}>{busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}向本机 AI 提问</button></div>
        </form>
      </section>

      <aside className="knowledge-aside">
        <section className="panel knowledge-scope"><div className="eyebrow"><Database size={13} />本地知识范围</div><h3>{snapshot.sources.length} 份原始资料</h3><p>同时检索 {snapshot.dailyBriefs.length} 份日报、{snapshot.events.length} 条历史进展和 {snapshot.workItems.length} 个聚合事项。</p><ul><li><Check size={13} />支持“上周、上个月、最近 30 天”</li><li><Check size={13} />按项目名和正文关键词匹配</li><li><Check size={13} />引用可以打开原始资料</li></ul></section>
        <section className="knowledge-tip"><Sparkles size={17} /><div><strong>提问小技巧</strong><p>带上日期范围和项目名，会得到更准确、引用更集中的答案。</p></div></section>
        {latestAnswer && <section className="knowledge-last"><span>最近一次检索</span><strong>{latestAnswer.retrievedCount} 条资料</strong><small>{latestAnswer.model}</small></section>}
      </aside>
    </div>
  )
}

interface HistoryRailPreviewItem {
  title: string
  summary: string
  eventType: string
}

interface HistoryRailGroup {
  date: string
  count: number
  itemNoun: string
  items: HistoryRailPreviewItem[]
}

function HistoryRail({
  pageRef,
  groups,
  activeDate,
  navLabel,
  previewId,
  onJump
}: {
  pageRef: { current: HTMLDivElement | null }
  groups: HistoryRailGroup[]
  activeDate: string | null
  navLabel: string
  previewId: string
  onJump: (date: string) => void
}): ReactNode {
  const [preview, setPreview] = useState<{
    date: string
    count: number
    itemNoun: string
    items: HistoryRailPreviewItem[]
    remaining: number
    top: number
    left: number
    width: number
  } | null>(null)
  const [railBox, setRailBox] = useState<{ top: number; left: number; height: number } | null>(null)
  const railRef = useRef<HTMLElement | null>(null)
  const markersRef = useRef<HTMLElement | null>(null)
  const historyWindowRef = useRef<HTMLDivElement | null>(null)
  const previousActiveIndexRef = useRef<number | null>(null)
  const lastWheelAt = useRef(0)

  useLayoutEffect(() => {
    const page = railRef.current?.closest<HTMLDivElement>('.timeline-page') ?? pageRef.current
    const content = page?.closest<HTMLElement>('main.content')
    const stream = page?.querySelector<HTMLElement>(':scope > .timeline-work-stream')
    if (!page || !content || !stream) return
    const updateRailBox = (): void => {
      const contentBox = content.getBoundingClientRect()
      const streamBox = stream.getBoundingClientRect()
      const railWidth = railRef.current?.getBoundingClientRect().width ?? 24
      const blankCenter = contentBox.left + Math.max(0, streamBox.left - contentBox.left) / 2
      const next = { top: contentBox.top, left: blankCenter - railWidth / 2, height: contentBox.height }
      setRailBox((current) => current
        && Math.abs(current.top - next.top) < 0.5
        && Math.abs(current.left - next.left) < 0.5
        && Math.abs(current.height - next.height) < 0.5
        ? current
        : next)
    }
    updateRailBox()
    const observer = new ResizeObserver(updateRailBox)
    observer.observe(content)
    observer.observe(page)
    observer.observe(stream)
    window.addEventListener('resize', updateRailBox)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateRailBox)
    }
  }, [groups.length, pageRef])

  const jumpToDate = useCallback((date: string): void => {
    setPreview(null)
    onJump(date)
  }, [onJump])

  const handleWheel = useCallback((event: WheelEvent): void => {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (Math.abs(delta) < 2) return
    const now = performance.now()
    if (now - lastWheelAt.current < 280) {
      event.preventDefault()
      return
    }
    const currentIndex = Math.max(0, groups.findIndex((group) => group.date === activeDate))
    const nextIndex = Math.min(groups.length - 1, Math.max(0, currentIndex + (delta > 0 ? 1 : -1)))
    if (nextIndex === currentIndex) return
    event.preventDefault()
    lastWheelAt.current = now
    jumpToDate(groups[nextIndex]!.date)
  }, [activeDate, groups, jumpToDate])

  useEffect(() => {
    const markers = markersRef.current
    if (!markers) return
    markers.addEventListener('wheel', handleWheel, { passive: false })
    return () => markers.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const activeIndex = groups.length ? Math.max(0, groups.findIndex((group) => group.date === activeDate)) : 0
  useLayoutEffect(() => {
    const previousIndex = previousActiveIndexRef.current
    previousActiveIndexRef.current = activeIndex
    const historyWindowElement = historyWindowRef.current
    if (!groups.length || previousIndex === null || previousIndex === activeIndex || !historyWindowElement) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    historyWindowElement.getAnimations().forEach((animation) => animation.cancel())
    historyWindowElement.animate(
      [
        { opacity: 0.48, transform: `translateY(${activeIndex > previousIndex ? 8 : -8}px)` },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
  }, [activeIndex, groups.length])

  if (!groups.length) return null
  const historyWindow = getTimelineHistoryWindow(groups, activeIndex)
  const showPreview = (target: HTMLButtonElement, group: HistoryRailGroup): void => {
    const bounds = target.getBoundingClientRect()
    const left = bounds.right + 16
    setPreview({
      date: group.date,
      count: group.count,
      itemNoun: group.itemNoun,
      items: group.items.slice(0, 2),
      remaining: Math.max(0, group.count - 2),
      top: (window.innerHeight + 92) / 2,
      left,
      width: Math.min(420, Math.max(260, window.innerWidth - left - 24))
    })
  }

  return <>
    <aside ref={railRef} className={`timeline-history-index ${railBox ? 'measured' : ''}`} aria-label="工作日期历史索引" style={railBox ?? undefined}>
      <nav ref={markersRef} className="timeline-history-markers" aria-label={navLabel}>
        <div ref={historyWindowRef} className="timeline-history-window">
          {historyWindow.map(({ item: group, index }) => {
            const active = activeDate === group.date
            const distance = Math.abs(index - activeIndex)
            const tickWidth = active ? 18 : distance === 1 ? 13 : distance === 2 ? 10 : distance === 3 ? 8 : 6
            const spokenTitles = group.items.slice(0, 2).map((item) => item.title).join('、')
            const remaining = Math.max(0, group.count - 2)
            const label = `${friendlyDate(group.date)}，${group.count} ${group.itemNoun}：${spokenTitles}${remaining ? `，另有 ${remaining} 项` : ''}`
            return <button key={group.date} className={active ? 'active' : ''} aria-label={label} aria-current={active ? 'date' : undefined} aria-describedby={preview?.date === group.date ? previewId : undefined} onMouseDown={(event) => event.preventDefault()} onMouseEnter={(event) => showPreview(event.currentTarget, group)} onMouseLeave={() => setPreview(null)} onFocus={(event) => showPreview(event.currentTarget, group)} onBlur={() => setPreview(null)} onClick={() => jumpToDate(group.date)}><span className="timeline-history-line" style={{ width: tickWidth }} /></button>
          })}
        </div>
      </nav>
    </aside>
    {preview && <section id={previewId} className="timeline-history-tooltip" role="tooltip" style={{ top: preview.top, left: preview.left, width: preview.width }}><header><div><strong>{friendlyDate(preview.date)}</strong><small>{preview.count} {preview.itemNoun}</small></div><span>点击刻度跳转</span></header><div className="timeline-history-preview-list">{preview.items.map((item, index) => <article key={`${item.title}:${index}`}><span>{item.eventType}</span><div><strong>{item.title}</strong><p>{item.summary}</p></div></article>)}</div>{preview.remaining > 0 && <footer>还有 {preview.remaining} 项</footer>}</section>}
  </>
}

function TimelinePage({ snapshot, onSelect, onRequestDelete }: { snapshot: AppSnapshot; onSelect: (source: SourceItem) => void; onRequestDelete: (event: WorkEvent) => void }): ReactNode {
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const groupRefs = useRef<Record<string, HTMLElement | null>>({})
  const timelinePageRef = useRef<HTMLDivElement | null>(null)
  const pendingTimelineDateRef = useRef<{ date: string; until: number } | null>(null)
  const groups = useMemo(() => {
    const map = new Map<string, WorkEvent[]>()
    for (const event of snapshot.events) {
      if (!event.eventDate) continue
      const date = event.eventDate.slice(0, 10)
      map.set(date, [...(map.get(date) ?? []), event])
    }
    return Array.from(map, ([date, events]) => ({ date, events })).sort((a, b) => a.date.localeCompare(b.date))
  }, [snapshot.events])
  const historyGroups = useMemo<HistoryRailGroup[]>(() => groups.map((group) => ({
    date: group.date,
    count: group.events.length,
    itemNoun: '项工作内容',
    items: group.events.map((event) => ({ title: event.title, summary: event.summary, eventType: event.eventType }))
  })), [groups])

  useEffect(() => {
    if (!groups.length) return
    setActiveDate((current) => current && groups.some((group) => group.date === current) ? current : groups[0]!.date)
  }, [groups])

  useEffect(() => {
    if (!groups.length) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      const pending = pendingTimelineDateRef.current
      if (pending) {
        if (performance.now() >= pending.until) {
          pendingTimelineDateRef.current = null
        } else if (visible.some((entry) => (entry.target as HTMLElement).dataset.timelineDate === pending.date)) {
          pendingTimelineDateRef.current = null
          setActiveDate(pending.date)
          return
        } else {
          return
        }
      }
      const date = (visible[0]?.target as HTMLElement | undefined)?.dataset.timelineDate
      if (date) setActiveDate(date)
    }, { rootMargin: '-112px 0px -55% 0px', threshold: [0, 0.05, 0.2] })
    groups.forEach((group) => {
      const element = groupRefs.current[group.date]
      if (element) observer.observe(element)
    })
    return () => observer.disconnect()
  }, [groups])

  const jumpToDate = useCallback((date: string): void => {
    setActiveDate(date)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    pendingTimelineDateRef.current = reducedMotion ? null : { date, until: performance.now() + 800 }
    groupRefs.current[date]?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
  }, [])

  if (!groups.length) return <EmptyState large icon={<Clock3 size={34} />} title="时间线等待第一条工作内容" text="日报生成并沉淀工作事项后，会按工作日显示在这里。" />
  return (
    <div ref={timelinePageRef} className="timeline-page">
      <div className="history-recent-jump"><button className="secondary-button" onClick={() => { const latest = groups.at(-1); if (latest) jumpToDate(latest.date) }}><Clock3 size={14} />最近工作</button></div>
      <HistoryRail pageRef={timelinePageRef} groups={historyGroups} activeDate={activeDate} navLabel="工作日期从早到晚排列，可点击或使用鼠标滚轮切换" previewId="timeline-history-preview" onJump={jumpToDate} />
      <div className="timeline-work-stream">
        {groups.map((group) => (
          <section className="timeline-group" data-timeline-date={group.date} key={group.date} ref={(element) => { groupRefs.current[group.date] = element }}>
            <div className="timeline-group-header"><h2>{friendlyDate(group.date)}</h2><span>{group.events.length} 项工作内容</span></div>
            {group.events.map((event) => {
              const key = `event:${event.id}`
              const expanded = expandedItem === key
              const evidenceItems = event.evidence.map((evidence) => ({
                evidence,
                source: snapshot.sources.find((item) => item.id === evidence.sourceItemId) ?? null
              }))
              return <article className={`timeline-card timeline-expand-card event-card ${expanded ? 'expanded' : ''}`} key={event.id}>
                <div className="timeline-card-header">
                  <button className="timeline-card-trigger" aria-expanded={expanded} onClick={() => setExpandedItem(expanded ? null : key)}><div className="timeline-card-icon"><BriefcaseBusiness size={17} /></div><div><div className="card-meta"><span>{normalizeWorkItemCategory(event.eventType)}</span>{event.confidence < 0.7 && <span title="AI 对归类的把握较低，请核对原文">待核对</span>}</div><h3>{event.title}</h3><p>{event.summary}</p></div><ChevronDown size={18} /></button>
                  <button className="card-delete-button timeline-card-delete" aria-label={`删除时间线内容：${event.title}`} title="删除这条时间线内容" onClick={() => onRequestDelete(event)}><Trash2 size={15} /></button>
                </div>
                {expanded && <div className="timeline-card-detail event-detail"><div className="timeline-detail-heading"><strong>事项详情</strong><span>{event.eventDate ?? '日期未定'} · {event.evidence.length} 条相关证据</span></div><p>{event.summary}</p><div className="timeline-original-content"><strong>相关原文：</strong><div className="timeline-evidence-list">{evidenceItems.length ? evidenceItems.map(({ evidence, source }) => <article key={evidence.id}><q>{evidence.quote}</q><div><span>{source?.title ?? '原始资料'}</span>{source && <button className="text-button" onClick={() => onSelect(source)}>打开完整原始资料 <ArrowRight size={13} /></button>}</div></article>) : <p>暂无可显示的相关原文片段</p>}</div></div></div>}
              </article>
            })}
          </section>
        ))}
      </div>
    </div>
  )
}

export function EventsPage({ workItems, events, sources, initialSection = 'events', focusedEventId, onFocusHandled, onSectionChange, onSelectSource, onRequestDelete, onChanged, notify, fail }: { workItems: WorkItem[]; events: WorkEvent[]; sources: SourceItem[]; initialSection?: 'events' | 'library'; focusedEventId?: string | null; onFocusHandled?: () => void; onSectionChange?: (section: 'events' | 'library') => void; onSelectSource: (source: SourceItem) => void; onRequestDelete: (item: WorkItem) => void; onChanged: () => Promise<void>; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [typeFilter, setTypeFilter] = useState('all')
  const [qualityFilter, setQualityFilter] = useState<'main' | 'review' | 'all'>('main')
  const [filterOpen, setFilterOpen] = useState(false)
  const [section, setSection] = useState<'events' | 'library'>(initialSection)
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null)
  const [highlightedWorkItemId, setHighlightedWorkItemId] = useState<string | null>(null)
  const [cardFocusRequest, setCardFocusRequest] = useState(0)
  const [editor, setEditor] = useState<{ item: WorkItem; mode: 'edit' | 'merge' } | null>(null)
  const [activeWorkItemDate, setActiveWorkItemDate] = useState<string | null>(null)
  const [reorganizingSourceId, setReorganizingSourceId] = useState<string | null>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const workItemsPageRef = useRef<HTMLDivElement | null>(null)
  const workItemCardRefs = useRef<Record<string, HTMLElement | null>>({})
  const pendingCardFocusRef = useRef(false)
  const onFocusHandledRef = useRef(onFocusHandled)
  onFocusHandledRef.current = onFocusHandled
  const workItemGroupRefs = useRef<Record<string, HTMLElement | null>>({})
  const pendingWorkItemDateRef = useRef<{ date: string; until: number } | null>(null)
  const focusedItem = useMemo(() => focusedEventId ? workItems.find((item) => item.eventIds.includes(focusedEventId)) : undefined, [focusedEventId, workItems])
  const reviewReasons = useMemo(() => new Map(workItems.map((item) => [item.id, getWorkItemReviewReasons(item)])), [workItems])
  const fragments = useMemo(() => new Set(workItems.filter((item) => item.isFragment ?? isWorkItemFragmentTitle(item.title)).map((item) => item.id)), [workItems])
  const reviewCount = workItems.filter((item) => reviewReasons.get(item.id)?.length).length
  const types = Array.from(new Set(workItems.map((item) => normalizeWorkItemCategory(item.eventType))))
  const filterOptions = [{ value: 'all', label: '全部类型' }, ...types.map((type) => ({ value: type, label: type }))]
  const visible = useMemo(() => workItems.filter((item) => {
    if (focusedItem?.id === item.id) return true
    if (typeFilter !== 'all' && normalizeWorkItemCategory(item.eventType) !== typeFilter) return false
    return qualityFilter === 'all' || (qualityFilter === 'review' ? Boolean(reviewReasons.get(item.id)?.length) : !fragments.has(item.id))
  }), [focusedItem?.id, fragments, qualityFilter, reviewReasons, typeFilter, workItems])
  const workItemDateGroups = useMemo(() => {
    const map = new Map<string, WorkItem[]>()
    for (const item of visible) {
      if (!item.latestDate) continue
      const date = item.latestDate.slice(0, 10)
      map.set(date, [...(map.get(date) ?? []), item])
    }
    return Array.from(map, ([date, items]) => ({ date, items })).sort((left, right) => left.date.localeCompare(right.date))
  }, [visible])
  const undatedWorkItems = useMemo(() => visible.filter((item) => !item.latestDate), [visible])
  const workItemHistoryGroups = useMemo<HistoryRailGroup[]>(() => workItemDateGroups.map((group) => ({
    date: group.date,
    count: group.items.length,
    itemNoun: '个工作事项',
    items: group.items.map((item) => ({ title: item.title, summary: item.summary, eventType: normalizeWorkItemCategory(item.eventType) }))
  })), [workItemDateGroups])
  const sourceLibrary = [...sources].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  useEffect(() => setSection(initialSection), [initialSection])
  useEffect(() => {
    if (!focusedItem) return
    pendingCardFocusRef.current = true
    setSection('events')
    setTypeFilter('all')
    setQualityFilter('all')
    setExpandedEvidence(focusedItem.id)
    setHighlightedWorkItemId(focusedItem.id)
    setCardFocusRequest((request) => request + 1)
  }, [focusedEventId, focusedItem?.id])
  useLayoutEffect(() => {
    if (!highlightedWorkItemId || section !== 'events' || !pendingCardFocusRef.current) return
    const card = workItemCardRefs.current[highlightedWorkItemId]
    if (!card) return
    const frame = window.requestAnimationFrame(() => {
      pendingCardFocusRef.current = false
      card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
      card.focus({ preventScroll: true })
      if (focusedItem?.id === highlightedWorkItemId) onFocusHandledRef.current?.()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [cardFocusRequest, highlightedWorkItemId, section, focusedItem?.id])
  const changeSection = (nextSection: 'events' | 'library'): void => {
    setSection(nextSection)
    onSectionChange?.(nextSection)
  }
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])
  useEffect(() => {
    if (!workItemDateGroups.length) {
      setActiveWorkItemDate(null)
      return
    }
    setActiveWorkItemDate((current) => current && workItemDateGroups.some((group) => group.date === current) ? current : workItemDateGroups[0]!.date)
  }, [workItemDateGroups])
  useEffect(() => {
    if (!workItemDateGroups.length || section !== 'events') return
    const observer = new IntersectionObserver((entries) => {
      const visibleEntries = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      const pending = pendingWorkItemDateRef.current
      if (pending) {
        if (performance.now() >= pending.until) {
          pendingWorkItemDateRef.current = null
        } else if (visibleEntries.some((entry) => (entry.target as HTMLElement).dataset.workItemDate === pending.date)) {
          pendingWorkItemDateRef.current = null
          setActiveWorkItemDate(pending.date)
          return
        } else {
          return
        }
      }
      const date = (visibleEntries[0]?.target as HTMLElement | undefined)?.dataset.workItemDate
      if (date) setActiveWorkItemDate(date)
    }, { rootMargin: '-112px 0px -55% 0px', threshold: [0, 0.05, 0.2] })
    workItemDateGroups.forEach((group) => {
      const element = workItemGroupRefs.current[group.date]
      if (element) observer.observe(element)
    })
    return () => observer.disconnect()
  }, [section, workItemDateGroups])
  const jumpToWorkItemDate = useCallback((date: string): void => {
    setActiveWorkItemDate(date)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    pendingWorkItemDateRef.current = reducedMotion ? null : { date, until: performance.now() + 800 }
    workItemGroupRefs.current[date]?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
  }, [])
  const reorganizeSource = async (source: SourceItem): Promise<void> => {
    if (reorganizingSourceId) return
    setReorganizingSourceId(source.id)
    try {
      const result = await window.worklens.reanalyzeSource(source.id)
      await onChanged()
      notify(result.message)
    } catch (error) {
      fail(error)
      await onChanged()
    } finally {
      setReorganizingSourceId(null)
    }
  }
  const renderWorkItemCard = (item: WorkItem): ReactNode => {
    const expanded = expandedEvidence === item.id
    const reasons = reviewReasons.get(item.id) ?? []
    const history = events.filter((event) => item.eventIds.includes(event.id)).sort((a, b) => (b.eventDate ?? b.updatedAt).localeCompare(a.eventDate ?? a.updatedAt))
    const mergedSources = item.sourceItemIds.map((sourceId) => sources.find((source) => source.id === sourceId)).filter((source): source is SourceItem => Boolean(source))
    return <article className={`entity-card work-item-card ${expanded ? 'evidence-expanded' : ''} ${highlightedWorkItemId === item.id ? 'work-item-focused' : ''}`} key={item.id} ref={(element) => { workItemCardRefs.current[item.id] = element }} tabIndex={-1} aria-label={`工作事项：${item.title}`}>
      <div className="entity-card-top"><span className="entity-type"><BriefcaseBusiness size={14} />{normalizeWorkItemCategory(item.eventType)}</span><div className="entity-card-actions"><span>最近更新 {item.latestDate ?? '日期未定'}</span><button className="card-delete-button" aria-label={`删除工作事项：${item.title}`} title="删除这个工作事项" onClick={() => onRequestDelete(item)}><Trash2 size={15} /></button></div></div>
      <h3>{item.title}</h3><p>{item.summary}</p>
      {reasons.length > 0 && <div className="work-item-review-reasons"><strong><CircleAlert size={12} /> 待核对</strong><ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
      <div className="work-item-edit-actions"><button onClick={() => setEditor({ item, mode: 'edit' })} aria-label={`修改标题和分类：${item.title}`}>修改标题 / 分类</button><button disabled={workItems.length < 2} onClick={() => setEditor({ item, mode: 'merge' })} aria-label={`合并工作事项：${item.title}`}>合并事项</button></div>
      <button className="mini-evidence" aria-expanded={expanded} onClick={() => setExpandedEvidence(expanded ? null : item.id)}><span><Timeline size={13} />{item.eventCount} 次进展 · {item.sourceItemIds.length} 份来源</span><ChevronDown size={14} /></button>
      {expanded && <div className="work-item-expanded">
        <section><div className="work-item-section-title"><strong>进展时间线</strong><span>{item.firstDate && item.latestDate ? `${item.firstDate} — ${item.latestDate}` : '日期待确认'}</span></div><div className="work-item-history">{history.map((event) => <article key={event.id}><time>{event.eventDate ?? '日期未定'}</time><div><strong>{event.title}</strong><p>{event.summary}</p></div></article>)}</div></section>
        <section><div className="work-item-section-title"><strong>全部合并来源</strong><span>{item.evidence.length} 条相关证据</span></div><div className="work-item-sources">{mergedSources.map((source) => { const quotes = item.evidence.filter((evidence) => evidence.sourceItemId === source.id); return <button key={source.id} onClick={() => onSelectSource(source)}><div><FileText size={14} /><span><strong>{source.title}</strong><small>上传于 {formatTimestamp(source.createdAt)}</small></span><ChevronRight size={14} /></div>{quotes[0] && <q>{quotes[0].quote}</q>}{quotes.length > 1 && <small>另有 {quotes.length - 1} 条相关证据</small>}</button> })}</div></section>
      </div>}
      <div className="entity-footer"><span>{item.manualEdited ? '已人工校正' : reasons.length ? '建议查看来源核对' : '来源可追溯'}</span><span>{item.eventCount} 个日期事件 · {item.sourceItemIds.length} 份资料</span></div>
    </article>
  }
  return (
    <div className="page-stack">
      <section className="events-overview">
        <div><div className="eyebrow">{section === 'events' ? <Activity size={14} /> : <Library size={14} />}{section === 'events' ? '聚合后的工作事项' : '原始工作资料库'}</div><h2>{section === 'events' ? `${workItems.length} 个可追溯工作事项` : `${sources.length} 份原始工作资料`}</h2><p>{section === 'events' ? '同类工作跨日期合并，卡片始终显示最新进展，并保留全部历史事件与来源。' : '按真实上传时间排序；可重新调用当前 Codex/Cursor 读取全文并更新日期和工作事项。'}</p></div>
        <div className="events-overview-actions">
          <div className="events-view-switch" aria-label="工作内容视图"><button className={section === 'events' ? 'active' : ''} onClick={() => changeSection('events')}><BriefcaseBusiness size={14} />工作事项</button><button className={section === 'library' ? 'active' : ''} onClick={() => changeSection('library')}><Library size={14} />工作资料库</button></div>
          {section === 'events' && workItems.length > 0 && <div className={`events-filter-menu ${filterOpen ? 'open' : ''}`} ref={filterMenuRef}>
            <button className="events-filter-trigger" aria-label="筛选工作事项类型" aria-haspopup="listbox" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)} onKeyDown={(event) => { if (event.key === 'Escape') setFilterOpen(false) }}><ListFilter size={14} /><span>{typeFilter === 'all' ? '全部类型' : typeFilter}</span><ChevronDown size={14} /></button>
            {filterOpen && <div className="events-filter-popover" role="listbox" aria-label="工作事项类型">
              {filterOptions.map((option) => {
                const selected = typeFilter === option.value
                const count = option.value === 'all' ? workItems.length : workItems.filter((item) => normalizeWorkItemCategory(item.eventType) === option.value).length
                return <button key={option.value} className={selected ? 'selected' : ''} role="option" aria-selected={selected} onClick={() => { setTypeFilter(option.value); setFilterOpen(false) }}><span>{option.label}<small>{count} 项</small></span>{selected && <Check size={14} />}</button>
              })}
            </div>}
          </div>}
        </div>
      </section>
      {section === 'events' && workItems.length > 0 && <>
        <div className="work-item-quality-toolbar"><div className="work-item-quality-filters" role="group" aria-label="工作事项核对筛选"><button aria-pressed={qualityFilter === 'main'} onClick={() => setQualityFilter('main')}>主要事项 {workItems.length - fragments.size}</button><button aria-pressed={qualityFilter === 'review'} onClick={() => setQualityFilter('review')}>待核对 {reviewCount}</button><button aria-pressed={qualityFilter === 'all'} onClick={() => setQualityFilter('all')}>全部 {workItems.length}</button></div><button className="secondary-button" disabled={!workItemDateGroups.length} onClick={() => { const latest = workItemDateGroups.at(-1); if (latest) jumpToWorkItemDate(latest.date) }}><Clock3 size={14} />最近更新</button></div>
        {qualityFilter === 'main' && fragments.size > 0 && <div className="work-item-review-notice"><CircleAlert size={14} /><span>已收起 {fragments.size} 个疑似片段，原始资料和历史进展仍保留。</span><button onClick={() => { setQualityFilter('review'); setTypeFilter('all') }}>查看并核对</button></div>}
      </>}
      {section === 'events' && (workItems.length ? visible.length ? <div ref={workItemsPageRef} className="timeline-page work-items-timeline-page">
        <HistoryRail pageRef={workItemsPageRef} groups={workItemHistoryGroups} activeDate={activeWorkItemDate} navLabel="工作事项按最近更新日期从早到晚排列，可点击或使用鼠标滚轮切换" previewId="work-items-history-preview" onJump={jumpToWorkItemDate} />
        <div className="timeline-work-stream work-items-by-date">
          {workItemDateGroups.map((group) => <section className="work-item-date-group" data-work-item-date={group.date} key={group.date} ref={(element) => { workItemGroupRefs.current[group.date] = element }}><div className="work-item-date-heading"><h3>{friendlyDate(group.date)}</h3><span>{group.items.length} 个工作事项最近更新</span></div><div className="card-grid">{group.items.map(renderWorkItemCard)}</div></section>)}
          {undatedWorkItems.length > 0 && <section className="work-item-date-group"><div className="work-item-date-heading"><h3>日期未定</h3><span>{undatedWorkItems.length} 个工作事项</span></div><div className="card-grid">{undatedWorkItems.map(renderWorkItemCard)}</div></section>}
        </div>
      </div> : <EmptyState large icon={<ListFilter size={34} />} title={qualityFilter === 'review' ? '当前筛选下没有待核对事项' : '没有符合筛选条件的工作事项'} text="可以切换上方分类或选择“全部”，查看其他工作事项。" /> : <EmptyState large icon={<BriefcaseBusiness size={34} />} title="还没有合并后的工作事项" text="生成第一份日报后，关键进展、会议、交付、问题和决策会显示在这里。" />)}
      {section === 'library' && (sourceLibrary.length ? <section className="source-library panel"><div className="source-library-head"><div><span>资料名称</span><span>类型</span><span>上传时间</span><span>状态</span><span /></div><span>操作</span></div>{sourceLibrary.map((source) => { const uploaded = formatTimestamp(source.createdAt).split(' '); const reorganizing = reorganizingSourceId === source.id; return <article className="source-library-row" key={source.id}><button className="source-library-open" onClick={() => onSelectSource(source)}><div><div className={`file-kind ${source.kind}`}><FileText size={15} /></div><span><strong>{source.title}</strong><small>{source.workDates.length ? `涉及工作日：${formatWorkDateRange(source.workDates)}` : source.excerpt || '等待识别工作日期'}</small></span></div><span className="source-library-kind">{source.kind.toUpperCase()}</span><time>{uploaded[0]}<small>{uploaded[1] ?? ''}</small></time><StatusPill status={source.status} /><ChevronRight size={15} /></button><button className="source-reanalyze-button" aria-label={`重新整理：${source.title}`} disabled={Boolean(reorganizingSourceId)} onClick={() => void reorganizeSource(source)}>{reorganizing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}<span>{reorganizing ? '整理中' : '重新整理'}</span></button></article>})}</section> : <EmptyState large icon={<Library size={34} />} title="工作资料库还是空的" text="通过每日记录或批量上传添加资料后，可以在这里按日期回看原始内容。" />)}
      {editor && <WorkItemEditor key={`${editor.mode}:${editor.item.id}`} item={editor.item} workItems={workItems} mode={editor.mode} onClose={() => setEditor(null)} onSaved={async (updated, message) => { await onChanged(); pendingCardFocusRef.current = true; setQualityFilter('all'); setTypeFilter('all'); setExpandedEvidence(updated.id); setHighlightedWorkItemId(updated.id); setCardFocusRequest((request) => request + 1); notify(message) }} />}
    </div>
  )
}

function ExportPage({ snapshot, notify, fail }: { snapshot: AppSnapshot; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [busy, setBusy] = useState('')
  const rangeComplete = Boolean(fromDate && toDate)
  const rangeInvalid = rangeComplete && fromDate > toDate
  const exportReady = rangeComplete && !rangeInvalid
  const previewCounts = useMemo(() => {
    if (!exportReady) return null
    const inRange = (value: string | null): boolean => {
      if (!value) return false
      const date = value.slice(0, 10)
      return date >= fromDate && date <= toDate
    }
    const sources = snapshot.sources.filter((source) => source.workDates.length
      ? source.workDates.some((date) => inRange(date))
      : inRange(source.businessDate))
    return {
      sources: sources.length,
      briefs: snapshot.dailyBriefs.filter((brief) => inRange(brief.workDate)).length,
      events: snapshot.events.filter((event) => inRange(event.eventDate)).length
    }
  }, [exportReady, fromDate, snapshot, toDate])
  const runExport = async (format: ExportRequest['format']): Promise<void> => {
    if (!exportReady) {
      fail(new Error(rangeInvalid ? '开始日期不能晚于结束日期，请重新选择' : '请先选择开始日期和结束日期'))
      return
    }
    setBusy(format)
    try {
      const result = await window.worklens.exportData({
        format,
        fromDate,
        toDate,
        includeAttachments: false
      })
      if (result.ok) notify(result.message)
    } catch (error) {
      fail(error)
    } finally {
      setBusy('')
    }
  }
  const backup = async (): Promise<void> => {
    setBusy('backup')
    try {
      const result = await window.worklens.createBackup()
      if (result.ok) notify(result.message)
    } catch (error) {
      fail(error)
    } finally {
      setBusy('')
    }
  }
  const formats = [
    { id: 'markdown', title: '工作汇报 Markdown', text: '早会稿、日报、时间线与工作事项', icon: FileText },
    { id: 'pdf', title: '工作汇报 PDF', text: '适合周报、复盘和向上汇报', icon: Download },
    { id: 'csv', title: '日报 CSV', text: '按日期导出完成、进展、风险和计划', icon: Clipboard }
  ] as const

  return (
    <div className="export-layout">
      <section className="export-report-panel panel">
        <div className="export-report-heading"><h2>按日期范围导出工作报告</h2><p>选择日期和报告格式后导出，不会再次调用 AI</p></div>
        <div className="export-workspace">
          <div className="export-config">
            <div className="export-section-label"><span>01</span><div><strong>选择工作日期范围</strong><small>开始与结束日期均包含在导出结果中</small></div></div>
            <div className="date-range"><label>开始日期<input type="date" value={fromDate} aria-invalid={rangeInvalid} onChange={(event) => setFromDate(event.target.value)} /></label><ArrowRight size={16} /><label>结束日期<input type="date" value={toDate} aria-invalid={rangeInvalid} onChange={(event) => setToDate(event.target.value)} /></label></div>
            <div className={`export-range-status ${rangeInvalid ? 'error' : ''}`} role={rangeInvalid ? 'alert' : undefined}>{rangeInvalid ? '开始日期不能晚于结束日期' : rangeComplete ? `当前范围：${fromDate} 至 ${toDate}` : '请选择完整的开始与结束日期'}</div>
            <div className="export-preview"><div><FileText size={17} /><strong>{previewCounts?.sources ?? '—'}</strong><span>份资料</span></div><div><Clipboard size={17} /><strong>{previewCounts?.briefs ?? '—'}</strong><span>份日报</span></div><div><BriefcaseBusiness size={17} /><strong>{previewCounts?.events ?? '—'}</strong><span>个事项</span></div></div>
          </div>
          <div className="export-formats">
            <div className="export-section-label"><span>02</span><div><strong>选择导出格式</strong><small>三种报告均严格使用左侧选择的日期范围</small></div></div>
            <div className="format-grid three">
              {formats.map((item) => {
                const Icon = item.icon
                return <button className={`format-card ${!exportReady ? 'scope-required' : ''}`} aria-describedby={!exportReady ? 'export-scope-message' : undefined} key={item.id} onClick={() => void runExport(item.id)} disabled={Boolean(busy)}><div className="format-icon"><Icon size={22} /></div><div><h3>{item.title}</h3><p>{item.text}</p></div>{busy === item.id ? <LoaderCircle className="spin" size={18} /> : <ChevronRight size={18} />}</button>
              })}
              {!exportReady && <p className="export-scope-message" id="export-scope-message">请先选择完整的开始与结束日期，再选择导出格式</p>}
            </div>
          </div>
        </div>
      </section>
      <section className="backup-callout"><div className="backup-icon"><Database size={22} /></div><div><h3>创建完整本地备份</h3><p>包含所有日期、数据库、结构化数据与全部原始附件。</p></div><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void backup()}>{busy === 'backup' ? <LoaderCircle className="spin" size={16} /> : <Archive size={16} />}立即备份</button></section>
    </div>
  )
}

function SettingsPage({ pendingCount, resumingAnalysis, onResume, onProviderChanged, notify, fail }: { pendingCount: number; resumingAnalysis: boolean; onResume: () => void; onProviderChanged: () => Promise<void>; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [settings, setSettings] = useState<ProviderSettings>({
    kind: 'cursor_cli',
    model: 'auto',
    baseUrl: '',
    hasApiKey: false,
    sendImages: false,
    autoAnalyze: true,
    connected: false,
    connectedAt: null,
    connectionMessage: '未连接 AI'
  })
  const [cliStatus, setCliStatus] = useState<CursorCliStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const saved = await window.worklens.getProviderSettings()
        setSettings(saved)
      } catch (error) {
        fail(error)
      }
    })()
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const input: SaveProviderSettings = { kind: settings.kind, model: settings.model, baseUrl: settings.baseUrl, apiKey: apiKey || undefined, sendImages: settings.sendImages, autoAnalyze: settings.autoAnalyze }
      const saved = await window.worklens.saveProviderSettings(input)
      setSettings(saved)
      setApiKey('')
      notify(saved.connected ? 'AI 设置已保存，连接保持有效' : 'AI 设置已保存，请连接 AI 后再整理')
      await onProviderChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const loadModels = async (): Promise<void> => {
    setBusy(true)
    try {
      if (settings.kind === 'cursor_cli') {
        const available = await window.worklens.listCursorCliModels()
        setModels(available)
        if (!available.some((model) => model.id === settings.model)) setSettings((value) => ({ ...value, model: available[0]?.id ?? 'auto', connected: false, connectedAt: null, connectionMessage: '模型已修改，请重新连接' }))
        notify(`读取到 ${available.length} 个可用模型`)
        return
      }
      if (settings.kind === 'codex_cli') {
        const available = await window.worklens.listCodexCliModels()
        setModels(available)
        if (!available.some((model) => model.id === settings.model)) setSettings((value) => ({ ...value, model: available[0]?.id ?? 'auto', connected: false, connectedAt: null, connectionMessage: '模型已修改，请重新连接' }))
        notify(`读取到 ${available.length} 个可用模型`)
        return
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const refreshCliStatus = async (): Promise<void> => {
    setBusy(true)
    try {
      const status = await window.worklens.getCursorCliStatus()
      setCliStatus(status)
      if (status.authenticated) setModels(await window.worklens.listCursorCliModels())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const loginCli = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.worklens.saveProviderSettings({ kind: 'cursor_cli', model: settings.model || 'auto', baseUrl: '', sendImages: settings.sendImages, autoAnalyze: settings.autoAnalyze })
      const status = await window.worklens.loginCursorCli()
      setCliStatus(status)
      if (!status.authenticated) throw new Error(status.message)
      const available = await window.worklens.listCursorCliModels()
      setModels(available)
      setSettings(await window.worklens.getProviderSettings())
      notify('Cursor 账号已连接，后续启动会保持此连接')
      await onProviderChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const refreshCodexStatus = async (): Promise<void> => {
    setBusy(true)
    try {
      const status = await window.worklens.getCodexCliStatus()
      setCodexStatus(status)
      if (status.authenticated) setModels(await window.worklens.listCodexCliModels())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const loginCodex = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.worklens.saveProviderSettings({ kind: 'codex_cli', model: settings.model || 'auto', baseUrl: '', sendImages: settings.sendImages, autoAnalyze: settings.autoAnalyze })
      const status = await window.worklens.loginCodexCli()
      setCodexStatus(status)
      if (!status.authenticated) throw new Error(status.message)
      const available = await window.worklens.listCodexCliModels()
      setModels(available)
      setSettings(await window.worklens.getProviderSettings())
      notify('Codex 账号已连接，后续启动会保持此连接')
      await onProviderChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.worklens.saveProviderSettings({
        kind: settings.kind,
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKey: apiKey || undefined,
        sendImages: settings.sendImages,
        autoAnalyze: settings.autoAnalyze
      })
      setSettings(saved)
      setApiKey('')
      if (saved.kind === 'cursor_cli') {
        let status = await window.worklens.getCursorCliStatus()
        setCliStatus(status)
        if (!status.installed) throw new Error(status.message || '尚未安装 Cursor Agent CLI')
        if (!status.authenticated) {
          status = await window.worklens.loginCursorCli()
          setCliStatus(status)
        }
        if (!status.authenticated) throw new Error(status.message || 'Cursor 尚未登录')
      }
      if (saved.kind === 'codex_cli') {
        let status = await window.worklens.getCodexCliStatus()
        setCodexStatus(status)
        if (!status.installed) throw new Error(status.message || '尚未安装 Codex CLI')
        if (!status.authenticated) {
          status = await window.worklens.loginCodexCli()
          setCodexStatus(status)
        }
        if (!status.authenticated) throw new Error(status.message || 'Codex 尚未登录')
      }
      const result = await window.worklens.testProvider()
      setSettings(await window.worklens.getProviderSettings())
      await onProviderChanged()
      notify(result.message)
    } catch (error) {
      setSettings(await window.worklens.getProviderSettings().catch(() => settings))
      await onProviderChanged()
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const isLocalProvider = settings.kind === 'cursor_cli' || settings.kind === 'codex_cli'
  const providerLabel = settings.kind === 'cursor_cli'
    ? '本机 Cursor'
    : settings.kind === 'codex_cli'
      ? '本机 Codex'
      : '外部 API'
  const selectProvider = (kind: ProviderSettings['kind']): void => {
    if (settings.kind === kind) return
    setModels([])
    setApiKey('')
    setCliStatus(null)
    setCodexStatus(null)
    setSettings((value) => ({
      ...value,
      kind,
      model: kind === 'cursor_cli' || kind === 'codex_cli' ? 'auto' : '',
      baseUrl: kind === 'openai_compatible' ? value.baseUrl : '',
      hasApiKey: false,
      connected: false,
      connectedAt: null,
      connectionMessage: '尚未保存并连接此接口'
    }))
  }

  return (
    <div className="settings-layout">
      <section className="settings-panel panel">
        <div className="settings-heading"><div className="settings-icon"><Bot size={22} /></div><div><h2>日报生成与资料问答模型</h2><p>可连接本机已登录的 Cursor 或 Codex，无需在 WorkLens 中保存 API Key。</p></div></div>
        {(pendingCount > 0 || resumingAnalysis) && <div className="pending-analysis-notice" role="status"><div><strong>{resumingAnalysis ? '正在整理已保存资料' : `${pendingCount} 份已保存资料等待整理或重试`}</strong><small>{settings.connected ? '点击后继续处理原文，不需要重新上传；可以切换页面。' : '连接 AI 后即可继续处理这些资料。'}</small></div><button className="secondary-button" disabled={!settings.connected || resumingAnalysis || busy} onClick={onResume}>{resumingAnalysis ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{resumingAnalysis ? '整理中' : `整理这 ${pendingCount} 份资料`}</button></div>}
        <div className="provider-tabs">
          <button className={settings.kind === 'cursor_cli' ? 'active' : ''} onClick={() => selectProvider('cursor_cli')}><Terminal size={16} />本机 Cursor</button>
          <button className={settings.kind === 'codex_cli' ? 'active' : ''} onClick={() => selectProvider('codex_cli')}><Bot size={16} />本机 Codex</button>
          <button className={settings.kind === 'openai_compatible' ? 'active' : ''} onClick={() => selectProvider('openai_compatible')}><Network size={16} />外部 API</button>
        </div>
        <div className={`provider-connection-state ${settings.connected ? 'connected' : ''}`} role="status">
          <span className="provider-connection-dot" />
          <div><strong>{providerLabel}{settings.connected ? ' 已连接' : ' 未连接'}</strong><small>{settings.connectionMessage}{settings.connectedAt ? ` · ${formatTimestamp(settings.connectedAt)}` : ''}</small></div>
          <span>{settings.connected ? '连接会持续保留' : '未连接时不会整理资料'}</span>
        </div>
        <div className="settings-form">
          {settings.kind === 'cursor_cli' && (
            <div className={`cli-status-card ${settings.connected || cliStatus?.authenticated ? 'connected' : ''}`}>
              <div className="cli-status-icon">{settings.connected || cliStatus?.authenticated ? <CheckCircle2 size={20} /> : <Terminal size={20} />}</div>
              <div><strong>{settings.connected ? 'Cursor 连接已保留' : cliStatus?.authenticated ? 'Cursor 账号可用' : cliStatus?.installed ? 'Cursor CLI 等待登录' : cliStatus ? '尚未安装 Cursor Agent CLI' : '尚未检测本机 Cursor'}</strong><span>{cliStatus?.message ?? (settings.connected ? '无需每次进入设置重新连接' : '仅在点击检查或连接时访问本机 Cursor')}</span>{cliStatus?.version && <small>版本 {cliStatus.version}</small>}</div>
              {cliStatus?.installed && !cliStatus.authenticated ? <button className="secondary-button" disabled={busy} onClick={() => void loginCli()}><LogIn size={15} />登录 Cursor</button> : <button className="ghost-button" disabled={busy} onClick={() => void refreshCliStatus()}>检查状态</button>}
            </div>
          )}
          {settings.kind === 'codex_cli' && (
            <div className={`cli-status-card ${settings.connected || codexStatus?.authenticated ? 'connected' : ''}`}>
              <div className="cli-status-icon">{settings.connected || codexStatus?.authenticated ? <CheckCircle2 size={20} /> : <Bot size={20} />}</div>
              <div><strong>{settings.connected ? 'Codex 连接已保留' : codexStatus?.authenticated ? 'Codex 账号可用' : codexStatus?.installed ? 'Codex CLI 等待登录' : codexStatus ? '尚未安装 Codex CLI' : '尚未检测本机 Codex'}</strong><span>{codexStatus?.message ?? (settings.connected ? '无需每次进入设置重新连接' : '仅在点击检查或连接时访问本机 Codex')}</span>{codexStatus?.accountLabel && <small>{codexStatus.accountLabel}</small>}{codexStatus?.version && <small>版本 {codexStatus.version}</small>}</div>
              {codexStatus?.installed && !codexStatus.authenticated ? <button className="secondary-button" disabled={busy} onClick={() => void loginCodex()}><LogIn size={15} />登录 Codex</button> : <button className="ghost-button" disabled={busy} onClick={() => void refreshCodexStatus()}>检查状态</button>}
            </div>
          )}
          {settings.kind === 'openai_compatible' && <label>Base URL<input value={settings.baseUrl} onChange={(event) => setSettings((value) => ({ ...value, baseUrl: event.target.value, connected: false, connectedAt: null, connectionMessage: '接口地址已修改，请重新连接' }))} placeholder="https://api.example.com/v1" /><small>必须使用 HTTPS；只有 localhost 可以使用 HTTP。</small></label>}
          {!isLocalProvider && <label>API Key<div className="input-with-status"><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSettings((value) => ({ ...value, connected: false, connectedAt: null, connectionMessage: '密钥已修改，请重新连接' })) }} placeholder={settings.hasApiKey ? '已安全保存，留空表示不修改' : '粘贴 API Key'} autoComplete="off" />{settings.hasApiKey && <CheckCircle2 size={17} />}</div><small>密钥由操作系统安全存储加密，不进入业务数据库和导出包。</small></label>}
          <label>模型<div className="model-row">{models.length && isLocalProvider ? <select value={settings.model} onChange={(event) => setSettings((value) => ({ ...value, model: event.target.value, connected: false, connectedAt: null, connectionMessage: '模型已修改，请重新连接' }))}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select> : <input value={settings.model} onChange={(event) => setSettings((value) => ({ ...value, model: event.target.value, connected: false, connectedAt: null, connectionMessage: '模型已修改，请重新连接' }))} placeholder={isLocalProvider ? '点击刷新模型' : '模型 ID'} />}{isLocalProvider && <button className="secondary-button" disabled={busy} onClick={() => void loadModels()}>刷新模型</button>}</div></label>
          <label className="check-row muted"><input type="checkbox" checked={settings.autoAnalyze} onChange={(event) => setSettings((value) => ({ ...value, autoAnalyze: event.target.checked }))} /><span><strong>记录或上传后自动生成日报</strong><small>同一天的内容会重新合并，并更新次日早会逐字稿。</small></span></label>
        </div>
        <div className="settings-actions"><button className="ghost-button" disabled={busy || !settings.model || (!isLocalProvider && !apiKey && !settings.hasApiKey)} onClick={() => void test()}>{settings.connected ? '重新连接' : '连接 AI'}</button><button className="primary-button" disabled={busy || !settings.model} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存设置</button></div>
      </section>
      <aside className="privacy-panel"><ShieldCheck size={26} /><h3>本地保存，按需调用 AI</h3><p>原始资料、日报、时间线和搜索索引默认留在本机。生成日报时，当天文本会发送给当前选择的模型。</p><ul><li><Check size={14} />原始记录永不被 AI 覆盖</li><li><Check size={14} />同一天资料统一合并去重</li><li><Check size={14} />AI 在独立进程和临时目录中运行</li><li><Check size={14} />API Key 不进入导出文件</li></ul></aside>
    </div>
  )
}

function SourceDrawer({ source, retrying, aiReady, onRetry, onOpenBrief, onClose, onDelete }: { source: SourceItem; retrying: boolean; aiReady: boolean; onRetry: (source: SourceItem) => void; onOpenBrief: (date: string) => void; onClose: () => void; onDelete: (source: SourceItem) => Promise<void> }): ReactNode {
  const [assets, setAssets] = useState<Asset[]>([])
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null)
  const [previewData, setPreviewData] = useState<AssetPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [assetError, setAssetError] = useState('')
  const [assetNotice, setAssetNotice] = useState('')
  const [openingAssetId, setOpeningAssetId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmDelete) cancelDeleteRef.current?.focus()
  }, [confirmDelete])

  useEffect(() => {
    let active = true
    setAssetsLoading(true)
    setAssets([])
    setPreviewUrls({})
    setAssetError('')
    setAssetNotice('')
    void window.worklens.listSourceAssets(source.id).then(async (nextAssets) => {
      if (!active) return
      setAssets(nextAssets)
      const images = nextAssets.filter((asset) => asset.mimeType.startsWith('image/'))
      const results = await Promise.all(images.map(async (asset) => ({ asset, preview: await window.worklens.getAssetPreview(asset.id) })))
      if (!active) return
      setPreviewUrls(Object.fromEntries(results.filter((result) => result.preview.dataUrl).map((result) => [result.asset.id, result.preview.dataUrl as string])))
    }).catch((error: unknown) => {
      if (active) setAssetError(error instanceof Error ? error.message : '附件加载失败')
    }).finally(() => {
      if (active) setAssetsLoading(false)
    })
    return () => { active = false }
  }, [source.id])

  const showAssetPreview = async (asset: Asset): Promise<void> => {
    setPreviewAsset(asset)
    setPreviewData(null)
    setAssetError('')
    if (!asset.mimeType.startsWith('image/') && asset.mimeType !== 'application/pdf') return
    const cached = previewUrls[asset.id]
    if (cached) {
      setPreviewData({ assetId: asset.id, mimeType: asset.mimeType, dataUrl: cached })
      return
    }
    setPreviewLoading(true)
    try {
      setPreviewData(await window.worklens.getAssetPreview(asset.id))
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : '附件预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }
  const openAsset = async (asset: Asset): Promise<void> => {
    setAssetError('')
    setAssetNotice('')
    setOpeningAssetId(asset.id)
    try {
      const result = await window.worklens.openAsset(asset.id)
      setAssetNotice(result.message || `已打开 ${asset.originalName}`)
      if (result.path === `preview:${asset.id}` && previewAsset?.id !== asset.id) await showAssetPreview(asset)
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : '附件打开失败')
    } finally {
      setOpeningAssetId(null)
    }
  }
  const deleteCurrentSource = async (): Promise<void> => {
    setDeleting(true)
    try {
      await onDelete(source)
    } finally {
      setDeleting(false)
    }
  }

  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="source-drawer" onMouseDown={(event) => event.stopPropagation()}>
    <div className="drawer-header"><div><span>{source.kind.toUpperCase()} · 上传于 {formatTimestamp(source.createdAt).split(' ')[0]}</span><h2>{source.title}</h2></div><div className="drawer-header-actions"><button className="danger-text-button" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除资料</button><button className="icon-button" aria-label="关闭原始资料" onClick={onClose}><X size={18} /></button></div></div>
    <div className="drawer-meta"><StatusPill status={source.status} /><span><Archive size={13} />{source.assetCount} 个附件</span><span><Clock3 size={13} />{formatTimestamp(source.createdAt)}</span></div>
    {source.workDates.length > 0 && <div className="source-work-dates"><span>识别到的工作日期 · 点击查看早会稿</span><div>{source.workDates.map((date) => <button key={date} type="button" onClick={() => onOpenBrief(date)} title={`查看 ${date} 工作对应的早会稿`}>{friendlyDate(date)}</button>)}</div></div>}
    {(source.status === 'queued' || source.status === 'failed') && <div className="ai-readiness"><div><strong>原文已保存在本机</strong><small>{source.status === 'failed' ? '整理未完成，可以直接重试，不需要重新上传。' : 'AI 整理完成后可查看早会稿与工作事项。'}</small></div><button className="secondary-button" disabled={retrying} onClick={() => onRetry(source)}>{retrying ? '整理中…' : !aiReady ? '连接 AI 后整理' : source.status === 'failed' ? '重试整理' : '开始整理'}</button></div>}
    {source.error && <div className="error-box"><CircleAlert size={16} />{source.error}</div>}
    <div className="raw-content"><div className="raw-label"><FileText size={14} />原始内容</div><pre>{source.rawText || '这份文件没有提取到可显示文字，原件仍保存在本地。'}</pre></div>
    <section className="source-attachments"><div className="attachments-heading"><div><strong>附件</strong><span>点击缩略图预览，或直接打开原件</span></div><small>{assets.length || source.assetCount} 个</small></div>
      {assetsLoading ? <div className="attachments-loading"><LoaderCircle className="spin" size={16} />正在读取附件</div> : assets.length ? <div className="attachment-grid">{assets.map((asset) => <article className="attachment-card" key={asset.id}>
        <button className="attachment-thumbnail" onClick={() => void showAssetPreview(asset)} aria-label={`预览附件 ${asset.originalName}`}>
          {previewUrls[asset.id] ? <img src={previewUrls[asset.id]} alt="" /> : <span className={`attachment-file-icon ${asset.mimeType === 'application/pdf' ? 'pdf' : ''}`}><FileText size={23} /><b>{attachmentTypeLabel(asset)}</b></span>}
        </button>
        <div className="attachment-info"><strong title={asset.originalName}>{asset.originalName}</strong><span>{formatFileSize(asset.byteSize)}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</span></div>
        <button className="attachment-open-button" disabled={openingAssetId === asset.id} onClick={() => void openAsset(asset)}>{openingAssetId === asset.id ? <LoaderCircle className="spin" size={12} /> : null}{openingAssetId === asset.id ? '正在打开' : '打开原件'} <ArrowRight size={12} /></button>
      </article>)}</div> : <div className="attachments-empty">这条资料没有附件</div>}
      {assetError && <div className="asset-error"><CircleAlert size={13} />{assetError}</div>}
      {assetNotice && <div className="asset-success"><CheckCircle2 size={13} />{assetNotice}</div>}
    </section>
    {previewAsset && <div className="asset-preview-backdrop" onMouseDown={() => setPreviewAsset(null)}><section className="asset-preview-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><span>{attachmentTypeLabel(previewAsset)} · {formatFileSize(previewAsset.byteSize)}</span><h3>{previewAsset.originalName}</h3></div><button className="icon-button" aria-label="关闭附件预览" onClick={() => setPreviewAsset(null)}><X size={17} /></button></header><div className="asset-preview-body">{previewLoading ? <div className="attachment-preview-state"><LoaderCircle className="spin" size={22} />正在生成预览</div> : previewAsset.mimeType.startsWith('image/') && previewData?.dataUrl ? <img src={previewData.dataUrl} alt={previewAsset.originalName} /> : previewAsset.mimeType === 'application/pdf' && previewData?.dataUrl ? <iframe title={previewAsset.originalName} src={previewData.dataUrl} /> : previewAsset.extractedText ? <pre>{previewAsset.extractedText}</pre> : <div className="attachment-preview-state"><FileText size={30} /><strong>此格式使用系统应用查看</strong><span>可以点击下方按钮打开原件</span></div>}</div><footer>{assetNotice && <span className="asset-open-notice"><CheckCircle2 size={13} />{assetNotice}</span>}<button className="secondary-button" disabled={openingAssetId === previewAsset.id} onClick={() => void openAsset(previewAsset)}>{openingAssetId === previewAsset.id ? <LoaderCircle className="spin" size={13} /> : null}{openingAssetId === previewAsset.id ? '正在打开' : '打开原件'} <ArrowRight size={13} /></button></footer></section></div>}
  </aside>{confirmDelete && <div className="delete-confirm-layer" onMouseDown={(event) => event.stopPropagation()}><section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-source-title" aria-describedby="delete-source-description"><div className="delete-confirm-icon"><Trash2 size={20} /></div><h3 id="delete-source-title">删除这份工作资料？</h3><p id="delete-source-description">将删除原始资料、附件以及只由它产生的时间线事件；与其他资料合并的工作事项会保留剩余来源。</p><strong>{source.title}</strong><div><button ref={cancelDeleteRef} className="secondary-button" disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</button><button className="danger-button" disabled={deleting} onClick={() => void deleteCurrentSource()}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deleting ? '正在删除' : '确认删除'}</button></div></section></div>}</div>
}

function SearchPopover({ query, results, loading, onClose, onOpen }: { query: string; results: SearchHit[]; loading: boolean; onClose: () => void; onOpen: (result: SearchHit) => void }): ReactNode {
  useEffect(() => {
    const close = (event: PointerEvent): void => { if (!(event.target instanceof Element) || !event.target.closest('.global-search')) onClose() }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [onClose])
  return <div className="search-popover" onKeyDown={event => {
    if (event.key === 'Escape') { document.querySelector<HTMLInputElement>('.global-search input')?.focus(); onClose() }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-search-result]'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }}><div className="search-popover-head"><span>“{query}” 的结果</span><button aria-label="关闭搜索结果" onClick={onClose}><X size={14} /></button></div>{results.map((result) => <button data-search-result className="search-result" key={`${result.entityType}:${result.entityId}`} onClick={() => onOpen(result)}><div className={`search-result-icon ${result.entityType}`}>{result.entityType === 'brief' ? <Clipboard size={15} /> : result.entityType === 'event' ? <BriefcaseBusiness size={15} /> : <FileText size={15} />}</div><div><strong>{result.title}</strong><span>{result.excerpt}</span></div><small>{result.date}</small></button>)}{!results.length && <div className="search-empty" role="status">{loading ? '正在搜索…' : '没有找到匹配内容'}</div>}</div>
}

function NavButton({ item, active, onClick }: { item: (typeof NAV_ITEMS)[number]; active: boolean; onClick: () => void }): ReactNode {
  const Icon = item.icon
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><Icon size={17} /><span>{item.label}</span></button>
}
function AskNavButton({ active, onClick }: { active: boolean; onClick: () => void }): ReactNode {
  return <button className={`ask-nav-card ${active ? 'active' : ''}`} onClick={onClick}><span className="ask-nav-icon"><MessageCircleQuestion size={18} /></span><span className="ask-nav-copy"><strong>问工作资料</strong><small>让本机 AI 回答历史工作</small></span><ArrowRight size={15} /></button>
}
function Panel({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return <section className="panel"><div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>{children}</section>
}
function StatusPill({ status }: { status: SourceItem['status'] }): ReactNode {
  const labels: Record<SourceItem['status'], string> = { queued: '待整理', processing: '合并中', review: '待迁移', ready: '已合并', failed: '需重试' }
  return <span className={`status-pill ${status}`}>{labels[status]}</span>
}
function EmptyState({ icon, title, text, large = false }: { icon: ReactNode; title: string; text: string; large?: boolean }): ReactNode {
  return <div className={`empty-state ${large ? 'large' : ''}`}><div>{icon}</div><h3>{title}</h3><p>{text}</p></div>
}
function EmptyInline({ icon, title, text }: { icon: ReactNode; title: string; text: string }): ReactNode {
  return <div className="empty-inline"><div>{icon}</div><span><strong>{title}</strong><small>{text}</small></span></div>
}
function ChartEmpty({ label = '记录更多工作后，这里会出现趋势' }: { label?: string }): ReactNode {
  return <div className="chart-empty"><Activity size={23} /><span>{label}</span></div>
}
function LoadingState(): ReactNode {
  return <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>正在打开本地工作空间…</span></div>
}
function Toast({ message, tone }: { message: string; tone: 'success' | 'error' }): ReactNode {
  return <div className={`toast ${tone}`}>{tone === 'success' ? <CheckCircle2 size={17} /> : <XCircle size={17} />}{message}</div>
}

function pageSubtitle(key: NavKey): string {
  return { dashboard: '看清最近工作和明早要说的内容', capture: '为选定工作日写下一条新记录', batch: '跨日期导入，并按正文日期自动归档', briefs: '可以直接照着念的次日早会汇报', ask: '用本机 AI 回答过往工作问题', timeline: '按工作日回看整理后的工作内容', events: '日报合并后沉淀的关键工作内容', library: '查看原始资料、处理状态和来源', export: '生成工作报告或保存完整备份', settings: '选择用于日报生成和资料问答的 AI 模型' }[key]
}
function messageId(): string {
  return globalThis.crypto.randomUUID()
}
function batchFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}
function batchFileType(file: File): string {
  return (file.name.split('.').pop() || 'FILE').toUpperCase()
}
function formatFileSize(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`
}
function attachmentTypeLabel(asset: Asset): string {
  const extension = asset.originalName.split('.').pop()?.trim().toUpperCase()
  if (extension && extension.length <= 8) return extension
  if (asset.mimeType.startsWith('image/')) return '图片'
  if (asset.mimeType === 'application/pdf') return 'PDF'
  return '文件'
}
function pastedTextTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '粘贴的工作内容'
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}
function displayErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
}
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}
function todayLocal(): string {
  const date = new Date()
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}
function sourceWorkDates(source: SourceItem): string[] {
  if (source.workDates.length) return source.workDates
  return source.businessDate ? [source.businessDate.slice(0, 10)] : []
}
function sourceHasWorkDate(source: SourceItem, date: string): boolean {
  return sourceWorkDates(source).includes(date)
}
function friendlyDate(date: string): string {
  if (date === todayLocal()) return '今天'
  return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`
}
function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
function formatWorkDateRange(values: string[]): string {
  const dates = Array.from(new Set(values)).sort()
  if (!dates.length) return '日期待确认'
  if (dates.length === 1) return dates[0]!
  return `${dates[0]} — ${dates.at(-1)}（${dates.length} 天）`
}
function showError(setToast: (value: { message: string; tone: 'success' | 'error' } | null) => void, error: unknown): void {
  setToast({ message: displayErrorMessage(error), tone: 'error' })
}
