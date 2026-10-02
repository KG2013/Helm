import type {
  Provider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
} from './types.js';

export type MockResponseFactory = (request: ProviderRequest) => ProviderResponse | undefined;

export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly model = 'mock-model';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolCalls: true,
    structuredOutput: true,
    vision: false,
    reasoning: false,
  };
  readonly requests: ProviderRequest[] = [];
  private readonly queue: ProviderResponse[];
  private readonly responseFactory?: MockResponseFactory;

  constructor(responses: ProviderResponse[] = [], responseFactory?: MockResponseFactory) {
    this.queue = [...responses];
    this.responseFactory = responseFactory;
  }

  enqueue(...responses: ProviderResponse[]): void {
    this.queue.push(...responses);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return this.queue.shift() ?? this.responseFactory?.(request) ?? { kind: 'final', content: `Completed local task: ${request.task.goal}` };
  }
}
