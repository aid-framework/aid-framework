/**
 * `aid review` — the review pack for one service: what the build proved, and what only the
 * platform owner can confirm.
 *
 * The framework's delivery story ends at a document. `aid validate` proves the document is
 * buildable, and the profile gate proves an enterprise spec *declares* its controls. Neither
 * can take the next step: no build opens a connection to an identity provider, inspects a
 * VPC, or asks whether the named approvers are real people. A reviewer handed "the gates
 * passed" will reasonably assume they did.
 *
 * So this command prints the split rather than a verdict. It re-uses the same read and
 * lower pipeline `aid validate` uses, adds no gate of its own, and refuses the same specs --
 * a review pack for a spec the build rejects would itemise controls the build never reached.
 * What it adds is the second list: every declaration the spec makes that survives the build
 * as a claim, with the exact path a reviewer has to go and confirm.
 *
 * It reads files and nothing else, so it runs in CI and produces the same pack every time.
 * A pack is a starting point for a review, never a substitute for one.
 */

import type { DeploymentShape, IR } from '@aid-framework/ir';
import { countBySeverity } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import { EXIT_FAILURE, EXIT_OK } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';

export interface ReviewOptions {
  readonly spec: string | undefined;
}

/** One thing the spec claims and the build cannot check. */
export interface UnverifiedControl {
  readonly control: string;
  readonly declared: string;
  readonly path: string;
}

/**
 * Every declaration on a deployment that the gates check for *presence and shape* and that
 * no build can check for *truth*. Ordered as the spec declares them, so a diff of two packs
 * reads like a diff of two specs.
 */
function controlsOf(deployment: DeploymentShape): UnverifiedControl[] {
  const at = `deployments.${deployment.id}`;
  const controls: UnverifiedControl[] = [];

  if (deployment.cloud !== undefined) {
    controls.push({
      control: 'cloud',
      declared: deployment.cloud,
      path: `${at}.cloud`,
    });
  }
  if (deployment.region !== undefined) {
    controls.push({
      control: 'region pin',
      declared: deployment.region,
      path: `${at}.region`,
    });
  }
  if (deployment.audit !== undefined) {
    controls.push({
      control: 'audit sink',
      declared: deployment.audit.sink,
      path: `${at}.audit.sink`,
    });
    if (deployment.audit.retentionDays !== undefined) {
      controls.push({
        control: 'audit retention',
        declared: `${deployment.audit.retentionDays} days`,
        path: `${at}.audit.retentionDays`,
      });
    }
  }
  if (deployment.identity !== undefined) {
    controls.push({
      control: 'identity issuer',
      declared: deployment.identity.issuer,
      path: `${at}.identity.issuer`,
    });
    if (deployment.identity.audience !== undefined) {
      controls.push({
        control: 'identity audience',
        declared: deployment.identity.audience,
        path: `${at}.identity.audience`,
      });
    }
  }
  if (deployment.network !== undefined) {
    controls.push({
      control: 'private networking',
      declared: deployment.network.private ? 'private' : 'public',
      path: `${at}.network.private`,
    });
    if (deployment.network.egress !== undefined) {
      controls.push({
        control: 'egress policy',
        declared: deployment.network.egress,
        path: `${at}.network.egress`,
      });
    }
  }
  if (deployment.approvals !== undefined) {
    controls.push({
      control: 'approval policy',
      declared:
        deployment.approvals.require.length === 0
          ? 'no approvers named'
          : deployment.approvals.require.join(', '),
      path: `${at}.approvals.require`,
    });
    controls.push({
      control: 'minimum approvers',
      declared: String(deployment.approvals.minApprovers),
      path: `${at}.approvals.minApprovers`,
    });
  }
  if (deployment.secrets.length > 0) {
    controls.push({
      control: 'secret references',
      declared: deployment.secrets.join(', '),
      path: `${at}.secrets`,
    });
  }

  return controls;
}

function controlsFor(ir: IR): UnverifiedControl[] {
  return ir.deployments.flatMap(controlsOf);
}

/** A two-column block wide enough for any control name, so the pack stays diffable. */
function table(controls: readonly UnverifiedControl[]): string[] {
  if (controls.length === 0) return ['  nothing is declared, so there is nothing here to confirm'];
  const width = Math.max(...controls.map((control) => control.control.length));
  return controls.map(
    (control) => `  ${control.control.padEnd(width)}  ${control.declared}  (${control.path})`,
  );
}

export function review(context: CliContext, options: ReviewOptions): CommandOutcome {
  const command = 'review';
  const specPath = options.spec ?? DEFAULT_SPEC_PATH;

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { spec: specPath },
      diagnostics: read.diagnostics,
    });
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    const counts = countBySeverity(lowered.diagnostics);
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { spec: specPath, counts },
      diagnostics: lowered.diagnostics,
      text: `${specPath}: not reviewable, the build refuses it (${counts.error} error(s))`,
    });
  }

  const ir = lowered.ir;
  const controls = controlsFor(ir);
  const counts = countBySeverity(lowered.diagnostics);

  const text = [
    `review pack for ${specPath} (profile ${ir.profile})`,
    '',
    'the build verified',
    `  the spec parses, reduces to the IR, and every build-time gate accepted it`,
    `  ${counts.warning} warning(s) at build time`,
    '',
    'the build did not verify',
    ...table(controls),
    '',
    'The build reads the document. It does not contact your identity provider, look inside',
    'your network, or ask your approvers whether they agreed. Confirm each line above with',
    'the owner of that system before you approve the change.',
  ].join('\n');

  return outcome({
    command,
    exitCode: EXIT_OK,
    fields: {
      spec: specPath,
      profile: ir.profile,
      counts,
      deployments: ir.deployments.map((deployment) => deployment.id),
      unverified: controls,
    },
    diagnostics: lowered.diagnostics,
    text,
  });
}
