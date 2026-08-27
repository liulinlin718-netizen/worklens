import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
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
  DailyBriefImage,
  ExportRequest,
  ImportResult,
  JobProgressEvent,
  ProviderSettings,
  SaveProviderSettings,
  SearchHit,
  SourceItem,
  UpdateDailyBriefInput,
  WorkQuestionAnswer,
  WorkQuestionCitation,
  WorkQuestionMessage,
  WorkEvent
} from '@shared/contracts'

type NavKey = 'dashboard' | 'capture' | 'batch' | 'briefs' | 'ask' | 'timeline' | 'events' | 'export' | 'settings'

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

const BATCH_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'tiff'
])
const MAX_BATCH_ITEMS = 200
const MAX_BATCH_FILE_BYTES = 25 * 1024 * 1024
const MAX_DAILY_BRIEF_IMAGES = 6
const MAX_DAILY_BRIEF_IMAGE_BYTES = 5 * 1024 * 1024
const DAILY_BRIEF_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const EMPTY_SNAPSHOT: AppSnapshot = {
  sources: [],
  events: [],
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
  { key: 'ask', label: '问工作资料', icon: MessageCircleQuestion },
  { key: 'export', label: '导出与备份', icon: Download },
  { key: 'settings', label: 'AI 设置', icon: Settings }
]

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
  const [eventsInitialSection, setEventsInitialSection] = useState<'events' | 'library'>('events')
  const [workChat, setWorkChat] = useState<WorkChatEntry[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await window.worklens.getSnapshot()
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

  useEffect(() => {
    void loadSnapshot()
    const removeDataListener = window.worklens.onDataChanged(() => void loadSnapshot())
    const removeProgressListener = window.worklens.onJobProgress(setProgress)
    return () => {
      removeDataListener()
      removeProgressListener()
    }
  }, [loadSnapshot])

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
    const timer = window.setTimeout(async () => {
      if (!searchQuery.trim()) {
        setSearchResults([])
        return
      }
      try {
        setSearchResults(await window.worklens.search({ query: searchQuery, entityTypes: [] }))
      } catch (error) {
        showError(setToast, error)
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const navigate = (key: NavKey): void => {
    if (key === 'events') setEventsInitialSection('events')
    setActiveNav(key)
    setSearchOpen(false)
  }
  const openWorkLibrary = (): void => {
    setEventsInitialSection('library')
    setActiveNav('events')
    setSearchOpen(false)
  }
  const openBrief = (workDate: string): void => {
    setActiveBriefDate(workDate)
    navigate('briefs')
  }
  const openSearchResult = (result: SearchHit): void => {
    if (result.entityType === 'brief') openBrief(result.date ?? activeBriefDate)
    if (result.entityType === 'event') navigate('events')
    if (result.entityType === 'source') {
      setSelectedSource(snapshot.sources.find((source) => source.id === result.entityId) ?? null)
      navigate('capture')
    }
    setSearchOpen(false)
  }
  const openWorkCitation = (citation: WorkQuestionCitation): void => {
    if (citation.entityType === 'source') {
      setSelectedSource(snapshot.sources.find((source) => source.id === citation.entityId) ?? null)
      return
    }
    if (citation.entityType === 'brief') {
      openBrief(citation.date ?? activeBriefDate)
      return
    }
    navigate('events')
  }
  const notify = (message: string): void => setToast({ message, tone: 'success' })
  const fail = (error: unknown): void => showError(setToast, error)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag-region" />
        <div className="brand">
          <div className="brand-mark"><Sparkles size={17} strokeWidth={2.4} /></div>
          <div><strong>WorkLens</strong><span>每天工作，清晰汇报</span></div>
        </div>
        <div className="quick-entry-grid">
          <button className={`quick-entry ${activeNav === 'capture' ? 'active' : ''}`} onClick={() => navigate('capture')} title="每日记录（⌘ N）"><Plus size={16} /><span>每日记录</span></button>
          <button className={`quick-entry ${activeNav === 'batch' ? 'active' : ''}`} onClick={() => navigate('batch')}><Upload size={16} /><span>批量上传</span></button>
        </div>
        <nav>
          <div className="primary-nav-stack" aria-label="主要工作入口">
            {NAV_ITEMS.filter((item) => ['dashboard', 'briefs', 'timeline', 'events'].includes(item.key)).map((item) => (
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
            />
            <kbd>⌘ K</kbd>
            {searchOpen && searchQuery && (
              <SearchPopover query={searchQuery} results={searchResults} onClose={() => setSearchOpen(false)} onOpen={openSearchResult} />
            )}
          </div>
        </header>

        {progress && (
          <div className={`progress-banner ${progress.finished ? 'finished' : ''}`}>
            {progress.finished ? <CheckCircle2 size={15} /> : <LoaderCircle size={15} className="spin" />}<span>{progress.message}</span>
            {progress.current && progress.total ? <small>{progress.current} / {progress.total}</small> : null}
            <button onClick={() => setProgress(null)} aria-label="关闭进度"><X size={14} /></button>
          </div>
        )}

        <main className="content">
          {loading ? <LoadingState /> : (
            <>
              {activeNav === 'dashboard' && <Dashboard snapshot={snapshot} navigate={navigate} openBrief={openBrief} onSelectSource={setSelectedSource} />}
              {activeNav === 'capture' && (
                <CapturePage sources={snapshot.sources} onSelect={setSelectedSource} onChanged={loadSnapshot} openBrief={openBrief} notify={notify} fail={fail} />
              )}
              {activeNav === 'batch' && (
                <BatchUploadPage snapshot={snapshot} progress={progress?.jobType === 'import' ? progress : null} onSelect={setSelectedSource} onChanged={loadSnapshot} openTimeline={() => navigate('timeline')} openLibrary={openWorkLibrary} notify={notify} fail={fail} />
              )}
              {activeNav === 'briefs' && (
                <BriefsPage briefs={snapshot.dailyBriefs} sources={snapshot.sources} selectedDate={activeBriefDate} setSelectedDate={setActiveBriefDate} onChanged={loadSnapshot} notify={notify} fail={fail} />
              )}
              {activeNav === 'ask' && (
                <AskWorkPage snapshot={snapshot} entries={workChat} setEntries={setWorkChat} onOpenCitation={openWorkCitation} fail={fail} />
              )}
              {activeNav === 'timeline' && <TimelinePage snapshot={snapshot} onSelect={setSelectedSource} />}
              {activeNav === 'events' && <EventsPage key={eventsInitialSection} events={snapshot.events} sources={snapshot.sources} initialSection={eventsInitialSection} onSelectSource={setSelectedSource} />}
              {activeNav === 'export' && <ExportPage snapshot={snapshot} notify={notify} fail={fail} />}
              {activeNav === 'settings' && <SettingsPage notify={notify} fail={fail} />}
            </>
          )}
        </main>
      </section>

      {selectedSource && <SourceDrawer source={selectedSource} onClose={() => setSelectedSource(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} />}
    </div>
  )
}

function Dashboard({ snapshot, navigate, openBrief, onSelectSource }: { snapshot: AppSnapshot; navigate: (key: NavKey) => void; openBrief: (date: string) => void; onSelectSource: (source: SourceItem) => void }): ReactNode {
  const { dashboard } = snapshot
  const todaySources = snapshot.sources.filter((source) => sourceDate(source) === todayLocal())
  const recentSources = [...snapshot.sources]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4)
  const cards = [
    { label: '今日记录', value: todaySources.length, note: '文字与文件统一合并', icon: FileText, tone: 'violet', destination: 'capture' as NavKey },
    { label: '已生成日报', value: dashboard.totals.dailyBriefs, note: '每个工作日保留一版', icon: Clipboard, tone: 'green', destination: 'briefs' as NavKey },
    { label: '工作事项', value: dashboard.totals.events, note: '来自合并后的日报', icon: BriefcaseBusiness, tone: 'amber', destination: 'events' as NavKey }
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
                <div><strong>{source.title}</strong><span>{sourceDate(source)} · {source.kind.toUpperCase()}</span></div>
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

function CapturePage({ sources, onSelect, onChanged, openBrief, notify, fail }: { sources: SourceItem[]; onSelect: (source: SourceItem) => void; onChanged: () => Promise<void>; openBrief: (date: string) => void; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [busy, setBusy] = useState(false)
  const visibleSources = sources.filter((source) => sourceDate(source) === date)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try {
      await window.worklens.captureText({ title: title.trim(), text: text.trim(), businessDate: date })
      setTitle('')
      setText('')
      await onChanged()
      notify('工作内容已保存，正在自动合并日报')
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.worklens.generateDailyBrief(date)
      await onChanged()
      notify(result.message)
      openBrief(date)
    } catch (error) {
      fail(error)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-stack">
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
            <span className="privacy-copy"><Database size={14} />原文保存在本机，AI 生成内容不会覆盖它</span>
            <button className="primary-button" disabled={!text.trim() || busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}保存并自动整理</button>
          </div>
        </form>
      </section>

      <section className="panel source-panel">
        <div className="panel-header">
          <div><h2>{date} 的原始资料</h2><p>{visibleSources.length} 条记录，将被合并为一份早会稿</p></div>
          <button className="secondary-button" disabled={busy || !visibleSources.length} onClick={() => void generate()}><RefreshCw size={15} />重新生成当日日报</button>
        </div>
        <div className="source-table">
          <div className="source-table-head daily"><span>资料</span><span>类型</span><span>状态</span><span>录入时间</span></div>
          {visibleSources.map((source) => (
            <div className="source-table-row daily" key={source.id}>
              <button className="source-title-cell" onClick={() => onSelect(source)}><div className={`file-kind ${source.kind}`}><FileText size={16} /></div><div><strong>{source.title}</strong><span>{source.excerpt || '未提取到文字'}</span></div></button>
              <span className="kind-label">{source.kind.toUpperCase()}</span>
              <StatusPill status={source.status} />
              <span>{formatTimestamp(source.createdAt)}</span>
            </div>
          ))}
          {!visibleSources.length && <EmptyState icon={<Inbox size={28} />} title="这一天还没有工作记录" text="从上方写几句话，保存后会自动归入这一天。" />}
        </div>
      </section>
    </div>
  )
}

function BatchUploadPage({ snapshot, progress, onSelect, onChanged, openTimeline, openLibrary, notify, fail }: { snapshot: AppSnapshot; progress: JobProgressEvent | null; onSelect: (source: SourceItem) => void; onChanged: () => Promise<void>; openTimeline: () => void; openLibrary: () => void; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [phase, setPhase] = useState<BatchPhase>('compose')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [pendingTexts, setPendingTexts] = useState<PendingTextItem[]>([])
  const [pasteDraft, setPasteDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [editingDateId, setEditingDateId] = useState<string | null>(null)
  const [localProgress, setLocalProgress] = useState<JobProgressEvent | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pasteInputRef = useRef<HTMLTextAreaElement>(null)
  const cancelRequestedRef = useRef(false)
  const pendingCount = pendingFiles.length + pendingTexts.length
  const pendingBytes = pendingFiles.reduce((sum, file) => sum + file.size, 0)
  const phaseIndex = phase === 'compose' ? 0 : phase === 'processing' ? 1 : 2
  const groups = useMemo(() => {
    const grouped = new Map<string, SourceItem[]>()
    for (const source of result?.imported ?? []) {
      const date = sourceDate(source)
      grouped.set(date, [...(grouped.get(date) ?? []), source])
    }
    return Array.from(grouped, ([date, sources]) => ({ date, sources })).sort((a, b) => b.date.localeCompare(a.date))
  }, [result])
  const fallbackCount = result?.imported.filter((source) => !source.businessDate).length ?? 0

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
    let next: ImportResult = { imported: [], duplicates: [], failed: [], cancelled: false }
    cancelRequestedRef.current = false
    setResult(null)
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
          setLocalProgress({ sourceItemId: '', jobType: 'import', message: `正在保存粘贴内容 · ${item.title}`, current, total })
          try {
            const source = await window.worklens.captureText({ title: '', text: item.text, businessDate: null })
            if (knownSourceIds.has(source.id)) next.duplicates.push({ fileName: item.title, source })
            else {
              next.imported.push(source)
              knownSourceIds.add(source.id)
            }
          } catch (error) {
            next.failed.push({ fileName: item.title, error: displayErrorMessage(error), sourceItemId: null })
          }
        }
      }
      if (cancelRequestedRef.current) next.cancelled = true
      setResult(next)
      await onChanged()
      if (!next.cancelled) {
        setPendingFiles([])
        setPendingTexts([])
      }
      setPhase('review')
      if (next.cancelled) notify('已停止处理；完成的资料已保留，待处理列表仍在')
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
      if (next.imported.length) notify('重新解析成功，资料已经恢复到工作时间线')
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
      setRetryingId(null)
    }
  }

  const updateDate = async (source: SourceItem, businessDate: string): Promise<void> => {
    if (!businessDate || businessDate === sourceDate(source)) return
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
    ? { ...progress, total: pendingCount }
    : localProgress

  return (
    <div className="batch-page page-stack">
      <section className="batch-flow-header panel">
        <div>
          <div className="eyebrow"><Upload size={14} />跨日期批量导入</div>
          <h2>{phase === 'compose' ? '先把资料放进待处理列表' : phase === 'processing' ? '正在逐项解析处理' : '检查这批资料的归档结果'}</h2>
          <p>{phase === 'compose' ? '选择文件、拖入资料或粘贴文字；确认列表无误后再开始，不会一选中就写入。' : phase === 'processing' ? '每项资料独立处理，取消时已完成的内容仍会安全保留。' : '重点检查黄色的日期项和红色的失败项，确认后即可去时间线回看。'}</p>
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
              <div><div className="batch-paste-icon"><Clipboard size={17} /></div><div><h3>粘贴复制的工作文字</h3><p>可直接按 ⌘V，粘贴后还能检查和修改</p></div></div>
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
          <div className="batch-processing-count">{activeProgress?.current ?? 0}<span>/ {activeProgress?.total ?? pendingCount}</span></div>
          <div className="batch-progress-track"><span style={{ width: activeProgress?.current && activeProgress.total ? `${Math.max(4, activeProgress.current / activeProgress.total * 100)}%` : '4%' }} /></div>
          <small>处理过程中请保持此页面打开；取消时已完成的资料不会丢失。</small>
          <button className="secondary-button danger" disabled={cancelling} onClick={() => void cancelImport()}>{cancelling ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}{cancelling ? '正在停止' : '停止处理'}</button>
        </section>
      )}

      {phase === 'review' && result && (
        <>
          {result.cancelled && <div className="batch-cancel-note"><CircleAlert size={15} /><span>这批处理已停止，已完成的资料已经保留；待处理列表也仍在，可以返回后继续。</span></div>}
          <section className="batch-summary panel">
            <div><span>成功导入</span><strong>{result.imported.length}</strong><small>份新增资料</small></div>
            <div><span>归档工作日</span><strong>{groups.length}</strong><small>个日期</small></div>
            <div><span>重复跳过</span><strong>{result.duplicates.length}</strong><small>不会重复入库</small></div>
            <div className={result.failed.length || fallbackCount ? 'warn' : ''}><span>需要留意</span><strong>{result.failed.length + fallbackCount}</strong><small>{result.failed.length} 份失败 · {fallbackCount} 份待校日期</small></div>
          </section>

          <section className="batch-results panel">
            <div className="panel-header"><div><h2>本次归档结果</h2><p>日期可以直接修改；修改后对应工作日会自动重新整理</p></div><div className="batch-result-actions"><button className="secondary-button" disabled={busy} onClick={resetForNextBatch}>{result.cancelled ? '返回待处理列表' : '再导入一批'}</button><button className="primary-button" onClick={openTimeline}><Timeline size={15} />完成并查看时间线</button></div></div>
            {fallbackCount > 0 && <div className="batch-review-warning"><CircleAlert size={15} /><span>{fallbackCount} 项没有识别到明确日期，暂按导入日归档；请检查黄色日期项。</span></div>}
            <div className="batch-date-groups">
              {groups.map((group) => (
                <section className="batch-date-group" key={group.date}>
                  <div className="batch-date-heading"><div className="batch-date-icon"><CalendarDays size={15} /></div><div><strong>{group.date}</strong><span>{friendlyDate(group.date)} · {group.sources.length} 份资料</span></div><small>已归入时间线</small></div>
                  <div className="batch-source-list">
                    {group.sources.map((source) => (
                      <div className="batch-source-row" key={source.id}>
                        <button className="batch-source-open" onClick={() => onSelect(source)}><div className={`file-kind ${source.kind}`}><FileText size={15} /></div><div><strong>{source.title}</strong><span>{source.excerpt || '未提取到文字'}</span></div><ChevronRight size={15} /></button>
                        <div className="batch-date-editor"><span className={`date-origin-badge ${source.businessDate ? '' : 'fallback'} ${source.dateOrigin === 'manual' ? 'manual' : ''}`}>{source.dateOrigin === 'manual' ? '手动修正' : source.businessDate ? '正文识别' : '按导入日'}</span><label><span>归档日期</span><input type="date" aria-label={`${source.title}归档日期`} value={sourceDate(source)} disabled={editingDateId === source.id} onChange={(event) => void updateDate(source, event.target.value)} /></label>{editingDateId === source.id && <LoaderCircle className="spin" size={14} />}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {!result.imported.length && <EmptyState icon={<Upload size={27} />} title="这次没有新增资料" text="重复文件已安全跳过；失败文件可以在下方直接重试。" />}
            </div>

            {result.duplicates.length > 0 && <div className="batch-duplicates"><div><CheckCircle2 size={15} /><strong>{result.duplicates.length} 份重复资料已跳过</strong><span>数据库中的原记录保持不变</span></div>{result.duplicates.map((item, index) => <button key={`${item.source.id}:${item.fileName}:${index}`} onClick={() => onSelect(item.source)}><div><strong>{item.fileName}</strong><span>已存在于 {sourceDate(item.source)} · {item.source.title}</span></div><ChevronRight size={14} /></button>)}</div>}

            {result.failed.length > 0 && <div className="batch-failures"><div><CircleAlert size={15} /><strong>{result.failed.length} 份文件需要处理</strong></div>{result.failed.map((item, index) => <div className="batch-failure-row" key={`${item.sourceItemId ?? item.fileName}:${index}`}><div><strong>{item.fileName}</strong><span>{item.error}</span></div>{item.sourceItemId ? <button className="secondary-button" disabled={busy} onClick={() => void retryFailure(item.sourceItemId!)}>{retryingId === item.sourceItemId ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}重新解析</button> : <small>请确认格式和文件大小后重新选择</small>}</div>)}</div>}
          </section>
        </>
      )}

      {phase !== 'processing' && <section className="batch-library-note"><Database size={17} /><div><strong>当前本地工作库已有 {snapshot.sources.length} 份资料</strong><span>原文件与解析文字都保存在本机；批量上传不会覆盖已有内容。</span></div><button className="text-button" onClick={openLibrary}>进入工作资料库 <ArrowRight size={13} /></button></section>}
    </div>
  )
}

function mergeImportResults(current: ImportResult | null, next: ImportResult): ImportResult {
  if (!current) return next
  const imported = new Map(current.imported.map((source) => [source.id, source]))
  for (const source of next.imported) imported.set(source.id, source)
  const duplicates = new Map(current.duplicates.map((item) => [`${item.source.id}:${item.fileName}`, item]))
  for (const item of next.duplicates) duplicates.set(`${item.source.id}:${item.fileName}`, item)
  const failed = new Map(current.failed.map((item) => [item.sourceItemId ?? item.fileName, item]))
  for (const item of next.failed) failed.set(item.sourceItemId ?? item.fileName, item)
  return {
    imported: Array.from(imported.values()),
    duplicates: Array.from(duplicates.values()),
    failed: Array.from(failed.values()),
    cancelled: current.cancelled || next.cancelled
  }
}

function BriefsPage({ briefs, sources, selectedDate, setSelectedDate, onChanged, notify, fail }: { briefs: DailyBrief[]; sources: SourceItem[]; selectedDate: string; setSelectedDate: (date: string) => void; onChanged: () => Promise<void>; notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftScript, setDraftScript] = useState('')
  const [draftImages, setDraftImages] = useState<DailyBriefImage[]>([])
  const [dateMenuOpen, setDateMenuOpen] = useState(false)
  const dateMenuRef = useRef<HTMLDivElement>(null)
  const brief = briefs.find((item) => item.workDate === selectedDate) ?? null
  const sourceCount = sources.filter((source) => sourceDate(source) === selectedDate).length
  const availableDates = Array.from(new Set([...briefs.map((item) => item.workDate), ...sources.map(sourceDate)])).sort((a, b) => b.localeCompare(a))

  useEffect(() => {
    setDraftScript(brief?.script ?? '')
    setDraftImages(brief?.images ?? [])
  }, [brief?.id, brief?.updatedAt, selectedDate])

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!dateMenuRef.current?.contains(event.target as Node)) setDateMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])

  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.worklens.generateDailyBrief(selectedDate)
      await onChanged()
      notify(result.message)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (): Promise<void> => {
    if (!brief) return
    try {
      const result = await window.worklens.copyText(draftScript || brief.script)
      notify(result.message)
    } catch (error) {
      fail(error)
    }
  }
  const saveBrief = async (): Promise<void> => {
    if (!brief || !draftScript.trim() || saving) return
    setSaving(true)
    try {
      const input: UpdateDailyBriefInput = { briefId: brief.id, script: draftScript.trim(), images: draftImages }
      const updated = await window.worklens.updateDailyBrief(input)
      setDraftScript(updated.script)
      setDraftImages(updated.images ?? [])
      await onChanged()
      notify('逐字稿修改已保存')
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const pasteImages = async (event: ReactClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!imageFiles.length) return

    const unsupported = imageFiles.find((file) => !DAILY_BRIEF_IMAGE_TYPES.has(file.type))
    if (unsupported) {
      fail(new Error('暂不支持这种图片格式，请粘贴 PNG、JPG、WebP 或 GIF 图片'))
      return
    }
    const oversized = imageFiles.find((file) => file.size > MAX_DAILY_BRIEF_IMAGE_BYTES)
    if (oversized) {
      fail(new Error(`图片“${oversized.name || '剪贴板图片'}”超过 5 MB，请压缩后再粘贴`))
      return
    }
    const remaining = MAX_DAILY_BRIEF_IMAGES - draftImages.length
    if (remaining <= 0) {
      fail(new Error(`逐字稿最多保存 ${MAX_DAILY_BRIEF_IMAGES} 张图片，请先移除一张`))
      return
    }

    try {
      const accepted = imageFiles.slice(0, remaining)
      const pastedImages = await Promise.all(accepted.map(async (file, index) => ({
        id: crypto.randomUUID(),
        name: file.name || `粘贴图片-${draftImages.length + index + 1}.${imageExtension(file.type)}`,
        dataUrl: await readFileAsDataUrl(file)
      })))
      setDraftImages((current) => [...current, ...pastedImages])
      notify(imageFiles.length > remaining
        ? `已加入 ${pastedImages.length} 张图片；逐字稿最多保存 ${MAX_DAILY_BRIEF_IMAGES} 张`
        : `已加入 ${pastedImages.length} 张图片，保存修改后生效`)
    } catch (error) {
      fail(error)
    }
  }
  const imagesChanged = JSON.stringify(draftImages) !== JSON.stringify(brief?.images ?? [])

  return (
    <div className="brief-layout">
      <aside className="brief-history panel">
        <div className="panel-header"><div><h2>日报历史</h2><p>{briefs.length} 个工作日</p></div></div>
        <div className="brief-history-list">
          {briefs.map((item) => (
            <button key={item.id} className={item.workDate === selectedDate ? 'active' : ''} onClick={() => setSelectedDate(item.workDate)}>
              <div><strong>{friendlyDate(item.workDate)}</strong><span>{item.title}</span></div>
              <small>{item.sourceItemIds.length} 份资料</small><ChevronRight size={15} />
            </button>
          ))}
          {!briefs.length && <div className="history-empty">生成日报后会保存在这里</div>}
        </div>
      </aside>

      <section className="brief-main">
        <div className="brief-toolbar">
          <div className={`brief-date-menu ${dateMenuOpen ? 'open' : ''}`} ref={dateMenuRef}><button className="brief-date-trigger" aria-label="选择工作日期" aria-haspopup="listbox" aria-expanded={dateMenuOpen} onClick={() => setDateMenuOpen((open) => !open)}><CalendarDays size={15} /><span><strong>{friendlyDate(selectedDate)}</strong><small>{selectedDate}</small></span><ChevronDown size={14} /></button>{dateMenuOpen && <div className="brief-date-popover" role="listbox" aria-label="工作日期">{(availableDates.length ? availableDates : [selectedDate]).map((date) => { const selected = date === selectedDate; const count = sources.filter((source) => sourceDate(source) === date).length; return <button key={date} className={selected ? 'selected' : ''} role="option" aria-selected={selected} onClick={() => { setSelectedDate(date); setDateMenuOpen(false) }}><span><strong>{friendlyDate(date)}</strong><small>{date} · {count} 份资料</small></span>{selected && <Check size={14} />}</button> })}</div>}</div>
          <span>{sourceCount} 份原始资料</span>
          <button className="secondary-button" disabled={busy || saving || !sourceCount} onClick={() => void generate()}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{brief ? '重新生成' : '生成早会稿'}</button>
          {brief && <button className="secondary-button" disabled={saving || !draftScript.trim() || (draftScript.trim() === brief.script.trim() && !imagesChanged)} onClick={() => void saveBrief()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{saving ? '正在保存' : '保存修改'}</button>}
          {brief && <button className="primary-button" onClick={() => void copy()}><Copy size={15} />复制逐字稿</button>}
        </div>

        {brief ? (
          <>
            <article className="standup-script-card">
              <div className="script-card-head"><div><div className="eyebrow"><Clipboard size={14} />{brief.standupDate} 早会使用</div><h2>{brief.title}</h2><p>基于 {brief.workDate} 的 {brief.sourceItemIds.length} 份工作资料自动合并 · 可直接在下方编辑和粘贴</p></div><span>{estimateSpeakingTime(draftScript || brief.script)} 分钟</span></div>
              <div className="script-paper editing">
                <textarea aria-label="逐字稿正文" aria-describedby="script-paste-hint" value={draftScript} onChange={(event) => setDraftScript(event.target.value)} onPaste={(event) => void pasteImages(event)} maxLength={50_000} />
                <div className="script-paste-hint" id="script-paste-hint"><Clipboard size={13} /><span>光标停在正文中即可直接粘贴图片，最多 {MAX_DAILY_BRIEF_IMAGES} 张；保存修改后生效</span><strong>{draftImages.length}/{MAX_DAILY_BRIEF_IMAGES}</strong></div>
                {draftImages.length > 0 && <div className="script-image-grid">{draftImages.map((image) => <figure key={image.id}><img src={image.dataUrl} alt={image.name} /><figcaption>{image.name}</figcaption><button type="button" aria-label={`移除图片 ${image.name}`} onClick={() => setDraftImages((current) => current.filter((item) => item.id !== image.id))}><X size={14} /></button></figure>)}</div>}
              </div>
              <div className="script-meta"><span>{brief.provider} · {brief.model}</span><span>更新于 {formatTimestamp(brief.updatedAt)}</span></div>
            </article>
            <div className="brief-section-grid three">
              <BriefSection tone="green" title="已经完成" items={brief.completed} empty="没有识别到明确完成项" />
              <BriefSection tone="violet" title="正在推进" items={brief.inProgress} empty="没有识别到进行中事项" />
              <BriefSection tone="amber" title="下一步计划" items={brief.nextSteps} empty="没有识别到后续计划" />
            </div>
          </>
        ) : <EmptyState large icon={<Clipboard size={34} />} title={sourceCount ? '这一天还没有生成早会稿' : '先记录这一天的工作'} text={sourceCount ? '点击“生成早会稿”，系统会合并这一天的全部资料。' : '通过每日记录输入文字，或在批量上传中导入文件，然后回来生成。'} />}
      </section>
    </div>
  )
}

function BriefSection({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: string }): ReactNode {
  return <section className={`brief-section ${tone}`}><div><span className="section-dot" /><h3>{title}</h3><b>{items.length}</b></div>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}</section>
}

function AskWorkPage({ snapshot, entries, setEntries, onOpenCitation, fail }: { snapshot: AppSnapshot; entries: WorkChatEntry[]; setEntries: Dispatch<SetStateAction<WorkChatEntry[]>>; onOpenCitation: (citation: WorkQuestionCitation) => void; fail: (error: unknown) => void }): ReactNode {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
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
    const history: WorkQuestionMessage[] = entries
      .slice(-8)
      .map((entry) => ({ role: entry.role, content: entry.content }))
    const userEntry: WorkChatEntry = { id: messageId(), role: 'user', content: question }
    setEntries((current) => [...current, userEntry])
    setDraft('')
    setBusy(true)
    try {
      const answer = await window.worklens.askWorkQuestion({ question, history })
      setEntries((current) => [...current, { id: messageId(), role: 'assistant', content: answer.answer, answer }])
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
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
          {entries.length > 0 && <button className="ghost-button compact" disabled={busy} onClick={() => setEntries([])}>清空会话</button>}
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
        <section className="panel knowledge-scope"><div className="eyebrow"><Database size={13} />本地知识范围</div><h3>{snapshot.sources.length} 份原始资料</h3><p>同时检索 {snapshot.dailyBriefs.length} 份日报和 {snapshot.events.length} 个合并事项。</p><ul><li><Check size={13} />支持“上周、上个月、最近 30 天”</li><li><Check size={13} />按项目名和正文关键词匹配</li><li><Check size={13} />引用可以打开原始资料</li></ul></section>
        <section className="knowledge-tip"><Sparkles size={17} /><div><strong>提问小技巧</strong><p>带上日期范围和项目名，会得到更准确、引用更集中的答案。</p></div></section>
        {latestAnswer && <section className="knowledge-last"><span>最近一次检索</span><strong>{latestAnswer.retrievedCount} 条资料</strong><small>{latestAnswer.model}</small></section>}
      </aside>
    </div>
  )
}

function TimelinePage({ snapshot, onSelect }: { snapshot: AppSnapshot; onSelect: (source: SourceItem) => void }): ReactNode {
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const groups = useMemo(() => {
    const map = new Map<string, WorkEvent[]>()
    for (const event of snapshot.events) {
      const date = (event.eventDate ?? event.createdAt).slice(0, 10)
      map.set(date, [...(map.get(date) ?? []), event])
    }
    return Array.from(map, ([date, events]) => ({ date, events })).sort((a, b) => b.date.localeCompare(a.date))
  }, [snapshot.events])

  if (!groups.length) return <EmptyState large icon={<Clock3 size={34} />} title="时间线等待第一条工作内容" text="日报生成并沉淀工作事项后，会按工作日显示在这里。" />
  return (
    <div className="timeline-page">
      <div className="timeline-rail" />
      {groups.map((group) => (
        <section className="timeline-group" key={group.date}>
          <div className="timeline-date"><strong>{group.date.slice(8)}</strong><span>{monthLabel(group.date)}</span></div>
          <div className="timeline-node" />
          <div className="timeline-content">
            <div className="timeline-group-header"><h2>{friendlyDate(group.date)}</h2><span>{group.events.length} 项工作内容</span></div>
            {group.events.map((event) => {
              const key = `event:${event.id}`
              const expanded = expandedItem === key
              const source = snapshot.sources.find((item) => item.id === event.sourceItemId) ?? null
              const originalText = source?.rawText || event.evidence[0]?.quote || '暂无可显示的原文内容'
              return <article className={`timeline-card timeline-expand-card event-card ${expanded ? 'expanded' : ''}`} key={event.id}>
                <button className="timeline-card-trigger" aria-expanded={expanded} onClick={() => setExpandedItem(expanded ? null : key)}><div className="timeline-card-icon"><BriefcaseBusiness size={17} /></div><div><div className="card-meta"><span>{event.eventType}</span><span>AI {Math.round(event.confidence * 100)}%</span></div><h3>{event.title}</h3><p>{event.summary}</p></div><ChevronDown size={18} /></button>
                {expanded && <div className="timeline-card-detail event-detail"><div className="timeline-detail-heading"><strong>事项详情</strong><span>{event.eventDate ?? '日期未定'} · {event.evidence.length} 条来源证据</span></div><p>{event.summary}</p><div className="timeline-original-content"><strong>原文内容：</strong><p>{originalText}</p>{source && <button className="text-button" onClick={() => onSelect(source)}>打开完整原始资料 <ArrowRight size={13} /></button>}</div></div>}
              </article>
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function EventsPage({ events, sources, initialSection = 'events', onSelectSource }: { events: WorkEvent[]; sources: SourceItem[]; initialSection?: 'events' | 'library'; onSelectSource: (source: SourceItem) => void }): ReactNode {
  const [typeFilter, setTypeFilter] = useState('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [section, setSection] = useState<'events' | 'library'>(initialSection)
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const types = Array.from(new Set(events.map((event) => event.eventType)))
  const filterOptions = [{ value: 'all', label: '全部类型' }, ...types.map((type) => ({ value: type, label: type }))]
  const visible = typeFilter === 'all' ? events : events.filter((event) => event.eventType === typeFilter)
  const sourceLibrary = [...sources].sort((a, b) => sourceDate(b).localeCompare(sourceDate(a)) || b.createdAt.localeCompare(a.createdAt))
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])
  return (
    <div className="page-stack">
      <section className="events-overview">
        <div><div className="eyebrow">{section === 'events' ? <Activity size={14} /> : <Library size={14} />}{section === 'events' ? '合并后的工作内容' : '原始工作资料库'}</div><h2>{section === 'events' ? `${events.length} 个可追溯工作事项` : `${sources.length} 份原始工作资料`}</h2><p>{section === 'events' ? '相似内容会在日报生成时去重，保留结果、进展和来源证据。' : '按上传日期查看文件和文字记录，点击任意资料即可阅读完整原始内容。'}</p></div>
        <div className="events-overview-actions">
          <div className="events-view-switch" aria-label="工作内容视图"><button className={section === 'events' ? 'active' : ''} onClick={() => setSection('events')}><BriefcaseBusiness size={14} />工作事项</button><button className={section === 'library' ? 'active' : ''} onClick={() => setSection('library')}><Library size={14} />工作资料库</button></div>
          {section === 'events' && events.length > 0 && <div className={`events-filter-menu ${filterOpen ? 'open' : ''}`} ref={filterMenuRef}>
            <button className="events-filter-trigger" aria-label="筛选工作事项类型" aria-haspopup="listbox" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)} onKeyDown={(event) => { if (event.key === 'Escape') setFilterOpen(false) }}><ListFilter size={14} /><span>{typeFilter === 'all' ? '全部类型' : typeFilter}</span><ChevronDown size={14} /></button>
            {filterOpen && <div className="events-filter-popover" role="listbox" aria-label="工作事项类型">
              {filterOptions.map((option) => {
                const selected = typeFilter === option.value
                const count = option.value === 'all' ? events.length : events.filter((event) => event.eventType === option.value).length
                return <button key={option.value} className={selected ? 'selected' : ''} role="option" aria-selected={selected} onClick={() => { setTypeFilter(option.value); setFilterOpen(false) }}><span>{option.label}<small>{count} 项</small></span>{selected && <Check size={14} />}</button>
              })}
            </div>}
          </div>}
        </div>
      </section>
      {section === 'events' && (events.length ? <div className="card-grid">
        {visible.map((event) => {
          const evidence = event.evidence[0]
          const evidenceSource = evidence ? sources.find((source) => source.id === evidence.sourceItemId) ?? null : null
          const expanded = expandedEvidence === event.id
          return <article className={`entity-card ${expanded ? 'evidence-expanded' : ''}`} key={event.id}>
            <div className="entity-card-top"><span className="entity-type"><BriefcaseBusiness size={14} />{event.eventType}</span><span>{event.eventDate ?? '日期未定'}</span></div>
            <h3>{event.title}</h3><p>{event.summary}</p>
            {evidence && <><button className="mini-evidence" aria-expanded={expanded} onClick={() => setExpandedEvidence(expanded ? null : event.id)}><span><FileText size={13} />“{evidence.quote}”</span><ChevronDown size={14} /></button>{expanded && <div className="evidence-original"><div><strong>原始内容</strong><span>{evidenceSource ? `${sourceDate(evidenceSource)} · ${evidenceSource.title}` : '原始资料暂不可用'}</span></div><p>{evidenceSource?.rawText || evidence.quote}</p>{evidenceSource && <button className="text-button" onClick={() => onSelectSource(evidenceSource)}>打开完整资料 <ArrowRight size={13} /></button>}</div>}</>}
            <div className="entity-footer"><span>可信度 {Math.round(event.confidence * 100)}%</span><span>{event.evidence.length} 条来源证据</span></div>
          </article>
        })}
      </div> : <EmptyState large icon={<BriefcaseBusiness size={34} />} title="还没有合并后的工作事项" text="生成第一份日报后，关键进展、会议、交付、问题和决策会显示在这里。" />)}
      {section === 'library' && (sourceLibrary.length ? <section className="source-library panel"><div className="source-library-head"><span>资料名称</span><span>类型</span><span>上传日期</span><span>状态</span></div>{sourceLibrary.map((source) => <button className="source-library-row" key={source.id} onClick={() => onSelectSource(source)}><div><div className={`file-kind ${source.kind}`}><FileText size={15} /></div><span><strong>{source.title}</strong><small>{source.excerpt || '未提取到文字'}</small></span></div><span className="source-library-kind">{source.kind.toUpperCase()}</span><time>{sourceDate(source)}<small>{formatTimestamp(source.createdAt).split(' ')[1] ?? ''}</small></time><StatusPill status={source.status} /><ChevronRight size={15} /></button>)}</section> : <EmptyState large icon={<Library size={34} />} title="工作资料库还是空的" text="通过每日记录或批量上传添加资料后，可以在这里按日期回看原始内容。" />)}
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
    const sources = snapshot.sources.filter((source) => inRange(source.businessDate ?? source.createdAt))
    const sourceIds = new Set(sources.map((source) => source.id))
    return {
      sources: sources.length,
      briefs: snapshot.dailyBriefs.filter((brief) => inRange(brief.workDate)).length,
      events: snapshot.events.filter((event) => sourceIds.has(event.sourceItemId) || inRange(event.eventDate ?? event.createdAt)).length
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

function SettingsPage({ notify, fail }: { notify: (message: string) => void; fail: (error: unknown) => void }): ReactNode {
  const [settings, setSettings] = useState<ProviderSettings>({ kind: 'cursor_cli', model: 'auto', baseUrl: '', hasApiKey: false, sendImages: false, autoAnalyze: true })
  const [cliStatus, setCliStatus] = useState<CursorCliStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [saved, status, nextCodexStatus] = await Promise.all([
          window.worklens.getProviderSettings(),
          window.worklens.getCursorCliStatus(),
          window.worklens.getCodexCliStatus()
        ])
        setSettings(saved)
        setCliStatus(status)
        setCodexStatus(nextCodexStatus)
        if (saved.kind === 'cursor_cli' && status.authenticated) setModels(await window.worklens.listCursorCliModels())
        if (saved.kind === 'codex_cli' && nextCodexStatus.authenticated) setModels(await window.worklens.listCodexCliModels())
      } catch (error) {
        fail(error)
      }
    })()
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const input: SaveProviderSettings = { kind: settings.kind, model: settings.model, baseUrl: settings.baseUrl, apiKey: apiKey || undefined, sendImages: settings.sendImages, autoAnalyze: settings.autoAnalyze }
      setSettings(await window.worklens.saveProviderSettings(input))
      setApiKey('')
      notify('AI 设置已安全保存')
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
        if (!available.some((model) => model.id === settings.model)) setSettings((value) => ({ ...value, model: available[0]?.id ?? 'auto' }))
        notify(`读取到 ${available.length} 个可用模型`)
        return
      }
      if (settings.kind === 'codex_cli') {
        const available = await window.worklens.listCodexCliModels()
        setModels(available)
        if (!available.some((model) => model.id === settings.model)) setSettings((value) => ({ ...value, model: available[0]?.id ?? 'auto' }))
        notify(`读取到 ${available.length} 个可用模型`)
        return
      }
      if (settings.kind === 'cursor' && apiKey) {
        setSettings(await window.worklens.saveProviderSettings({ kind: 'cursor', model: settings.model || 'auto', baseUrl: '', apiKey, sendImages: settings.sendImages, autoAnalyze: settings.autoAnalyze }))
        setApiKey('')
      }
      if (settings.kind === 'cursor') {
        const available = await window.worklens.listCursorModels()
        setModels(available)
        if (!settings.model && available[0]) setSettings((value) => ({ ...value, model: available[0]!.id }))
        notify(`读取到 ${available.length} 个可用模型`)
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
      const status = await window.worklens.loginCursorCli()
      setCliStatus(status)
      if (!status.authenticated) throw new Error(status.message)
      const available = await window.worklens.listCursorCliModels()
      setModels(available)
      setSettings((value) => ({ ...value, kind: 'cursor_cli', model: available.some((model) => model.id === value.model) ? value.model : 'auto' }))
      notify('Cursor 账号登录成功')
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
      const status = await window.worklens.loginCodexCli()
      setCodexStatus(status)
      if (!status.authenticated) throw new Error(status.message)
      const available = await window.worklens.listCodexCliModels()
      setModels(available)
      setSettings((value) => ({ ...value, kind: 'codex_cli', model: available.some((model) => model.id === value.model) ? value.model : 'auto' }))
      notify('Codex 账号登录成功')
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.worklens.testProvider()
      notify(result.message)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const isLocalProvider = settings.kind === 'cursor_cli' || settings.kind === 'codex_cli'
  const activeLocalStatus = settings.kind === 'codex_cli' ? codexStatus : cliStatus

  return (
    <div className="settings-layout">
      <section className="settings-panel panel">
        <div className="settings-heading"><div className="settings-icon"><Bot size={22} /></div><div><h2>日报生成与资料问答模型</h2><p>可连接本机已登录的 Cursor 或 Codex，无需在 WorkLens 中保存 API Key。</p></div></div>
        <div className="provider-tabs">
          <button className={settings.kind === 'cursor_cli' ? 'active' : ''} onClick={() => { setModels([]); setSettings((value) => ({ ...value, kind: 'cursor_cli', model: 'auto', baseUrl: '' })) }}><Terminal size={16} />本机 Cursor</button>
          <button className={settings.kind === 'codex_cli' ? 'active' : ''} onClick={() => { setModels([]); setSettings((value) => ({ ...value, kind: 'codex_cli', model: 'auto', baseUrl: '' })) }}><Bot size={16} />本机 Codex</button>
          <button className={settings.kind === 'cursor' ? 'active' : ''} onClick={() => { setModels([]); setSettings((value) => ({ ...value, kind: 'cursor', model: '', baseUrl: '' })) }}><Sparkles size={16} />Cursor API</button>
          <button className={settings.kind === 'openai_compatible' ? 'active' : ''} onClick={() => { setModels([]); setSettings((value) => ({ ...value, kind: 'openai_compatible', model: '' })) }}><Network size={16} />外部 API</button>
        </div>
        <div className="settings-form">
          {settings.kind === 'cursor_cli' && (
            <div className={`cli-status-card ${cliStatus?.authenticated ? 'connected' : ''}`}>
              <div className="cli-status-icon">{cliStatus?.authenticated ? <CheckCircle2 size={20} /> : <Terminal size={20} />}</div>
              <div><strong>{cliStatus?.authenticated ? 'Cursor 账号已连接' : cliStatus?.installed ? 'Cursor CLI 等待登录' : '尚未安装 Cursor Agent CLI'}</strong><span>{cliStatus?.message ?? '正在检测本机 Cursor CLI…'}</span>{cliStatus?.version && <small>版本 {cliStatus.version}</small>}</div>
              {cliStatus?.installed && !cliStatus.authenticated ? <button className="secondary-button" disabled={busy} onClick={() => void loginCli()}><LogIn size={15} />登录 Cursor</button> : <button className="ghost-button" disabled={busy} onClick={() => void refreshCliStatus()}>刷新状态</button>}
            </div>
          )}
          {settings.kind === 'codex_cli' && (
            <div className={`cli-status-card ${codexStatus?.authenticated ? 'connected' : ''}`}>
              <div className="cli-status-icon">{codexStatus?.authenticated ? <CheckCircle2 size={20} /> : <Bot size={20} />}</div>
              <div><strong>{codexStatus?.authenticated ? 'Codex 账号已连接' : codexStatus?.installed ? 'Codex CLI 等待登录' : '尚未安装 Codex CLI'}</strong><span>{codexStatus?.message ?? '正在检测本机 Codex CLI…'}</span>{codexStatus?.accountLabel && <small>{codexStatus.accountLabel}</small>}{codexStatus?.version && <small>版本 {codexStatus.version}</small>}</div>
              {codexStatus?.installed && !codexStatus.authenticated ? <button className="secondary-button" disabled={busy} onClick={() => void loginCodex()}><LogIn size={15} />登录 Codex</button> : <button className="ghost-button" disabled={busy} onClick={() => void refreshCodexStatus()}>刷新状态</button>}
            </div>
          )}
          {settings.kind === 'openai_compatible' && <label>Base URL<input value={settings.baseUrl} onChange={(event) => setSettings((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /><small>必须使用 HTTPS；只有 localhost 可以使用 HTTP。</small></label>}
          {!isLocalProvider && <label>API Key<div className="input-with-status"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? '已安全保存，留空表示不修改' : '粘贴 API Key'} autoComplete="off" />{settings.hasApiKey && <CheckCircle2 size={17} />}</div><small>密钥由 macOS Keychain 加密，不进入业务数据库和导出包。</small></label>}
          <label>模型<div className="model-row">{models.length && (settings.kind === 'cursor' || isLocalProvider) ? <select value={settings.model} onChange={(event) => setSettings((value) => ({ ...value, model: event.target.value }))}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select> : <input value={settings.model} onChange={(event) => setSettings((value) => ({ ...value, model: event.target.value }))} placeholder={settings.kind === 'cursor' || isLocalProvider ? '点击刷新模型' : '模型 ID'} />}{(settings.kind === 'cursor' || isLocalProvider) && <button className="secondary-button" disabled={busy} onClick={() => void loadModels()}>刷新模型</button>}</div></label>
          <label className="check-row muted"><input type="checkbox" checked={settings.autoAnalyze} onChange={(event) => setSettings((value) => ({ ...value, autoAnalyze: event.target.checked }))} /><span><strong>记录或上传后自动生成日报</strong><small>同一天的内容会重新合并，并更新次日早会逐字稿。</small></span></label>
        </div>
        <div className="settings-actions"><button className="ghost-button" disabled={busy || (isLocalProvider ? !activeLocalStatus?.authenticated : !settings.hasApiKey)} onClick={() => void test()}>测试连接</button><button className="primary-button" disabled={busy || !settings.model} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存设置</button></div>
      </section>
      <aside className="privacy-panel"><ShieldCheck size={26} /><h3>本地保存，按需调用 AI</h3><p>原始资料、日报、时间线和搜索索引默认留在本机。生成日报时，当天文本会发送给当前选择的模型。</p><ul><li><Check size={14} />原始记录永不被 AI 覆盖</li><li><Check size={14} />同一天资料统一合并去重</li><li><Check size={14} />AI 在独立进程和临时目录中运行</li><li><Check size={14} />API Key 不进入导出文件</li></ul></aside>
    </div>
  )
}

function SourceDrawer({ source, onClose }: { source: SourceItem; onClose: () => void }): ReactNode {
  const [assets, setAssets] = useState<Asset[]>([])
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null)
  const [previewData, setPreviewData] = useState<AssetPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [assetError, setAssetError] = useState('')
  const [assetNotice, setAssetNotice] = useState('')
  const [openingAssetId, setOpeningAssetId] = useState<string | null>(null)

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

  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="source-drawer" onMouseDown={(event) => event.stopPropagation()}>
    <div className="drawer-header"><div><span>{source.kind.toUpperCase()} · {sourceDate(source)}</span><h2>{source.title}</h2></div><button className="icon-button" aria-label="关闭原始资料" onClick={onClose}><X size={18} /></button></div>
    <div className="drawer-meta"><StatusPill status={source.status} /><span><Archive size={13} />{source.assetCount} 个附件</span><span><Clock3 size={13} />{formatTimestamp(source.createdAt)}</span></div>
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
  </aside></div>
}

function SearchPopover({ query, results, onClose, onOpen }: { query: string; results: SearchHit[]; onClose: () => void; onOpen: (result: SearchHit) => void }): ReactNode {
  return <div className="search-popover"><div className="search-popover-head"><span>“{query}” 的结果</span><button onClick={onClose}><X size={14} /></button></div>{results.map((result) => <button className="search-result" key={`${result.entityType}:${result.entityId}`} onClick={() => onOpen(result)}><div className={`search-result-icon ${result.entityType}`}>{result.entityType === 'brief' ? <Clipboard size={15} /> : result.entityType === 'event' ? <BriefcaseBusiness size={15} /> : <FileText size={15} />}</div><div><strong>{result.title}</strong><span>{result.excerpt}</span></div><small>{result.date}</small></button>)}{!results.length && <div className="search-empty">没有找到匹配内容</div>}</div>
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
  return { dashboard: '看清最近工作和明早要说的内容', capture: '为选定工作日写下一条新记录', batch: '跨日期导入，并按正文日期自动归档', briefs: '可以直接照着念的次日早会汇报', ask: '用本机 AI 回答过往工作问题', timeline: '按工作日回看整理后的工作内容', events: '日报合并后沉淀的关键工作内容', export: '生成工作报告或保存完整备份', settings: '选择用于日报生成和资料问答的 AI 模型' }[key]
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
function sourceDate(source: SourceItem): string {
  return (source.businessDate ?? source.createdAt).slice(0, 10)
}
function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType.split('/')[1] ?? 'png'
}
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法读取剪贴板中的图片'))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('无法读取剪贴板中的图片')))
    reader.readAsDataURL(file)
  })
}
function friendlyDate(date: string): string {
  if (date === todayLocal()) return '今天'
  return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`
}
function monthLabel(date: string): string {
  return `${Number(date.slice(5, 7))}月`
}
function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
function estimateSpeakingTime(script: string): number {
  return Math.max(1, Math.ceil(script.replace(/\s/g, '').length / 260))
}
function showError(setToast: (value: { message: string; tone: 'success' | 'error' } | null) => void, error: unknown): void {
  setToast({ message: displayErrorMessage(error), tone: 'error' })
}
