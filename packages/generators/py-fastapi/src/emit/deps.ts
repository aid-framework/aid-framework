/**
 * `app/generated/deps.py`: what a pipeline step is given besides the event.
 *
 * A step receives one argument -- the runtime's `PipelineContext` -- so the gateway,
 * the prompt registry and the tool executor have to travel *through* the context
 * rather than through module-level globals. That is what makes a pipeline testable
 * without a network: the app assembles the container, and a test assembles one over a
 * fake provider instead.
 */

import { INDENT } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const DEPS_PATH = `${GENERATED_ROOT}/deps.py`;

/** The context key the container travels under; reserved against user bindings. */
export const DEPS_BINDING = 'deps';

export function emitDeps(): EmittedFile {
  return generated(
    DEPS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The container a pipeline step reads from its context: the model gateway, the ' +
          'prompt registry, and the tool executor.',
      ),
      importBlock([
        [importFrom('dataclasses', ['dataclass'])],
        [importFrom('aid_runtime', ['ModelGateway', 'PromptRegistry', 'ToolExecutor'])],
        [
          'from .gateway import build_gateway',
          'from .prompts import build_registry',
          'from .tools import build_executor',
        ],
      ]),
      [
        '@dataclass(frozen=True, slots=True)',
        'class Deps:',
        pythonDoc("The app's runtime dependencies, assembled once per app.", INDENT),
        `${INDENT}gateway: ModelGateway`,
        `${INDENT}prompts: PromptRegistry`,
        `${INDENT}tools: ToolExecutor`,
      ].join('\n'),
      '_SINGLETON: Deps | None = None',
      [
        'def build_deps(',
        `${INDENT}*,`,
        `${INDENT}gateway: ModelGateway | None = None,`,
        `${INDENT}prompts: PromptRegistry | None = None,`,
        `${INDENT}tools: ToolExecutor | None = None,`,
        ') -> Deps:',
        pythonDoc(
          "The app's dependencies, each defaulting to the wiring the spec generated.",
          INDENT,
        ),
        `${INDENT}return Deps(`,
        `${INDENT}${INDENT}gateway=build_gateway() if gateway is None else gateway,`,
        `${INDENT}${INDENT}prompts=build_registry() if prompts is None else prompts,`,
        `${INDENT}${INDENT}tools=build_executor() if tools is None else tools,`,
        `${INDENT})`,
      ].join('\n'),
      [
        'def get_deps() -> Deps:',
        pythonDoc(
          'The process-wide container, built on first use. FastAPI resolves this per ' +
            'request, so an app has one gateway and one executor; a test replaces it with ' +
            '`app.dependency_overrides[get_deps]`.',
          INDENT,
        ),
        `${INDENT}global _SINGLETON`,
        `${INDENT}if _SINGLETON is None:`,
        `${INDENT}${INDENT}_SINGLETON = build_deps()`,
        `${INDENT}return _SINGLETON`,
      ].join('\n'),
    ]),
  );
}
