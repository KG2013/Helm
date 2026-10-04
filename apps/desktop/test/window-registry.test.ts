import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopWindowRegistry, type WebContentsLike } from '../src/main/window-registry.js'

function sender() {
  const messages: unknown[] = []
  const value: WebContentsLike = {
    isDestroyed: () => false,
    send: (_channel, payload) => messages.push(payload),
  }
  return { value, messages }
}

const event = (runId: string, sequence: number, id = `${runId}-${sequence}`) => ({
  id,
  sequence,
  type: 'run.state_changed' as const,
  runId,
  payload: { state: 'executing' },
  timestamp: new Date(0).toISOString(),
})

test('window registry only broadcasts authorized Runs and deduplicates ordered events', () => {
  const registry = new DesktopWindowRegistry()
  const first = sender()
  const second = sender()
  registry.register(first.value)
  registry.register(second.value)
  registry.authorizeRun(first.value, 'run-a')
  registry.authorizeRun(second.value, 'run-b')

  registry.publish(event('run-a', 1))
  registry.publish(event('run-a', 2))
  registry.publish(event('run-a', 1, 'late'))
  registry.publish(event('run-a', 2, 'duplicate'))
  registry.publish(event('run-b', 1))
  registry.publish(event('run-c', 1))

  assert.deepEqual(first.messages.map((item) => (item as { sequence: number }).sequence), [1, 2])
  assert.deepEqual(second.messages.map((item) => (item as { sequence: number }).sequence), [1])
  registry.unregister(first.value)
  registry.publish(event('run-a', 3))
  assert.deepEqual(first.messages.map((item) => (item as { sequence: number }).sequence), [1, 2])
})

test('destroyed or unregistered windows never receive a replayed event', () => {
  const registry = new DesktopWindowRegistry()
  let destroyed = false
  const messages: unknown[] = []
  const value: WebContentsLike = { isDestroyed: () => destroyed, send: (_channel, payload) => messages.push(payload) }
  registry.register(value)
  registry.authorizeRun(value, 'run-a')
  destroyed = true
  registry.publish(event('run-a', 1))
  assert.deepEqual(messages, [])
})
