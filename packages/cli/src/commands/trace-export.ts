/**
 * `aid trace export` — turn traced runs into a dataset file an eval can read.
 *
 * The trace sink records *what happened*. With `AID_TRACE_CONTENT=1` it also records
 * *what was said*, which is the one thing a dataset needs: without an input there is no
 * case, and inventing one by asking the model again would answer a different question
 * while looking like an answer to this one. So this command refuses rather than
 * approximating, and its most common refusal is "the runs in this directory recorded no
 * payloads" with the variable that fixes it.
 *
 * What a case is, exactly: **one trace is one case**. `input` is the prompt the run was
 * first given, `expected` is the answer it last produced. For a single-call run those are
 * two attributes of the same span, so the case is an exact record of the call. For a
 * multi-step agent run the pair means "given this prompt, the run ended with this answer",
 * which is the behaviour worth regressing on -- and is what the spans say, not a guess.
 *
 * What it is **not**: a curated eval set. The `expected` is the behaviour a run happened
 * to produce, so `exact-match` against it measures *stability*, not quality -- any good
 * rewording fails it. Every case is therefore tagged `unreviewed`, and the honest next
 * step is a human editing the file (and removing the tag) rather than a build that trusts
 * it. A dataset is versioned and the eval gate refuses to compare across versions, so
 * bumping `--version` is the deliberate act that marks a curation pass.
 *
 * ## The spec decides what may be exported
 *
 * An export writes prompts and completions verbatim, so it is the one command that can
 * move text out of a deployment and into a git-tracked file. It therefore reads the spec
 * (`--spec`, defaulting to the project's `app/app.spec.yaml`) and refuses in two cases
 * rather than exporting content the document does not allow:
 *
 * - the spec says a trace must never carry some field, and this command cannot strip a
 *   *named* field out of prose -- so it writes nothing rather than something forbidden;
 * - the profile is `enterprise`, where captured content may not leave the deployment at
 *   all until a redaction hook exists to remove what must not travel.
 *
 * Both refusals disappear when runtime redaction ships; that is the point of asking here,
 * where a wrong answer is recoverable, rather than at review time, where it is not.
 *
 * Exit codes:
 *
 * - `2` for a wrong invocation: no `--dataset`, a `--filter` that is not
 *   `agent=<id>`, a spec that cannot be read or does not pass its gates, a spec whose
 *   policy forbids exporting captured content, a directory with nothing exportable in
 *   it, or an existing file this would overwrite without `--force`.
 * - `1` only when the dataset could not be written.
 * - `0` when the file was written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { group, outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';
import type { TraceRun, TraceSpan } from '../trace.js';
import { ATTRIBUTES, runsOf } from '../trace.js';
import { displayPath, readTraceDir, resolveTraceDir, TRACE_DIR_ENV } from '../trace-dir.js';

export interface TraceExportOptions {
  /** The dataset's `name`, and the default file stem. Required. */
  readonly dataset: string | undefined;
  /** The directory to read; defaults to `$AID_TRACE_DIR`. */
  readonly dir: string | undefined;
  /** `agent=<id>`: only export runs whose agent span names this agent. */
  readonly filter: string | undefined;
  /** The spec whose policy governs the export; defaults to the project's spec. */
  readonly spec: string | undefined;
  /** The dataset's `version`; defaults to `1`. */
  readonly version: string | undefined;
  /** Where to write; defaults to `datasets/<name>.json`. */
  readonly out: string | undefined;
  /** Replace an existing file instead of refusing. */
  readonly force: boolean;
}

