import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { arch, platform, versions } from 'node:process'
import { providerConfigFromEnv, type ProviderEnvironment } from '@helm/providers'
import {
  DockerSandboxError,
  PythonDocumentWorkerClient,
  type OfficeHealthSnapshot,
} from '@helm/runtime'
import { createDockerCodingSandboxFromEnv } from '@helm/runtime/tools'

export type AcceptanceStatus = 'passed' | 'failed' | 'unknown' | 'unverified'
export type AcceptanceKind = 'docker' | 'provider' | 'office' | 'electron'

export interface AcceptanceCheck {
  id: string
  kind: AcceptanceKind
  mode: 'preflight'
  status: AcceptanceStatus
  reason: string
  evidenceRefs: string[]
  limitations: string[]
  collectedAt: string
  environmentFingerprint: string
  details: Record<string, unknown>
}

export interface AcceptanceReport {
  schemaVersion: 'helm.acceptance/v1'
  collectedAt: string
  environment: {
    platform: string
    arch: string
    node: string
    workspaceName: string
    commit: string
    fingerprint: string
  }
  checks: AcceptanceCheck[]
  releaseGate: {
    result: 'passed' | 'blocked'
    eligible: boolean
    reasons: string[]
  }
}

interface DockerProbe {
  describe(): Record<string, unknown>
  preflight(): Promise<{ image: string; securityOptions: string[] }>
}

export interface AcceptanceProbeOptions {
  env?: ProviderEnvironment & Record<string, string | undefined>
  cwd?: string
  now?: () => string
  commit?: string
  dockerFactory?: (env: Record<string, string | undefined>, root: string) => DockerProbe | undefined
  officeHealth?: () => Promise<OfficeHealthSnapshot>
  desktopRoot?: string
  fileProbe?: (path: string) => { exists: boolean; bytes: number }
  electronAvailable?: boolean
}

const DIGEST_IMAGE = /@sha256:[a-f0-9]{64}$/i
const MAX_REASON = 240
const MAX_LIST = 8

export async function collectAcceptanceReport(options: AcceptanceProbeOptions = {}): Promise<AcceptanceReport> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = env.HELM_WORKSPACE_ROOT ?? cwd
  const collectedAt = options.now?.() ?? new Date().toISOString()
  const environment = buildEnvironment(options, workspaceRoot)
  const checks = await Promise.all([
    collectDockerCheck({ env, workspaceRoot, collectedAt, fingerprint: environment.fingerprint, dockerFactory: options.dockerFactory }),
    collectProviderCheck({ env, collectedAt, fingerprint: environment.fingerprint }),
    collectOfficeCheck({ env, workspaceRoot, collectedAt, fingerprint: environment.fingerprint, officeHealth: options.officeHealth }),
    collectElectronCheck({ env, collectedAt, fingerprint: environment.fingerprint, desktopRoot: options.desktopRoot, fileProbe: options.fileProbe, electronAvailable: options.electronAvailable }),
  ])
  const blocked = checks.filter((check) => check.status !== 'passed')
  return {
    schemaVersion: 'helm.acceptance/v1',
    collectedAt,
    environment,
    checks,
    releaseGate: {
      result: blocked.length ? 'blocked' : 'passed',
      eligible: blocked.length === 0,
      reasons: blocked.map((check) => `${check.id}: ${check.reason}`).slice(0, MAX_LIST),
    },
  }
}

