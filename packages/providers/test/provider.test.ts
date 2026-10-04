import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleProvider, ProviderHttpError, ProviderRequestError, createProviderFromEnv, providerConfigFromEnv } from '../src/index.js'
import type { ProviderRequest } from '@helm/runtime'

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    task: { id: 'task-1', goal: 'inspect', workspaceId: 'workspace', createdAt: 'now', budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    session: { id: 'session-1', taskId: 'task-1', createdAt: 'now', status: 'active' },
    run: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'deciding', createdAt: 'now', updatedAt: 'now', steps: 0, reviewerRounds: 0, budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    context: [],
    messages: [
      { role: 'system', content: 'You are a bounded local assistant.' },
      { role: 'user', content: 'Inspect the workspace.' },
      { role: 'tool', toolCallId: 'tool-1', content: '{"ok":true}' },
    ],
    tools: [{ id: 'workspace.inspect', version: 'v1', name: 'workspace.inspect', description: 'Inspect metadata', inputSchema: { type: 'object' }, readOnly: true, scope: 'workspace' }],
    toolResults: [{ toolCallId: 'tool-1', name: 'workspace.inspect', ok: true, output: { kind: 'directory' } }],
    ...overrides,
  }
}

test('provider catalog resolves DeepSeek, Zhipu, and Kimi without exposing credentials', () => {
  for (const [id, expected] of [['deepseek', 'deepseek-chat'], ['zhipu', 'glm-4-flash'], ['kimi', 'kimi-for-coding']] as const) {
    const config = providerConfigFromEnv({ HELM_PROVIDER: id })
    assert.equal(config?.entry.id, id)
    assert.equal(config?.model, expected)
    assert.equal(config?.keychainService.includes('provider.'), true)
  }
  assert.equal(providerConfigFromEnv({ HELM_PROVIDER: 'deepseek' })?.entry.streaming, true)
  assert.equal(providerConfigFromEnv({ HELM_PROVIDER: 'zhipu' })?.entry.streaming, true)
  assert.equal(providerConfigFromEnv({ HELM_PROVIDER: 'kimi' })?.entry.streaming, false)
  assert.equal(providerConfigFromEnv({ HELM_PROVIDER: 'unknown' }), undefined)
  const provider = createProviderFromEnv({ env: { HELM_PROVIDER: 'deepseek' }, getApiKey: () => 'secret-value' })
  assert.equal(provider?.id, 'deepseek')
  assert.equal(provider?.model, 'deepseek-chat')
  assert.equal(provider?.capabilities.streaming, true)
})

test('Keychain-backed providers fail closed with a bounded credential diagnostic', async () => {
  const provider = createProviderFromEnv({ env: { HELM_PROVIDER: 'zhipu' }, getApiKey: () => undefined, fetchImpl: async () => { throw new Error('network must not be called') } })
  await assert.rejects(() => provider!.complete(request()), (error: unknown) => {
    if (!(error instanceof ProviderRequestError)) return false
    assert.equal(error.failure.code, 'auth')
    assert.equal(error.failure.retryable, false)
    assert.match(error.message, /credentials.*unavailable/i)
    assert.doesNotMatch(error.message, /secret|authorization|token/i)
    return true
  })
})

test('OpenAI-compatible provider maps final response, structured context, usage, cost and IDs', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const provider = new OpenAICompatibleProvider({
    id: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://provider.example/v1/', apiKey: 'test-key', inputCostUsdPer1k: 1, outputCostUsdPer1k: 2,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200 })
    },
  })
  const response = await provider.complete(request())
  assert.equal(response.kind, 'final')
  assert.equal(response.content, 'done')
  assert.equal(response.provider, 'deepseek')
  assert.equal(response.requestId, 'request-1')
  assert.equal(response.usage?.inputTokens, 2)
  assert.equal(response.usage?.outputTokens, 3)
  assert.equal(response.usage?.costUsd, 0.008)
  assert.equal(requests[0]?.url, 'https://provider.example/v1/chat/completions')
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, 'Bearer test-key')
  const body = JSON.parse(String(requests[0]?.init?.body)) as { messages: Array<Record<string, unknown>>; tools: unknown[] }
  assert.equal(body.tools.length, 1)
  assert.equal(body.messages.filter((message) => message.role === 'tool').length, 1)
  assert.equal(body.messages.some((message) => String(message.content).includes('private')), false)
})

