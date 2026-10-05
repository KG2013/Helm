import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { collectAcceptanceReport, type AcceptanceCheck, type AcceptanceProbeOptions, type AcceptanceReport } from './acceptance.js'
import { providerConfigFromEnv } from '@helm/providers'
import { PythonDocumentWorkerClient } from '@helm/runtime'
import { createDockerCodingSandboxFromEnv } from '@helm/runtime/tools'
import { readKeychainSecret } from './keychain.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024
const SMOKE_TIMEOUT_MS = 120_000

export interface SmokeEvidence {
  command: string
  exitCode?: number
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  stdoutHash: string
  stderrHash: string
  timedOut?: boolean
  unavailable?: boolean
}

export interface AcceptanceSmokeCheck extends AcceptanceCheck {
  mode: 'smoke'
  details: AcceptanceCheck['details'] & { smoke?: SmokeEvidence }
}

export interface AcceptanceSmokeReport extends Omit<AcceptanceReport, 'checks' | 'releaseGate'> {
  checks: AcceptanceSmokeCheck[]
  releaseGate: AcceptanceReport['releaseGate']
}

export interface AcceptanceSmokeOptions extends AcceptanceProbeOptions {
  runReal?: boolean
  preflight?: AcceptanceReport
  electronRunner?: () => Promise<SmokeEvidence>
  dockerRunner?: () => Promise<SmokeEvidence>
  providerRunner?: () => Promise<SmokeEvidence>
  officeRunner?: () => Promise<SmokeEvidence>
}

export async function collectAcceptanceSmokeReport(options: AcceptanceSmokeOptions = {}): Promise<AcceptanceSmokeReport> {
  const preflight = options.preflight ?? await collectAcceptanceReport(options)
  const checks = await Promise.all(preflight.checks.map((check) => smokeCheck(check, options)))
  const blocked = checks.filter((check) => check.status !== 'passed')
  return {
    schemaVersion: preflight.schemaVersion,
    collectedAt: preflight.collectedAt,
    environment: preflight.environment,
    checks,
    releaseGate: {
      result: blocked.length ? 'blocked' : 'passed',
      eligible: blocked.length === 0,
      reasons: blocked.map((check) => `${check.id}: ${check.reason}`).slice(0, 8),
    },
  }
}

export function printAcceptanceSmokeSummary(report: AcceptanceSmokeReport): void {
  console.log(`Helm acceptance smoke: ${report.releaseGate.result}`)
  for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(11)} ${check.id}: ${check.reason}`)
  console.log(`environment fingerprint: ${report.environment.fingerprint}`)
  if (report.releaseGate.reasons.length) console.log(`release gate: ${report.releaseGate.reasons.join(' | ')}`)
}

async function smokeCheck(check: AcceptanceCheck, options: AcceptanceSmokeOptions): Promise<AcceptanceSmokeCheck> {
  const base = { ...check, mode: 'smoke' as const, details: { ...check.details } }
  if (!options.runReal) return { ...base, status: 'unverified', reason: 'Real smoke is disabled; pass --run-real to execute target smoke commands.' }
  if (check.status === 'failed') return { ...base, reason: check.reason }
  const runner = check.kind === 'electron'
    ? (options.electronRunner ?? (() => runElectronSmoke(options)))
    : check.kind === 'docker'
      ? (options.dockerRunner ?? (() => runDockerSmoke(options)))
      : check.kind === 'provider'
        ? (options.providerRunner ?? (() => runProviderSmoke(options)))
        : (options.officeRunner ?? (() => runOfficeSmoke(options)))
  try {
    const evidence = await runner()
    const unavailable = evidence.unavailable === true || evidence.timedOut === true
    const status = unavailable ? 'unknown' : evidence.exitCode === 0 ? 'passed' : 'failed'
    const reason = unavailable
      ? `${check.kind} smoke could not establish a trustworthy target result; outcome is UNKNOWN.`
      : evidence.exitCode === 0
        ? `${check.kind} real smoke passed.`
        : `${check.kind} real smoke failed with exit code ${evidence.exitCode ?? 'unknown'}.`
    return { ...base, status, reason, evidenceRefs: [...check.evidenceRefs, `command://${evidence.command.replace(/[^a-z0-9._/-]+/gi, '-')}`], details: { ...check.details, smoke: evidence } }
  } catch (error) {
    const evidence = errorEvidence(error)
    const unavailable = evidence.timedOut === true || evidence.unavailable === true
    return { ...base, status: unavailable ? 'unknown' : 'failed', reason: unavailable ? `${check.kind} smoke timed out or target is unavailable; outcome is unknown.` : `${check.kind} smoke could not be executed.`, evidenceRefs: [...check.evidenceRefs, `command://${evidence.command.replace(/[^a-z0-9._/-]+/gi, '-')}`], details: { ...check.details, smoke: evidence } }
  }
}

async function runDockerSmoke(options: AcceptanceSmokeOptions): Promise<SmokeEvidence> {
  const startedAt = Date.now()
  const root = options.env?.HELM_WORKSPACE_ROOT ?? options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const command = 'docker run --pull=never --rm --network=none helm-coding-smoke'
  const sandbox = createDockerCodingSandboxFromEnv(env, root)
  if (!sandbox) return evidence(command, Date.now() - startedAt, '', 'Docker sandbox configuration is unavailable.', undefined, false, true)
  try {
    const result = await sandbox.run('sh', ['-c', 'printf helm-docker-smoke'], root, { timeoutMs: SMOKE_TIMEOUT_MS })
    return evidence(command, Date.now() - startedAt, result.stdout, result.stderr, result.exitCode)
  } catch (error) {
    return errorEvidence(error, command)
  }
}

