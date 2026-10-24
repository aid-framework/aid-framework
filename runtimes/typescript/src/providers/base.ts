/**
 * The provider seam.
 *
 * A provider is deliberately narrow: given a request and the model it is already
 * pinned to, answer once. Everything interesting -- aliases, capability checks,
 * fallback, budgets, tracing -- lives in the gateway, so adding a provider cannot
 * change what a run costs or which model was called.
 */

import type { Capability, CompletionRequest, CompletionResponse, ModelSpec } from '../types.js';

/** One model vendor. `close` must be idempotent. */
export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse>;
  close(): Promise<void>;
}

/** Whether a provider declares a capability. */
export function supports(provider: Provider, capability: Capability): boolean {
  return provider.capabilities.has(capability);
}