export function printAcceptanceSummary(report: AcceptanceReport): void {
  console.log(`Helm acceptance preflight: ${report.releaseGate.result}`)
  for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(11)} ${check.id}: ${check.reason}`)
  console.log(`environment fingerprint: ${report.environment.fingerprint}`)
  if (report.releaseGate.reasons.length) console.log(`release gate: ${report.releaseGate.reasons.join(' | ')}`)
}

async function collectDockerCheck(input: {
  env: Record<string, string | undefined>
  workspaceRoot: string
  collectedAt: string
  fingerprint: string
  dockerFactory?: AcceptanceProbeOptions['dockerFactory']
}): Promise<AcceptanceCheck> {
  const id = 'docker.preflight'
  const mode = input.env.HELM_CODING_SANDBOX?.toLowerCase()
  const image = input.env.HELM_CODING_SANDBOX_IMAGE?.trim()
  if (mode !== 'docker') return check({ id, kind: 'docker', status: 'unverified', reason: 'Docker real smoke is not enabled; set HELM_CODING_SANDBOX=docker for target validation.', evidenceRefs: ['env://HELM_CODING_SANDBOX'], limitations: ['No Docker daemon or coding task was invoked.'], details: { configured: false }, ...input })
  if (!image) return check({ id, kind: 'docker', status: 'failed', reason: 'HELM_CODING_SANDBOX_IMAGE is missing; a fixed digest image is required.', evidenceRefs: ['env://HELM_CODING_SANDBOX_IMAGE'], limitations: ['No Docker operation was attempted.'], details: { configured: true, imageDigestPinned: false }, ...input })
  if (!DIGEST_IMAGE.test(image)) return check({ id, kind: 'docker', status: 'failed', reason: 'Docker image must use an immutable @sha256 digest reference.', evidenceRefs: ['env://HELM_CODING_SANDBOX_IMAGE'], limitations: ['Tag-based images are rejected before daemon access.'], details: { configured: true, imageDigestPinned: false }, ...input })

  const factory = input.dockerFactory ?? createDockerCodingSandboxFromEnv
  let sandbox: DockerProbe | undefined
  try {
    sandbox = factory(input.env, input.workspaceRoot)
  } catch (error) {
    return check({ id, kind: 'docker', status: 'failed', reason: sanitizeReason(error, 'Docker sandbox configuration failed.'), evidenceRefs: ['docker://factory'], limitations: ['No host fallback is permitted.'], details: { configured: true, imageDigestPinned: true }, ...input })
  }
  if (!sandbox) return check({ id, kind: 'docker', status: 'failed', reason: 'Docker sandbox configuration was rejected by the fail-closed factory.', evidenceRefs: ['docker://factory'], limitations: ['No host fallback is permitted.'], details: { configured: true, imageDigestPinned: true }, ...input })
  let details: Record<string, unknown>
  try {
    details = safeSandboxDetails(sandbox.describe())
  } catch (error) {
    return check({ id, kind: 'docker', status: 'failed', reason: sanitizeReason(error, 'Docker sandbox description failed.'), evidenceRefs: ['docker://describe'], limitations: ['No container task was started.'], details: {}, ...input })
  }
  try {
    const preflight = await sandbox.preflight()
    return check({ id, kind: 'docker', status: 'passed', reason: `Docker daemon and pinned image preflight passed (${preflight.securityOptions.length} security options).`, evidenceRefs: ['docker://daemon', 'docker://image-inspect'], limitations: ['Coding task smoke and verifier evidence are separate real-smoke steps.'], details: { ...details, securityOptionCount: preflight.securityOptions.length }, ...input })
  } catch (error) {
    const unavailable = error instanceof DockerSandboxError
      ? error.unavailable
      : Boolean(error && typeof error === 'object' && 'unavailable' in error && (error as { unavailable?: unknown }).unavailable === true)
    return check({ id, kind: 'docker', status: unavailable ? 'unknown' : 'failed', reason: sanitizeReason(error, unavailable ? 'Docker daemon, image, or security preflight is unavailable.' : 'Docker preflight failed.'), evidenceRefs: ['docker://preflight'], limitations: ['No container task was started.'], details, ...input })
  }
}

async function collectProviderCheck(input: { env: Record<string, string | undefined>; collectedAt: string; fingerprint: string }): Promise<AcceptanceCheck> {
  const id = 'provider.preflight'
  const provider = input.env.HELM_PROVIDER?.trim().toLowerCase()
  if (!provider) return check({ id, kind: 'provider', status: 'unverified', reason: 'No real Provider is selected; fixture/MockProvider remains the active path.', evidenceRefs: ['env://HELM_PROVIDER'], limitations: ['No Keychain lookup or network request was performed.'], details: { configured: false }, ...input })
  const config = providerConfigFromEnv(input.env)
  if (!config) return check({ id, kind: 'provider', status: 'failed', reason: `Unsupported HELM_PROVIDER value: ${sanitizeReason(provider, 'invalid provider')}.`, evidenceRefs: ['env://HELM_PROVIDER'], limitations: ['No Keychain lookup or network request was performed.'], details: { configured: true }, ...input })
  return check({ id, kind: 'provider', status: 'unverified', reason: `${config.entry.label} configuration resolved; credentials and real network smoke were not executed.`, evidenceRefs: ['env://HELM_PROVIDER', `keychain://${config.keychainService}`], limitations: ['API keys are not read or printed by this preflight.', 'Text, tool, SSE, cancellation, timeout, rate-limit, and auth smoke remain unverified.'], details: { configured: true, provider: config.entry.id, model: bound(config.model, 120), baseUrlOrigin: safeOrigin(config.baseUrl), keychainService: bound(config.keychainService, 120), credentialPresence: 'not-probed', streaming: config.entry.streaming }, ...input })
}

