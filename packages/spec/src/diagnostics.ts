/**
 * Diagnostics are the single currency of every AID build-time gate: the parser,
 * the spec validator, and from the IR package onward every build-time gate emit
 * the same shape, so a user sees one compiler-style report whatever layer
 * rejected the input. Codes are part of the public contract; renaming one is a
 * breaking change.
 */

/** Severity levels, ordered from most to least severe. */
export const SEVERITIES = ['error', 'warning'] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * Every diagnostic code emitted by the spec layer. `spec/not-supported` (defined
 * for a later phase) and `spec/unknown-key` (defined by no version, usually a
 * typo) stay distinct so the message does not lie about which one it is.
 */
export const DIAGNOSTIC_CODES = {
  documentNotAMapping: 'spec/document-not-a-mapping',
  emptyDocument: 'spec/empty-document',
  notSupported: 'spec/not-supported',
  unknownKey: 'spec/unknown-key',
  unsupportedStep: 'spec/unsupported-step',
  schemaViolation: 'spec/schema-violation',
  yamlSyntax: 'spec/yaml-syntax',
  yamlWarning: 'spec/yaml-warning',
  malformedTemplate: 'spec/malformed-template',
  duplicateBinding: 'spec/duplicate-binding',
  metricUnavailableInCi: 'spec/metric-unavailable-in-ci',
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

/** A location inside a spec document: object keys and array indices, from the root. */
export type PathSegment = string | number;

export type DiagnosticPath = readonly PathSegment[];

export interface SourcePosition {
  line: number;
  column: number;
}

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  message: string;
  /** Where in the document the problem is. Empty means "the document as a whole". */
  path: DiagnosticPath;
  file?: string;
  line?: number;
  column?: number;
  /** Optional actionable next step. Rendered on an indented line under the message. */
  hint?: string;
}

/** The subset of fields a diagnostic factory needs. `path` defaults to the document root. */
export interface DiagnosticInit {
  code: DiagnosticCode;
  message: string;
  path?: DiagnosticPath;
  hint?: string;
}

export function errorDiagnostic(init: DiagnosticInit): Diagnostic {
  return { severity: 'error', path: [], ...init };
}

export function warningDiagnostic(init: DiagnosticInit): Diagnostic {
  return { severity: 'warning', path: [], ...init };
}

/** Renders a path the way it would be written in YAML: `pipelines.answer_ticket.steps[0].tool`. */
export function formatPath(path: DiagnosticPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out === '' ? segment : `.${segment}`;
    }
  }
  return out === '' ? '<document>' : out;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
}

/**
 * Deterministic ordering: by file, then position, then code, then message. Ajv
 * reports in schema-traversal order, and the golden-file tests compare rendered
 * output byte for byte, so the sort is what makes output reproducible.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    if (left.file !== right.file) {
      return (left.file ?? '') < (right.file ?? '') ? -1 : 1;
    }
    if ((left.line ?? 0) !== (right.line ?? 0)) {
      return (left.line ?? 0) - (right.line ?? 0);
    }
    if ((left.column ?? 0) !== (right.column ?? 0)) {
      return (left.column ?? 0) - (right.column ?? 0);
    }
    if (left.code !== right.code) {
      return left.code < right.code ? -1 : 1;
    }
    if (left.message !== right.message) {
      return left.message < right.message ? -1 : 1;
    }
    return 0;
  });
}

/** Renders one diagnostic without a trailing newline. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const file = diagnostic.file ?? '<spec>';
  const location =
    diagnostic.line === undefined ? file : `${file}:${diagnostic.line}:${diagnostic.column ?? 1}`;

  const path = formatPath(diagnostic.path);
  let line = `${location}: ${diagnostic.severity}: ${diagnostic.message} [${diagnostic.code}]`;
  if (path !== '<document>') {
    line += `\n    at ${path}`;
  }
  if (diagnostic.hint !== undefined) {
    line += `\n    hint: ${diagnostic.hint}`;
  }
  return line;
}

/** Renders a whole report, one diagnostic per block, with a trailing newline. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return '';
  }
  return `${sortDiagnostics(diagnostics).map(formatDiagnostic).join('\n')}\n`;
}