test('DeepSeek, Zhipu and Kimi share the provider-neutral tool contract', async () => {
  for (const id of ['deepseek', 'zhipu', 'kimi'] as const) {
    let body: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      id, model: `${id}-model`, baseUrl: 'https://provider.example',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'workspace.inspect', arguments: '{"path":"README.md"}' } }] } }] }), { status: 200 })
      },
    })
    const response = await provider.complete(request())
    assert.equal(response.kind, 'tool_call')
    assert.equal(response.name, 'workspace.inspect')
    assert.equal(provider.capabilities.context, true)
    assert.equal(provider.capabilities.toolResults, true)
    assert.equal(provider.capabilities.cancellation, true)
    assert.equal((body?.tools as unknown[]).length, 1)
  }
})

test('provider maps tool calls and classifies HTTP errors without exposing response text', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'kimi', model: 'moonshot', baseUrl: 'https://provider.example',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] }), { status: 200 }),
  })
  const response = await provider.complete(request({ messages: undefined, tools: undefined, toolResults: undefined }))
  assert.equal(response.kind, 'tool_call')
  assert.deepEqual(response.arguments, { path: 'README.md' })
  const failing = new OpenAICompatibleProvider({ id: 'zhipu', model: 'glm', baseUrl: 'https://provider.example', fetchImpl: async () => new Response('Authorization: Bearer secret', { status: 502, headers: { 'retry-after': '3' } }) })
  await assert.rejects(() => failing.complete(request()), (error: unknown) => {
    if (!(error instanceof ProviderHttpError)) return false
    assert.equal(error.status, 502)
    assert.equal(error.failure.code, 'unavailable')
    assert.equal(error.failure.retryable, true)
    assert.equal(error.failure.retryAfterMs, 3000)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

test('provider propagates cancellation and timeout through the transport contract', async () => {
  const pending = new OpenAICompatibleProvider({
    id: 'kimi', model: 'moonshot', baseUrl: 'https://provider.example',
    fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })
  const controller = new AbortController()
  const cancelled = pending.complete(request({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) => error instanceof ProviderRequestError && error.failure.code === 'aborted')
  await assert.rejects(pending.complete(request({ timeoutMs: 1 })), (error: unknown) => error instanceof ProviderRequestError && error.failure.code === 'timeout')
})

test('an already-aborted signal prevents dispatch', async () => {
  let fetchCalls = 0
  const provider = new OpenAICompatibleProvider({
    id: 'kimi', model: 'moonshot', baseUrl: 'https://provider.example',
    fetchImpl: async () => { fetchCalls += 1; return new Response('{}', { status: 200 }) },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.complete(request({ signal: controller.signal })), (error: unknown) => error instanceof ProviderRequestError && error.failure.code === 'aborted')
  assert.equal(fetchCalls, 0)
})

test('stream contract exposes normalized chunks even when the adapter uses unary transport', async () => {
  const provider = new OpenAICompatibleProvider({ id: 'deepseek', model: 'model', baseUrl: 'https://provider.example', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 1 } }), { status: 200 }) })
  const chunks = []
  for await (const chunk of provider.stream!(request())) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.kind), ['text_delta', 'usage', 'done'])
})

test('streaming capability parses OpenAI SSE chunks and preserves tool deltas', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'kimi', model: 'model', baseUrl: 'https://provider.example', capabilities: { streaming: true },
    fetchImpl: async () => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"id":"tool-1","function":{"name":"workspace.inspect","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]'))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const chunks = []
  for await (const chunk of provider.stream!(request())) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.kind), ['text_delta', 'tool_call_delta', 'done'])
  assert.equal(chunks[1]?.kind === 'tool_call_delta' ? chunks[1].name : undefined, 'workspace.inspect')
})
