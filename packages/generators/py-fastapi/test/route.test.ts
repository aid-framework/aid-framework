/**
 * The `route` composite, as the pipeline module emits it.
 *
 * Each fixture is a whole spec through `planForSpecText`, so a route that lowered but
 * could not be planned fails here rather than in a later layer. `route.yaml` maps every
 * label and therefore declares no `default`; `route-default.yaml` leaves `off_topic`
 * unmapped, which is what makes its `otherwise` reachable.
 *
 * The two fixtures plan through `planForSpecText`, which checks and lowers but does not
 * run the build gates. That is deliberate: the gates are the IR package's contract, and
 * the question here is what bytes reach the module once the IR exists.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compositePlan,
  fileAt,
  PACKAGE_REPO_ROOT,
  planForSpecText,
  withLine,
} from './composite.js';

const FIXTURES = join(PACKAGE_REPO_ROOT, 'packages', 'ir', 'test', 'fixtures');
const ROUTE_FIXTURE = join(FIXTURES, 'route.yaml');
const DEFAULT_FIXTURE = join(FIXTURES, 'route-default.yaml');

function specTextOf(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The `triage` pipeline module a fixture plans, proved to be the one the plan ships. */
function moduleFor(path: string): string {
  return fileAt(planForSpecText(specTextOf(path), path), 'app/generated/pipelines/triage.py');
}

/** The `def` names the module opens, in the order they appear. */
function definitions(module: string): string[] {
  return [...module.matchAll(/^async def (\w+)\(/gm)].map((match) => match[1] ?? '');
}

describe('the route emitter', () => {
  const module = moduleFor(ROUTE_FIXTURE);

  it('imports the runtime factory and the definition it hands it', () => {
    expect(module).toContain(
      'from aid_runtime import CompletionRequest, Pipeline, PipelineContext, route',
    );
    expect(module).toContain('from aid_runtime.agents import DecisionDefinition');
  });

  it('carries one definition table for every decision a route names', () => {
    expect(module).toContain('DECISIONS: dict[str, DecisionDefinition] = {');
    expect(module).toContain(
      [
        '    "topic": DecisionDefinition(',
        '        id="topic",',
        '        model="jev-1.14.0",',
        '        instructions="Which part of the product is this question about",',
        '        criteria=("billing", "off_topic", "product"),',
        '    ),',
      ].join('\n'),
    );
  });

  it('asks the decision about the rendered input and runs the arm its label names', () => {
    expect(module).toContain(
      [
        '    _step = route(',
        '        decision="topic",',
        '        state=f\'{ctx.require("plan")}\',',
        '        on={',
        '            "product": Pipeline.of(_route_1_on_1_1_reply),',
        '            "billing": Pipeline.of(_route_1_on_2_1_reply),',
        '            "off_topic": Pipeline.of(_route_1_on_3_1_reply),',
        '        },',
        '        as_="path",',
        '        decisions=DECISIONS,',
        '        max_depth=MAX_STEP_DEPTH,',
        '        name="_route_1",',
        '    )',
        '    return await _step(ctx)',
      ].join('\n'),
    );
  });

  it('gives every arm its own module-level name, even when the arms bind one', () => {
    // All three arms bind `reply`, so naming them after the binding would emit three
    // `def reply` where the second shadows the first -- and `Pipeline.of` would refuse a
    // pipeline holding two steps with one name anyway.
    expect(definitions(module)).toEqual([
      'plan',
      '_route_1_on_1_1_reply',
      '_route_1_on_2_1_reply',
      '_route_1_on_3_1_reply',
      '_route_1',
    ]);
  });

  it('emits no `otherwise` when `on` already covers every label', () => {
    expect(module).not.toContain('otherwise=');
  });

  it('interpolates the state without a backslash-escaped quote', () => {
    // A backslash inside an f-string's replacement field is refused before Python 3.12.
    expect(module).not.toContain('\\"');
  });

  it('binds the answered label when the spec asks for it', () => {
    expect(module).toContain('as_="path"');
  });
});

describe('a route with a default arm', () => {
  const module = moduleFor(DEFAULT_FIXTURE);

  it('passes the default as `otherwise` and maps only the labels `on` names', () => {
    expect(module).toContain('otherwise=Pipeline.of(_route_1_default_1_reply)');
    expect(module).toContain('"product": Pipeline.of(_route_1_on_1_1_reply),');
    expect(module).toContain('"billing": Pipeline.of(_route_1_on_2_1_reply),');
    expect(module).not.toContain('"off_topic":');
  });

  it('names the default arm among the arms rather than after its binding', () => {
    expect(definitions(module)).toEqual([
      'plan',
      '_route_1_on_1_1_reply',
      '_route_1_on_2_1_reply',
      '_route_1_default_1_reply',
      '_route_1',
    ]);
  });
});

describe('a route variant', () => {
  it('omits `as_` when the spec binds no path', () => {
    const text = withLine(specTextOf(ROUTE_FIXTURE), '          as: path', '');
    expect(
      fileAt(planForSpecText(text, ROUTE_FIXTURE), 'app/generated/pipelines/triage.py'),
    ).not.toContain('as_=');
  });

  it('renders an input with no substitution as the text it renders', () => {
    const text = withLine(
      specTextOf(ROUTE_FIXTURE),
      '          input: "{{plan}}"',
      '          input: "classify this"',
    );
    const module = fileAt(
      planForSpecText(text, ROUTE_FIXTURE),
      'app/generated/pipelines/triage.py',
    );
    expect(module).toContain('state="classify this",');
  });

  it('leaves every module without a route free of the definition table', () => {
    const module = fileAt(compositePlan(), 'app/generated/pipelines/triage.py');
    expect(module).not.toContain('DECISIONS');
    expect(module).not.toContain('DecisionDefinition');
  });
});
