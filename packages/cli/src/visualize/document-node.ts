/**
 * The document, read from a path: the CLI half of `document.ts`.
 *
 * It exists as its own module because reading the spec and asking the installed generators
 * what each target supports both need a filesystem. The website draws the same document from
 * text a visitor pasted, so the pure builder is in `document.ts` where a browser can import it
 * and the node-only entry point is here.
 */

import type { CliContext } from '../context.js';
import { readSpec } from '../pipeline.js';
import { targetCapabilities } from '../targets.js';
import type { VisualDocument } from './document.js';
import { visualDocumentFrom } from './document.js';

export function buildVisualDocument(context: CliContext, specPath: string): VisualDocument {
  const read = readSpec(context, specPath);
  if (!read.ok) return { ok: false, specPath, diagnostics: read.diagnostics };

  return visualDocumentFrom(read.text, specPath, targetCapabilities());
}
