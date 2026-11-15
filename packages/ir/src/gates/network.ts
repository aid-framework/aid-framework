/**
 * Network — one gate, `network`, that gives `deployments[].network.ingress` a meaning
 * per target, and refuses the combinations that have none.
 *
 * The key it replaces was a boolean that nothing branched on. This gate exists so the
 * replacement cannot drift the same way: every refusal below is a request the emitters
 * could not satisfy, caught before a reviewer approves an environment that quietly does
 * something else.
 *
 * `ir/network-ingress-unsupported` — `private-link` is a declared value with no emitter.
 * A private endpoint is a provider resource named after the service behind it, and no
 * module creates one, so this refuses rather than emitting a load balancer and calling it
 * a private endpoint.
 *
 * `ir/network-target-incapable` — `internal` on a target that has no private placement.
 * `serverless` emits no VPC at all; `edge` is a CloudFront function, which is reachable
 * from the internet by definition. The refusal names the target swap rather than
 * pretending a deployment declaration can move a serverless function into a subnet.
 *
 * `ir/network-ingress-conflict` — reachability stated twice and disagreeing. Two cases:
 * an `internal` deployment that also declares a `kubernetes.ingress` object (the object
 * *is* the public entry point, and the chart emits no internal-class annotations), and
 * two `container` deployments in different modes (the environment has one load balancer,
 * emitted by one module call, so it is either internal or it is not).
 *
 * `ir/network-allow-from` — the list is required where it is used and refused where it is
 * not. Required for a container `internal` ingress, because the emitted load balancer's
 * security group opens exactly the CIDRs named and an empty list is a service nothing can
 * reach. A zero-length prefix (`0.0.0.0/0`, `::/0`) is refused for the same reason in the
 * other direction: it makes an `internal` load balancer reachable from the internet, so the
 * document would say private and the security group would say otherwise. Refused
 * elsewhere, because `kubernetes` emits no NetworkPolicy and `batch` emits no ingress:
 * accepting the list there would record a restriction the build does not make.
 *
 * What this gate does not do: it does not verify that a CIDR is routable from the
 * customer's network, that a peered route exists, or that egress is actually restricted.
 * Those are properties of the account, not of the document.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** Targets that can be placed privately at all, and the ones that cannot. */
const INCAPABLE_TARGETS: readonly string[] = ['serverless', 'edge'];

/** Targets whose emitted artifact has a real ingress the `allowFrom` list applies to. */
const ALLOW_FROM_TARGETS: readonly string[] = ['container'];

/**
 * Whether a CIDR admits every address.
 *
 * Judged on the prefix length alone rather than on the base: `10.0.0.0/0` and `::/0` both
 * mean "everything" to a security group, and a gate that only recognised `0.0.0.0/0`
 * would pass exactly the typo it exists to catch.
 */
function admitsEverything(cidr: string): boolean {
  return /^0+$/.test(cidr.slice(cidr.lastIndexOf('/') + 1));
}

