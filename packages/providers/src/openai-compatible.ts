import type {
  Provider,
  ProviderCapabilities,
  ProviderFailure,
  ProviderChunk,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
} from '@helm/runtime'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OpenAICompatibleProviderOptions {
  id: string
  model: string
  baseUrl: string
  apiKey?: string
  getApiKey?: () => Promise<string | undefined> | string | undefined
  capabilities?: Partial<ProviderCapabilities>
  fetchImpl?: FetchLike
  inputCostUsdPer1k?: number
  outputCostUsdPer1k?: number
}

export class ProviderHttpError extends Error {
  readonly status: number
  readonly responseBody: string
  readonly failure: ProviderFailure

  constructor(status: number, responseBody: string, requestId?: string, retryAfterMs?: number) {
    super(`Provider request failed with HTTP ${status}`)
    this.name = 'ProviderHttpError'
    this.status = status
    this.responseBody = redactProviderText(responseBody).slice(0, 2_000)
    this.failure = classifyHttpFailure(status, requestId, retryAfterMs)
  }
}

export class ProviderRequestError extends Error {
  readonly failure: ProviderFailure

  constructor(failure: ProviderFailure) {
    super(failure.message)
    this.name = 'ProviderRequestError'
    this.failure = failure
  }
}

const defaultCapabilities: ProviderCapabilities = {
  streaming: false,
  toolCalls: true,
  structuredOutput: false,
  vision: false,
  reasoning: false,
  context: true,
  toolResults: true,
  cancellation: true,
  timeout: true,
  cost: true,
}

