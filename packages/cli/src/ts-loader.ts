/**
 * The module hook `aid eval` runs a TypeScript target's generated eval through.
 *
 * Node strips types, so a generated `.ts` module runs without a build step -- with one
 * exception. The generator emits NodeNext specifiers (`../deps.js`) because that is what
 * the compiled tree has, and type stripping does not rewrite them: Node looks for
 * `../deps.js`, finds nothing, and fails with `ERR_MODULE_NOT_FOUND`. This hook closes
 * that gap by resolving a relative `.js` specifier to the `.ts` file beside it when the
 * `.js` file does not exist.
 *
 * It is deliberately narrow. A specifier that resolves to a real file is left alone, so a
 * project that has built itself keeps running its build output; only a missing `.js` is
 * redirected, which is exactly the case that cannot work otherwise.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const compiled = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(compiled))) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(source))) {
          return { url: source.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
