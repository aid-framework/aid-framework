/**
 * The agent-engine seam: which backend runs an agent, and on exactly which release.
 *
 * Deep Agents is an *orchestration backend* selected per agent, never the IR, never the
 * gateway, and never the only implementation. `native` stays the default.
 *
 * **The pin.** {@link DEEPAGENTS_PIN} is the single authoritative record of the Deep
 * Agents release this runtime was built and measured against. It is a bare constant rather
 * than a range because a range is the thing pinning exists to prevent: the harness's
 * middleware stack, its recursion accounting and its interrupt payload all move between
 * releases, so an unpinned backend would change behaviour under a stored eval baseline.
 * {@link checkEngine} compares the IR's `engineVersion` against *this* constant, not
 * against whatever package happens to be importable.
 *
 * **Fail closed, in one place.** Every reason a `deepagents` agent cannot run -- unknown
 * engine, transfer declared, mismatched pin, missing extra -- is raised from
 * {@link checkEngine}. Putting them together means there is one function to read to know
 * whether an engine is supported, and no second path that could grow a silent fallback to
 * the native loop. A runtime that quietly ran a `deepagents` agent on the native engine
 * would leave `engine` in the IR meaning nothing at all.
 *
 * **The TypeScript runtime ships no Deep Agents backend.** This port keeps the seam, the
 * pin and all four refusals, because they are what the conformance corpus measures; it
 * deliberately does not port the harness itself, so every `deepagents` agent that survives
 * the pin check fails here with {@link DeepAgentsUnavailableError}. That is a capability
 * deviation from the Python runtime and is recorded as such rather than papered over with a
 * native fallback.
 */

import {
  AgentHandoffUnsupportedError,
  ConfigurationError,
  DeepAgentsUnavailableError,
  DeepAgentsVersionMismatchError,
} from '../errors.js';
import { repr } from '../internal/json.js';
import type { AgentDefinition } from './ir.js';

/** The default engine, and the one every agent that names none keeps using. */
export const NATIVE = 'native';

/** The Deep Agents backend. */
export const DEEPAGENTS = 'deepagents';

/** The closed set of engines the IR may name. */
export const ENGINES: ReadonlySet<string> = new Set([NATIVE, DEEPAGENTS]);

/**
 * The one authoritative pin. Measured from PyPI and mirrored in the Python runtime's
 * `pyproject.toml` `deepagents` extra; compared against the IR's `engineVersion` at run
 * time.
 */
export const DEEPAGENTS_PIN = '0.7.32';

/** The optional extra that installs the harness. */
export const DEEPAGENTS_EXTRA = 'aid-runtime-python[deepagents]';

/** The distribution the extra installs. */
export const DEEPAGENTS_DISTRIBUTION = 'deepagents';

/**
 * The installed `deepagents` version, or `undefined` when the extra is absent.
 *
 * Always `undefined` here: this runtime has no Deep Agents backend to detect. The function
 * exists so the availability refusal is a distinct, testable branch in the same position
 * Python puts it, rather than a check this port silently dropped.
 */
export function installedDeepagentsVersion(): string | undefined {
  return undefined;
}

/**
 * Validate this agent's engine, or raise the reason it cannot run.
 *
 * Returns the validated engine name. `native` always passes; `deepagents` passes only when
 * it declares no handoffs, pins `engineVersion` to the version this runtime is built for,
 * and the extra is actually installed.
 */
export function checkEngine(agent: AgentDefinition): string {
  if (agent.engine === NATIVE) return NATIVE;
  if (agent.engine !== DEEPAGENTS) {
    throw new ConfigurationError(
      `agent ${repr(agent.id)} declares engine ${repr(agent.engine)}; the IR admits ` +
        `[${[...ENGINES]
          .sort()
          .map((engine) => repr(engine))
          .join(', ')}]`,
    );
  }
  if (agent.handoffs.length > 0) {
    throw new AgentHandoffUnsupportedError(agent.id, agent.handoffs, DEEPAGENTS);
  }
  if (agent.engineVersion !== DEEPAGENTS_PIN) {
    throw new DeepAgentsVersionMismatchError(agent.id, agent.engineVersion, DEEPAGENTS_PIN);
  }
  if (installedDeepagentsVersion() === undefined) {
    throw new DeepAgentsUnavailableError(DEEPAGENTS_EXTRA, DEEPAGENTS_DISTRIBUTION);
  }
  return DEEPAGENTS;
}