/** One case, in the shape `Dataset`/`EvalCase` validate. */
interface ExportedCase {
  readonly id: string;
  readonly input: string;
  readonly expected: string;
  /** Written in the order Python's `sort_keys=True` would, so the bytes match. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

function textOf(span: TraceSpan, name: keyof typeof ATTRIBUTES): string | undefined {
  const value = span.attributes?.[ATTRIBUTES[name]];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isClient(span: TraceSpan): boolean {
  return span.kind === 'CLIENT';
}

/**
 * The agent a run belongs to, when one recorded it.
 *
 * Read off the run's own spans rather than passed in, because the agent id lives on the
 * agent span while the payloads live on the model-call spans below it; a run with no
 * agent span is a plain pipeline call and belongs to no agent.
 */
function agentOf(run: TraceRun): string | undefined {
  for (const span of run.spans) {
    const agent = textOf(span, 'agentId');
    if (agent !== undefined) return agent;
  }
  return undefined;
}

/**
 * A case from one run, or the reason the run cannot contribute one.
 *
 * The prompt is the first model call's input, not the last: an agent's later calls carry
 * tool observations, which are the loop's own bookkeeping rather than the question the
 * run was asked.
 */
function caseOf(
  run: TraceRun,
): { readonly case: ExportedCase } | { readonly missing: 'input' | 'expected' } {
  const paying = run.spans.filter(isClient);

  let prompt: string | undefined;
  let model: string | undefined;
  let toolNames: string | undefined;
  for (const span of paying) {
    prompt = textOf(span, 'inputText');
    if (prompt === undefined) continue;
    model = textOf(span, 'responseModel') ?? textOf(span, 'requestModel');
    toolNames = textOf(span, 'toolNames');
    break;
  }
  if (prompt === undefined) return { missing: 'input' };

  // The answer the run ended with. Searched from the end so a failed final step, which
  // recorded no output, does not hide the answer an earlier step did produce.
  let expected: string | undefined;
  for (const span of [...paying].reverse()) {
    expected = textOf(span, 'outputText');
    if (expected !== undefined) break;
  }
  if (expected === undefined) return { missing: 'expected' };

  const agent = agentOf(run);

  return {
    case: {
      // The trace id *is* the case's identity: it is what ties an exported case back to
      // the run it came from, and two runs cannot share one.
      id: run.traceId,
      input: prompt,
      expected,
      metadata: {
        ...(agent === undefined ? {} : { agent }),
        calls: String(paying.length),
        cost_usd: String(run.costUsd),
        duration_ms: String(run.durationMs),
        ...(model === undefined ? {} : { model }),
        started_at: run.startedAt,
        ...(toolNames === undefined ? {} : { tools: toolNames }),
        trace_id: run.traceId,
      },
      // `unreviewed` is the point: nobody has looked at this case, so nothing should
      // treat it as a judgement about what a good answer is.
      tags: ['trace-export', 'unreviewed'],
    },
  };
}

/**
 * Serialise a dataset the way Python's `json.dumps(indent=2, sort_keys=True)` does.
 *
 * The two writers must agree byte for byte or a dataset regenerated by the CLI would
 * diff against the one a Python tool wrote from the same cases, which is the noise the
 * canonical form exists to prevent. Sorted keys come from building the object in sorted
 * order; `ensure_ascii` comes from escaping every non-ASCII code unit, surrogates
 * included, exactly as Python escapes them.
 */
function canonicalJson(value: unknown): string {
  const body = JSON.stringify(value, null, 2).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${body}\n`;
}

/**
 * Copy an object with its keys in sorted order.
 *
 * Python's `sort_keys=True` sorts every object in the document, not just the top level,
 * so `metadata` has to be ordered too. Sorting here rather than relying on the literal's
 * order keeps a future field from silently changing the bytes.
 */
function sortedKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const ordered: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) ordered[key] = record[key] as T;
  return ordered;
}

function datasetJson(name: string, version: string, cases: readonly ExportedCase[]): string {
  return canonicalJson({
    // Sorted: cases, name, version.
    cases: cases.map((item) => ({
      // Sorted: expected, id, input, metadata, tags.
      expected: item.expected,
      id: item.id,
      input: item.input,
      metadata: sortedKeys(item.metadata),
      tags: item.tags,
    })),
    name,
    version,
  });
}

/**
 * What the spec says about exporting recorded text.
 *
 * `withheld` is the trace redaction set, which the security gate has already refused if
 * it is looser than the fields the IR marks sensitive. An empty set means the document
 * forbids nothing, and an export may write the payloads it captured.
 */
interface ExportPolicy {
  readonly specPath: string;
  readonly profile: string;
  readonly withheld: readonly string[];
}

type PolicyRead =
  | { readonly ok: true; readonly policy: ExportPolicy }
  | { readonly ok: false; readonly outcome: CommandOutcome };

/**
 * Read the spec and decide whether this project may export captured content.
 *
 * `lowerSpec` is the same path `aid validate` takes, gates included, so an export can
 * never be produced from a document the build would refuse -- which matters here more
 * than elsewhere, because the output is a committed file other tooling trusts.
 */
function exportPolicy(context: CliContext, specPath: string): PolicyRead {
  const read = readSpec(context, specPath);
  if (!read.ok) {
    return {
      ok: false,
      outcome: refusal(
        CLI_DIAGNOSTIC_CODES.traceExportSpecRequired,
        `cannot read the spec at "${specPath}", and an export applies the policy it declares.`,
        `Pass --spec <path> to name the document, or run \`aid init\` (the default is ${DEFAULT_SPEC_PATH}).`,
        `aid: cannot read the spec at "${specPath}". Pass --spec <path>.\n`,
        EXIT_USAGE,
      ),
    };
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    return {
      ok: false,
      outcome: outcome({
        command: 'trace export',
        exitCode: EXIT_FAILURE,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.traceExportSpecInvalid,
            message: `"${specPath}" does not pass its build-time gates, so there is no agreed policy for what a trace may carry.`,
            hint: 'Run `aid validate` on the same file and fix what it reports.',
          }),
          ...lowered.diagnostics,
        ],
        text: `aid: "${specPath}" does not pass its gates; nothing was exported.\n`,
      }),
    };
  }

  const policy: ExportPolicy = {
    specPath,
    profile: lowered.ir.profile,
    withheld: lowered.ir.observability.redact,
  };

  // `enterprise` promises that what leaves a deployment can be accounted for. Captured
  // prompts and completions leave verbatim, and no runtime hook removes anything from
  // them yet, so there is no honest enterprise export of content to offer.
  if (policy.profile === 'enterprise') {
    return {
      ok: false,
      outcome: refusal(
        CLI_DIAGNOSTIC_CODES.traceExportEnterpriseCapture,
        `"${specPath}" is an enterprise document, and capturing prompts and completions into a dataset is content leaving the deployment.`,
        'Nothing in the runtime removes a withheld field from recorded text yet, so no enterprise export of content can be made. Record the runs without AID_TRACE_CONTENT=1 to export structure only, or wait for trace redaction to ship.',
        'aid: an enterprise profile does not export captured content.\n',
        EXIT_USAGE,
      ),
    };
  }

  if (policy.withheld.length > 0) {
    return {
      ok: false,
      outcome: refusal(
        CLI_DIAGNOSTIC_CODES.traceExportRedactionUnapplied,
        `"${specPath}" declares ${group(policy.withheld.length)} field(s) a trace must never carry (${policy.withheld.join(', ')}), and an export writes the recorded text verbatim.`,
        'This command cannot strip a named field out of prose, so it exports nothing rather than text the document forbids. Remove the declaration if the field may appear in a trace; the runtime hook that applies it is what will lift this refusal.',
        `aid: "${specPath}" forbids ${policy.withheld.join(', ')} in a trace; nothing was exported.\n`,
        EXIT_USAGE,
      ),
    };
  }

  return { ok: true, policy };
}

