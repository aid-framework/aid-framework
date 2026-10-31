/**
 * The value every emitter returns: a finished file, not a write.
 *
 * The plan is a value, so the whole output can be assembled, hashed, diffed and
 * compared against a golden tree before anything touches the user's disk.
 */

import { managedRoots } from '@aid-framework/generator-sdk';

import { PY_FASTAPI_MANIFEST } from '../manifest.js';

/** Ownership as the SDK names it: `generated` is overwritten, `business` is not. */
export type FileOwner = 'business' | 'generated';

export interface EmittedFile {
  readonly path: string;
  readonly content: string;
  readonly owner: FileOwner;
}

/**
 * The managed roots, read from the SDK rather than restated here.
 *
 * `validatePlan` refuses any path outside them, so a generator that hard-codes its
 * own idea of the layout fails plan validation instead of quietly drifting from the
 * other targets that share the manifest shape.
 */
const roots = managedRoots(PY_FASTAPI_MANIFEST);

export const GENERATED_ROOT = roots.generatedDir;
export const BUSINESS_ROOT = roots.businessDir;
export const MANIFEST_PATH = roots.manifestFilename;

/**
 * The package the generated and business trees live in, which is where the app's own
 * modules (`main.py`) go. Derived from the manifest path rather than restated, so a
 * manifest that moved its output root cannot leave this behind.
 */
export const APP_ROOT = MANIFEST_PATH.slice(0, MANIFEST_PATH.lastIndexOf('/'));

export function generated(path: string, content: string): EmittedFile {
  return { path, content, owner: 'generated' };
}

export function business(path: string, content: string): EmittedFile {
  return { path, content, owner: 'business' };
}
