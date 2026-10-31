/**
 * `app/generated/deps.py`: what a pipeline step is given besides the event.
 *
 * A step receives one argument -- the runtime's `PipelineContext` -- so the gateway,
 * the prompt registry and the tool executor have to travel *through* the context
 * rather than through module-level globals. That is what makes a pipeline testable
 * without a network: the app assembles the container, and a test assembles one over a
 * fake provider instead.
 */

import type { IR } from '@aid-framework/ir';

import { INDENT } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import { hasAgents } from './agents.js';
import { CONCURRENCY_LIMIT, everyStep, hasFanOut } from './control.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const DEPS_PATH = `${GENERATED_ROOT}/deps.py`;

/** The context key the container travels under; reserved against user bindings. */
export const DEPS_BINDING = 'deps';

/**
 * The container a pipeline step reads from its context.
 *
 * A spec that declares no retriever gets no retrieval field and no import of the
 * retrieval package: an app with nothing to search should not carry a name for it.
 */
export function emitDeps(ir: IR): EmittedFile {
  const retrieval = ir.retrievers.length > 0;
  /* A fan-out needs exactly one limiter, so the app builds one and hands every composite
   * the same instance. A spec with no fan-out declares no cap and gets no limiter: there
   * is nothing for it to bound. */
  const fanOut = hasFanOut(ir.pipelines);
  /* The agent route needs the tool objects the runtime takes, the pipeline route needs the
   * executor. One tuple, built once, handed to both -- so a tool cannot be permissioned one
   * way on one route and another way on the other. */
  const agents = hasAgents(ir);
  /* A `rerank` step names a model, and the model selects the scorer. The container is where
   * that selection lives, so a test can hand a pipeline a reranker of its own without editing
   * the step -- the same seam `retriever()` gives a retrieval test. */
  const rerank = everyStep(ir.pipelines).some((step) => step.kind === 'rerank');
  return generated(
    DEPS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The container a pipeline step reads from its context: the model gateway, the ' +
          'prompt registry, and the tool executor.' +
          (agents ? ' The agent route reads the same gateway and the same tool objects.' : '') +
          (retrieval ? ' The retrievers the spec declares travel with it too.' : ''),
      ),
      importBlock([
        [importFrom('dataclasses', agents ? ['dataclass', 'field'] : ['dataclass'])],
        [
          importFrom('aid_runtime', [
            ...(retrieval || rerank ? ['ConfigurationError'] : []),
            ...(fanOut ? ['ConcurrencyLimiter'] : []),
            'ModelGateway',
            'PromptRegistry',
            ...(rerank ? ['Reranker', 'RerankSpec', 'reranker_for'] : []),
            ...(retrieval ? ['Retriever'] : []),
            ...(agents ? ['Tool', 'ToolExecutor'] : ['ToolExecutor']),
          ]),
        ],
        [
          ...(fanOut ? [`from .control import ${CONCURRENCY_LIMIT}`] : []),
          'from .gateway import build_gateway',
          'from .prompts import build_registry',
          ...(retrieval ? ['from .retrieval.bindings import build_retrievers'] : []),
          agents
            ? 'from .tools import build_agent_tools, build_executor'
            : 'from .tools import build_executor',
        ],
      ]),
      [
        '@dataclass(frozen=True, slots=True)',
        'class Deps:',
        pythonDoc("The app's runtime dependencies, assembled once per app.", INDENT),
        `${INDENT}gateway: ModelGateway`,
        `${INDENT}prompts: PromptRegistry`,
        `${INDENT}tools: ToolExecutor`,
        ...(fanOut
          ? [
              `${INDENT}#: The one cap a fan-out draws from. The app builds it once, so a`,
              `${INDENT}#: parallel step cannot invent a second, wider bound beside it.`,
              `${INDENT}limiter: ConcurrencyLimiter`,
            ]
          : []),
        ...(agents
          ? [`${INDENT}agent_tools: tuple[Tool, ...] = field(default_factory=build_agent_tools)`]
          : []),
        ...(retrieval
          ? [
              `${INDENT}retrievers: dict[str, Retriever] | None = None`,
              '',
              `${INDENT}def retriever(self, retriever_id: str) -> Retriever:`,
              pythonDoc(
                'One declared retriever, or a configuration error naming what was asked for.',
                `${INDENT}${INDENT}`,
              ),
              `${INDENT}${INDENT}declared = self.retrievers or {}`,
              `${INDENT}${INDENT}try:`,
              `${INDENT}${INDENT}${INDENT}return declared[retriever_id]`,
              `${INDENT}${INDENT}except KeyError:`,
              `${INDENT}${INDENT}${INDENT}raise ConfigurationError(`,
              `${INDENT}${INDENT}${INDENT}${INDENT}f"retriever {retriever_id!r} is not declared in the spec"`,
              `${INDENT}${INDENT}${INDENT}) from None`,
            ]
          : []),
        ...(rerank
          ? [
              '',
              `${INDENT}def reranker(self, model: str, top_n: int) -> Reranker:`,
              pythonDoc(
                'The scorer a rerank step names. The runtime selector owns which models it ' +
                  'can serve, so a step cannot run a scorer the app never built, and a model ' +
                  'it cannot serve is refused here rather than answered by a scorer of another ' +
                  'name.',
                `${INDENT}${INDENT}`,
              ),
              `${INDENT}${INDENT}declared = reranker_for(RerankSpec(model=model, topN=top_n))`,
              `${INDENT}${INDENT}if declared is None:`,
              `${INDENT}${INDENT}${INDENT}raise ConfigurationError(` +
                `f"rerank model {model!r} names no reranker")`,
              `${INDENT}${INDENT}return declared`,
            ]
          : []),
      ].join('\n'),
      '_SINGLETON: Deps | None = None',
      [
        'def build_deps(',
        `${INDENT}*,`,
        `${INDENT}gateway: ModelGateway | None = None,`,
        `${INDENT}prompts: PromptRegistry | None = None,`,
        `${INDENT}tools: ToolExecutor | None = None,`,
        ...(fanOut ? [`${INDENT}limiter: ConcurrencyLimiter | None = None,`] : []),
        ...(agents ? [`${INDENT}agent_tools: tuple[Tool, ...] | None = None,`] : []),
        ...(retrieval ? [`${INDENT}retrievers: dict[str, Retriever] | None = None,`] : []),
        ') -> Deps:',
        pythonDoc(
          "The app's dependencies, each defaulting to the wiring the spec generated.",
          INDENT,
        ),
        ...(agents
          ? [
              `${INDENT}declared_tools = build_agent_tools() if agent_tools is None else agent_tools`,
            ]
          : []),
        ...(fanOut
          ? [
              `${INDENT}if limiter is None:`,
              `${INDENT}${INDENT}limiter = ConcurrencyLimiter(${CONCURRENCY_LIMIT})`,
            ]
          : []),
        `${INDENT}return Deps(`,
        `${INDENT}${INDENT}gateway=build_gateway() if gateway is None else gateway,`,
        `${INDENT}${INDENT}prompts=build_registry() if prompts is None else prompts,`,
        ...(agents
          ? [
              `${INDENT}${INDENT}tools=build_executor(tools=declared_tools) ` +
                'if tools is None else tools,',
              `${INDENT}${INDENT}agent_tools=declared_tools,`,
            ]
          : [`${INDENT}${INDENT}tools=build_executor() if tools is None else tools,`]),
        ...(fanOut ? [`${INDENT}${INDENT}limiter=limiter,`] : []),
        ...(retrieval
          ? [
              `${INDENT}${INDENT}retrievers=build_retrievers() if retrievers is None else retrievers,`,
            ]
          : []),
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
