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
 * **Per-runtime pins.** The npm harness and the Python harness do not share version
 * numbers: this runtime pins `deepagents@1.16.0`, the Python runtime pins
 * `deepagents==0.7.32`. One `engineVersion` therefore cannot satisfy both, and it is not
 * asked to. Each runtime compares the declaration against its own pin, so a spec versioned
 * for Python is refused here with {@link DeepAgentsVersionMismatchError} -- honestly, at
 * the seam that would have to run it -- rather than being waved through on a major-version
 * match. Accepting any installed release would recreate exactly the silent-drift hole the
 * pin exists to close.
 *
 * **Fail closed, in one place.** Every reason a `deepagents` agent cannot run -- unknown
 * engine, transfer declared, mismatched pin, missing package -- is raised from
 * {@link checkEngine}. Putting them together means there is one function to read to know
 * whether an engine is supported, and no second path that could grow a silent fallback to
 * the native loop. A runtime that quietly ran a `deepagents` agent on the native engine
 * would leave `engine` in the IR meaning nothing at all.
 *
 * **The backend.** This runtime runs `deepagents` agents through the real npm harness; see
 * `./deep_agents.ts`. The harness is an optional peer dependency, because an application
 * that never names `engine: deepagents` should not install a LangChain tree. That makes
 * {@link installedDeepagentsVersion} load-bearing: it is what turns "the package is absent"
 * into {@link DeepAgentsUnavailableError} instead of an unresolvable import.
 */

import { createRequire } from 'node:module';

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
 * The one authoritative pin. Measured from the npm registry and mirrored in this
 * package's `peerDependenciesMeta`; compared against the IR's `engineVersion` at run time.
 */
export const DEEPAGENTS_PIN = '1.16.0';

/**
 * The harness and every required peer, at the exact releases this runtime was measured
 * against. `deepagents@1.16.0` declares each of these as a peer, so an application that
 * opts into the backend has to satisfy all of them; spelling them out means the install
 * instruction in the error message is the one that was actually tested.
 */
export const DEEPAGENTS_PEERS: readonly string[] = [
  'deepagents@1.16.0',
  'langchain@1.5.10',
  '@langchain/core@1.2.14',
  '@langchain/langgraph@1.5.3',
  '@langchain/langgraph-sdk@1.12.8',
  '@langchain/langgraph-checkpoint@1.2.1',
  'langsmith@0.9.0',
];

/** The optional peer set that installs the harness, as one `npm install` argument list. */
export const DEEPAGENTS_EXTRA = DEEPAGENTS_PEERS.join(' ');

/** The distribution the peers install. */
export const DEEPAGENTS_DISTRIBUTION = 'deepagents';

/**
 * How {@link installedDeepagentsVersion} finds the harness.
 *
 * A seam rather than a bare import so the absent-harness branch is reachable in a test that
 * has the package installed -- the alternative is uninstalling it, which no hermetic test
 * can do. It is also what the native-default test observes to prove the runtime never goes
 * looking for the harness at all when the engine is `native`.
 */
export type VersionDetector = () => string | undefined;

const requireFromHere = createRequire(import.meta.url);

/**
 * Read the installed harness version from its own manifest.
 *
 * `deepagents/package.json` rather than the module entry point: the manifest is not behind
 * an `exports` guard, and reading it means detection never loads 3 MB of LangChain just to
 * answer a version question.
 */
function readInstalledVersion(): string | undefined {
  let manifest: unknown;
  try {
    manifest = requireFromHere('deepagents/package.json');
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const version = (manifest as { version?: unknown }).version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * The installed `deepagents` version, or `undefined` when the package is absent.
 *
 * `detect` exists so a test can exercise the absent branch without uninstalling anything;
 * production callers pass nothing.
 */
export function installedDeepagentsVersion(
  detect: VersionDetector = readInstalledVersion,
): string | undefined {
  return detect();
}

/**
 * Validate this agent's engine, or raise the reason it cannot run.
 *
 * Returns the validated engine name. `native` always passes, and passes *before* any
 * version detection: an agent that does not opt in must never pay for, or even look for,
 * the harness. `deepagents` passes only when it declares no handoffs, pins
 * `engineVersion` to the version this runtime is built for, and the package is installed.
 */
export function checkEngine(
  agent: AgentDefinition,
  detect: VersionDetector = readInstalledVersion,
): string {
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
  if (detect() === undefined) {
    throw new DeepAgentsUnavailableError(DEEPAGENTS_EXTRA, DEEPAGENTS_DISTRIBUTION);
  }
  return DEEPAGENTS;
}
