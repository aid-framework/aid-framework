/**
 * `observability.redact` decides what the app records, and where it can.
 *
 * The runtime does the redacting: `aid_runtime.redaction` replaces each withheld value
 * with `[redacted:<name>]` before a trace is written. So this target's whole job is to
 * tell it which fields, at the one place a value is known -- the rendered prompt, whose
 * bindings turn a name into the text that must not travel. These tests pin that wiring.
 *
 * They also pin the other half of the same boundary. An agent run's structured record is
 * its tool calls, so a document whose agents declare a tool binds the withheld names from
 * the arguments the model composes and keeps the guarantee -- those are the tests below.
 * The one shape that cannot is an agent document with no tool at all, which is refused
 * rather than emitted unkept; that refusal needs a tool-less fixture, so it lives beside
 * the fixture that can omit the tool, in `agents-memory.test.ts`.
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

/** The example agent app -- the document that must accept a set, unmodified. */
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

/**
 * The other side of the same refusal: an agent document that *does* have a record to bind.
 *
 * `examples/support-copilot` declares two tools, so an agent run there composes tool calls
 * whose arguments are mappings with declared keys -- the boundary the runtime binds. The set
 * therefore crosses into `app/generated/agents.py`, and a gate that refused it would be
 * refusing a guarantee the emitted run actually keeps.
 */
describe('an agent document with a tool honours the withheld field', () => {
  it('accepts a declared set and carries it into the agent document', () => {
    const agents = source(
      `${AGENT_SPEC}\nobservability:\n  redact: [email]\n`,
      'app/generated/agents.py',
    );

    // The names, not the marker: the runtime resolves each to the tool-call argument it
    // names, so a document that dropped this block would record the value in full.
    expect(agents).toContain('"observability": {"redact": ["email"]}');
  });

  it('accepts a field whose name derives the set, with nothing declared at all', () => {
    // `observability.redact` is omitted here and the document withholds `email` anyway,
    // because an omitted set defaults to the names the security gate derives from field
    // names. The derived route reaches the same document by a path the spec never spells
    // out, so it is the one more likely to be lost in a projection.
    const derived = AGENT_SPEC.replace(ANCHOR, `${ANCHOR}${DERIVED}`);
    expect(derived).not.toBe(AGENT_SPEC);

    expect(source(derived, 'app/generated/agents.py')).toContain('"redact": ["email"]');
  });

  it('accepts the same withheld field when the work is served through a pipeline', () => {
    // A pipeline binds at its render, which exists with or without an agent in the
    // document, so the declaration is honoured there too -- and emitted as the request's
    // own constant rather than into the agent document.
    expect(AGENT_SPEC).toContain('agents:');
    expect(source(REDACTING, 'app/generated/pipelines/extract_invoice.py')).toContain('REDACT');
  });
});