/**
 * Minimal non-streaming adapter for OpenAI-compatible chat endpoints. It keeps
 * vendor-specific HTTP details outside Runtime; credentials can be resolved
 * lazily from Keychain by getApiKey in the desktop/CLI composition layer.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string
  readonly model: string
  readonly capabilities: ProviderCapabilities
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly getApiKey?: OpenAICompatibleProviderOptions['getApiKey']
  private readonly fetchImpl: FetchLike
  private readonly inputCostUsdPer1k?: number
  private readonly outputCostUsdPer1k?: number

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id
    this.model = options.model
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.getApiKey = options.getApiKey
    this.capabilities = { ...defaultCapabilities, ...options.capabilities }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.inputCostUsdPer1k = options.inputCostUsdPer1k
    this.outputCostUsdPer1k = options.outputCostUsdPer1k
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    const apiKey = this.getApiKey ? await this.getApiKey() : this.apiKey
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    headers['x-request-id'] = requestId
    const transport = makeTransportSignal(request.signal, request.timeoutMs)
    try {
      throwIfAborted(transport.signal, requestId, transport.timedOut())
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: transport.signal,
        body: JSON.stringify(buildRequestBody(request, false, this.model)),
      })
      const responseBody = await response.text()
      if (!response.ok) throw new ProviderHttpError(response.status, responseBody, requestId, parseRetryAfter(response.headers.get('retry-after')))

      let payload: OpenAIChatResponse
      try {
        payload = JSON.parse(responseBody) as OpenAIChatResponse
      } catch {
        throw new ProviderRequestError({ code: 'transport', message: 'Provider returned invalid JSON.', retryable: false, requestId })
      }
      const choice = payload.choices?.[0]
      if (!choice) throw new ProviderRequestError({ code: 'empty_response', message: 'Provider response did not contain a choice.', retryable: false, requestId })
      const usage = payload.usage
        ? withCost({
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
            latencyMs: Date.now() - startedAt,
            requestId,
          }, this.inputCostUsdPer1k, this.outputCostUsdPer1k)
        : { latencyMs: Date.now() - startedAt, requestId }
      const toolCall = choice.message?.tool_calls?.[0]
      if (toolCall) {
        return {
          kind: 'tool_call',
          name: toolCall.function.name,
          arguments: parseToolArguments(toolCall.function.arguments),
          provider: this.id,
          model: this.model,
          usage,
          ...responseMetadata(request, requestId),
        }
      }
      return {
        kind: 'final',
        content: extractContent(choice.message?.content),
        provider: this.id,
        model: this.model,
        usage,
        ...responseMetadata(request, requestId),
      }
    } catch (error) {
      if (error instanceof ProviderHttpError || error instanceof ProviderRequestError) throw error
      const timedOut = transport.timedOut()
      if (timedOut || request.signal?.aborted) {
        throw new ProviderRequestError({ code: timedOut ? 'timeout' : 'aborted', message: timedOut ? 'Provider request timed out.' : 'Provider request was aborted.', retryable: true, requestId })
      }
      throw new ProviderRequestError({ code: 'transport', message: 'Provider transport failed.', retryable: true, requestId })
    } finally {
      transport.dispose()
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!this.capabilities.streaming) {
      const response = await this.complete(request)
      if (response.kind === 'final') yield { kind: 'text_delta', content: response.content }
      if (response.kind === 'tool_call') yield { kind: 'tool_call_delta', id: response.requestId ?? request.requestId ?? 'tool-call', name: response.name, argumentsDelta: JSON.stringify(response.arguments) }
      if (response.usage) yield { kind: 'usage', usage: response.usage }
      yield { kind: 'done', finishReason: response.kind }
      return
    }
    const requestId = request.requestId ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const apiKey = this.getApiKey ? await this.getApiKey() : this.apiKey
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const transport = makeTransportSignal(request.signal, request.timeoutMs)
    try {
      throwIfAborted(transport.signal, requestId, transport.timedOut())
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, signal: transport.signal, body: JSON.stringify(buildRequestBody(request, true, this.model)) })
      if (!response.ok) throw new ProviderHttpError(response.status, await response.text(), requestId, parseRetryAfter(response.headers.get('retry-after')))
      if (!response.body) throw new ProviderRequestError({ code: 'empty_response', message: 'Provider stream did not contain a body.', retryable: false, requestId })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const part = await reader.read()
        buffer += decoder.decode(part.value, { stream: !part.done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : ''
          if (!data) continue
          if (data === '[DONE]') { yield { kind: 'done', finishReason: 'stop' }; return }
          let chunk: OpenAIStreamChunk
          try { chunk = JSON.parse(data) as OpenAIStreamChunk } catch { continue }
          const delta = chunk.choices?.[0]?.delta
          if (delta?.content) yield { kind: 'text_delta', content: delta.content }
          for (const toolCall of delta?.tool_calls ?? []) yield { kind: 'tool_call_delta', id: toolCall.id ?? requestId, name: toolCall.function?.name, argumentsDelta: toolCall.function?.arguments }
          if (chunk.usage) yield { kind: 'usage', usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens, requestId } }
        }
        if (part.done) break
      }
      yield { kind: 'done', finishReason: 'stop' }
    } catch (error) {
      if (error instanceof ProviderHttpError || error instanceof ProviderRequestError) throw error
      const timedOut = transport.timedOut()
      throw new ProviderRequestError({ code: timedOut ? 'timeout' : request.signal?.aborted ? 'aborted' : 'transport', message: timedOut ? 'Provider request timed out.' : request.signal?.aborted ? 'Provider request was aborted.' : 'Provider stream failed.', retryable: true, requestId })
    } finally {
      transport.dispose()
    }
  }
}

function buildRequestBody(request: ProviderRequest, stream: boolean, model: string): Record<string, unknown> {
  return {
    model,
    stream,
    messages: buildMessages(request),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
  }
}

function buildMessages(request: ProviderRequest): Array<Record<string, unknown>> {
  const messages: ProviderMessage[] = request.messages?.length
    ? request.messages
    : [{ role: 'user', content: buildPrompt(request) }]
  const result = messages.map((message) => ({ role: message.role, content: redactProviderText(message.content).slice(0, 12_000), ...(message.name ? { name: message.name } : {}), ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}) }))
  const existingToolResults = new Set(result.filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string').map((message) => String(message.tool_call_id)))
  for (const toolResult of request.toolResults ?? []) {
    if (existingToolResults.has(toolResult.toolCallId)) continue
    result.push({ role: 'tool', tool_call_id: toolResult.toolCallId, content: JSON.stringify({ ok: toolResult.ok, output: redactProviderValue(toolResult.output), error: typeof toolResult.error === 'string' ? redactProviderText(toolResult.error).slice(0, 500) : undefined, receipt: redactProviderValue(toolResult.receipt) }) })
  }
  return result
}

function buildPrompt(request: ProviderRequest): string {
  const input = typeof request.task.input === 'string' ? `\nUser input:\n${redactProviderText(request.task.input).slice(0, 8_000)}` : ''
  const envelope = request.contextEnvelope
    ? `\nContext:\n${redactProviderText(JSON.stringify({ items: request.contextEnvelope.items, gaps: request.contextEnvelope.gaps, truncated: request.contextEnvelope.truncated })).slice(0, 12_000)}`
    : ''
  return `Helm local task:\n${redactProviderText(request.task.goal).slice(0, 8_000)}${input}${envelope}\n\nRun step: ${request.stepId}`
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part ? String(part.text) : '')
      .join('')
  }
  return content == null ? '' : String(content)
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown
      tool_calls?: Array<{ function: { name: string; arguments: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function classifyHttpFailure(status: number, requestId?: string, retryAfterMs?: number): ProviderFailure {
  if (status === 401 || status === 403) return { code: 'auth', message: 'Provider authentication failed.', retryable: false, status, requestId }
  if (status === 413) return { code: 'context_window', message: 'Provider context window was exceeded.', retryable: false, status, requestId }
  if (status === 429) return { code: 'rate_limit', message: 'Provider rate limit reached.', retryable: true, status, retryAfterMs, requestId }
  if (status >= 500) return { code: 'unavailable', message: 'Provider is temporarily unavailable.', retryable: true, status, retryAfterMs, requestId }
  if (status === 408 || status === 409) return { code: 'transport', message: 'Provider request can be retried.', retryable: true, status, requestId }
  if (status >= 400) return { code: 'invalid_request', message: 'Provider rejected the request.', retryable: false, status, requestId }
  return { code: 'unknown', message: 'Provider request failed.', retryable: false, status, requestId }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined
}

function withCost(usage: import('@helm/runtime').TokenUsage, inputRate?: number, outputRate?: number): import('@helm/runtime').TokenUsage {
  if (usage.costUsd !== undefined || (inputRate === undefined && outputRate === undefined)) return usage
  const input = (usage.inputTokens ?? 0) / 1000 * (inputRate ?? 0)
  const output = (usage.outputTokens ?? 0) / 1000 * (outputRate ?? 0)
  return { ...usage, costUsd: input + output }
}

function responseMetadata(request: ProviderRequest, requestId: string): { requestId: string; attemptId?: string; traceId?: string } {
  return {
    requestId,
    ...(request.attemptId ? { attemptId: request.attemptId } : {}),
    ...(request.traceId ? { traceId: request.traceId } : {}),
  }
}

function makeTransportSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) : undefined
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function throwIfAborted(signal: AbortSignal, requestId: string, timedOut: boolean): void {
  if (!signal.aborted) return
  throw new ProviderRequestError({ code: timedOut ? 'timeout' : 'aborted', message: timedOut ? 'Provider request timed out.' : 'Provider request was aborted.', retryable: true, requestId })
}

function redactProviderText(value: string): string {
  return value
    .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\/(?:Users|private|tmp)\/[^\s]+/g, '[workspace-path]')
}

function redactProviderValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return redactProviderText(value).slice(0, 2_000)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactProviderValue(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [
    key,
    /api[-_]?key|authorization|cookie|secret|password|token|private|content|body|diff/i.test(key) ? '[redacted]' : redactProviderValue(item, depth + 1),
  ]))
}
