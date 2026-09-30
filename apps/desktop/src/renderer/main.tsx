import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type StepState = 'done' | 'running' | 'queued'

type TimelineStep = {
  id: string
  label: string
  detail: string
  state: StepState
  time?: string
}

const initialSteps: TimelineStep[] = [
  { id: 'intent', label: 'Understand request', detail: 'Task intent and constraints extracted', state: 'done', time: '10:42:01' },
  { id: 'plan', label: 'Plan changes', detail: '3 files, 1 verification gate', state: 'done', time: '10:42:08' },
  { id: 'edit', label: 'Apply implementation', detail: 'Waiting for workspace permission', state: 'running' },
  { id: 'verify', label: 'Run verification', detail: 'Tests and artifact checks', state: 'queued' },
  { id: 'deliver', label: 'Prepare delivery', detail: 'Summary and changed files', state: 'queued' },
]

function Icon({ name }: { name: 'grid' | 'folder' | 'plus' | 'chevron' | 'code' | 'file' | 'check' | 'clock' | 'shield' | 'spark' | 'play' | 'more' | 'search' | 'send' | 'terminal' }) {
  const paths: Record<string, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v8A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5z',
    plus: 'M12 5v14M5 12h14',
    chevron: 'm9 18 6-6-6-6',
    code: 'm8 9-3 3 3 3m8-6 3 3-3 3m-4-9-2 12',
    file: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
    check: 'm5 12 4 4L19 6',
    clock: 'M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    shield: 'M12 3 19 6v5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V6zM9 12l2 2 4-4',
    spark: 'm12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4zM19 17v4M17 19h4',
    play: 'm8 5 11 7-11 7z',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    search: 'm20 20-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z',
    send: 'm21 3-7.2 18-3.8-7-7-3.8zM10 14l4-4',
    terminal: 'm5 7 5 5-5 5m7 0h7',
  }
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
}

