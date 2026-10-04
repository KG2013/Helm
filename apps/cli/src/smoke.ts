import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectAcceptanceReport, type AcceptanceCheck, type AcceptanceProbeOptions, type AcceptanceReport } from './acceptance.js'

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
  if (check.status === 'failed' || check.status === 'unknown') return { ...base, reason: check.reason }
  if (check.kind !== 'electron') {
    return { ...base, status: 'unverified', reason: `${check.kind} real smoke runner is not configured in this slice; target-specific evidence remains unverified.` }
  }
  const runner = options.electronRunner ?? runElectronSmoke
  try {
    const evidence = await runner()
    return { ...base, status: evidence.exitCode === 0 ? 'passed' : 'failed', reason: evidence.exitCode === 0 ? 'Electron packaged restart/multi-window smoke passed.' : `Electron packaged smoke failed with exit code ${evidence.exitCode ?? 'unknown'}.`, evidenceRefs: [...check.evidenceRefs, 'command://pnpm--filter-@helm/desktop-test:electron'], details: { ...check.details, smoke: evidence } }
  } catch (error) {
    const evidence = errorEvidence(error)
    return { ...base, status: evidence.timedOut ? 'unknown' : 'failed', reason: evidence.timedOut ? 'Electron packaged smoke timed out; outcome is unknown.' : 'Electron packaged smoke could not be executed.', evidenceRefs: [...check.evidenceRefs, 'command://pnpm--filter-@helm/desktop-test:electron'], details: { ...check.details, smoke: evidence } }
  }
}

async function runElectronSmoke(): Promise<SmokeEvidence> {
  const startedAt = Date.now()
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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

function errorEvidence(error: unknown): SmokeEvidence {
  const cause = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }
  return evidence('pnpm --filter @helm/desktop test:electron', 0, cause.stdout ?? '', cause.stderr ?? '', typeof cause.code === 'number' ? cause.code : undefined, cause.killed === true || cause.signal === 'SIGTERM')
}

function evidence(command: string, durationMs: number, stdout: string, stderr: string, exitCode?: number, timedOut = false): SmokeEvidence {
  const boundedStdout = Buffer.from(stdout).subarray(0, MAX_OUTPUT_BYTES)
  const boundedStderr = Buffer.from(stderr).subarray(0, MAX_OUTPUT_BYTES)
  return { command, exitCode, durationMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutHash: hash(boundedStdout), stderrHash: hash(boundedStderr), ...(timedOut ? { timedOut: true } : {}) }
}

function hash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
