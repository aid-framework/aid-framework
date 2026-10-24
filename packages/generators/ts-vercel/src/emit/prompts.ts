/**
 * `generated/prompts/*.ts`.
 *
 * A prompt is emitted as a `PromptTemplate` rather than as a string constant: the
 * runtime refuses to render a template with a missing or unused variable, and that
 * refusal is worth keeping. Business overrides are merged at build time from the
 * never-overwritten tier, so changing a prompt's wording does not touch generated code.
 */

import type { IR, PromptShape } from '@aid/ir';
import { literal, toSnakeCase } from '../names.js';
import { runtimeTemplate } from '../placeholders.js';
import { type EmittedFile, generated, paths, promptPath } from './file.js';
import { arrayLiteral, importStatement, moduleText, templateLiteral } from './text.js';

export function promptConstant(id: string): string {
  return toSnakeCase(id).toUpperCase();
}

function promptModule(prompt: PromptShape): string {
  const required = prompt.variables.filter((variable) => variable.required).map((v) => v.name);
  const fields = [
    `  name: ${literal(prompt.id)},`,
    `  version: ${literal(String(prompt.version))},`,
    // The template is the IR's mustache body converted to the `str.format` fields the
    // runtime renders, and it is emitted verbatim: re-indenting it would change the
    // text the model is shown.
    `  template: ${templateLiteral(runtimeTemplate(prompt.template))},`,
  ];
  if (required.length > 0) {
    fields.push(`  required: [${required.map((name) => literal(name)).join(', ')}],`);
  }
  return [
    importStatement('@aid/runtime', [{ name: 'PromptTemplate', type: false }]),
    '',
    `export const ${promptConstant(prompt.id)} = new PromptTemplate({`,
    ...fields,
    '});',
  ].join('\n');
}

export function emitPromptModules(ir: IR): EmittedFile[] {
  return ir.prompts.map((prompt) =>
    generated(promptPath(toSnakeCase(prompt.id)), moduleText(promptModule(prompt))),
  );
}

export function emitPromptsIndex(ir: IR): EmittedFile {
  const header = [
    importStatement('@aid/runtime', [{ name: 'PromptRegistry', type: false }]),
    importStatement('../../business/prompts/index.js', [{ name: 'OVERRIDES', type: false }]),
    ...ir.prompts.map((prompt) =>
      importStatement(`./${toSnakeCase(prompt.id)}.js`, [
        { name: promptConstant(prompt.id), type: false },
      ]),
    ),
  ].join('\n');
  const names = ir.prompts.map((prompt) => promptConstant(prompt.id));
  const body = [
    `const TEMPLATES = ${arrayLiteral(names, '  ')};`,
    '',
    '/** The generated templates, with any business override layered on top. */',
    'export function buildPrompts(): PromptRegistry {',
    '  const registry = new PromptRegistry();',
    '  for (const template of [...TEMPLATES, ...OVERRIDES]) registry.register(template);',
    '  return registry;',
    '}',
  ].join('\n');
  return generated(paths.promptsIndex, moduleText(header, body));
}