async function runProviderSmoke(options: AcceptanceSmokeOptions): Promise<SmokeEvidence> {
  const startedAt = Date.now()
  const env = options.env ?? process.env
  const config = providerConfigFromEnv(env)
  const command = config ? `node apps/cli/dist/main.js run provider-smoke:${config.entry.id}` : 'provider://unconfigured'
  if (!config) return evidence(command, Date.now() - startedAt, '', 'No provider selected.', undefined, false, true)
  const key = await readKeychainSecret(config.keychainService)
  if (!key) return evidence(`keychain://${config.keychainService}`, Date.now() - startedAt, '', 'Provider credential is unavailable.', undefined, false, true)
  const root = resolve(options.cwd ?? process.cwd())
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/(API_KEY|AUTH|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(name)))
  childEnv.HELM_PROVIDER = config.entry.id
  delete childEnv.HELM_TASK_KIND
  delete childEnv.HELM_STATE_DB
  try {
    const result = await execFileAsync(process.execPath, ['apps/cli/dist/main.js', 'run', `Helm provider smoke (${config.entry.id})`], { cwd: root, env: childEnv, timeout: SMOKE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
    return evidence(command, Date.now() - startedAt, result.stdout, result.stderr, 0)
  } catch (error) {
    return errorEvidence(error, command)
  }
}

async function runOfficeSmoke(options: AcceptanceSmokeOptions): Promise<SmokeEvidence> {
  const startedAt = Date.now()
  const scriptPath = options.env?.HELM_DOCUMENT_WORKER ?? resolve(options.cwd ?? process.cwd(), 'workers/document-worker/worker.py')
  const command = 'python workers/document-worker/worker.py docx_create'
  const directory = await mkdtemp(resolve(tmpdir(), 'helm-office-smoke-'))
  try {
    const worker = new PythonDocumentWorkerClient({ scriptPath, workspaceRoot: directory })
    const health = await worker.health()
    const response = await worker.execute({ id: 'acceptance-office-smoke', runId: 'acceptance-office-smoke', operation: 'docx_create', path: 'smoke.docx', paragraphs: ['Helm Office smoke'] })
    const rendering = response.receipt && typeof response.receipt === 'object' && response.receipt.checks && typeof response.receipt.checks === 'object' ? (response.receipt.checks as Record<string, unknown>).rendering : undefined
    const output = JSON.stringify({ ok: response.ok, rendering, pdfOcr: health.checks.pdfOcr })
    const blocked = health.checks.docxRendering !== 'passed' || health.checks.pdfOcr !== 'passed' || !response.ok || rendering !== 'passed'
    return evidence(command, Date.now() - startedAt, output, blocked ? JSON.stringify(health.missing ?? []) : '', blocked ? 2 : 0, false, blocked)
  } catch (error) {
    return errorEvidence(error, command)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runElectronSmoke(options: AcceptanceSmokeOptions): Promise<SmokeEvidence> {
  const startedAt = Date.now()
  const root = resolve(options.cwd ?? process.cwd())
  const command = 'pnpm --filter @helm/desktop test:electron'
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|AUTH|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(key)))
  delete env.HELM_PROVIDER
  delete env.HELM_TASK_KIND
  delete env.HELM_CODING_SANDBOX
  env.NODE_ENV = 'production'
  try {
    const result = await execFileAsync('pnpm', ['--filter', '@helm/desktop', 'test:electron'], { cwd: root, env, timeout: SMOKE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
    return evidence(command, Date.now() - startedAt, result.stdout, result.stderr, 0)
  } catch (error) {
    const cause = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }
    const timedOut = cause.killed === true || cause.signal === 'SIGTERM'
    return evidence(command, Date.now() - startedAt, cause.stdout ?? '', cause.stderr ?? '', typeof cause.code === 'number' ? cause.code : undefined, timedOut)
  }
}

function errorEvidence(error: unknown, command = 'pnpm --filter @helm/desktop test:electron'): SmokeEvidence {
  const cause = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }
  const diagnostics = `${cause.stderr ?? ''} ${error instanceof Error ? error.message : ''}`
  const unavailable = /cannot connect|daemon|no such image|credential|keychain|unavailable|not found/i.test(diagnostics)
  return evidence(command, 0, cause.stdout ?? '', cause.stderr ?? '', typeof cause.code === 'number' ? cause.code : undefined, cause.killed === true || cause.signal === 'SIGTERM', unavailable)
}

function evidence(command: string, durationMs: number, stdout: string, stderr: string, exitCode?: number, timedOut = false, unavailable = false): SmokeEvidence {
  const boundedStdout = Buffer.from(stdout).subarray(0, MAX_OUTPUT_BYTES)
  const boundedStderr = Buffer.from(stderr).subarray(0, MAX_OUTPUT_BYTES)
  return { command, exitCode, durationMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutHash: hash(boundedStdout), stderrHash: hash(boundedStderr), ...(timedOut ? { timedOut: true } : {}), ...(unavailable ? { unavailable: true } : {}) }
}

function hash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
