/**
 * `observability.redact` decides what the app records, and where it can.
 *
 * The runtime does the redacting: `aid_runtime.redaction` replaces each withheld value
 * with `[redacted:<name>]` before a trace is written. So this target's whole job is to
 * tell it which fields, at the one place a value is known -- the rendered prompt, whose
 * bindings turn a name into the text that must not travel. These tests pin that wiring.
 *
 * They also pin the refusal that stands where no render exists. An agent run re-sends a
 * transcript it assembled, so there is no field to bind and the guarantee cannot be kept;
 * emitting the module anyway would be the approximation the gates exist to prevent.
 *
 * The third case is what keeps the feature from costing every other document: a spec that
 * withholds nothing emits no redaction table at all, so the bytes of an app that never
 * asked for redaction do not move.
 *
 * Both documents are the shipped examples rather than specs written to make these tests
 * pass, so the shapes under test are the shapes an author actually gets.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PyFastApiPlanError } from '../src/errors.js';
import type { PlanProblem } from '../src/validate.js';
import { buildForSpecText, exampleSpecText, fileMap } from './helpers.js';

/** The accounts-payable app: one prompt, one pipeline, no agent. */
const INVOICE_SPEC = readFileSync(
  fileURLToPath(
    new URL('../../../../examples/scenarios/invoice-intake/app/app.spec.yaml', import.meta.url),
  ),
  'utf8',
);

/**
 * The same document withholding the invoice body.
 *
 * `invoice` is the prompt's own variable, so the set names something the render can
 * actually bind a value to -- which is the whole mechanism.
 */
const REDACTING = `${INVOICE_SPEC}\nobservability:\n  redact: [invoice]\n`;

/** The example agent app -- the document the refusal is about, unmodified. */
const AGENT_SPEC = exampleSpecText();

/** A field of that app's own types, and a name the security gate derives a mark from. */
const ANCHOR = '        description: The account name, for the reply to address.\n';
const DERIVED =
  '      email:\n        type: string\n        description: The address a reply goes to.\n';

/** One planned file's text. */
function source(text: string, path: string): string {
  const found = fileMap(buildForSpecText(text).plan.files).get(path);
  expect(found, `${path} is not in the plan`).toBeTypeOf('string');
  return found ?? '';
}

/** The problems a refused plan reports; a refused plan throws instead of returning one. */
function problems(text: string): readonly PlanProblem[] {
  try {
    buildForSpecText(text);
  } catch (error) {
    if (error instanceof PyFastApiPlanError) return error.problems;
    throw error;
  }
  throw new Error('the spec planned without a problem');
}

describe('a withheld field reaches the request that records it', () => {
  it('emits the set once per module and passes it to the completion request', () => {
    const pipeline = source(REDACTING, 'app/generated/pipelines/extract_invoice.py');

    // One constant, so the request and the constant it reads cannot disagree.
    expect(pipeline).toContain('REDACT: tuple[str, ...] = ("invoice",)');
    // `redactions()` is what pairs a name with its value: the render holds the text, and
    // the set says which pieces of it must not be recorded.
    expect(pipeline).toContain('redactions=_rendered.redactions(REDACT)');
  });

  it('redacts the same set in an eval, so measuring a run cannot escape it', () => {
    // An eval module serves one eval, not one pipeline. It takes the union of the
    // process-wide set and every pipeline's, because a value one pipeline refuses to
    // record must not become recordable by asking the same prompt through an eval.
    const evals = source(REDACTING, 'app/generated/evals/extraction_quality.py');

    expect(evals).toContain('REDACT: tuple[str, ...] = ("invoice",)');
    expect(evals).toContain('redactions=rendered.redactions(REDACT)');
  });

  it('emits no redaction at all when the document withholds nothing', () => {
    // The falsifier for the two tests above: an emitter that wrote the table
    // unconditionally would satisfy them while changing every app that never asked.
    for (const path of [
      'app/generated/pipelines/extract_invoice.py',
      'app/generated/evals/extraction_quality.py',
    ]) {
      expect(source(INVOICE_SPEC, path)).not.toContain('REDACT');
    }
  });
});

describe('a document that runs an agent cannot honour a withheld field', () => {
  it('refuses a declared set, and says why no emitted code can strip it', () => {
    const [problem] = problems(`${AGENT_SPEC}\nobservability:\n  redact: [email]\n`);

    expect(problem?.code).toBe('unsupported-redact');
    expect(problem?.path).toBe('observability.redact');
    expect(problem?.message).toContain('the document runs an agent');
    expect(problem?.message).toContain('transcript it was handed');
  });

  it('refuses a field whose name derives the set, with nothing declared at all', () => {
    // `observability.redact` is omitted here and the document still withholds `email`,
    // because an omitted set defaults to the names the security gate derives from field
    // names. That is the same guarantee arriving by a route the document never spells
    // out, which is why it is refused rather than quietly dropped.
    const derived = AGENT_SPEC.replace(ANCHOR, `${ANCHOR}${DERIVED}`);
    expect(derived).not.toBe(AGENT_SPEC);

    const refused = problems(derived).filter((entry) => entry.code === 'unsupported-redact');

    expect(refused.map((entry) => entry.path)).toContain('observability.redact');
    expect(refused.some((entry) => entry.message.includes('email'))).toBe(true);
  });

  it('accepts the same withheld field once the work is served through a pipeline', () => {
    // The refusal's own advice, taken: this document names no agent, and the first block
    // proves it plans and emits the table. The refusal is a dead end only if the author
    // leaves the agent in place.
    expect(AGENT_SPEC).toContain('agents:');
    expect(source(REDACTING, 'app/generated/pipelines/extract_invoice.py')).toContain('REDACT');
  });
});
