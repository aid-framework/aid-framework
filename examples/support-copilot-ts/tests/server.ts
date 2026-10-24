/**
 * The Node host the end-to-end harness boots.
 *
 * The generator emits a route handler, not a server: in a Next.js App Router project
 * `app/api/tickets/answer/route.ts` is what Next serves. This host looks up the same
 * `ROUTE` constant the handler exports and speaks the same Fetch-shaped contract, so
 * the harness can prove the generated handler answers without a Next install.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { setDeps } from '../app/generated/deps.js';
import { handleAnswerTicket, ROUTE } from '../app/generated/routes/answer_ticket.js';
import { buildExecutor } from '../app/generated/tools/index.js';
import { fakeDeps } from './fake_gateway.js';

/** Set to `1` to make `lookup_customer` fail, which must surface as a 502. */
const BROKEN_TOOL = process.env.AID_EXAMPLE_BROKEN_TOOL === '1';

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? '/').split('?')[0];
  if (request.method === 'GET' && path === '/health') {
    reply(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === ROUTE.method && path === ROUTE.path) {
    const body = await bodyOf(request);
    const result = await handleAnswerTicket({ json: async () => JSON.parse(body) as unknown });
    reply(response, result.status, result.body);
    return;
  }
  reply(response, 404, { error: `no route for ${request.method ?? 'GET'} ${path ?? '/'}` });
}

function main(): void {
  setDeps(
    fakeDeps(
      BROKEN_TOOL
        ? {
            tools: buildExecutor({
              lookup_customer: async () => {
                throw new Error('crm is unreachable');
              },
            }),
          }
        : {},
    ),
  );
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    process.stdout.write(`AID_EXAMPLE_LISTENING ${String(port)}\n`);
  });
}

main();
