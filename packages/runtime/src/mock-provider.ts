import type {
  Provider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
} from './types.js';

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

  constructor(responses: ProviderResponse[] = []) {
    this.queue = [...responses];
  }

  enqueue(...responses: ProviderResponse[]): void {
    this.queue.push(...responses);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return this.queue.shift() ?? { kind: 'final', content: `Completed local task: ${request.task.goal}` };
  }
}
