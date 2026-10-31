// Created once by AID Framework "@aid-framework/generator-ts-vercel" v0.1.0. Edit freely.
// This file is yours: the generator seeds it on first run and never overwrites it.

import type { LookupCustomerHandler } from '../../generated/contracts/lookup_customer.js';
import type { Customer, Ticket } from '../../generated/schemas.js';

/**
 * The `lookup_customer` tool: resolve the account a ticket came from.
 *
 * The example stands in for a CRM, so it resolves against a fixed table keyed by
 * account name. A real implementation would query one; the generated wiring cares
 * only that the signature is honoured: a validated `Ticket` in, a `Customer` out, and
 * a rejected promise failing the pipeline step.
 */

/** The accounts this example knows about, in a fixed order so lookups are deterministic. */
const ACCOUNTS: readonly (readonly [string, Customer])[] = [
  ['acme', { id: 'acct_acme', name: 'Acme Corp', open_tickets: 2, plan: 'enterprise' }],
  ['globex', { id: 'acct_globex', name: 'Globex', open_tickets: 0, plan: 'pro' }],
  ['initech', { id: 'acct_initech', name: 'Initech', open_tickets: 5, plan: 'free' }],
];

const UNKNOWN: Customer = {
  id: 'acct_unknown',
  name: 'Unknown account',
  open_tickets: 0,
  plan: 'free',
};

/**
 * Match an account name anywhere in the ticket, else return an unknown account.
 *
 * `request` is the validated `Ticket` the generated adapter produced; `context`
 * carries the wire name and the raw arguments the model passed.
 */
export const lookupCustomer: LookupCustomerHandler = async (_context, request: Ticket) => {
  const haystack = `${request.subject}\n${request.body}`.toLowerCase();
  for (const [account, customer] of ACCOUNTS) {
    if (haystack.includes(account)) return { ...customer };
  }
  return { ...UNKNOWN };
};
