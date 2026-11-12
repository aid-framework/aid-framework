/**
 * An `agent:` eval target drives a loop, not a prompt, and the module it generates differs
 * from a sampled prompt eval in three ways this file pins.
 *
 * It takes no `Deps`: the harness builds the loop from the generated document and the tools
 * the app registers, so `evaluate()` is callable with nothing and the CLI's
 * `python -m app.generated.evals.<id>` works. It resolves providers through a recording when
 * `AID_EVAL_TRANSCRIPT` is set, so the same module runs offline on a laptop and in CI. And
 * its metrics all read the trajectory, which is why a model-backed metric is refused at
 * generation time rather than measured against a recording that cannot contain a judge.
 *
 * The spec under test is the committed example, which ships this eval so that the claim
 * about trajectory evals is exercised as shipped rather than in a fixture only this file
 * reads. The one refusal below mutates that example; nothing else is synthesized.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { checkPlan, evalModulePath, planPyFastApi, TOOL_TRACE_EXPECT } from '../src/index.js';
import { assignedValue, exampleSpecText, lowerForSpecText, quotedSegments } from './helpers.js';

const EVAL_ID = 'refund_trajectory';
const AGENT_ID = 'refund_agent';

/**
 * The committed example, which is the fixture.
 *
 * It ships a `refund_trajectory` agent eval precisely so a claim about trajectory evals is
 * exercised as shipped, in the spec the golden and drift tests also regenerate, rather than
 * in a spec only this file reads. Nothing is appended here: two evals with one id is what
 * made the earlier version of this fixture stop parsing.
 */
function agentSpecText(): string {
  return exampleSpecText();
}

/**
 * The same fixture with an advisory judge added to the agent eval.
 *
 * Two edits, in this order: the gate goes advisory first, because the spec layer already
 * refuses an `llm-judge` metric under a CI gate and that would hide the target's own
 * refusal, which is what the caller is testing. Both anchors are unique in the committed
 * spec; `ordered: true` is not, so it is not used.
 */
function judgeSpecText(): string {
  return agentSpecText()
    .replace(
      '        max: 0.05\n    gate:\n      ci: true\n',
      '        max: 0.05\n    gate:\n      ci: false\n',
    )
    .replace(
      '      - kind: cost\n        max: 0.05\n',
      [
        '      - kind: cost',
        '        max: 0.05',
        '      - kind: llm-judge',
        '        rubric: ticket_agent_prompt',
        '',
      ].join('\n'),
    );
}

function lower(): IR {
  return lowerForSpecText(agentSpecText());
}

function agentEvalSource(): string {
  const ir = lower();
  const path = evalModulePath(EVAL_ID);
  const file = planPyFastApi(ir).files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`the plan emitted no ${path}`);
  }
  return file.content;
}

describe('an agent eval module', () => {
  it('needs no app container, so the CLI can run it as a module', () => {
    const source = agentEvalSource();

    expect(source).not.toContain('build_deps');
    expect(source).not.toContain('Deps');
    expect(source).toContain('async def run() -> EvalRun:');
    expect(source).toContain('async def evaluate() -> GateResult:');
  });

  it('names the agent as its subject and reuses MODEL so baselines read uniformly', () => {
    const source = agentEvalSource();

    expect(assignedValue(source, 'AGENT')).toBe(`"${AGENT_ID}"`);
    // `aid eval --baseline` reads MODEL from every generated suite; naming the agent there
    // keeps that reader from special-casing agent evals.
    expect(assignedValue(source, 'MODEL')).toBe('AGENT');
    expect(assignedValue(source, 'SAMPLES')).toBe('3');
    expect(assignedValue(source, 'MAX_REGRESSION')).toBe('0.1');
  });

  it('replays one recording for every provider key when the transcript variable is set', () => {
    const source = agentEvalSource();

    expect(assignedValue(source, 'TRANSCRIPT_ENV')).toBe('"AID_EVAL_TRANSCRIPT"');
    expect(source).toContain('if recording is None:');
    expect(source).toContain('return default_providers()');
    expect(source).toContain('replayed: Provider = RecordedProvider.from_path(Path(recording))');
    // One recording serves every key, and `dict.fromkeys` says so in a shape `C420` accepts.
    expect(source).toContain('return dict.fromkeys(PROVIDER_KEYS, replayed)');
    expect(quotedSegments(assignedValue(source, 'PROVIDER_KEYS') ?? '')).toContain('openai');
  });

  it('builds the loop from the generated document and the app tools', () => {
    const source = agentEvalSource();

    expect(source).toContain(
      'return AgentEvalRunner(DOCUMENT, AGENT, providers=providers(), tools=build_agent_tools())',
    );
  });

  it('hoists the expected tool list into a constant the metric reads', () => {
    const source = agentEvalSource();

    expect(TOOL_TRACE_EXPECT).toBe('EXPECT_TOOLS');
    expect(assignedValue(source, TOOL_TRACE_EXPECT)).toBe('("lookup_customer", "issue_refund")');
    // The metric reads the constant rather than repeating the tuple inline: a tuple that
    // long would not fit the generated file's line budget and `ruff format` would rewrite it.
    expect(source).toContain(`ToolTrace(expect=${TOOL_TRACE_EXPECT}, ordered=True)`);
  });

  it('measures the trajectory and thresholds on it, rather than measuring nothing', () => {
    const source = agentEvalSource();

    // A module whose `metrics()` and `thresholds()` are empty imports cleanly, typechecks,
    // and passes every gate run, so nothing else in the suite would notice a mapping that
    // measured nothing.
    expect(source).toContain('ToolTrace(expect=EXPECT_TOOLS, ordered=True)');
    expect(source).toContain('Threshold(metric="tool-trace"');
    expect(source).not.toContain('    return ()\n');
  });

  it('measures the run, and says so, rather than claiming to judge a model', () => {
    // The docstring is reflowed to the file's line budget, so the assertion reads it the way
    // a reader does -- as one paragraph -- rather than as it happens to be wrapped.
    const source = agentEvalSource().replace(/\s+/g, ' ');

    expect(source).toContain('measures policy and plumbing');
    expect(source).toContain('and not how a model would behave');
  });

  it('stays inside the generated file line budget', () => {
    const overlong = agentEvalSource()
      .split('\n')
      .filter((line) => line.length > 100);

    expect(overlong).toEqual([]);
  });

  it('refuses a model-backed metric on an agent subject', () => {
    // The gate is advisory in `judgeSpecText()` because the spec layer already refuses a
    // judge under a CI gate. What is left for the target to refuse is the advisory agent
    // eval, whose metrics are built from a recording a judge never wrote to.
    const problems = checkPlan(lowerForSpecText(judgeSpecText())).filter(
      (problem) => problem.code === 'unsupported-metric',
    );

    expect(problems.map((problem) => problem.path)).toContain(`evals.${EVAL_ID}.metrics`);
    const [problem] = problems;
    // The refusal has to name what would work, because "unsupported" alone leaves the author
    // guessing which metric is measurable against a recording.
    expect(problem?.message).toContain('llm-judge');
    expect(problem?.message).toContain('tool-trace');
  });

  it('accepts the trajectory metrics it can measure', () => {
    expect(checkPlan(lower())).toEqual([]);
  });
});