function App() {
  const [steps, setSteps] = useState(initialSteps)
  const [isRunning, setIsRunning] = useState(false)
  const [approvalState, setApprovalState] = useState<'pending' | 'approved'>('pending')
  const [runtime, setRuntime] = useState('local runtime')
  const [inputValue, setInputValue] = useState('')

  useEffect(() => {
    window.helm?.runtimeInfo().then((info) => setRuntime(`${info.platform} · ${info.isPackaged ? 'packaged' : 'dev'}`)).catch(() => undefined)
    const unsubscribe = window.helm?.subscribe('run:event', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const event = payload as { stepId?: string; state?: StepState; detail?: string }
      if (!event.stepId) return
      setSteps((current) => current.map((step) => step.id === event.stepId ? { ...step, state: event.state ?? step.state, detail: event.detail ?? step.detail } : step))
    })
    return () => unsubscribe?.()
  }, [])

  const completed = useMemo(() => steps.filter((step) => step.state === 'done').length, [steps])

  function startRun() {
    setIsRunning(true)
    setSteps((current) => current.map((step) => step.id === 'edit' ? { ...step, state: 'running', detail: 'Applying changes in isolated workspace' } : step))
    window.setTimeout(() => {
      setSteps((current) => current.map((step) => step.id === 'edit' ? { ...step, state: 'done', detail: 'Changes applied to 3 files', time: '10:42:19' } : step.id === 'verify' ? { ...step, state: 'running', detail: 'Running checks' } : step))
      window.setTimeout(() => {
        setSteps((current) => current.map((step) => step.id === 'verify' ? { ...step, state: 'done', detail: 'All checks passed', time: '10:42:24' } : step.id === 'deliver' ? { ...step, state: 'running', detail: 'Preparing summary' } : step))
        setIsRunning(false)
      }, 1000)
    }, 900)
  }

  async function approve() {
    await window.helm?.requestApproval({ action: 'workspace.write', reason: 'Apply the planned implementation' })
    setApprovalState('approved')
  }

  function sendMessage() {
    if (!inputValue.trim()) return
    setInputValue('')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Icon name="spark" /></div><span>Helm</span><span className="beta">LOCAL AI WORKBENCH</span></div>
        <div className="topbar-center"><span className="connection-dot" />{runtime}<span className="separator">/</span><span className="provider">DeepSeek</span><button className="icon-button" aria-label="More options"><Icon name="more" /></button></div>
        <div className="topbar-actions"><button className="icon-button" aria-label="Search"><Icon name="search" /></button><div className="avatar">ZK</div></div>
      </header>

      <main className="workspace">
        <aside className="left-panel panel">
          <div className="panel-heading"><span>Workspace</span><button className="icon-button subtle" aria-label="Add workspace"><Icon name="plus" /></button></div>
          <div className="workspace-selector"><div className="workspace-icon"><Icon name="folder" /></div><div><strong>Helm</strong><span>~/Lab/Helm</span></div><Icon name="chevron" /></div>
          <div className="section-heading"><span>SESSIONS</span><button className="new-button"><Icon name="plus" /> New</button></div>
          <div className="session-list">
            <button className="session-item active"><span className="session-status running" /><span className="session-copy"><strong>Desktop shell</strong><span>Build the initial workbench</span></span><span className="session-time">now</span></button>
            <button className="session-item"><span className="session-status done" /><span className="session-copy"><strong>Provider adapter</strong><span>DeepSeek connection</span></span><span className="session-time">yesterday</span></button>
            <button className="session-item"><span className="session-status done" /><span className="session-copy"><strong>Event ledger</strong><span>SQLite schema draft</span></span><span className="session-time">Sep 28</span></button>
          </div>
          <div className="left-footer"><div className="system-health"><span className="health-dot" /> System ready</div><button className="footer-link"><Icon name="shield" /> Permissions</button></div>
        </aside>

        <section className="center-panel panel">
          <div className="conversation-header">
            <div>
              <div className="eyebrow"><span className="run-pulse" /> ACTIVE SESSION <span className="run-id">RUN-240930-01</span></div>
              <h1>Build the initial workbench</h1>
              <p>Helm session · Coding task · DeepSeek</p>
            </div>
            <button className="run-menu icon-button" aria-label="Run options"><Icon name="more" /></button>
          </div>

          <div className="chat-stream">
            <div className="message user-message">
              <div className="message-avatar user-avatar">ZK</div>
              <div className="message-body"><div className="message-meta"><strong>You</strong><time>10:41</time></div><p>Build the initial workbench with an Electron + React desktop shell and a secure local runtime.</p></div>
            </div>
            <div className="message assistant-message">
              <div className="message-avatar assistant-avatar"><Icon name="spark" /></div>
              <div className="message-body"><div className="message-meta"><strong>Helm</strong><span className="message-provider">DeepSeek</span><time>10:42</time></div><p>I’ll set up the desktop shell, keep the Runtime behind a narrow boundary, and verify the workspace changes before delivery.</p>
                <div className="execution-card">
                  <div className="execution-card-header"><div><Icon name="terminal" /><strong>Working on the task</strong></div><span>{completed} / {steps.length} steps</span></div>
                  <div className="execution-steps">{steps.slice(0, 4).map((step) => <div className={`execution-step ${step.state}`} key={step.id}><span className="execution-marker">{step.state === 'done' ? <Icon name="check" /> : step.state === 'running' ? <span className="marker-dot" /> : null}</span><span>{step.label}</span><span className="execution-detail">{step.state === 'done' ? 'Done' : step.state === 'running' ? 'Running' : 'Queued'}</span></div>)}</div>
                  <div className="execution-footer"><span><span className="budget-bar"><span /></span> 6 / 30 steps</span><span>Budget 15 min</span><button className="inline-action" onClick={startRun} disabled={isRunning || approvalState !== 'approved'}><Icon name="play" /> {isRunning ? 'Running…' : 'Continue run'}</button></div>
                </div>
              </div>
            </div>
            <div className="message assistant-message latest-message">
              <div className="message-avatar assistant-avatar"><Icon name="spark" /></div>
              <div className="message-body"><div className="message-meta"><strong>Helm</strong><span className="message-provider">Planning</span></div><p className="message-muted">The plan is ready. Approve workspace writes in the right panel, then I’ll continue the run.</p></div>
            </div>
          </div>

          <div className="composer-wrap">
            <div className="composer"><textarea value={inputValue} onChange={(event) => setInputValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendMessage() }} placeholder="Message Helm…" rows={2} /><div className="composer-toolbar"><span><Icon name="code" /> Coding task</span><span className="composer-hint">⌘ ↵ to send</span><button className="composer-send" aria-label="Send message" onClick={sendMessage} disabled={!inputValue.trim()}><Icon name="send" /></button></div></div>
            <div className="composer-note">Helm can read and modify files only after an explicit approval.</div>
          </div>
        </section>

        <aside className="right-panel panel">
          <div className="right-tabs"><button className="right-tab active">Artifacts <span>3</span></button><button className="right-tab">Trace</button></div>
          <div className="artifact-section"><div className="section-heading"><span>CHANGED FILES</span><span className="muted">3 files</span></div><div className="artifact-card"><div className="artifact-icon code-icon"><Icon name="code" /></div><div className="artifact-copy"><strong>apps/desktop</strong><span>Electron shell</span></div><span className="artifact-status added">M</span></div><div className="artifact-card"><div className="artifact-icon file-icon"><Icon name="file" /></div><div className="artifact-copy"><strong>src/main/main.ts</strong><span>Secure IPC boundary</span></div><span className="artifact-status added">A</span></div><div className="artifact-card"><div className="artifact-icon file-icon"><Icon name="file" /></div><div className="artifact-copy"><strong>src/renderer/main.tsx</strong><span>Workbench UI</span></div><span className="artifact-status added">A</span></div></div>
          <div className="approval-section"><div className="section-heading"><span>APPROVAL</span><span className={`approval-state ${approvalState}`}>{approvalState === 'approved' ? 'Approved' : 'Required'}</span></div><div className="approval-card"><div className="approval-icon"><Icon name="shield" /></div><div><strong>Write to workspace</strong><p>Allow Helm to apply the planned changes to this workspace.</p></div>{approvalState === 'pending' ? <button className="approve-button" onClick={approve}>Allow</button> : <Icon name="check" />}</div></div>
          <div className="verification-section"><div className="section-heading"><span>VERIFICATION</span><span className="muted">P0 gate</span></div><div className="verification-card"><div className="verification-row"><span className="verification-icon passed"><Icon name="check" /></span><span>Workspace boundary</span><strong>Passed</strong></div><div className="verification-row"><span className="verification-icon pending"><Icon name="clock" /></span><span>Build and typecheck</span><strong>Pending</strong></div><div className="verification-row"><span className="verification-icon pending"><Icon name="clock" /></span><span>Artifact receipt</span><strong>Pending</strong></div></div></div>
        </aside>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
