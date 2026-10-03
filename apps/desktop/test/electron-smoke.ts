import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function assertBuildExists(): Promise<void> {
  for (const relativePath of ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs']) {
    try {
      await access(join(desktopRoot, relativePath))
    } catch {
      throw new Error(`Electron smoke requires built desktop artifacts; missing ${relativePath}. Run pnpm build first.`)
    }
  }
}

async function waitForText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
}

async function launchDesktop(): Promise<ElectronApplication> {
  await assertBuildExists()
  const environment = { ...process.env, NODE_ENV: 'production' }
  delete environment.HELM_DEV_SERVER_URL
  return electron.launch({
    executablePath: require('electron') as string,
    args: [desktopRoot],
    env: environment,
    timeout: 20_000,
  })
}

test('production Electron Main/preload/Renderer completes two real UI Runs', async () => {
  let electronApp: ElectronApplication | undefined
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  try {
    electronApp = await launchDesktop()
    const page = await electronApp.firstWindow()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForSelector('textarea[placeholder="Message Helm…"]', { state: 'visible', timeout: 10_000 })

    const bridge = await page.evaluate(() => ({
      helmKeys: Object.keys(window.helm ?? {}).sort(),
      processType: typeof (globalThis as { process?: unknown }).process,
      requireType: typeof (globalThis as { require?: unknown }).require,
    }))
    assert.deepEqual(bridge.helmKeys, ['controlRun', 'exportRun', 'getRunSnapshot', 'resolveApproval', 'runtimeInfo', 'startRun', 'subscribe'])
    assert.equal(bridge.processType, 'undefined', 'Renderer must not receive Node process')
    assert.equal(bridge.requireType, 'undefined', 'Renderer must not receive CommonJS require')

    const preferences = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const webPreferences = window.webContents.getLastWebPreferences()
      return {
        contextIsolation: webPreferences.contextIsolation,
        nodeIntegration: webPreferences.nodeIntegration,
        sandbox: webPreferences.sandbox,
      }
    })
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.sandbox, true)

    await page.evaluate(() => {
      const events: unknown[] = []
      ;(window as Window & { __helmSmokeEvents?: unknown[] }).__helmSmokeEvents = events
      window.helm?.subscribe((event) => events.push(event))
    })

    const composer = page.locator('textarea[placeholder="Message Helm…"]')
    const send = page.locator('button[aria-label="Send message"]')
    const runIds: string[] = []
    const goals = ['electron smoke first task', 'electron smoke second task']
    const renderedGoals: string[] = []

    for (const goal of goals) {
      await composer.fill(goal)
      await send.click()
      await waitForText(page, `Completed local task: ${goal}`)
      await waitForText(page, 'passed')
      await waitForText(page, 'completed')
      const runId = await page.locator('.run-id').innerText()
      assert.match(runId, /^run-/)
      runIds.push(runId)
      const renderedState = await page.locator('body').innerText()
      assert.match(renderedState, new RegExp(goal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(renderedState, /Task task-/)
      assert.match(renderedState, /Session /)
      renderedGoals.push(goal)
    }

    assert.equal(new Set(runIds).size, goals.length, 'each submitted goal must have its own Run')
    assert.deepEqual(renderedGoals, goals)

    const smokeEvents = await page.evaluate(() => (
      (window as Window & { __helmSmokeEvents?: unknown[] }).__helmSmokeEvents ?? []
    )) as Array<{ runId?: unknown; sequence?: unknown }>
    assert.ok(smokeEvents.length >= 18, `expected events from both Runs, got ${smokeEvents.length}`)
    assert.ok(smokeEvents.every((event) => typeof event.runId === 'string' && event.runId.length > 0))
    assert.ok(smokeEvents.every((event) => typeof event.sequence === 'number'))
    for (let index = 1; index < smokeEvents.length; index += 1) {
      assert.ok((smokeEvents[index - 1].sequence as number) < (smokeEvents[index].sequence as number), 'forwarded event sequence must be monotonic')
    }
    assert.deepEqual(new Set(smokeEvents.map((event) => event.runId)), new Set(runIds))
    assert.deepEqual(consoleErrors, [], `Renderer console errors: ${consoleErrors.join('; ')}`)
    assert.deepEqual(pageErrors, [], `Renderer page errors: ${pageErrors.join('; ')}`)
  } finally {
    await electronApp?.close()
  }
})
