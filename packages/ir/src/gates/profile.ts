/**
 * Profile — one gate, `profile`, that enforces what a profile promises.
 *
 * A `profile` is a bundle of controls, and a bundle that is not enforced is a label. So
 * the enterprise profile exports two obligations to the build: every deployment pins the
 * region its data must stay in and the sink its audit record must land in, and the
 * document declares at least one guardrail that inspects model *output*. Both are
 * properties of the spec alone, which is what lets `aid validate` refuse them without a
 * cloud account, a CLI flag, or a network call.
 *
 * The gate also owns the target-consistency checks, because a region or an audit sink is
 * only meaningful against a named cloud: `eu-west-1` is not a GCP region and
 * `google_logging_project_sink` is not something AWS can create. Those checks run for
 * every profile, including documents that declare none -- an unvalidated region is wrong
 * regardless of which controls the document promised. For the same reason it refuses a
 * document whose deployments disagree about their placement: one module set targets one
 * cloud, and one environment has one audit destination, so a second value would silently
 * be generated for the wrong provider or dropped in favour of the first.
 *
 * From spec 0.26 the enterprise bundle also owns the controls that make a deployment
 * defensible in a review: it names the identity provider that callers authenticate
 * against, it places the workload in a private network, and it records who has to sign
 * off before a change lands. Those three are enforced only for documents that declare
 * `specVersion: "0.26"` or later, because a 0.25 document has no key to satisfy them
 * with; requiring them there would be an unsatisfiable gate, which is the same
 * approximation this layer refuses. A document that upgrades to 0.26 is told exactly
 * which control it is missing.
 *
 * What this gate deliberately does not do: it does not verify that the declared identity
 * provider exists, that the private network has been peered, or that the named reviewers
 * are real people. Those are properties of the customer's platform, not of the document,
 * and a build that guessed at them would be claiming a check it cannot run. It is for the
 * same reason that, from 0.33, the enterprise profile refuses an `identity` block with no
 * `verifiedBy`: AID generates no token verification, so the document has to name the thing
 * that does it, and the gate can check that the name is there without pretending to check
 * that the name works.
 */

