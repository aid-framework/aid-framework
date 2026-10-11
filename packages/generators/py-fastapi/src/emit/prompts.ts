/**
 * `app/generated/prompts/`: the prompt registry, one template literal per prompt.
 *
 * Prompts are emitted as *data* (`docs/design.md` §6: the DSL is a prompt registry,
 * not prompt text scattered through code), and the runtime's `PromptRegistry` turns
 * that data into the rendered call. A business module may override a template by
 * name and version, so the generated registry is assembled from the business
 * overrides first and the generated declarations second -- `register` refuses a
 * duplicate name and version, so "last one wins" is the only way to express an
 * override without a second registry.
 */

import type { IR, PromptShape } from '@aid/ir';

import { constantName, moduleName } from '../names.js';
import { interpolate } from '../placeholders.js';
import { argumentString, INDENT, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom, tupleLiteral } from '../template.js';
import type { EmittedFile } from './file.js';
import { BUSINESS_ROOT, business, GENERATED_ROOT, generated } from './file.js';
import { orderedPrompts } from './order.js';
import { pythonDoc } from './text.js';

export const PROMPTS_INIT_PATH = `${GENERATED_ROOT}/prompts/__init__.py`;
export const BUSINESS_PROMPTS_INIT_PATH = `${BUSINESS_ROOT}/prompts/__init__.py`;

export function promptPath(promptId: string): string {
  return `${GENERATED_ROOT}/prompts/${moduleName(promptId)}.py`;
}

/** `version` is a string in the runtime, so a spec's `2` is emitted as `"2"`. */
export function promptVersion(version: number): string {
  return String(version);
}

/**
 * The IR's `{{ name }}` template as the `str.format` body the runtime renders.
 *
 * The two conventions are not the same language. The IR interpolates mustache
 * placeholders, so `{{ name }}` is a substitution site and a lone brace is literal
 * text; the runtime's `PromptTemplate` parses its body with `string.Formatter`, where
 * `{{ name }}` is an *escaped* literal and `{ name }` is the substitution site. Emitting
 * the IR's text unchanged therefore produces a template with no variables at all, and
 * the runtime -- which refuses a value the template never uses -- rejects the render
 * call the generated pipeline makes. {@link interpolate} performs the conversion:
 * the placeholder becomes `{name}` and literal braces are doubled, so the model sees
 * the text the spec asked for and the runtime sees the fields it can bind.
 */
export function runtimeTemplate(template: string): string {
  return interpolate(template, (name) => name);
}

export function emitPromptModule(prompt: PromptShape): EmittedFile {
  const required = [
    ...new Set(prompt.variables.filter((v) => v.required).map((v) => v.name)),
  ].sort();
  const arguments_: string[] = [
    `${INDENT}name=${pythonString(prompt.id)}`,
    `${INDENT}version=${pythonString(promptVersion(prompt.version))}`,
    argumentString('template', runtimeTemplate(prompt.template), INDENT),
  ];
  if (required.length > 0) {
    arguments_.push(
      `${INDENT}required=${tupleLiteral(
        required.map((name) => pythonString(name)),
        INDENT,
        'required=',
      )}`,
    );
  }

  return generated(
    promptPath(prompt.id),
    assemble([
      HEADER,
      pythonDoc(
        `The \`${prompt.id}\` prompt at version ${promptVersion(prompt.version)}, as declared ` +
          'by the spec. Business code can override it by registering the same name and ' +
          'version in app/business/prompts.',
      ),
      importFrom('aid_runtime', ['PromptTemplate']),
      [
        `${constantName(prompt.id)} = PromptTemplate(`,
        ...arguments_.map((argument) => `${argument},`),
        ')',
      ].join('\n'),
    ]),
  );
}

export function emitPromptsInit(ir: IR): EmittedFile {
  const prompts = orderedPrompts(ir);
  const imports = prompts.map(
    (prompt) => `from .${moduleName(prompt.id)} import ${constantName(prompt.id)}`,
  );
  const templates = prompts.map((prompt) => constantName(prompt.id));
  const templatesPrefix = 'TEMPLATES: tuple[PromptTemplate, ...] = ';

  const body = [
    'def build_registry(overrides: Iterable[PromptTemplate] = OVERRIDES) -> PromptRegistry:',
    pythonDoc(
      'A registry holding every generated template, with business overrides applied.',
      INDENT,
    ),
    `${INDENT}selected: dict[tuple[str, str], PromptTemplate] = {`,
    `${INDENT}${INDENT}(template.name, template.version): template for template in TEMPLATES`,
    `${INDENT}}`,
    `${INDENT}for override in overrides:`,
    `${INDENT}${INDENT}selected[(override.name, override.version)] = override`,
    `${INDENT}ordered = [selected[key] for key in sorted(selected)]`,
    `${INDENT}return PromptRegistry(templates=tuple(ordered))`,
  ];

  return generated(
    PROMPTS_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The prompt registry for this app. Register a business override with ' +
          '`OVERRIDES` in app/business/prompts to replace a generated template without ' +
          'editing generated code.',
      ),
      importBlock([
        [importFrom('collections.abc', ['Iterable'])],
        [importFrom('aid_runtime', ['PromptRegistry', 'PromptTemplate'])],
        ['from ...business.prompts import OVERRIDES', ...imports],
      ]),
      `${templatesPrefix}${tupleLiteral(templates, '', templatesPrefix)}`,
      body.join('\n'),
    ]),
  );
}

/**
 * The business prompts seed: written once, then owned by the developer.
 *
 * The generated registry reads `OVERRIDES` at import time, so this file has to exist
 * for a fresh generation to be importable at all. It is seeded empty rather than
 * pre-filled: a developer adds an override by copying a generated template's name and
 * version, which is the only way to replace one without editing generated code.
 */
export function emitBusinessPromptsInit(): EmittedFile {
  return business(
    BUSINESS_PROMPTS_INIT_PATH,
    assemble(
      [
        HEADER,
        pythonDoc(
          'Your prompt overrides. A template registered here replaces the generated ' +
            'template with the same name and version.',
        ),
        importFrom('aid_runtime', ['PromptTemplate']),
        'OVERRIDES: tuple[PromptTemplate, ...] = ()',
      ],
      'business',
    ),
  );
}
