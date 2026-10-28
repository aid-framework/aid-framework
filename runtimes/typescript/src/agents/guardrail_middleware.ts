/**
 * Our authorization and tool-call guardrail engine, at the harness's tool boundary.
 *
 * The harness has no guardrail concept, so this is where ours wraps it. It runs before the
 * tool body -- the only point where a decision can still stop the call -- and it throws
 * rather than returning an observation, so the harness cannot hand the decision back to the
 * model as something to work around.
 *
 * One middleware instance is bound to one frame. The caller's is attached to the graph; a
 * delegate's is attached to its subagent spec and bound to the *delegate's* frame, which is
 * the same split the native loop makes by driving each frame with its own agent's
 * guardrails.
 */

import type { ToolMessage } from '@langchain/core/messages';
import type { Command } from '@langchain/langgraph';
import type { AgentMiddleware, ToolCallHandler, ToolCallRequest } from 'langchain';

import { canonicalJson } from '../internal/json.js';
import type { Principal } from '../policy.js';
import { ToolCall } from '../types.js';
import type { DeepAgentsHost } from './deep_agents.js';
import type { Frame, Outcome } from './loop.js';

/**
 * The harness's delegation tool.
 *
 * Delegation is the one harness tool this engine exposes on purpose, and only an agent that
 * declares a delegate is granted it. It carries no side effect of its own: the delegate's
 * own grant governs what it may do once it is running.
 */
export const DELEGATE_TOOL = 'task';

/**
 * A guardrail decision the harness must not be able to continue past.
 *
 * An error rather than a returned observation: a `ToolMessage` saying "blocked" would be
 * fed back to the model as a tool result, and the model would be free to try again. The
 * harness propagates an exception, so the decision ends the run -- which is what `blocked`
 * means.
 */
export class HaltError extends Error {
  readonly outcome: Outcome;

  constructor(outcome: Outcome) {
    super(`the harness was halted at the tool boundary with status ${outcome.status}`);
    this.name = 'HaltError';
    this.outcome = outcome;
  }
}

/** The harness's call shape, converted to ours. */
function asCall(raw: { id?: string; name?: string; args?: Record<string, unknown> }): ToolCall {
  return new ToolCall({
    id: raw.id ?? raw.name ?? 'tool-call',
    name: raw.name ?? '',
    arguments: raw.args ?? {},
  });
}

/** The parts of the runtime this middleware is allowed to reach. */
export interface GuardrailMiddlewareOptions {
  readonly host: DeepAgentsHost;
  readonly frame: Frame;
  readonly principal: Principal;
  readonly memoryKey: string;
}

/**
 * Build the middleware for one frame.
 *
 * The `task` branch is the delegation boundary, and it is deliberately the first thing the
 * hook does: a delegate's call is authorized and guarded by the middleware bound to the
 * *delegate's* frame, so running the caller's authorize/guardrail over it would refuse a
 * call the delegate is entitled to make and would apply the caller's redactions inside
 * another agent's grant. That is the native loop's semantic too -- `#delegate` opens a frame
 * for the target and drives it, so the target's `tool-call` stage is what runs and the
 * caller's does not cross the boundary.
 */
export function guardrailMiddleware(options: GuardrailMiddlewareOptions): AgentMiddleware {
  const { host, frame, principal, memoryKey } = options;
  return {
    name: 'aid-guardrails',
    async wrapToolCall(
      request: ToolCallRequest,
      handler: ToolCallHandler,
    ): Promise<ToolMessage | Command> {
      const call = asCall(request.toolCall);
      if (call.name === DELEGATE_TOOL) return await handler(request);

      host.authorize(frame.agent, call, principal);
      const guarded = host.guardrailToolCalls(frame, [call], memoryKey);
      if (guarded.paused !== undefined) throw new HaltError(guarded.paused);
      const rewritten = guarded.calls[0];
      if (
        rewritten !== undefined &&
        canonicalJson(rewritten.arguments) !== canonicalJson(call.arguments)
      ) {
        // A redaction rewrote the arguments; the tool must see the rewritten ones, not the
        // model's originals.
        return await handler({
          ...request,
          toolCall: { ...request.toolCall, args: rewritten.arguments },
        });
      }
      return await handler(request);
    },
  };
}
