/** PORT: context/condenser/llm_summarizing_condenser.py at the shared manifest pin. */
import { condensationSchema, type Condensation, type LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient, LLMCompletionResponse } from '../llm/client.js';
import { messageSchema, textContent } from '../llm/index.js';
import { CondenserCompletionCallbackError, NoCondensationAvailableError, RollingCondenser, type CondenserContext, type CondensationRequirement } from './condenser.js';
import { getSuffixLengthForTokenReduction, getTotalTokenCount } from './condenser-utils.js';
import { renderCondenserEvent, renderSummarizingPrompt, truncateCondenserEvent } from './condenser-prompt.js';
import type { View } from './view.js';

export type CondensationReason = 'request' | 'tokens' | 'events';
export interface LLMSummarizingCondenserOptions {
  readonly llm: LLMClient;
  readonly maxSize?: number;
  readonly maxTokens?: number | null;
  readonly keepFirst?: number;
  readonly minimumProgress?: number;
  readonly hardContextResetMaxRetries?: number;
  readonly hardContextResetContextScaling?: number;
}

export class LLMSummarizingCondenser extends RollingCondenser {
  readonly llm: LLMClient;
  readonly maxSize: number;
  readonly maxTokens: number | null;
  readonly keepFirst: number;
  readonly minimumProgress: number;
  readonly hardContextResetMaxRetries: number;
  readonly hardContextResetContextScaling: number;

  constructor(options: LLMSummarizingCondenserOptions) {
    super();
    this.llm = options.llm;
    this.maxSize = options.maxSize ?? 240;
    this.maxTokens = options.maxTokens ?? null;
    this.keepFirst = options.keepFirst ?? 2;
    this.minimumProgress = options.minimumProgress ?? 0.1;
    this.hardContextResetMaxRetries = options.hardContextResetMaxRetries ?? 5;
    this.hardContextResetContextScaling = options.hardContextResetContextScaling ?? 0.8;
    if (!Number.isInteger(this.maxSize) || this.maxSize <= 0) throw new RangeError('maxSize must be a positive integer');
    if (!Number.isInteger(this.keepFirst) || this.keepFirst < 0) throw new RangeError('keepFirst must be a non-negative integer');
    if (Math.floor(this.maxSize / 2) - this.keepFirst - 1 <= 0) throw new RangeError('keepFirst must be less than maxSize // 2 to leave room for condensation');
    if (this.maxTokens !== null && !Number.isInteger(this.maxTokens)) throw new RangeError('maxTokens must be an integer or null');
    if (!(this.minimumProgress > 0 && this.minimumProgress < 1)) throw new RangeError('minimumProgress must be between zero and one');
    if (!Number.isInteger(this.hardContextResetMaxRetries) || this.hardContextResetMaxRetries <= 0) throw new RangeError('hardContextResetMaxRetries must be positive');
    if (!(this.hardContextResetContextScaling > 0 && this.hardContextResetContextScaling < 1)) throw new RangeError('hardContextResetContextScaling must be between zero and one');
  }

  handlesCondensationRequests(): boolean { return true; }

  effectiveMaxTokens(agentLlm?: LLMClient | null): number | null {
    const limits = [this.maxTokens, agentLlm?.effectiveMaxInputTokens].filter((limit): limit is number => limit !== null && limit !== undefined);
    return limits.length ? Math.min(...limits) : null;
  }

