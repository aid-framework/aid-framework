import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { POST } from '../app/api/tickets/answer/route.js';
import { lookupCustomer } from '../app/business/tools/lookup_customer.js';
import { setDeps } from '../app/generated/deps.js';
import { ALIASES, FALLBACKS } from '../app/generated/gateway/index.js';
import { handleAnswerTicket } from '../app/generated/routes/answer_ticket.js';
import { handleTriage } from '../app/generated/routes/triage.js';
import { buildExecutor } from '../app/generated/tools/index.js';
import { fakeDeps } from './fake_gateway.js';

const TICKET = {
  subject: 'Acme: I was charged twice this month',
  body: 'Please refund one charge.',
};

/** An answer that is structurally valid but leaks an address the output guardrail blocks. */
const LEAKY_ANSWER = JSON.stringify({
  category: 'billing',
  confidence: 0.9,
  summary: 'Reply to ada@example.com about the duplicate charge.',
});

interface AnswerBody {
  readonly category: string;
  readonly confidence: number;
  readonly summary: string;
}

afterEach(() => {
  setDeps(undefined);
});

describe('generated gateway', () => {
  it('pins the model alias and its offline fallback', () => {
    const fast = ALIASES.fast;
    assert.ok(fast !== undefined);
    assert.equal(fast.name, 'gpt-4o-mini');
    assert.equal(fast.provider, 'openai');
    assert.deepEqual(FALLBACKS.fast, ['offline']);
  });
});

describe('business tool', () => {
  it('resolves a known account by name', async () => {
    const customer = await lookupCustomer({ name: 'lookup_customer', arguments: TICKET }, TICKET);
    assert.equal(customer.id, 'acct_acme');
    assert.equal(customer.name, 'Acme Corp');
    assert.equal(customer.plan, 'enterprise');
  });

  it('falls back to an unknown account', async () => {
    const ticket = { subject: 'Hoverboard questions', body: 'Does it fly?' };
    const customer = await lookupCustomer({ name: 'lookup_customer', arguments: ticket }, ticket);
    assert.equal(customer.id, 'acct_unknown');
  });
});

describe('route handler', () => {
  it('answers a ticket offline, end to end through the pipeline', async () => {
    setDeps(fakeDeps());
    const result = await handleAnswerTicket({ json: async () => TICKET });
    assert.equal(result.status, 200);
    const body = result.body as AnswerBody;
    assert.equal(body.category, 'billing');
    assert.ok(body.summary.length > 0);
  });

  it('reports a failing tool as a 502 naming the tool', async () => {
    setDeps(
      fakeDeps({
        tools: buildExecutor({
          lookup_customer: async () => {
            throw new Error('crm is unreachable');
          },
        }),
      }),
    );
    const result = await handleAnswerTicket({ json: async () => TICKET });
    assert.equal(result.status, 502);
    assert.match(String((result.body as { error: string }).error), /lookup_customer/);
  });

  it('rejects a body that does not match the request schema', async () => {
    setDeps(fakeDeps());
    const result = await handleAnswerTicket({ json: async () => ({ subject: 1 }) });
    assert.equal(result.status, 400);
  });

  it('is served through the Next.js route shim', async () => {
    setDeps(fakeDeps());
    const request = new Request('http://localhost/api/tickets/answer', {
      method: 'POST',
      body: JSON.stringify(TICKET),
      headers: { 'content-type': 'application/json' },
    });
    const response = await POST(request);
    assert.equal(response.status, 200);
    const body = (await response.json()) as AnswerBody;
    assert.equal(body.category, 'billing');
    assert.ok(body.confidence <= 1);
  });

  /**
   * The emitted `generate` step's inline `checkOutput` over the `output` stage of
   * `guardrails.inbound` (`pii-detect`, `block`).
   *
   * What this pins: the call exists in the emitted pipeline and its `block` reaches the
   * route as a 400 naming the guardrail. Delete `enforceGuardrail(ENGINE.checkOutput(...))`
   * from `app/generated/pipelines/answer_ticket.ts` and this test answers 200 with the
   * address intact; it also fails if the runtime stops carrying the block through
   * `PipelineError.cause`, which is what lets `guardrailBlock` find it.
   */
  it('refuses an answer that trips the emitted output guardrail', async () => {
    setDeps(fakeDeps({ answers: { 'charged twice': LEAKY_ANSWER } }));
    const result = await handleAnswerTicket({ json: async () => TICKET });
    assert.equal(result.status, 400);
    const body = result.body as { error: string; guardrail?: string; stage?: string };
    assert.match(body.error, /refused by a guardrail/);
    assert.equal(body.guardrail, 'inbound');
    assert.equal(body.stage, 'output');
  });
});

/**
 * The whole-pipeline case: `triage` is the pipeline that uses every construct the target
 * emits, so running it end to end is what separates "the emitter produced TypeScript" from
 * "the emitted application works".
 */
describe('the all-kinds pipeline', () => {
  it('runs tool, retrieve, rerank, generate, guard, branch, parallel, agent and emit', async () => {
    setDeps(fakeDeps());
    const result = await handleTriage({ json: async () => TICKET });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const body = result.body as { answer: string };
    // The last binding is the `agent` step's answer, so a non-empty note proves the agent
    // loop ran *after* the branch and the parallel arms rather than short-circuiting.
    assert.equal(typeof body.answer, 'string');
    assert.ok(body.answer.length > 0);
  });

  it('refuses a ticket whose own text trips the input guardrail, before any work runs', async () => {
    setDeps(fakeDeps());
    const result = await handleTriage({
      json: async () => ({ subject: 'Contact ada@example.com', body: 'Refund please.' }),
    });
    assert.equal(result.status, 400);
    assert.equal((result.body as { stage?: string }).stage, 'input');
  });
});
