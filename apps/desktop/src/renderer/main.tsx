import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildRunProjection, reduceRunEvents } from '@helm/runtime'
import type { DomainEvent, Run, Session, Task } from '@helm/runtime'
import type { RunEventPayload, RunSnapshot } from '../shared/ipc.js'
import './styles.css'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  source: 'task' | 'runtime'
  status?: 'failed'
}

type TimelineState = 'done' | 'running' | 'queued' | 'failed'
type TimelineStep = { id: string; label: string; detail: string; state: TimelineState }
type PendingApproval = { approvalId: string; reason: string; call: { name: string; arguments: Record<string, unknown> } }

const TERMINAL_STATES: Run['state'][] = ['completed', 'failed', 'cancelled', 'needs_reconciliation']

function Icon({ name }: { name: 'folder' | 'plus' | 'chevron' | 'code' | 'check' | 'clock' | 'shield' | 'spark' | 'more' | 'search' | 'send' | 'terminal' }) {
  const paths: Record<string, string> = {
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v8A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5z',
    plus: 'M12 5v14M5 12h14',
    chevron: 'm9 18 6-6-6-6',
    code: 'm8 9-3 3 3 3m8-6 3 3-3 3m-4-9-2 12',
    check: 'm5 12 4 4L19 6',
    clock: 'M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    shield: 'M12 3 19 6v5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V6zM9 12l2 2 4-4',
    spark: 'm12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4zM19 17v4M17 19h4',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    search: 'm20 20-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z',
    send: 'm21 3-7.2 18-3.8-7-7-3.8zM10 14l4-4',
    terminal: 'm5 7 5 5-5 5m7 0h7',
  }
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
}