  async getCondensationReasons(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Set<CondensationReason>> {
    await agentLlm?.resolveRuntimeMetadata?.();
    const reasons = new Set<CondensationReason>();
    if (view.unhandledCondensationRequest) reasons.add('request');
    const maxTokens = this.effectiveMaxTokens(agentLlm);
    if (maxTokens !== null && agentLlm) {
      const total = await getTotalTokenCount(view.events, agentLlm, context);
      if (total !== null && total > maxTokens) reasons.add('tokens');
    }
    if (view.length > this.maxSize) reasons.add('events');
    return reasons;
  }

  override async condensationRequirement(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<CondensationRequirement | null> {
    const reasons = await this.getCondensationReasons(view, agentLlm, context);
    if (!reasons.size) return null;
    return reasons.has('tokens') || reasons.has('request') ? 'hard' : 'soft';
  }

  async getForgottenEvents(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<{ events: readonly LLMConvertibleEvent[]; summaryOffset: number }> {
    const reasons = await this.getCondensationReasons(view, agentLlm, context);
    if (reasons.size === 0) throw new Error('No condensation reasons found.');
    const tailSizes: number[] = [];
    if (reasons.has('request')) tailSizes.push(Math.floor(view.length / 2) - this.keepFirst - 1);
    if (reasons.has('events')) tailSizes.push(Math.floor(this.maxSize / 2) - this.keepFirst - 1);
    if (reasons.has('tokens') && agentLlm) {
      const maxTokens = this.effectiveMaxTokens(agentLlm), total = await getTotalTokenCount(view.events, agentLlm, context);
      if (maxTokens !== null && total !== null) {
        const tail = await getSuffixLengthForTokenReduction(view.events.slice(this.keepFirst), agentLlm,
          total - Math.floor(maxTokens / 2), view.events.slice(0, this.keepFirst), context);
        if (tail !== null) tailSizes.push(tail);
      }
    }
    if (!tailSizes.length) throw new NoCondensationAvailableError('Token count became unavailable while computing forgotten events');
    const start = view.manipulationIndices.findNext(this.keepFirst);
    const end = view.manipulationIndices.findNext(view.length - Math.min(...tailSizes));
    return { events: view.events.slice(start, end), summaryOffset: start };
  }

  override async getCondensation(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Condensation> {
    let forgotten: Awaited<ReturnType<LLMSummarizingCondenser['getForgottenEvents']>>;
    try { forgotten = await this.getForgottenEvents(view, agentLlm, context); }
    catch (error) {
      if (error instanceof RangeError) throw new NoCondensationAvailableError('Unable to compute forgotten events', { cause: error });
      throw error;
    }
    if (forgotten.events.length === 0) throw new NoCondensationAvailableError('Cannot condense 0 events. No valid range for forgetting events.');
    if (forgotten.events.length < view.length * this.minimumProgress) throw new NoCondensationAvailableError('Cannot apply condensation: events forgotten below minimum progress threshold.');
    return this.generateCondensation(forgotten.events, forgotten.summaryOffset, null, context);
  }

  async generateCondensation(events: readonly LLMConvertibleEvent[], summaryOffset: number, maxEventStringLength: number | null = null, context?: CondenserContext): Promise<Condensation> {
    if (events.length === 0) throw new Error('No events to condense.');
    // Capture membership before asynchronous completion/accounting; later arrivals were not summarized.
    const forgottenEvents = [...events];
    const projected = context?.projectEvents?.(forgottenEvents, this.llm.profile) ?? forgottenEvents;
    const prompt = renderSummarizingPrompt(projected.map(event => truncateCondenserEvent(renderCondenserEvent(event), maxEventStringLength)));
    const messages = [messageSchema.parse({ role: 'user', content: [textContent(prompt)] })];
    const startedAt = Date.now();
    let response: LLMCompletionResponse;
    try { response = await this.llm.complete(messages); }
    catch (error) {
      await this.recordCompletion(context, { llm: this.llm, error, startedAt, completedAt: Date.now() });
      throw new NoCondensationAvailableError(`Summarization LLM call failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    // This callback is deliberately outside the provider try/catch. Its failure is never billable again.
    await this.recordCompletion(context, { llm: this.llm, response, startedAt, completedAt: Date.now() });
    const first = response.message.content[0];
    return condensationSchema.parse({ forgotten_event_ids: forgottenEvents.map(event => event.id),
      summary: first?.type === 'text' ? first.text : null, summary_offset: summaryOffset, llm_response_id: response.responseId ?? null });
  }

  private async recordCompletion(context: CondenserContext | undefined, attempt: Parameters<NonNullable<CondenserContext['onCompletion']>>[0]): Promise<void> {
    try { await context?.onCompletion?.(attempt); }
    catch (error) { throw new CondenserCompletionCallbackError(error); }
  }

  override async hardContextReset(view: View, _agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Condensation | null> {
    const events = [...view.events];
    let limit: number | null = null;
    for (let attempt = 0; attempt < this.hardContextResetMaxRetries; attempt++) {
      try { return await this.generateCondensation(events, 0, limit, context); }
      catch (error) {
        if (error instanceof CondenserCompletionCallbackError) throw error;
        if (events.length === 0) throw error;
        limit ??= Math.max(...events.map(event => [...renderCondenserEvent(event)].length));
        limit = Math.trunc(limit * this.hardContextResetContextScaling);
      }
    }
    return null;
  }
}

/** The upstream standard agent/sub-agent factory is intentionally smaller than class/settings defaults. */
export function defaultCondenser(llm: LLMClient): LLMSummarizingCondenser {
  return new LLMSummarizingCondenser({ llm, maxSize: 80, keepFirst: 4 });
}
