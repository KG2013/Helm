import type {
  Provider,
  ProviderCapabilities,
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
}

export class ProviderHttpError extends Error {
  readonly status: number
  readonly responseBody: string

  constructor(status: number, responseBody: string) {
    super(`Provider request failed with HTTP ${status}`)
    this.name = 'ProviderHttpError'
    this.status = status
    this.responseBody = responseBody
  }
}

const defaultCapabilities: ProviderCapabilities = {
  streaming: false,
  toolCalls: true,
  structuredOutput: false,
  vision: false,
  reasoning: false,
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

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id
    this.model = options.model
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.getApiKey = options.getApiKey
    this.capabilities = { ...defaultCapabilities, ...options.capabilities }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = this.getApiKey ? await this.getApiKey() : this.apiKey
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'user', content: buildPrompt(request) },
        ],
      }),
    })
    const responseBody = await response.text()
    if (!response.ok) throw new ProviderHttpError(response.status, responseBody)

    const payload = JSON.parse(responseBody) as OpenAIChatResponse
    const choice = payload.choices?.[0]
    if (!choice) throw new Error('Provider response did not contain choices[0]')
    const usage = payload.usage
      ? {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        }
      : undefined
    const toolCall = choice.message?.tool_calls?.[0]
    if (toolCall) {
      return {
        kind: 'tool_call',
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments),
        provider: this.id,
        model: this.model,
        usage,
      }
    }
    return {
      kind: 'final',
      content: extractContent(choice.message?.content),
      provider: this.id,
      model: this.model,
      usage,
    }
  }
}

function buildPrompt(request: ProviderRequest): string {
  const input = typeof request.task.input === 'string' ? `\nUser input:\n${request.task.input}` : ''
  return `Helm local task:\n${request.task.goal}${input}\n\nRun step: ${request.stepId}`
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
