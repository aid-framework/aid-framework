/**
 * `aid fleet` -- every customer this repository serves, read straight off the tree.
 *
 * There is no fleet database and no `aid fleet register`. A customer exists because an
 * overlay file declares one, and everything the table reports (profile, pinned models,
 * regions, cost ceilings, gate status) is derived from that file and the base it resolves
 * against. The repository is the inventory, which is what makes the fleet queryable in CI,
 * reviewable in a pull request, and reproducible on a laptop with no account anywhere.
 *
 * Discovery is by content, not by directory: a `.yaml` file is an overlay when it parses
 * as one. A convention would need documenting and would be wrong for the first team that
 * keeps overlays under `tenants/`; the file format is already the convention.
 *
 * `status` is the answer *now*, not a remembered verdict: every overlay is resolved and put
 * through `buildIR` and all 26 gates, so a table that says `ok` means the specification
 * this customer would be built from passes today. A stale committed marker would let the
 * table claim a green build for a base that has since changed underneath it.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseOverlay } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome, usd } from '../output.js';
import type { ResolvedOverlay } from '../overlays.js';
import { resolveOverlay } from '../overlays.js';
import { absolutePath } from '../paths.js';

export interface FleetOptions {
  readonly dir: string | undefined;
}

/** Directories that never hold a hand-written overlay, and that make the walk slow. */
const SKIP = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'dist',
  'node_modules',
  'vendor',
]);

/** Every `.yaml`/`.yml` file under `root`, repository-relative and POSIX-joined. */
function yamlFiles(root: string, prefix = '', depth = 0): string[] {
  if (depth > 8) return [];
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, ...prefix.split('/').filter(Boolean)), {
      withFileTypes: true,
    });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...yamlFiles(root, path, depth + 1));
    } else if (/\.ya?ml$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Row {
  readonly overlay: string;
  readonly customer: string;
  readonly profile: string;
  readonly models: string;
  readonly regions: string;
  readonly ceiling: string;
  readonly status: string;
  readonly applied: number;
  readonly codes: readonly string[];
}

/** The customer's pinned models, in declaration order and deduplicated. */
function pinnedModels(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.models)) return '-';
  const ids = new Set<string>();
  for (const model of Object.values(value.models)) {
    if (!isRecord(model)) continue;
    const id = model.modelId ?? model.model;
    if (typeof id === 'string') ids.add(id);
  }
  return ids.size === 0 ? '-' : [...ids].join(',');
}

/** Every region the customer's deployments pin, which is the residency answer. */
function regionsOf(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.deployments)) return '-';
  const regions = new Set<string>();
  for (const deployment of Object.values(value.deployments)) {
    if (isRecord(deployment) && typeof deployment.region === 'string')
      regions.add(deployment.region);
  }
  return regions.size === 0 ? '-' : [...regions].join(',');
}

/**
 * The sum of the customer's per-run cost ceilings. A sum rather than a list because the
 * fleet question is "what is the worst case here", and one number answers it; an agent with
 * no ceiling contributes nothing and is a spec the profile gate already refuses for
 * enterprise customers.
 */
function ceilingOf(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.agents)) return '-';
  let total = 0;
  let found = false;
  for (const agent of Object.values(value.agents)) {
    if (isRecord(agent) && typeof agent.maxCostBudget === 'number') {
      total += agent.maxCostBudget;
      found = true;
    }
  }
  return found ? usd(total) : '-';
}

function rowOf(resolved: ResolvedOverlay, value: unknown): Row {
  // An overlay whose base is missing resolved to no document at all, so the fleet has
  // nothing to report and must not fall back to the schema default -- printing "standard"
  // for a customer with no readable spec would be a guess.
  const profile =
    isRecord(value) && typeof value.profile === 'string'
      ? value.profile
      : value === undefined
        ? '-'
        : 'standard';
  const errors = resolved.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  return {
    overlay: resolved.overlayPath,
    customer: resolved.customer ?? '-',
    profile,
    models: pinnedModels(value),
    regions: regionsOf(value),
    ceiling: ceilingOf(value),
    status: resolved.ok ? 'ok' : `refused (${errors.length})`,
    applied: resolved.applied.length,
    codes: errors.map((diagnostic) => diagnostic.code),
  };
}

export function fleet(context: CliContext, options: FleetOptions): CommandOutcome {
  const command = 'fleet';
  const dir = options.dir ?? '.';

  try {
    if (!statSync(absolutePath(context.cwd, dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.fleetDirUnreadable,
          message: `"${dir}" is not a directory this command can read.`,
          path: [dir],
          hint: 'Pass the directory that holds your overlays, or no argument for the root.',
        }),
      ],
    });
  }

  const overlays: string[] = [];
  const root = absolutePath(context.cwd, dir);
  // The walk is rooted at `dir`, so the paths it returns are relative to `dir`. Re-prefixing
  // them with `dir` is what makes the reported overlay path the one `aid resolve` accepts;
  // passing `dir` into the walk as well would make it look for `dir/dir`.
  const prefix = dir === '.' ? '' : `${dir.replace(/\/+$/, '')}/`;
  for (const found of yamlFiles(root)) {
    const path = `${prefix}${found}`;
    let text: string;
    try {
      text = readFileSync(absolutePath(context.cwd, path), 'utf8');
    } catch {
      continue;
    }
    // A file is an overlay when it parses as one. The diagnostics are discarded here: this
    // is a discovery test, and a spec file that is not an overlay is not a mistake.
    if (parseOverlay(text).overlay !== undefined) overlays.push(path);
  }

  if (overlays.length === 0) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { dir, counts: { customers: 0, ok: 0, refused: 0 } },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.fleetNoOverlays,
          message: `No overlay files under "${dir}", so there is no fleet to report.`,
          path: [dir],
          hint: 'An overlay is a YAML file with `base`, `customer` and `overrides`. Run `aid init --template support-copilot` to see one.',
        }),
      ],
      text: `no customer overlays under ${dir}`,
    });
  }

  const rows: Row[] = [];
  const diagnostics: CliDiagnostic[] = [];
  for (const path of overlays.sort()) {
    const resolved = resolveOverlay(context, path);
    rows.push(rowOf(resolved, resolved.value));
    diagnostics.push(...resolved.diagnostics);
  }
  rows.sort((left, right) =>
    left.customer === right.customer
      ? left.overlay.localeCompare(right.overlay)
      : left.customer.localeCompare(right.customer),
  );

  const refused = rows.filter((row) => row.status !== 'ok');
  const counts = {
    customers: rows.length,
    ok: rows.length - refused.length,
    refused: refused.length,
  };

  const header = ['customer', 'profile', 'models', 'region', 'ceiling', 'status'];
  const body = rows.map((row) => [
    row.customer,
    row.profile,
    row.models,
    row.regions,
    row.ceiling,
    row.status,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => cells[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()}`;

  const text = [
    `${counts.customers} customer${counts.customers === 1 ? '' : 's'} under ${dir}`,
    '',
    line(header),
    ...body.map(line),
  ].join('\n');

  return outcome({
    command,
    exitCode: refused.length === 0 ? EXIT_OK : EXIT_FAILURE,
    fields: {
      dir,
      counts,
      customers: rows.map((row) => ({
        overlay: row.overlay,
        customer: row.customer,
        profile: row.profile,
        models: row.models,
        regions: row.regions,
        costCeiling: row.ceiling,
        applied: row.applied,
        status: row.status,
        codes: row.codes,
      })),
    },
    diagnostics,
    text,
  });
}
