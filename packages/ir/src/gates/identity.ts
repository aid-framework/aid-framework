/**
 * Gates 29–32 — a verifier AID generates.
 *
 * From spec 0.35 a deployment may write `identity.verifiedBy: aid`, which asks AID to emit
 * the token check instead of naming one the customer runs. That is a different kind of
 * claim from `verifiedBy: <a component>`, because it is a promise the build makes rather
 * than a note about the platform, and a promise the build makes can be wrong in ways a
 * declaration cannot. These four refusals cover the ways.
 *
 * - `ir/identity-kind` — `verifiedBy: aid` on a `saml` identity. The generated verifier
 *   checks signed JWTs; a SAML assertion is XML with a different trust model, so there is
 *   no honest thing to emit. Refused rather than generated-and-useless, because a verifier
 *   that refuses every token is indistinguishable from an outage and reads as though the
 *   document asked for something that happened.
 * - `ir/identity-audience` — `verifiedBy: aid` with no `audience`. The audience is what
 *   makes a token *this* service's token; an issuer with no audience pinned accepts a
 *   token minted for any other service the same IdP serves, which turns SSO into a
 *   skeleton key. The profile gate's other identity rules default where a default is safe;
 *   this one is not, so it is required rather than defaulted.
 * - `ir/identity-keys` — `verifiedBy: aid` with no `jwksUri`. A verifier needs the issuer's
 *   signing keys, and the alternative to naming them is discovering them from `issuer` over
 *   the network at startup. Discovery makes the trust decision an HTTP response nobody
 *   reviewed, and makes a boot depend on the IdP being up. The key source is a spec line.
 * - `ir/identity-conflict` — the deployments cannot agree on one verifier: either two that
 *   ask for a generated verifier name different issuers, audiences or claim names, or one
 *   asks for the generated verifier while another deployment declares an `identity` that
 *   does not. One generated app serves one verifier and `current_principal` is a single
 *   dependency, so the second shape is not a judgement call the build can make: honouring
 *   the generated check would verify tokens on a deployment whose document named a
 *   different component, and honouring the named component would silently drop the check
 *   the other deployment asked for.
 *
 * Only `verifiedBy: aid` is in scope. A deployment that names its own component keeps the
 * gate it had at 0.33 -- `ir/identity-verified-by` asks for the name and stops there --
 * because the build still cannot tell whether a module path is a real verifier.
 */

import { specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import {
  type DeploymentShape,
  GENERATED_VERIFIER,
  IDENTITY_GENERATED_MIN_VERSION,
  type IR,
} from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/**
 * The spec version that made `verifiedBy: aid` mean "generate the check".
 *
 * Re-exported from `shapes.ts` rather than written again here, because the generator reads
 * the same boundary: two copies of the literal would let a gate and an emitter disagree
 * about whether a document asked for a verifier. Below this version the literal is not
 * reserved, so a document that happens to name a component `aid` is a document naming a
 * component; the version diagnostics in `@aid-framework/spec` report that case with its own
 * fix, so by the time this gate runs the document either declared 0.35 or declared no
 * generated verifier at all.
 */
export const IDENTITY_GENERATED_ENFORCED_MIN_VERSION = IDENTITY_GENERATED_MIN_VERSION;

/** Deployments that ask AID to generate the token verifier, oldest declaration first. */
function generatedVerifierDeployments(ir: IR): Array<[string, DeploymentShape]> {
  return ir.deployments
    .filter((deployment) => deployment.identity?.verifiedBy === GENERATED_VERIFIER)
    .map((deployment) => [deployment.id, deployment]);
}

/** The configuration the generated verifier reads, or why it cannot be built. */
export function identityGate(ir: IR, options: GateOptions): GateResult {
  const report = reporter(options);
  const diagnostics: IrDiagnostic[] = [];
  if (!specVersionAtLeast(ir.specVersion, IDENTITY_GENERATED_ENFORCED_MIN_VERSION)) {
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }
  const asking = generatedVerifierDeployments(ir);
  if (asking.length === 0) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  for (const [id, deployment] of asking) {
    const identity = deployment.identity;
    if (identity === undefined) continue;
    if (identity.kind !== 'oidc') {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.identityKind,
          message: `the identity gate rejected "${id}": \`identity.verifiedBy: ${GENERATED_VERIFIER}\` asks AID to generate the token check, and the generated verifier reads signed JWTs, so it cannot check a \`${identity.kind}\` identity`,
          path: ['deployments', id, 'identity', 'kind'],
          hint: 'set `identity.kind: oidc` if the provider issues OIDC tokens, or name the component that terminates the SAML assertion in `verifiedBy` instead of `aid`',
        }),
      );
    }
    if (identity.audience === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.identityAudience,
          message: `the identity gate rejected "${id}": \`identity.verifiedBy: ${GENERATED_VERIFIER}\` generates a verifier that compares the token's audience, and this deployment pins none, so a token issued for any other service the same provider serves would be accepted`,
          path: ['deployments', id, 'identity', 'audience'],
          hint: "declare `audience:` with the value your IdP puts in the token's `aud` claim -- usually the application's client id -- so only this service's tokens are accepted",
        }),
      );
    }
    if (identity.jwksUri === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.identityKeys,
          message: `the identity gate rejected "${id}": \`identity.verifiedBy: ${GENERATED_VERIFIER}\` generates a verifier that needs the issuer's signing keys, and this deployment names no \`jwksUri\` for it to read`,
          path: ['deployments', id, 'identity', 'jwksUri'],
          hint: 'declare `jwksUri: https://<issuer>/.well-known/jwks.json`; naming it keeps the key source a reviewed line rather than a discovery response, and the generated verifier caches and rotates from it',
        }),
      );
    }
  }

  // One app, one verifier. Differing configuration across deployments is not a judgement
  // call the build can make on the author's behalf, so it is refused and the diff is named.
  const configurations = new Map<string, string[]>();
  for (const [id, deployment] of asking) {
    const identity = deployment.identity;
    if (identity === undefined) continue;
    const key = [
      identity.issuer,
      identity.audience ?? '',
      identity.jwksUri ?? '',
      identity.subjectClaim ?? '',
      identity.rolesClaim ?? '',
      identity.scopesClaim ?? '',
    ].join('\u0000');
    const ids = configurations.get(key);
    if (ids === undefined) configurations.set(key, [id]);
    else ids.push(id);
  }
  if (configurations.size > 1) {
    const groups = [...configurations.values()];
    const detail = groups.map((ids) => `[${ids.map((id) => `"${id}"`).join(', ')}]`).join(' and ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.identityConflict,
        message: `the identity gate rejected ${asking.length} deployment(s): \`identity.verifiedBy: ${GENERATED_VERIFIER}\` generates one verifier for the whole app, but the deployments that ask for it disagree about the provider -- ${detail}`,
        path: ['deployments', groups[groups.length - 1]?.[0] ?? '', 'identity'],
        hint: `make every deployment that sets \`verifiedBy: ${GENERATED_VERIFIER}\` name the same issuer, audience, jwksUri and claim names, or name the component each one really uses instead of \`${GENERATED_VERIFIER}\``,
      }),
    );
  }

  // `current_principal` is one dependency, so the generated verifier applies to every
  // deployment's routes. A deployment that declares an identity but not the generated
  // verifier would silently get the check it did not ask for, so the mismatch is named.
  const declared = ir.deployments
    .filter(
      (deployment) =>
        deployment.identity !== undefined && deployment.identity.verifiedBy !== GENERATED_VERIFIER,
    )
    .map((deployment) => deployment.id);
  if (declared.length > 0) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.identityConflict,
        message: `the identity gate rejected ${asking.length} deployment(s): \`identity.verifiedBy: ${GENERATED_VERIFIER}\` generates one verifier for the whole app and the generated \`current_principal\` serves every route, but ${declared.map((id) => `"${id}"`).join(', ')} declares an identity that does not ask for it -- so the generated check would run on a deployment whose document named something else`,
        path: ['deployments', declared[0] ?? '', 'identity', 'verifiedBy'],
        hint: `set \`verifiedBy: ${GENERATED_VERIFIER}\` on every deployment that declares an \`identity\`, or drop the generated verifier and name the component each deployment runs`,
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
