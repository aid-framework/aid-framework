// Created once by AID Framework "@aid-framework/generator-ts-vercel" v0.1.0. Edit freely.
// This file is yours: the generator seeds it on first run and never overwrites it.

import { lookupCustomer } from './lookup_customer.js';

/**
 * Every hand-written tool implementation, keyed by the IR tool id.
 *
 * The generated executor reads this map, so a new tool is added here and nowhere
 * else. The `unknown` value type is deliberate: the generated adapter is what
 * pins each entry to its declared handler type.
 */
export const IMPLEMENTATIONS: Readonly<Record<string, unknown>> = {
  lookup_customer: lookupCustomer,
};
