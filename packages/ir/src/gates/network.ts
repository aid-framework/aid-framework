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
 * `serverless` answers through an HTTP API whose endpoint is public, and the egress
 * attachment it does get (`declared-only`) narrows what the function may call, not who may
 * call it; `edge` is a CloudFront function, which is reachable from the internet by
 * definition. The refusal names the target swap rather than pretending a deployment
 * declaration can move a serverless function into a subnet.
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
 * document would say private and the security group would say otherwise. On `kubernetes`
 * the same list becomes the source set of the chart's NetworkPolicy, and is optional there
 * because a ClusterIP Service is already unreachable from outside the cluster. Refused
 * elsewhere, because `batch` answers no requests and `serverless` and `edge` emit no
 * ingress to restrict: accepting the list there would record a restriction the build does
 * not make.
 *
 * `ir/network-egress-unsupported` — `egress: declared-only` on a target that has no
 * workload egress to restrict. `edge` is a CloudFront function and `batch` runs without a
 * security group this generator writes, so the declaration would be a value no artifact
 * applies. `serverless` is no longer refused: the Lambda gets a security group with the
 * same rules and a `vpc_config`, which bounds what it can call without making it privately
 * reachable (that is the paragraph above). The declaration was inert on every target
 * before it was emitters' business, so a document that relied on it was never protected;
 * the refusal says so instead of leaving the belief in place.
 *
 * What this gate does not do: it does not verify that a CIDR is routable from the
 * customer's network, or that a peered route exists. Those are properties of the account,
 * not of the document. It also cannot promise that a NetworkPolicy is *enforced*: that is a
 * property of the cluster's CNI, which the chart cannot observe. The emitted chart says so.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** Targets that can be placed privately at all, and the ones that cannot. */
const INCAPABLE_TARGETS: readonly string[] = ['serverless', 'edge'];

/** Targets whose emitted artifact has a real ingress the `allowFrom` list applies to. */
const ALLOW_FROM_TARGETS: readonly string[] = ['container', 'kubernetes'];

/**
 * Targets where `allowFrom` is *required* for an internal placement.
 *
 * Only `container`, because its load balancer would be an internal listener admitting
 * nobody. A `kubernetes` Service is `ClusterIP` with or without the list, so an omission
 * there is a default rather than an outage.
 */
const ALLOW_FROM_REQUIRED: readonly string[] = ['container'];

/**
 * Targets whose emitters place a workload egress rule, so `declared-only` means something.
 *
 * `container` writes security-group egress rules, `serverless` attaches a security group to
 * the Lambda and puts it in subnets, and `kubernetes` writes a NetworkPolicy. Everywhere
 * else the value would be a declaration no artifact applies, which is the state this gate
 * exists to end.
 */
const EGRESS_TARGETS: readonly string[] = ['container', 'serverless', 'kubernetes'];

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

    const { ingress, allowFrom, egress } = network;
    const allowFromDeclared = allowFrom !== undefined && allowFrom.length > 0;

    if (egress === 'declared-only' && !EGRESS_TARGETS.includes(deployment.target)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.networkEgressUnsupported,
          message: `the network gate rejected "${deployment.id}": \`egress: declared-only\` restricts a workload's outbound traffic, and target "${deployment.target}" emits no workload for it to restrict`,
          path: ['deployments', deployment.id, 'network', 'egress'],
          hint:
            deployment.target === 'edge'
              ? 'edge is a CloudFront function with no outbound network of its own; drop `egress`, or move the call that needs restricting to `container`, `serverless` or `kubernetes`'
              : "batch emits no security group, so its egress is whatever the job's subnets allow; target `container`, `serverless` or `kubernetes` to have the restriction emitted",
        }),
      );
    }

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
              : 'serverless answers through a public HTTP API, and `egress: declared-only` bounds what the function calls rather than who calls it; target `container` or `kubernetes` to place this deployment in private subnets',
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

    if (ALLOW_FROM_REQUIRED.includes(deployment.target) && !allowFromDeclared) {
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
          message: `the network gate rejected "${deployment.id}": \`allowFrom\` narrows the source set of a load balancer or a NetworkPolicy, and target "${deployment.target}" emits neither`,
          path: ['deployments', deployment.id, 'network', 'allowFrom'],
          hint: 'drop `allowFrom`; a batch job answers no requests, so there is no ingress to restrict',
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