function refusal(
  code: (typeof CLI_DIAGNOSTIC_CODES)[keyof typeof CLI_DIAGNOSTIC_CODES],
  message: string,
  hint: string,
  text: string,
  exitCode: ExitCode,
): CommandOutcome {
  return outcome({
    command: 'trace export',
    exitCode,
    diagnostics: [cliError({ code, message, hint })],
    text,
  });
}

export function traceExport(context: CliContext, options: TraceExportOptions): CommandOutcome {
  const command = 'trace export';

  const name = options.dataset?.trim();
  if (name === undefined || name === '') {
    return refusal(
      CLI_DIAGNOSTIC_CODES.traceExportDatasetRequired,
      'no dataset name: `aid trace export` writes a dataset, and a dataset has a name.',
      "Pass --dataset <name>. The name becomes the dataset's `name` and the default file `datasets/<name>.json`.",
      'aid: --dataset <name> is required.\n',
      EXIT_USAGE,
    );
  }

  let agentFilter: string | undefined;
  if (options.filter !== undefined) {
    const match = /^agent=(.+)$/.exec(options.filter.trim());
    const wanted = match?.[1]?.trim();
    if (wanted === undefined || wanted === '') {
      return refusal(
        CLI_DIAGNOSTIC_CODES.traceExportFilterInvalid,
        `--filter ${options.filter} is not a filter this command understands.`,
        'The only filter is --filter agent=<id>, where <id> is the agent id the spec declares.',
        `aid: --filter ${options.filter} is not supported. Use --filter agent=<id>.\n`,
        EXIT_USAGE,
      );
    }
    agentFilter = wanted;
  }

  const version = options.version?.trim() ?? '';
  const resolvedVersion = version === '' ? '1' : version;

  const specPath = options.spec ?? DEFAULT_SPEC_PATH;
  const policy = exportPolicy(context, specPath);
  if (!policy.ok) return policy.outcome;

  const resolved = resolveTraceDir(context, options.dir, command, '--from <dir>');
  if (resolved.kind === 'refused') return resolved.outcome;
  const shown = resolved.shown;

  const diagnostics: CliDiagnostic[] = [];
  const { files, spans, skipped, unreadable } = readTraceDir(resolved.absolute);

  if (unreadable > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.traceUnreadable,
        message: `could not read ${unreadable} trace file(s) in "${shown}": this dataset covers only the files that were readable.`,
        hint: 'Check the file permissions, or move the unreadable file out of the directory.',
      }),
    );
  }
  if (skipped > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceMalformed,
        message: `skipped ${skipped} line(s) in "${shown}" that are not complete span records.`,
        hint: 'A trace file is appended to while it is read, so a truncated last line is normal; a large count is not.',
      }),
    );
  }
  if (files.length === 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceEmpty,
        message: `no trace files in "${shown}".`,
        hint: `The runtime writes one when ${TRACE_DIR_ENV} is set and a model call runs; check that this is the directory it names.`,
      }),
    );
  }

  const allRuns = runsOf(spans);
  const selected =
    agentFilter === undefined ? allRuns : allRuns.filter((run) => agentOf(run) === agentFilter);

  if (agentFilter !== undefined && allRuns.length > 0 && selected.length === 0) {
    return refusal(
      CLI_DIAGNOSTIC_CODES.traceExportFilterNoMatch,
      `no run in "${shown}" belongs to agent "${agentFilter}".`,
      'Run `aid trace --dir <dir>` to list the runs and their root spans, and check the agent id against the spec. Without --filter every run is exported.',
      `aid: no run belongs to agent "${agentFilter}".\n`,
      EXIT_USAGE,
    );
  }

  const cases: ExportedCase[] = [];
  let withoutInput = 0;
  let withoutExpected = 0;
  for (const run of selected) {
    const result = caseOf(run);
    if ('case' in result) cases.push(result.case);
    else if (result.missing === 'input') withoutInput += 1;
    else withoutExpected += 1;
  }

  if (cases.length === 0) {
    // The common case, and the one worth its own words: the runs exist and cost money,
    // but nobody asked the sink to keep the text.
    const payloads = selected.some((run) => run.spans.some(isClient));
    return refusal(
      CLI_DIAGNOSTIC_CODES.traceExportNoCases,
      selected.length === 0
        ? `"${shown}" has no runs to export: ${group(files.length)} trace file(s), ${group(spans.length)} span(s), none of them a run.`
        : `none of the ${group(selected.length)} run(s) in "${shown}" can become a case: ${group(withoutInput)} recorded no prompt text, ${group(withoutExpected)} no answer text.`,
      payloads
        ? `Re-run the application with AID_TRACE_CONTENT=1 (and ${TRACE_DIR_ENV} pointing at this directory) so the sink records prompts and completions, then export again.`
        : `The spans in "${shown}" carry no model calls. Point --from at the directory ${TRACE_DIR_ENV} names, and check that the application ran.`,
      selected.length === 0
        ? `aid: no runs in "${shown}" to export.\n`
        : `aid: no run in "${shown}" can become a case.\n`,
      EXIT_USAGE,
    );
  }

  // Chronological, then by id, so two exports of the same spans produce the same bytes.
  cases.sort((left, right) => {
    const leftAt = left.metadata.started_at ?? '';
    const rightAt = right.metadata.started_at ?? '';
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  if (withoutInput > 0 || withoutExpected > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceExportPartial,
        message: `${group(withoutInput + withoutExpected)} run(s) could not become a case and were left out: ${group(withoutInput)} recorded no prompt text, ${group(withoutExpected)} no answer text.`,
        hint: 'A run whose model call failed records no answer. Set AID_TRACE_CONTENT=1 before the run that should be exportable.',
      }),
    );
  }

  const target = resolve(context.cwd, options.out ?? `datasets/${name}.json`);
  const targetShown = displayPath(context.cwd, target);

  try {
    mkdirSync(dirname(target), { recursive: true });
    // `wx` creates only if the file is absent, so "does this exist" and "write it" are one
    // operation rather than a check followed by a write something can slip between.
    writeFileSync(target, datasetJson(name, resolvedVersion, cases), {
      encoding: 'utf8',
      flag: options.force ? 'w' : 'wx',
    });
  } catch (error) {
    if (!options.force && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return refusal(
        CLI_DIAGNOSTIC_CODES.traceExportWouldOverwrite,
        `"${targetShown}" already exists, and a dataset may have been curated by hand since it was generated.`,
        'Pass --force to replace it, or --out <path> to write somewhere else. Bump --version when the cases change, because the eval gate refuses to compare across versions.',
        `aid: "${targetShown}" already exists. Pass --force to replace it.\n`,
        EXIT_USAGE,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    return refusal(
      CLI_DIAGNOSTIC_CODES.traceExportUnwritable,
      `could not write "${targetShown}": ${reason}`,
      'Check that the directory is writable, or pass --out <path> for somewhere that is.',
      `aid: could not write "${targetShown}".\n`,
      EXIT_FAILURE,
    );
  }

  const exitCode = unreadable > 0 ? EXIT_FAILURE : EXIT_OK;
  return outcome({
    command,
    exitCode,
    fields: {
      dir: shown,
      files: files.length,
      spans: spans.length,
      runs: selected.length,
      dataset: name,
      version: resolvedVersion,
      path: targetShown,
      cases: cases.length,
      leftOut: withoutInput + withoutExpected,
      spec: specPath,
      profile: policy.policy.profile,
    },
    diagnostics,
    text: [
      `dataset: ${name}@${resolvedVersion}`,
      `cases: ${group(cases.length)} from ${group(selected.length)} run(s)  ${targetShown}`,
      ...(withoutInput + withoutExpected === 0
        ? []
        : [`left out: ${group(withoutInput + withoutExpected)} run(s) with no exportable payload`]),
      `policy: ${policy.policy.profile}, ${specPath} withholds no field from a trace`,
      `next: set evals[].dataset.uri to "${targetShown}" and curate the cases (every one is tagged "unreviewed").`,
    ].join('\n'),
  });
}
