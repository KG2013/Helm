import test from 'node:test'
import assert from 'node:assert/strict'
import { collectAcceptanceReport } from '../src/acceptance.js'

const allArtifacts = (path: string) => ({ exists: true, bytes: path.endsWith('.html') ? 1_024 : 2_048 })
const healthyOffice = async () => ({
  worker: 'document-worker',
  version: '1.0.0',
  tools: { officeRenderer: { status: 'available' as const, version: '24' }, pdftoppm: { status: 'available' as const, version: '25' }, tesseract: { status: 'available' as const, version: '5' } },
  python: { openpyxl: { status: 'available' as const, version: '3' } },
  checks: { docxRendering: 'passed' as const, pdfOcr: 'passed' as const },
  limitations: [],
})

test('acceptance preflight keeps missing real environments blocked and bounded', async () => {
  const report = await collectAcceptanceReport({
    env: { HELM_WORKSPACE_ROOT: '/tmp/helm-acceptance', SECRET_API_KEY: 'do-not-print' },
    now: () => '2026-10-04T00:00:00.000Z',
    officeHealth: healthyOffice,
    fileProbe: allArtifacts,
    electronAvailable: true,
  })

  assert.equal(report.schemaVersion, 'helm.acceptance/v1')
  assert.equal(report.releaseGate.result, 'blocked')
  assert.equal(report.checks.find((check) => check.id === 'docker.preflight')?.status, 'unverified')
  assert.equal(report.checks.find((check) => check.id === 'provider.preflight')?.status, 'unverified')
  assert.equal(report.checks.find((check) => check.id === 'office.preflight')?.status, 'passed')
  assert.equal(report.checks.find((check) => check.id === 'electron.preflight')?.status, 'unverified')
  assert.equal(JSON.stringify(report).includes('do-not-print'), false)
  assert.equal(report.checks.some((check) => 'env' in check), false)
})

test('acceptance preflight runs Docker metadata checks without reading Provider secrets', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  let preflightCalls = 0
  const report = await collectAcceptanceReport({
    env: { HELM_WORKSPACE_ROOT: '/tmp/helm-acceptance', HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: `registry.example/helm@${digest}`, HELM_PROVIDER: 'deepseek', HELM_PROVIDER_API_KEY: 'secret-value' },
    commit: 'abc123',
    dockerFactory: () => ({
      describe: () => ({ backend: 'docker', imageDigestPinned: true, network: 'none', user: '65532:65532', readOnlyRoot: true, outputLimitBytes: 64_000 }),
      preflight: async () => { preflightCalls += 1; return { image: 'redacted', securityOptions: ['name=seccomp'] } },
    }),
    officeHealth: healthyOffice,
    fileProbe: allArtifacts,
    electronAvailable: true,
  })

  assert.equal(preflightCalls, 1)
  assert.equal(report.environment.commit, 'abc123')
  assert.equal(report.checks.find((check) => check.id === 'docker.preflight')?.status, 'passed')
  assert.equal(report.checks.find((check) => check.id === 'provider.preflight')?.status, 'unverified')
  assert.equal(report.checks.find((check) => check.id === 'provider.preflight')?.details.credentialPresence, 'not-probed')
  assert.equal(JSON.stringify(report).includes('secret-value'), false)
})

test('acceptance preflight classifies Docker daemon uncertainty separately from configuration failure', async () => {
  const digest = `sha256:${'b'.repeat(64)}`
  const report = await collectAcceptanceReport({
    env: { HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: `registry.example/helm@${digest}` },
    dockerFactory: () => ({
      describe: () => ({ backend: 'docker', imageDigestPinned: true }),
      preflight: async () => { throw Object.assign(new Error('Docker daemon unavailable'), { unavailable: true }) },
    }),
    officeHealth: healthyOffice,
    fileProbe: allArtifacts,
    electronAvailable: true,
  })

  assert.equal(report.checks.find((check) => check.id === 'docker.preflight')?.status, 'unknown')
  assert.match(report.checks.find((check) => check.id === 'docker.preflight')?.reason ?? '', /unavailable/i)
})

test('acceptance preflight rejects non-digest Docker configuration before probing', async () => {
  let called = false
  const report = await collectAcceptanceReport({
    env: { HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: 'registry.example/helm:latest' },
    dockerFactory: () => { called = true; return undefined },
    officeHealth: healthyOffice,
    fileProbe: allArtifacts,
    electronAvailable: true,
  })

  assert.equal(called, false)
  assert.equal(report.checks.find((check) => check.id === 'docker.preflight')?.status, 'failed')
  assert.match(report.checks.find((check) => check.id === 'docker.preflight')?.reason ?? '', /digest/i)
})

test('acceptance preflight redacts credential-like Docker errors', async () => {
  const digest = `sha256:${'c'.repeat(64)}`
  const report = await collectAcceptanceReport({
    env: { HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: `registry.example/helm@${digest}` },
    dockerFactory: () => ({
      describe: () => ({ backend: 'docker', imageDigestPinned: true }),
      preflight: async () => { throw new Error('password=pass cookie=session sk-test-secret-value') },
    }),
    officeHealth: healthyOffice,
    fileProbe: allArtifacts,
    electronAvailable: true,
  })

  const reason = report.checks.find((check) => check.id === 'docker.preflight')?.reason ?? ''
  assert.equal(reason.includes('pass'), false)
  assert.equal(reason.includes('session'), false)
  assert.equal(reason.includes('sk-test-secret-value'), false)
  assert.match(reason, /redacted/)
})
