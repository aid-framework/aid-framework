/**
 * The package skeleton: the two `__init__.py` files that make the two managed roots
 * importable, and nothing above them.
 *
 * `docs/design.md` §8.3 draws the line at `app/generated/` and `app/business/`, and
 * the SDK's plan validation enforces it: everything above those roots -- the app's own
 * `__init__.py`, the ASGI entrypoint, `pyproject.toml` -- is a stack file the developer
 * owns. The generator emitting them anyway would be the generator claiming ownership of
 * files it may not overwrite, so it does not.
 */

import type { IR } from '@aid-framework/ir';

import { assemble, HEADER } from '../template.js';
import type { EmittedFile } from './file.js';
import { BUSINESS_ROOT, business, GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const GENERATED_INIT_PATH = `${GENERATED_ROOT}/__init__.py`;
export const BUSINESS_INIT_PATH = `${BUSINESS_ROOT}/__init__.py`;

export function emitGeneratedInit(ir: IR): EmittedFile {
  return generated(
    GENERATED_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        `Wiring generated for the \`${ir.project.name}\` app: the model gateway, the ` +
          'prompt registry, the tool executor, the pipelines and their routes. It is ' +
          'rewritten on every run, so put changes in app/business instead.',
      ),
    ]),
  );
}

export function emitBusinessInit(ir: IR): EmittedFile {
  return business(
    BUSINESS_INIT_PATH,
    assemble(
      [
        HEADER,
        pythonDoc(
          `The hand-written tier of the \`${ir.project.name}\` app: your prompts, your ` +
            'tools, your domain rules. The generator writes this package once and never ' +
            'touches it again.',
        ),
      ],
      'business',
    ),
  );
}