function eventPayload(event: DomainEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

function isTerminal(state: Run['state'] | undefined): boolean {
  return state ? TERMINAL_STATES.includes(state) : false
}

/** Project a run from the same event ledger that drives the chat messages. */
function projectRun(events: readonly DomainEvent[], fallback?: Run): Run | undefined {
  if (events.some((event) => event.type === 'run.created')) {
    try {
      return reduceRunEvents(events)
    } catch {
      // A partial event stream can arrive before run.created. Keep the last snapshot until it is complete.
    }
  }
  return fallback
}

function timeline(run: Run | undefined): TimelineStep[] {
  if (!run) {
    return [
      { id: 'task', label: 'Accept request', detail: 'Waiting for a task', state: 'queued' },
      { id: 'provider', label: 'Run provider', detail: 'Waiting for Runtime', state: 'queued' },
      { id: 'verify', label: 'Verify output', detail: 'Waiting for a Run', state: 'queued' },
      { id: 'deliver', label: 'Report result', detail: 'Waiting for output', state: 'queued' },
    ]
  }

  const failed = ['failed', 'cancelled', 'needs_reconciliation'].includes(run.state)
  const providerState: TimelineState = run.state === 'completed' || run.steps > 0 ? 'done' : failed ? 'failed' : 'running'
  const verificationState: TimelineState = run.state === 'completed'
    ? 'done'
    : failed
      ? 'failed'
      : ['verifying', 'reducing'].includes(run.state)
        ? 'running'
        : 'queued'
  const deliveryState: TimelineState = run.state === 'completed' ? 'done' : failed ? 'failed' : 'queued'

  return [
    { id: 'task', label: 'Accept request', detail: `Task ${run.taskId}`, state: 'done' },
    { id: 'provider', label: 'Run provider', detail: providerState === 'done' ? `${run.steps} step${run.steps === 1 ? '' : 's'}` : run.state, state: providerState },
    { id: 'verify', label: 'Verify output', detail: run.verification?.result ?? run.state, state: verificationState },
    { id: 'deliver', label: 'Report result', detail: run.state, state: deliveryState },
  ]
}

function messagesFromLedger(task: Task | undefined, run: Run | undefined, events: readonly DomainEvent[]): ChatMessage[] {
  if (!task) return []
  const messages: ChatMessage[] = [{ id: `task:${task.id}`, role: 'user', content: task.goal, source: 'task' }]
  const terminalMessages = events
    .filter((event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.needs_reconciliation')
    .map((event): ChatMessage | undefined => {
      const payload = eventPayload(event)
      if (event.type === 'run.completed' && typeof payload.output === 'string') {
        return { id: event.id, role: 'assistant', content: payload.output, source: 'runtime' }
      }
      const detail = typeof payload.error === 'string' ? payload.error : typeof payload.reason === 'string' ? payload.reason : undefined
      if (!detail) return undefined
      return { id: event.id, role: 'assistant', content: detail, source: 'runtime', status: 'failed' }
    })
    .filter((message): message is ChatMessage => Boolean(message))

  // The completed event is authoritative. The fallback only covers an already materialized snapshot
  // whose event batch is still being backfilled, and is keyed by the run so it cannot duplicate output.
  if (terminalMessages.length === 0 && run?.finalOutput) {
    terminalMessages.push({ id: `run-output:${run.id}`, role: 'assistant', content: run.finalOutput, source: 'runtime' })
  }
  return [...messages, ...terminalMessages]
}

function pendingApproval(events: readonly DomainEvent[]): PendingApproval | undefined {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'approval.decided') {
      const approvalId = eventPayload(event).approvalId
      if (typeof approvalId === 'string') decided.add(approvalId)
    }
  }
  for (const event of [...events].reverse()) {
    if (event.type !== 'approval.requested') continue
    const payload = eventPayload(event)
    const approvalId = payload.approvalId
    const call = payload.call
    if (typeof approvalId !== 'string' || decided.has(approvalId) || !call || typeof call !== 'object') continue
    const callRecord = call as Record<string, unknown>
    if (typeof callRecord.name !== 'string' || !callRecord.arguments || typeof callRecord.arguments !== 'object') continue
    return { approvalId, reason: typeof payload.reason === 'string' ? payload.reason : 'Runtime requests approval.', call: { name: callRecord.name, arguments: callRecord.arguments as Record<string, unknown> } }
  }
  return undefined
}

function CodingEvidence({ delivery, verification }: { delivery: NonNullable<RunSnapshot['projection']['codingDelivery']>; verification: RunSnapshot['projection']['verification'] }) {
  const conflicts = delivery.conflicts
  return <div className="coding-evidence" data-testid="coding-evidence">
    <div className="section-heading"><span>CODING EVIDENCE</span><span className={delivery.ready ? 'evidence-state ready' : 'evidence-state blocked'}>{delivery.ready ? 'ready' : 'blocked'}</span></div>
    <div className="coding-detail-card">
      <div className="coding-detail-meta"><span>Files</span><code>{delivery.changedFiles.join(', ') || 'No changed files'}</code></div>
      {conflicts.map((conflict, index) => { const detail = conflict.conflict; const candidates = Array.isArray(detail?.candidates) ? detail.candidates : []; return <div className="coding-conflict" data-testid="coding-conflict" key={conflict.id}><strong>Patch conflict {conflicts.length > 1 ? `${index + 1}/${conflicts.length}` : ''} · {String(detail?.reason ?? 'manual review')}</strong><p>{String(detail?.manualAction ?? 'Refresh the file and submit a new patch.')}</p><span>Candidate ranges: {String(detail?.matchCount ?? candidates.length)} · no mutation applied</span>{candidates.length > 0 && <div className="coding-candidates">{candidates.map((candidate, candidateIndex) => { const item = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}; return <code key={candidateIndex}>line {String(item.line ?? '?')} · {String(item.start ?? '?')}-{String(item.end ?? '?')} · {String(item.contextHash ?? 'context hash unavailable')}</code> })}</div>}</div> })}
      {delivery.diff?.text && <div className="coding-output" data-testid="coding-diff"><label>DIFF</label><pre>{delivery.diff.text}</pre></div>}
      {delivery.tests.length > 0 && <div className="coding-output" data-testid="coding-tests"><label>TESTS</label>{delivery.tests.map((test, index) => <div className="coding-test-row" key={String(test.outputHash ?? index)}><code>{[test.command, ...(test.args ?? [])].filter(Boolean).join(' ') || 'test command'}</code><span className={test.exitCode === 0 ? 'test-pass' : 'test-fail'}>{test.exitCode === 0 ? 'passed' : 'exit ' + String(test.exitCode ?? 'unknown')}</span><pre>{test.output ?? 'No test output recorded.'}</pre></div>)}</div>}
      {verification?.evidence?.length ? <div className="coding-output coding-evidence-refs" data-testid="coding-evidence-refs"><label>EVIDENCE REFERENCES</label>{verification.evidence.map((evidence, index) => <div className="coding-evidence-ref" key={evidence.type + '-' + String(evidence.hash ?? index)}><span>{evidence.type}</span><code>{evidence.uri ?? evidence.hash ?? evidence.summary}</code></div>)}</div> : <div className="coding-empty">Verification evidence will appear after Runtime checks.</div>}
    </div>
  </div>
}

