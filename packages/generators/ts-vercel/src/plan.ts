/**
 * The plan: IR in, bytes out.
 *
 * `planTsVercel` is a pure function of the IR. It does not read the spec, the
 * filesystem, the clock or the environment, which is what makes "generate twice and
 * diff" a meaningful test rather than a smoke test. Anything the IR cannot express is
 * reported as a `PlanProblem` and refused, never approximated: a generated app that
 * silently drops a declared capability is worse than one that will not generate.
 */

import type { GeneratedFile, Plan } from '@aid/generator-sdk';
import { sortByPath } from '@aid/generator-sdk';
import type { IR } from '@aid/ir';
import {
  emitBusinessIndex,
  emitBusinessPromptsIndex,
  emitBusinessToolSeeds,
  emitBusinessToolsIndex,
  emitEvalModules,
  emitEvalsIndex,
  emitGeneratedIndex,
} from './emit/business.js';
import type { EmittedFile } from './emit/file.js';
import {
  emitDeps,
  emitGatewayIndex,
  emitGatewayModels,
  emitObservability,
} from './emit/infrastructure.js';
import {
  emitPipelineModule,
  emitPipelinesIndex,
  emitRouteModule,
  emitRoutesIndex,
} from './emit/pipelines.js';
import { emitPromptModules, emitPromptsIndex } from './emit/prompts.js';
import {
  emitRetrievalBindings,
  emitRetrievalIndex,
  emitRetrievalIngestIndex,
  emitRetrievalIngestModules,
} from './emit/retrieval.js';
import { emitRequests, emitSchemas } from './emit/schemas.js';
import {
  emitContractModule,
  emitContractsIndex,
  emitToolAdapter,
  emitToolsIndex,
} from './emit/tools.js';
import { TsVercelPlanError } from './errors.js';
import { checkPlan } from './validate.js';

/** Every file the IR implies, in a fixed order, unsorted. */
function collect(ir: IR): EmittedFile[] {
  const files: EmittedFile[] = [];

  files.push(emitSchemas(ir));
  const requests = emitRequests(ir);
  if (requests !== undefined) files.push(requests);

  files.push(emitObservability(ir));
  files.push(emitDeps(ir));
  files.push(emitGatewayModels(ir));
  files.push(emitGatewayIndex(ir));

  files.push(emitContractsIndex(ir));
  for (const tool of ir.tools) {
    files.push(emitContractModule(ir, tool));
    files.push(emitToolAdapter(ir, tool));
  }
  files.push(emitToolsIndex(ir));

  files.push(...emitPromptModules(ir));
  files.push(emitPromptsIndex(ir));

  for (const pipeline of ir.pipelines) {
    files.push(emitPipelineModule(ir, pipeline));
    files.push(emitRouteModule(ir, pipeline));
  }
  files.push(emitPipelinesIndex(ir));
  files.push(emitRoutesIndex(ir));

  files.push(emitRetrievalBindings(ir));
  files.push(emitRetrievalIndex(ir));
  files.push(...emitRetrievalIngestModules(ir));
  files.push(emitRetrievalIngestIndex(ir));

  files.push(...emitEvalModules(ir));
  files.push(emitEvalsIndex(ir));

  files.push(...emitBusinessToolSeeds(ir));
  files.push(emitBusinessToolsIndex(ir));
  files.push(emitBusinessPromptsIndex(ir));
  files.push(emitBusinessIndex(ir));

  files.push(emitGeneratedIndex(ir));

  return files;
}

/** The plan's files, sorted by path so two runs cannot differ by traversal order. */
export function filesFor(ir: IR): GeneratedFile[] {
  return sortByPath(collect(ir));
}

/** The plan, or a `TsVercelPlanError` naming every reason it cannot be emitted. */
export function planTsVercel(ir: IR): Plan {
  const problems = checkPlan(ir);
  if (problems.length > 0) throw new TsVercelPlanError(problems);
  return { files: filesFor(ir) };
}

/** The plan as a path-to-bytes map, for callers that only want the tree. */
export function fileMap(plan: Plan): Map<string, string> {
  return new Map(plan.files.map((file) => [file.path, file.content]));
}
