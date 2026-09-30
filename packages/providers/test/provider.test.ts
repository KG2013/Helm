import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleProvider, ProviderHttpError } from '../src/index.js'

test('OpenAI-compatible provider maps a final response and usage', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const provider = new OpenAICompatibleProvider({
    id: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://provider.example/v1/',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200 })
    },
  })
  const response = await provider.complete({
    runId: 'run-1',
    stepId: 'step-1',
    task: { id: 'task-1', goal: 'report', workspaceId: 'workspace', createdAt: 'now', budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    session: { id: 'session-1', taskId: 'task-1', createdAt: 'now', status: 'active' },
    run: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'deciding', createdAt: 'now', updatedAt: 'now', steps: 0, reviewerRounds: 0, budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    context: [],
  })
  assert.deepEqual(response, { kind: 'final', content: 'done', provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
  assert.equal(requests[0]?.url, 'https://provider.example/v1/chat/completions')
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, 'Bearer test-key')
})

test('OpenAI-compatible provider maps a tool call and classifies HTTP errors', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'kimi',
    model: 'moonshot',
    baseUrl: 'https://provider.example',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] }), { status: 200 }),
  })
  const response = await provider.complete({
    runId: 'run-1', stepId: 'step-1',
    task: { id: 'task-1', goal: 'read', workspaceId: 'workspace', createdAt: 'now', budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    session: { id: 'session-1', taskId: 'task-1', createdAt: 'now', status: 'active' },
    run: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'deciding', createdAt: 'now', updatedAt: 'now', steps: 0, reviewerRounds: 0, budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    context: [],
  })
  assert.deepEqual(response, { kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' }, provider: 'kimi', model: 'moonshot', usage: undefined })

  const failing = new OpenAICompatibleProvider({ id: 'zhipu', model: 'glm', baseUrl: 'https://provider.example', fetchImpl: async () => new Response('bad gateway', { status: 502 }) })
  await assert.rejects(() => failing.complete({
    runId: 'run-1', stepId: 'step-1',
    task: { id: 'task-1', goal: 'read', workspaceId: 'workspace', createdAt: 'now', budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    session: { id: 'session-1', taskId: 'task-1', createdAt: 'now', status: 'active' },
    run: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'deciding', createdAt: 'now', updatedAt: 'now', steps: 0, reviewerRounds: 0, budget: { maxSteps: 1, maxDurationMs: 1000, maxReviewerRounds: 0 } },
    context: [],
  }), (error: unknown) => error instanceof ProviderHttpError && error.status === 502)
})
