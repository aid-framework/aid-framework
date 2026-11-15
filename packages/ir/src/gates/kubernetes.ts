/**
 * Kubernetes — one gate, `kubernetes`, that keeps a cluster placement honest.
 *
 * Three refusals, each for a mistake the schema cannot see and the chart emitter must not
 * paper over.
 *
 * `ir/kubernetes-block-misplaced` — a `kubernetes` block on a deployment whose target is
 * something else. The block is placement for a cluster; on a `container` target it would
 * configure a chart nothing emits, so a reader who declared an ingress host would get a
 * deployment with no ingress and no error saying so. Refusing is the only answer that does
 * not invent a resource.
 *
 * `ir/kubernetes-ingress-class` — an ingress that names a class the cluster cannot resolve.
 * The class is required because the alternative is landing on whichever controller the
 * cluster registered as default, which is a property of the cluster and not of this
 * document; the gate additionally refuses a class that is not a DNS label, since Kubernetes
 * would reject it at apply time and the build is the earlier place to find out.
 *
 * `ir/kubernetes-ingress-tls` — an `enterprise` ingress with no `tlsSecret`. The profile's
 * promise is that a deployment is defensible in a review; a plaintext ingress is the one
 * control whose absence is visible from outside the cluster, so the enterprise bundle
 * requires the Secret name. It is a name, never certificate material: the chart writes no
 * Secret, so the certificate lifecycle stays with the customer.
 *
 * What this gate does not do: it does not verify that the class exists, that the Secret
 * exists, or that the namespace is writable. Those are properties of the cluster, not of
 * the document, and the build has no account to ask.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** A Kubernetes object name: lowercase alphanumeric or `-`, starting and ending alphanumeric. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function kubernetesGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const enterprise = ir.profile === 'enterprise';

  for (const deployment of ir.deployments) {
    const placement = deployment.kubernetes;

    if (placement !== undefined && deployment.target !== 'kubernetes') {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.kubernetesBlockMisplaced,
          message: `the kubernetes gate rejected "${deployment.id}": it declares a \`kubernetes\` block, but its target is "${deployment.target}", which emits no chart to place`,
          path: ['deployments', deployment.id, 'kubernetes'],
          hint: `set target: kubernetes to run this deployment on a cluster, or remove the \`kubernetes\` block; a ${deployment.target} deployment is placed by its own module`,
        }),
      );
      continue;
    }

    if (placement?.ingress === undefined) continue;

    const { className, tlsSecret } = placement.ingress;
    if (!DNS_LABEL.test(className)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.kubernetesIngressClass,
          message: `the kubernetes gate rejected "${deployment.id}": ingress className ${JSON.stringify(className)} is not a DNS label Kubernetes can resolve`,
          path: ['deployments', deployment.id, 'kubernetes', 'ingress', 'className'],
          hint: 'name the IngressClass the cluster registers, such as nginx or traefik; a class the API server rejects fails at apply time, not build time, unless it is refused here',
        }),
      );
    }

    if (enterprise && tlsSecret === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.kubernetesIngressTls,
          message: `the kubernetes gate rejected "${deployment.id}": \`profile: enterprise\` exposes an ingress at "${placement.ingress.host}" with no \`tlsSecret\`, so every request to it is plaintext`,
          path: ['deployments', deployment.id, 'kubernetes', 'ingress', 'tlsSecret'],
          hint: 'name the kubernetes.io/tls Secret already in the cluster, or set `profile: standard` if this deployment is not production',
        }),
      );
    }
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