async function collectOfficeCheck(input: {
  env: Record<string, string | undefined>
  workspaceRoot: string
  collectedAt: string
  fingerprint: string
  officeHealth?: () => Promise<OfficeHealthSnapshot>
}): Promise<AcceptanceCheck> {
  const id = 'office.preflight'
  const health = input.officeHealth ?? (async () => {
    const scriptPath = input.env.HELM_DOCUMENT_WORKER ?? resolve(findRepoRoot(import.meta.url), 'workers/document-worker/worker.py')
    return new PythonDocumentWorkerClient({ scriptPath, workspaceRoot: input.workspaceRoot }).health()
  })
  try {
    const snapshot = await health()
    const missing = (snapshot.missing ?? []).slice(0, MAX_LIST).map((item) => bound(item, 100))
    const unknownChecks = Object.entries(snapshot.checks).filter(([, value]) => value === 'unknown').map(([name]) => name)
    const status: AcceptanceStatus = missing.length || unknownChecks.length ? 'unknown' : 'passed'
    const reason = status === 'passed' ? 'Document Worker and required Office/OCR preflight checks passed.' : `Office/OCR preflight has missing or unknown capabilities${missing.length ? `: ${missing.join(', ')}` : `: ${unknownChecks.join(', ')}`}.`
    return check({ id, kind: 'office', status, reason, evidenceRefs: ['worker://health'], limitations: (snapshot.limitations ?? []).slice(0, MAX_LIST).map((item) => bound(item, 180)), details: { worker: snapshot.worker, version: bound(snapshot.version, 80), tools: summarizeTools(snapshot.tools), python: summarizeTools(snapshot.python), missing, checks: snapshot.checks }, ...input })
  } catch (error) {
    return check({ id, kind: 'office', status: 'unknown', reason: sanitizeReason(error, 'Document Worker health preflight could not be collected.'), evidenceRefs: ['worker://health'], limitations: ['No Office/OCR task was started.'], details: {}, ...input })
  }
}

