import { llmCompletionResponseSchema, llmUsageSchema, type LLMClient, type LLMCompletionResponse, type LLMUsage } from '../llm/client.js';
import { llmProfileSchema, messageSchema, type LLMProfile, type Message } from '../llm/index.js';

export type TestLLMScriptedMessage = Message | Error;
export type TestLLMScriptedResponse = LLMCompletionResponse | Error;

export interface TestLLMOptions {
  readonly profile?: LLMProfile;
  readonly scriptedResponses?: readonly (TestLLMScriptedMessage | TestLLMScriptedResponse)[];
  readonly defaultUsage?: LLMUsage | null;
}

export class TestLLMExhaustedError extends Error {
  constructor(callCount: number) {
    super(`TestLLM: no more scripted responses (exhausted after ${callCount} calls)`);
    this.name = 'TestLLMExhaustedError';
  }
}

export class TestLLM implements LLMClient {
  readonly profile: LLMProfile;
  private readonly responses: (TestLLMScriptedMessage | TestLLMScriptedResponse)[];
  private readonly defaultUsage: LLMUsage | null;
  private calls = 0;

  constructor(options: TestLLMOptions = {}) {
    this.profile = options.profile ?? defaultTestProfile();
    this.responses = [...(options.scriptedResponses ?? [])];
    this.defaultUsage = options.defaultUsage === undefined ? llmUsageSchema.parse({}) : options.defaultUsage;
  }

  static fromMessages(messages: readonly TestLLMScriptedMessage[], options: Omit<TestLLMOptions, 'scriptedResponses'> = {}): TestLLM {
    return new TestLLM({ ...options, scriptedResponses: messages });
  }

  static fromResponses(responses: readonly TestLLMScriptedResponse[], options: Omit<TestLLMOptions, 'scriptedResponses'> = {}): TestLLM {
    return new TestLLM({ ...options, scriptedResponses: responses });
  }

  get callCount(): number {
    return this.calls;
  }

  get remainingResponses(): number {
    return this.responses.length;
  }

  complete(_messages: readonly Message[]): Promise<LLMCompletionResponse> {
    try {
      return Promise.resolve(this.nextResponse());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private nextResponse(): LLMCompletionResponse {
    if (this.responses.length === 0) {
      throw new TestLLMExhaustedError(this.calls);
    }

    const item = this.responses.shift();
    this.calls += 1;

    if (item instanceof Error) {
      throw item;
    }
    if (isCompletionResponse(item)) {
      return llmCompletionResponseSchema.parse(item);
    }

    const message = messageSchema.parse(item);
    return llmCompletionResponseSchema.parse({
      message,
      usage: this.defaultUsage,
      raw: {
        id: `test-response-${this.calls}`,
        model: this.profile.model,
      },
    });
  }
}

function defaultTestProfile(): LLMProfile {
  return llmProfileSchema.parse({
    profileId: 'test-llm',
    providerId: 'test',
    model: 'test-model',
  });
}

function isCompletionResponse(value: unknown): value is LLMCompletionResponse {
  return typeof value === 'object' && value !== null && 'message' in value;
}