function App() {
  const [runtime, setRuntime] = useState('local runtime')
  const [task, setTask] = useState<Task>()
  const [session, setSession] = useState<Session>()
  const [run, setRun] = useState<Run>()
  const [events, setEvents] = useState<DomainEvent[]>([])
  const [projection, setProjection] = useState<RunSnapshot['projection']>()
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [controlPending, setControlPending] = useState(false)

  const activeRunIdRef = useRef<string | undefined>(undefined)
  const submittingRef = useRef(false)
  const snapshotRequestRef = useRef(0)
  const ledgersRef = useRef(new Map<string, Map<string, DomainEvent>>())

  const mergeEvents = useCallback((runId: string, incoming: readonly DomainEvent[]): DomainEvent[] => {
    const ledger = ledgersRef.current.get(runId) ?? new Map<string, DomainEvent>()
    const existingSequences = new Set(Array.from(ledger.values(), (event) => event.sequence))
    for (const event of incoming) {
      if (event.runId && event.runId !== runId) continue
      if (ledger.has(event.id) || existingSequences.has(event.sequence)) continue
      // Runtime sequences are monotonic per run. An unseen lower sequence is still
      // accepted so a snapshot can backfill an event that arrived after a live event.
      ledger.set(event.id, event)
      existingSequences.add(event.sequence)
    }
    ledgersRef.current.set(runId, ledger)
    return Array.from(ledger.values()).sort((left, right) => left.sequence - right.sequence)
  }, [])

  const applySnapshot = useCallback((snapshot: RunSnapshot, requestId: number) => {
    if (activeRunIdRef.current !== snapshot.run.id || snapshotRequestRef.current !== requestId) return
    const merged = mergeEvents(snapshot.run.id, snapshot.events)
    setTask(snapshot.task)
    setSession(snapshot.session)
    setProjection(snapshot.projection)
    setEvents(merged)
    setRun((previous) => projectRun(merged, snapshot.run) ?? previous ?? snapshot.run)
  }, [mergeEvents])

  const refreshSnapshot = useCallback(async (runId: string, requestId: number) => {
    try {
      const snapshot = await window.helm?.getRunSnapshot(runId)
      if (snapshot) applySnapshot(snapshot, requestId)
    } catch (cause) {
      if (activeRunIdRef.current === runId && snapshotRequestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : 'Unable to load the Run snapshot.')
      }
    }
  }, [applySnapshot])

  useEffect(() => {
    const bridge = window.helm
    if (!bridge) {
      setRuntime('browser preview')
      return undefined
    }
    void bridge.runtimeInfo()
      .then((info) => {
        const missing = info.officePreflight?.missing ?? []
        const office = info.officePreflight ? ` · Office ${info.officePreflight.version}${missing.length > 0 ? ` · missing ${missing.join(', ')}` : ' · deps ready'}` : ''
        setRuntime(`${info.platform} · ${info.isPackaged ? 'packaged' : 'dev'}${office}`)
      })
      .catch(() => setRuntime('local runtime · unavailable'))

    const unsubscribe = bridge.subscribe((payload: RunEventPayload) => {
      const runId = payload.runId
      // Events are broadcast to every renderer. Only the selected Run may mutate this view.
      if (!runId || runId !== activeRunIdRef.current) return
      const merged = mergeEvents(runId, [payload])
      setEvents(merged)
      setRun((previous) => {
        const next = projectRun(merged, previous) ?? previous
        setProjection(buildRunProjection(merged, next))
        return next
      })
    })
    return unsubscribe
  }, [mergeEvents])

  const steps = useMemo(() => timeline(run), [run])
  const currentMessages = useMemo(() => messagesFromLedger(task, run, events), [events, run, task])
  const messages = useMemo(() => [...history, ...currentMessages], [currentMessages, history])
  const completedSteps = steps.filter((step) => step.state === 'done').length
  const canSend = Boolean(inputValue.trim()) && !isSubmitting && (!run || isTerminal(run.state))
  const verificationResult = run?.state === 'needs_reconciliation' ? 'needs_reconciliation' : run?.verification?.result ?? 'pending'
  const approval = useMemo(() => pendingApproval(events), [events])
  const codingDelivery = projection?.codingDelivery

  async function sendMessage() {
    const goal = inputValue.trim()
    if (!goal || submittingRef.current || !canSend) return
    const previousRunId = activeRunIdRef.current
    submittingRef.current = true
    setIsSubmitting(true)
    setError(undefined)
    // Stop old-run events from landing while the new IPC request is in flight.
    activeRunIdRef.current = undefined
    const requestId = ++snapshotRequestRef.current
    try {
      const response = await window.helm?.startRun({ goal, workspaceId: 'workspace-helm' })
      if (!response) throw new Error('Desktop IPC is unavailable. Open Helm through Electron.')
      activeRunIdRef.current = response.run.id
      ledgersRef.current.set(response.run.id, new Map())
      // Keep completed Run messages in the conversation when switching to the next Run.
      // The execution card and right rail still follow only the newly selected Run.
      if (task && run) {
        setHistory((previous) => {
          const known = new Set(previous.map((message) => message.id))
          return [...previous, ...currentMessages.filter((message) => !known.has(message.id))]
        })
      }
      setInputValue('')
      setTask(response.task)
      setSession(response.session)
      setRun(response.run)
      setProjection(undefined)
      setEvents([])
      await refreshSnapshot(response.run.id, requestId)
    } catch (cause) {
      activeRunIdRef.current = previousRunId
      setError(cause instanceof Error ? cause.message : 'Unable to start the Run.')
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  async function controlRun(action: 'pause' | 'resume' | 'cancel') {
    if (!run || controlPending) return
    setControlPending(true)
    try {
      const next = await window.helm?.controlRun({ runId: run.id, action })
      if (next) setRun(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to control the Run.')
    } finally {
      setControlPending(false)
    }
  }

  async function decideApproval(decision: 'approve' | 'deny') {
    if (!run || !approval || controlPending) return
    setControlPending(true)
    try {
      const next = await window.helm?.resolveApproval({ runId: run.id, approvalId: approval.approvalId, workspaceId: task?.workspaceId ?? 'workspace-helm', decision })
      if (next) setRun(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to resolve the approval.')
    } finally {
      setControlPending(false)
    }
  }

  const runStatus = run?.state ?? 'ready'
  const runLabel = runStatus === 'completed' ? 'Run complete' : runStatus === 'needs_reconciliation' ? 'Reconciliation required' : runStatus === 'failed' ? 'Run failed' : runStatus === 'cancelled' ? 'Run cancelled' : 'Working on the task'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Icon name="spark" /></div><span>Helm</span><span className="beta">LOCAL AI WORKBENCH</span></div>
        <div className="topbar-center"><span className="connection-dot" />{runtime}<span className="separator">/</span><span className="provider">Mock Provider · deterministic</span><button className="icon-button" aria-label="More options"><Icon name="more" /></button></div>
        <div className="topbar-actions"><button className="icon-button" aria-label="Search"><Icon name="search" /></button><div className="avatar">ZK</div></div>
      </header>

      <main className="workspace">
        <aside className="left-panel panel">
          <div className="panel-heading"><span>Workspace</span><button className="icon-button subtle" aria-label="Add workspace"><Icon name="plus" /></button></div>
          <div className="workspace-selector"><div className="workspace-icon"><Icon name="folder" /></div><div><strong>Helm</strong><span>~/Lab/Helm</span></div><Icon name="chevron" /></div>
          <div className="section-heading"><span>SESSIONS</span><button className="new-button"><Icon name="plus" /> New</button></div>
          <div className="session-list"><button className="session-item active"><span className={`session-status ${run && !isTerminal(run.state) ? 'running' : 'done'}`} /><span className="session-copy"><strong>{session ? `Session ${session.id.slice(-6)}` : 'New session'}</strong><span>{task?.goal ?? 'Start a local task'}</span></span><span className="session-time">{run ? runStatus : 'now'}</span></button></div>
          <div className="left-footer"><div className="system-health"><span className="health-dot" /> System ready</div><button className="footer-link"><Icon name="shield" /> Permissions</button></div>
        </aside>

        <section className="center-panel panel">
          <div className="conversation-header">
            <div>
              <div className="eyebrow"><span className={`run-pulse ${isTerminal(runStatus) ? 'stopped' : ''}`} /> {run ? 'ACTIVE SESSION' : 'READY'} <span className="run-id" data-testid="run-id">{run?.id ?? 'none'}</span></div>
              <h1>{task?.goal ?? 'Start a local task'}</h1>
              <p>Helm session · Coding task · {runtime}</p>
            </div>
            <button className="run-menu icon-button" aria-label="Run options"><Icon name="more" /></button>
          </div>

          <div className="chat-stream" data-testid="messages">
            {messages.length === 0 && <div className="empty-state"><div className="message-avatar assistant-avatar"><Icon name="spark" /></div><h2>What should Helm work on?</h2><p>Describe a local coding or office task. Runtime events will appear here.</p></div>}
            {messages.map((message) => <div className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'} ${message.status === 'failed' ? 'failed-message' : ''}`} key={message.id}><div className={`message-avatar ${message.role === 'user' ? 'user-avatar' : 'assistant-avatar'}`}>{message.role === 'user' ? 'ZK' : <Icon name="spark" />}</div><div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? 'You' : 'Helm'}</strong><span className="message-provider">{message.role === 'user' ? 'Task input' : 'Runtime · Mock Provider'}</span></div><p>{message.content}</p></div></div>)}
            {run && <div className="message assistant-message latest-message"><div className="message-avatar assistant-avatar"><Icon name="spark" /></div><div className="message-body"><div className="message-meta"><strong>Helm</strong><span className="message-provider">Runtime projection</span></div><div className="execution-card"><div className="execution-card-header"><div><Icon name="terminal" /><strong>{runLabel}</strong></div><span>{completedSteps} / {steps.length} steps</span></div><div className="execution-steps">{steps.map((step) => <div className={`execution-step ${step.state}`} key={step.id}><span className="execution-marker">{step.state === 'done' ? <Icon name="check" /> : step.state === 'failed' ? <span className="marker-failure">!</span> : step.state === 'running' ? <span className="marker-dot" /> : null}</span><span>{step.label}</span><span className="execution-detail">{step.detail}</span></div>)}</div><div className="execution-footer"><span><span className="budget-bar"><span style={{ width: `${run.budget.maxSteps > 0 ? Math.min(100, (run.steps / run.budget.maxSteps) * 100) : 0}%` }} /></span> {run.steps} / {run.budget.maxSteps} steps</span><span data-testid="run-state">{run.state}</span>{run.state === 'paused' ? <button className="inline-action" data-testid="run-resume" disabled={controlPending} onClick={() => void controlRun('resume')}>Resume</button> : !isTerminal(run.state) && <button className="inline-action" data-testid="run-pause" disabled={controlPending} onClick={() => void controlRun('pause')}>Pause</button>}{!isTerminal(run.state) && <button className="inline-action" data-testid="run-cancel" disabled={controlPending} onClick={() => void controlRun('cancel')}>Cancel</button>}</div></div></div></div>}
          </div>

          <div className="composer-wrap"><div className="composer"><textarea value={inputValue} disabled={isSubmitting} onChange={(event) => setInputValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage() }} placeholder={isSubmitting ? 'Starting Run…' : 'Message Helm…'} rows={2} /><div className="composer-toolbar"><span><Icon name="code" /> Coding task</span><span className="composer-hint">⌘ ↵ to send</span><button className="composer-send" data-testid="run-submit" aria-label="Send message" onClick={() => void sendMessage()} disabled={!canSend}><Icon name="send" /></button></div></div><div className="composer-note">Runtime events are shown here. Local tools require an explicit Approval.</div>{error && <div className="composer-note" data-testid="run-error" role="alert">{error}</div>}</div>
        </section>

        <aside className="right-panel panel">
          <div className="right-tabs"><button className="right-tab active">Run evidence <span>{events.length}</span></button><button className="right-tab">Trace</button></div>
          <div className="artifact-section"><div className="section-heading"><span>RUN CONTEXT</span><span className="muted">{run?.id ?? 'none'}</span></div><div className="artifact-card"><div className="artifact-icon code-icon"><Icon name="code" /></div><div className="artifact-copy"><strong>{task?.workspaceId ?? 'workspace-helm'}</strong><span>{task ? 'Workspace selected · no file changes' : 'Waiting for task input'}</span></div></div></div>{codingDelivery && <CodingEvidence delivery={codingDelivery} verification={projection?.verification} />}
          <div className="approval-section"><div className="section-heading"><span>APPROVAL</span><span className="approval-state">Runtime owned</span></div><div className={`approval-card ${approval ? 'approval-card-pending' : ''}`}><div className="approval-icon"><Icon name="shield" /></div><div>{approval ? <><strong>Approval required: {approval.call.name}</strong><p>{approval.reason}</p><code>{JSON.stringify(approval.call.arguments)}</code><div className="approval-actions"><button className="inline-action" disabled={controlPending} onClick={() => void decideApproval('approve')}>Approve</button><button className="inline-action danger" disabled={controlPending} onClick={() => void decideApproval('deny')}>Deny</button></div></> : <><strong>{events.some((event) => event.type === 'policy.decision') ? 'Policy decision recorded' : 'No pending approval'}</strong><p>Approval appears here only for a concrete Runtime tool proposal.</p></>}</div></div></div>
          <div className="verification-section"><div className="section-heading"><span>VERIFICATION</span><span className="muted">Runtime evidence</span></div><div className={`verification-card verification-${verificationResult}`} data-testid="verification"><div className="verification-row"><span className={`verification-icon ${verificationResult === 'passed' ? 'passed' : verificationResult === 'failed' || verificationResult === 'needs_reconciliation' ? 'failed' : 'pending'}`}><Icon name={verificationResult === 'passed' ? 'check' : 'clock'} /></span><span>{run?.state === 'needs_reconciliation' ? 'Unknown side effect; reconciliation required.' : run?.verification?.message ?? (run?.lastError ?? 'Waiting for final output')}</span><strong>{verificationResult}</strong></div></div></div>
        </aside>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
