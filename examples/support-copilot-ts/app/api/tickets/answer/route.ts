/**
 * The Next.js App Router entry point for `POST /tickets/answer`.
 *
 * Hand-written, and deliberately thin: Next only serves handlers that live under
 * `app/api/**`, while the generator's managed roots are `app/generated/**` and
 * `app/business/**`. A route emitted under `app/api` would be rejected by
 * `validatePlan` and would break the next `aid gen`, so the generator emits the
 * handler at `app/generated/routes/answer_ticket.ts` and this file adapts it to the
 * Fetch contract Next expects.
 */

import { handleAnswerTicket } from '../../../generated/routes/answer_ticket.js';

/** A model call is never cacheable, so the route must run per request. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const result = await handleAnswerTicket({ json: () => request.json() });
  return Response.json(result.body, { status: result.status });
}