export function networkGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  /** Container deployments by resolved mode, for the one-load-balancer check below. */
  const containerModes = new Map<string, string[]>();

  /**
   * Record a container placement once it has passed every per-deployment rule above.
   *
   * Recording only accepted placements keeps the conflict reported for documents that are
   * otherwise well-formed: a deployment already refused for a missing `allowFrom` would
   * otherwise collect a second diagnostic about a load balancer it does not reach.
   */
  function record(ingress: string, id: string): void {
    const ids = containerModes.get(ingress);
    if (ids === undefined) containerModes.set(ingress, [id]);
    else ids.push(id);
  }

  for (const deployment of ir.deployments) {
    const network = deployment.network;
    if (network === undefined) continue;

    const { ingress, allowFrom } = network;
    const allowFromDeclared = allowFrom !== undefined && allowFrom.length > 0;

    if (ingress === 'private-link') {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkIngressUnsupported,
          message: `the network gate rejected "${deployment.id}": \`ingress: private-link\` is declared but no module emits a private endpoint`,
          path: ['deployments', deployment.id, 'network', 'ingress'],
          hint: 'use `ingress: internal` with the CIDRs allowed to reach the service, or declare the endpoint yourself and keep this deployment `public` behind it',
        }),
      );
      continue;
    }

    if (ingress !== 'internal') {
      // A public deployment that names allowed CIDRs states a restriction it will not
      // get: nothing narrows the entry point for `public`. Accepting both would let a
      // reviewer approve a document whose two lines contradict each other.
      if (allowFromDeclared) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.networkAllowFrom,
            message: `the network gate rejected "${deployment.id}": it declares \`ingress: public\` and also \`allowFrom\`, so it asks to be reachable from the internet and restricted to named networks at once`,
            path: ['deployments', deployment.id, 'network', 'allowFrom'],
            hint: 'set `ingress: internal` to reach this deployment only through the listed networks, or remove `allowFrom` if it really is public',
          }),
        );
      } else if (deployment.target === 'container') {
        // A public container deployment is the other half of the conflict check, so it
        // has to be recorded here: this branch is the only place a clean one passes.
        record(ingress, deployment.id);
      }
      continue;
    }

    if (INCAPABLE_TARGETS.includes(deployment.target)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkTargetIncapable,
          message: `the network gate rejected "${deployment.id}": \`ingress: internal\` needs a private placement, and target "${deployment.target}" has none`,
          path: ['deployments', deployment.id, 'network', 'ingress'],
          hint:
            deployment.target === 'edge'
              ? 'edge is a CloudFront function, reachable from the internet by definition; move the workload to `container` or `kubernetes` to place it privately'
              : 'serverless emits no VPC; target `container` or `kubernetes` to place this deployment in private subnets',
        }),
      );
      continue;
    }

    if (deployment.kubernetes?.ingress !== undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkIngressConflict,
          message: `the network gate rejected "${deployment.id}": \`ingress: internal\` contradicts the \`kubernetes.ingress\` block at "${deployment.kubernetes.ingress.host}", which is the chart's public entry point`,
          path: ['deployments', deployment.id, 'kubernetes', 'ingress'],
          hint: 'drop the `kubernetes.ingress` block to keep the ClusterIP Service and its private default, or set `network.ingress: public` if this deployment is meant to be approached from outside the cluster',
        }),
      );
      continue;
    }

    if (ALLOW_FROM_TARGETS.includes(deployment.target) && !allowFromDeclared) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkAllowFrom,
          message: `the network gate rejected "${deployment.id}": \`ingress: internal\` opens the load balancer's security group to exactly the CIDRs in \`allowFrom\`, and none are declared`,
          path: ['deployments', deployment.id, 'network', 'allowFrom'],
          hint: 'list the networks allowed to reach this service, such as `allowFrom: [10.0.0.0/8]`, because no default range is right for every customer',
        }),
      );
      continue;
    }

    if (ALLOW_FROM_TARGETS.includes(deployment.target)) {
      const everything = (allowFrom ?? []).filter(admitsEverything);
      if (everything.length > 0) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.networkAllowFrom,
            message: `the network gate rejected "${deployment.id}": \`allowFrom\` names ${everything.map((cidr) => `"${cidr}"`).join(', ')}, a zero-length prefix that admits every address, so the load balancer is reachable from the internet while the document says it is internal`,
            path: ['deployments', deployment.id, 'network', 'allowFrom'],
            hint: 'narrow each entry to the customer network it stands for -- `10.0.0.0/8`, a VPC range, or a peered corporate prefix -- or declare `ingress: public` if the service really is open to everyone',
          }),
        );
        continue;
      }
    }

    if (!ALLOW_FROM_TARGETS.includes(deployment.target) && allowFromDeclared) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkAllowFrom,
          message: `the network gate rejected "${deployment.id}": \`allowFrom\` narrows a load balancer's security group, and target "${deployment.target}" emits no load balancer for it to narrow`,
          path: ['deployments', deployment.id, 'network', 'allowFrom'],
          hint:
            deployment.target === 'kubernetes'
              ? 'drop `allowFrom`; the chart emits a ClusterIP Service, and restricting which pods may call it is a NetworkPolicy you own rather than one AID generates'
              : 'drop `allowFrom`; a batch job answers no requests, so there is no ingress to restrict',
        }),
      );
      continue;
    }

    if (deployment.target === 'container') record(ingress, deployment.id);
  }

  // One module call per environment builds one load balancer for every container service
  // in it, so the modes cannot differ. Checked after the loop because the disagreement is
  // a property of the set, and reported once rather than once per member.
  const internal = containerModes.get('internal') ?? [];
  const publicIds = containerModes.get('public') ?? [];
  const conflicting = [...internal, ...publicIds];
  const subject = conflicting[0];
  if (internal.length > 0 && publicIds.length > 0 && subject !== undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.networkIngressConflict,
        message: `the network gate rejected this environment: container deployments ${conflicting.map((id) => `"${id}"`).join(', ')} resolve different ingress modes, but one environment emits one load balancer for all of them`,
        path: ['deployments', subject, 'network', 'ingress'],
        hint: `give every container deployment in this environment the same mode; ${internal.map((id) => `"${id}"`).join(', ')} ask for internal and ${publicIds.map((id) => `"${id}"`).join(', ')} for public`,
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