import { IDENTITY_VERIFIED_BY_MIN_VERSION, specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import { CLOUD_AUDIT_SINKS, CLOUD_REGIONS, type IR, type SpecCloud } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** The spec version that first let a deployment declare the enterprise control set. */
export const DELIVERY_CONTROLS_MIN_VERSION = '0.26';

/** Where a region has to be checked against, once a cloud is named. */
function regionHint(cloud: string, regions: readonly string[]): string {
  const sample = [...regions].slice(0, 2);
  return `pin a region ${cloud} offers, such as ${sample.join(' or ')}`;
}

export function profileGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const enterprise = ir.profile === 'enterprise';
  // A 0.25 document cannot spell `identity`, `network` or `approvals` at all, so demanding
  // them from it would be a gate no edit to that document could satisfy.
  const delivery = specVersionAtLeast(ir.specVersion, DELIVERY_CONTROLS_MIN_VERSION);

  // One module set targets one cloud, and `aid infra` drives one cloud per invocation, so
  // a document that pins two would generate the second deployment's resources for the
  // wrong provider and report success. `cloud` is optional per deployment, so the check
  // looks only at the deployments that named one.
  const clouds = [
    ...new Set(
      ir.deployments
        .map((deployment) => deployment.cloud)
        .filter((cloud): cloud is SpecCloud => cloud !== undefined),
    ),
  ];
  if (clouds.length > 1) {
    const named = ir.deployments
      .filter((deployment) => deployment.cloud !== undefined)
      .map((deployment) => `"${deployment.id}" (${deployment.cloud})`)
      .join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.cloudConflict,
        message: `the profile gate rejected the document: deployments name different clouds, and one module set targets one cloud — ${named}`,
        path: ['deployments'],
        hint: 'pin one cloud for every deployment, or split the deployments into one spec per cloud',
      }),
    );
  }

  // An audit sink is likewise one destination per environment: the plan has one audit
  // module, so two deployments naming different sinks (or different retention) would
  // emit one and report success for both.
  const audits = new Map<string, string[]>();
  for (const deployment of ir.deployments) {
    if (deployment.audit === undefined) continue;
    const key = `${deployment.audit.sink}:${deployment.audit.retentionDays ?? ''}`;
    audits.set(key, [...(audits.get(key) ?? []), deployment.id]);
  }
  if (audits.size > 1) {
    const named = [...audits.entries()]
      .map(([key, ids]) => {
        const [sink, retention] = key.split(':');
        const spelled =
          retention === '' ? `${sink}, no retention` : `${sink}, retention ${retention} days`;
        return `"${ids.join('", "')}" (${spelled})`;
      })
      .join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.auditConflict,
        message: `the profile gate rejected the document: deployments name different audit destinations, and one environment has one — ${named}. A different sink or a different retention is a different destination`,
        path: ['deployments'],
        hint: 'give every deployment the same `audit` sink and retention, or split them into one spec per audit destination',
      }),
    );
  }

  for (const deployment of ir.deployments) {
    const { id, cloud, region, audit } = deployment;

    if (cloud !== undefined) {
      if (region !== undefined && !CLOUD_REGIONS[cloud].includes(region)) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.regionTarget,
            message: `the profile gate rejected "${id}": region "${region}" is not a ${cloud} region`,
            path: ['deployments', id, 'region'],
            hint: regionHint(cloud, CLOUD_REGIONS[cloud]),
          }),
        );
      }

      if (audit !== undefined && !CLOUD_AUDIT_SINKS[cloud].includes(audit.sink)) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.auditTarget,
            message: `the profile gate rejected "${id}": audit sink "${audit.sink}" is not one ${cloud} can create`,
            path: ['deployments', id, 'audit', 'sink'],
            hint: `${cloud} sinks: ${CLOUD_AUDIT_SINKS[cloud].join(', ')}`,
          }),
        );
      }
    }

    if (!enterprise) continue;

    // Residency without a pinned cloud is not a residency guarantee: the deployment is
    // free to land on whatever cloud `aid infra --cloud` names, which the spec does not
    // constrain. So the enterprise profile requires the pair, not the region alone.
    if (region === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileRegion,
          message: `the profile gate rejected "${id}": the enterprise profile requires every deployment to pin the region its data must stay in`,
          path: ['deployments', id],
          hint: 'add `region: <region>` (and `cloud:` if the deployment does not pin one)',
        }),
      );
    }

    if (audit === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileAudit,
          message: `the profile gate rejected "${id}": the enterprise profile requires every deployment to pin an audit sink`,
          path: ['deployments', id],
          hint: 'add `audit: { sink: cloudwatch }` (or the sink your cloud provides) so the record has a destination',
        }),
      );
    }

    if (!delivery) continue;

    if (deployment.identity === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileIdentity,
          message: `the profile gate rejected "${id}": the enterprise profile requires a declared identity integration, so the deployment knows whose token it is checking`,
          path: ['deployments', id],
          hint: 'add `identity: { kind: oidc, issuer: https://<your-idp> }` so callers arrive with a verifiable principal',
        }),
      );
    } else if (
      deployment.identity.verifiedBy === undefined &&
      specVersionAtLeast(ir.specVersion, IDENTITY_VERIFIED_BY_MIN_VERSION)
    ) {
      // AID emits no token verification, so `identity` names the issuer and nothing more.
      // The enterprise profile's claim that callers arrive with a verifiable principal is
      // only true if somebody named is doing the verifying, so the document has to say who.
      // Below 0.33 the key does not exist, which is why the check is version-gated rather
      // than an unsatisfiable demand on a document that cannot answer it.
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.identityVerifiedBy,
          message: `the profile gate rejected "${id}": the enterprise profile requires \`identity.verifiedBy\`, because AID generates no token verification and the issuer alone does not say who checks it`,
          path: ['deployments', id, 'identity', 'verifiedBy'],
          hint: `name the component that verifies tokens before they reach a route, such as \`verifiedBy: api-gateway\` or \`verifiedBy: app/business/principal.py\` -- AID emits the check point, not the check`,
        }),
      );
    }

    if (deployment.network === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileNetwork,
          message: `the profile gate rejected "${id}": the enterprise profile requires private networking, and this deployment does not place the workload in one`,
          path: ['deployments', id, 'network'],
          hint: 'add `network: { private: true }`, or set `profile: standard` if the workload is meant to be internet-reachable directly',
        }),
      );
    } else if (!deployment.network.private) {
      // Declared `false` rather than omitted, so the refusal names what was written instead
      // of what is missing -- the operator's fix is to change a value, not to add a key.
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileNetwork,
          message: `the profile gate rejected "${id}": the enterprise profile requires private networking, and this deployment declares \`network.private: false\``,
          path: ['deployments', id, 'network', 'private'],
          hint: 'set `network.private: true`, or set `profile: standard` if the workload is meant to be internet-reachable directly',
        }),
      );
    }

    if (deployment.approvals === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileApprovals,
          message: `the profile gate rejected "${id}": the enterprise profile requires an approval policy for production changes`,
          path: ['deployments', id],
          hint: 'add `approvals: { require: [<team>], minApprovers: 1 }` so a change to this environment waits for a human',
        }),
      );
    } else if (deployment.approvals.minApprovers > deployment.approvals.require.length) {
      // A policy that asks for more approvals than it names can never be satisfied, so it
      // is refused here rather than emitted as a workflow binding that blocks every change.
      const { minApprovers, require: named } = deployment.approvals;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.profileApprovals,
          message: `the profile gate rejected "${id}": \`approvals.minApprovers\` is ${minApprovers} but \`approvals.require\` names ${named.length} (${named.map((who) => `"${who}"`).join(', ')}), so no change could ever be approved`,
          path: ['deployments', id, 'approvals', 'minApprovers'],
          hint: `set minApprovers to at most ${named.length}, or name ${minApprovers} reviewers in \`require\``,
        }),
      );
    }
  }

  if (enterprise && !ir.guardrails.some((guardrail) => guardrail.stages.includes('output'))) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.profileGuardrail,
        message:
          'the profile gate rejected the document: the enterprise profile requires at least one guardrail that inspects model output',
        path: ['guardrails'],
        hint: 'add a guardrail with `stages: [output]`; an input-only guardrail cannot see what the model says',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
