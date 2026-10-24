import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { POST } from '../app/api/tickets/answer/route.js';
import { lookupCustomer } from '../app/business/tools/lookup_customer.js';
import { setDeps } from '../app/generated/deps.js';
import { ALIASES, FALLBACKS } from '../app/generated/gateway/index.js';
import { handleAnswerTicket } from '../app/generated/routes/answer_ticket.js';
import { buildExecutor } from '../app/generated/tools/index.js';
import { fakeDeps } from './fake_gateway.js';

const TICKET = {
  subject: 'Acme: I was charged twice this month',
  body: 'Please refund one charge.',
};

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
});
