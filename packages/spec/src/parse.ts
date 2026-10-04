import { LineCounter, parseDocument } from 'yaml';
import {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  errorDiagnostic,
  warningDiagnostic,
} from './diagnostics.js';
import { SourceDocument } from './source-document.js';

export interface ParseOptions {
  /** Path used in diagnostics. Defaults to `<spec>`. */
  file?: string;
}

export interface ParseResult {
  document: SourceDocument;
  diagnostics: Diagnostic[];
  /** The plain JavaScript value, or `undefined` when the YAML could not be parsed. */
  value: unknown;
}

/**
 * Parses spec YAML into a value plus syntax diagnostics when the YAML itself is
 * broken. Only syntax is judged here; schema and semantic rules live in
 * `validate.ts`, which keeps this a pure function of the text.
 */
export function parseSpecDocument(text: string, options: ParseOptions = {}): ParseResult {
  const lineCounter = new LineCounter();
  const yaml = parseDocument(text, {
    lineCounter,
    // YAML's own pretty error block is off: this package formats the position.
    prettyErrors: false,
    uniqueKeys: true,
    strict: true,
  });

  const document = new SourceDocument(text, options.file, yaml, lineCounter);
  const diagnostics: Diagnostic[] = [];

  // Attach the file name only when one is known, as `validate.ts` does.
  const withFile = (diagnostic: Diagnostic): Diagnostic =>
    options.file === undefined ? diagnostic : { ...diagnostic, file: options.file };

  for (const failure of yaml.errors) {
    const offset = failure.pos[0];
    const { line, col } = lineCounter.linePos(offset);
    diagnostics.push(
      withFile({
        ...errorDiagnostic({
          code: DIAGNOSTIC_CODES.yamlSyntax,
          message: failure.message,
        }),
        line,
        column: col,
      }),
    );
  }

  for (const warning of yaml.warnings) {
    const offset = warning.pos[0];
    const { line, col } = lineCounter.linePos(offset);
    diagnostics.push(
      withFile({
        ...warningDiagnostic({
          code: DIAGNOSTIC_CODES.yamlWarning,
          message: warning.message,
        }),
        line,
        column: col,
      }),
    );
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { document, diagnostics, value: undefined };
  }

  let value: unknown;
  try {
    // `maxAliasCount` guards against a YAML alias bomb.
    value = yaml.toJS({ maxAliasCount: 100 });
  } catch (cause) {
    diagnostics.push(
      withFile(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.yamlSyntax,
          message:
            cause instanceof Error
              ? cause.message
              : 'the document could not be converted to a value',
        }),
      ),
    );
    return { document, diagnostics, value: undefined };
  }

  return { document, diagnostics, value };
}

// A well-formed placeholder: `{{ name }}`, `{{ ticket.subject }}`, `{{_x}}`.
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * Detects a malformed `{{ }}` placeholder by removing every well-formed one and
 * inspecting the remainder. Counting braces would be wrong in both directions:
 * `{{ a }} {{ b }}` is balanced and fine, `{{ a }` is not.
 */
export function findMalformedTemplate(text: string): string | undefined {
  const remainder = text.replace(PLACEHOLDER, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    return 'contains a malformed `{{ }}` placeholder (expected e.g. `{{ name }}`)';
  }
  return undefined;
}