async function collectElectronCheck(input: {
  env: Record<string, string | undefined>
  collectedAt: string
  fingerprint: string
  desktopRoot?: string
  fileProbe?: (path: string) => { exists: boolean; bytes: number }
  electronAvailable?: boolean
}): Promise<AcceptanceCheck> {
  const id = 'electron.preflight'
  const root = input.desktopRoot ?? join(findRepoRoot(import.meta.url), 'apps/desktop')
  const probe = input.fileProbe ?? ((path: string) => {
    try {
      const stats = statSync(path)
      return { exists: stats.isFile(), bytes: stats.size }
    } catch {
      return { exists: false, bytes: 0 }
    }
  })
  const artifacts = ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs'].map((relativePath) => {
    try { return { relativePath, ...probe(join(root, relativePath)) } } catch { return { relativePath, exists: false, bytes: 0 } }
  })
  const missing = artifacts.filter((artifact) => !artifact.exists).map((artifact) => artifact.relativePath)
  if (missing.length) return check({ id, kind: 'electron', status: 'failed', reason: `Electron build artifacts are missing: ${missing.join(', ')}.`, evidenceRefs: ['artifact://desktop-build'], limitations: ['Run pnpm build before packaged smoke.'], details: { artifacts }, ...input })
  const electronAvailable = input.electronAvailable ?? resolveElectron(root) !== undefined
  return check({ id, kind: 'electron', status: 'unverified', reason: 'Electron build artifacts are present; packaged restart/multi-window smoke was not executed.', evidenceRefs: ['artifact://desktop-build'], limitations: [electronAvailable ? 'Real packaged smoke remains a separate step.' : 'Electron executable was not resolved in this process.'], details: { artifacts, electronExecutable: electronAvailable, smokeCommand: 'pnpm --filter @helm/desktop test:electron' }, ...input })
}

function check(input: Omit<AcceptanceCheck, 'mode' | 'environmentFingerprint' | 'collectedAt'> & { collectedAt: string; fingerprint: string }): AcceptanceCheck {
  const { id, kind, status, reason, evidenceRefs, limitations, details, collectedAt, fingerprint } = input
  return { id, kind, status, mode: 'preflight', collectedAt, environmentFingerprint: fingerprint, reason: bound(reason, MAX_REASON), evidenceRefs: evidenceRefs.slice(0, MAX_LIST).map((item) => bound(item, 180)), limitations: limitations.slice(0, MAX_LIST).map((item) => bound(item, 180)), details: boundDetails(details) }
}

function buildEnvironment(options: AcceptanceProbeOptions, workspaceRoot: string): AcceptanceReport['environment'] {
  const raw = { platform, arch, node: versions.node, workspaceName: basename(resolve(workspaceRoot)), commit: options.commit ?? process.env.GIT_COMMIT ?? 'unknown' }
  return { ...raw, fingerprint: hash(JSON.stringify(raw)) }
}

function safeSandboxDetails(details: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['backend', 'imageDigestPinned', 'network', 'user', 'readOnlyRoot', 'workspaceMount', 'memory', 'cpus', 'pidsLimit', 'outputLimitBytes', 'preflight']
  return Object.fromEntries(allowed.filter((key) => key in details).map((key) => [key, typeof details[key] === 'string' ? bound(String(details[key]), 120) : details[key]]))
}

function summarizeTools(value: Record<string, { status: string; version?: string }> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}).slice(0, MAX_LIST).map(([name, item]) => [bound(name, 80), { status: item.status, ...(item.version ? { version: bound(item.version, 80) } : {}) }]))
}

function resolveElectron(desktopRoot: string): string | undefined {
  try {
    return createRequire(join(desktopRoot, 'package.json')).resolve('electron')
  } catch {
    return undefined
  }
}

function findRepoRoot(start: string): string {
  let current = resolve(start.startsWith('file:') ? dirname(new URL(start).pathname) : start)
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    current = dirname(current)
  }
  return resolve(start)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function safeOrigin(value: string): string {
  try { return new URL(value).origin } catch { return 'invalid' }
}

function sanitizeReason(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : fallback
  return bound(message
    .replace(/(?:authorization|bearer|api[-_]?key|token|secret|cookie|password)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)[-_][a-z0-9_-]{8,}\b/gi, '[redacted]'), MAX_REASON) || fallback
}

function bound(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

function boundDetails(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, typeof item === 'string' ? bound(item, 180) : Array.isArray(item) ? item.slice(0, MAX_LIST) : item]))
}
