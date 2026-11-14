/**
 * Gates 25–28 — the resume route's integrity.
 *
 * `POST /agents/resume` takes a checkpoint and continues a run from it. That checkpoint
 * carries the pending tool call and the human's answer, so **holding one is authority to
 * run a paused write**. Before spec 0.32 the route accepted any well-formed checkpoint:
 * the body was the capability, and a holder could approve their own held call, swap the
 * pending arguments, or replay a spent checkpoint.
 *
 * Five refusals stand in for that. Two depend on the profile that promised the control;
 * two are errors under every profile, because they describe a document the route cannot
 * honour at all rather than a control the author declined to pay for; and one names the
 * declaration that makes the binding possible:
 *
 * - `ir/resume-unsigned` — `profile: enterprise` with a pausable agent and no
 *   `state.signingKeyEnv`. Version-gated, following `eval-coverage`: below 0.32 the
 *   document cannot express the fix, so it is a warning there rather than an error the
 *   author has no way to clear.
 * - `ir/resume-replay-weak` — a pausable agent and no durable store, so a spent
 *   checkpoint is remembered only in the process that answered it. Error under
 *   `enterprise`, warning under `standard`: one surviving process is the honest default
 *   for a small deployment, and the limit is stated rather than hidden.
 * - `ir/resume-key-conflict` — one route, one key, one store. Pausable agents that
 *   disagree about either are refused, because the route cannot honour both and picking
 *   one silently would sign a checkpoint with a key its author did not name.
 * - `ir/resume-key-alias` — the variable `state.signingKeyEnv` names already holds
 *   another credential (the run-store connection string, a provider key, the OTLP
 *   endpoint, or a deployment secret), so one secret would both sign every checkpoint
 *   and reach that system, and neither could be rotated alone.
 * - `ir/resume-owner-unbound` — a pausable agent and no deployment naming
 *   `identity.verifiedBy`, so no caller arrives with a subject and the generated route
 *   cannot bind a checkpoint to the principal that paused it. Error under `enterprise`
 *   from 0.34, warning under `standard`, which requires no identity: there a signed
 *   checkpoint stays a bearer capability and the limit is stated. The rule reads two
 *   declarations that already exist at 0.33, so the version is what keeps yesterday's
 *   documents building rather than what makes the fix expressible.
 *
 * The state declaration is resolved per agent (`agent.state ?? document state`) exactly
 * as `buildAgents` resolves it, so these gates and the generator cannot disagree about
 * which store an agent has.
 */

import { RESUME_OWNER_BINDING_MIN_VERSION, specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { AgentShape, AgentStateShape, IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/**
 * The spec version that made an unsigned resume route an error under `profile: enterprise`.
 * Before it, a document could not name a signing key at all, so refusing would refuse a
 * document whose author had no available fix.
 */
export const RESUME_SIGNING_ENFORCED_MIN_VERSION = '0.32';

type Reporter = ReturnType<typeof reporter>;

/** The agents that can end a run in `PAUSED`, by the same three routes the emitter uses. */
function pausingAgents(ir: IR): AgentShape[] {
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  const guardrails = new Map((ir.guardrails ?? []).map((guardrail) => [guardrail.id, guardrail]));
  return ir.agents.filter((agent) => {
    if (agent.humanInTheLoop !== undefined) return true;
    if (agent.tools.some((id) => tools.get(id)?.requiresConfirmation === true)) return true;
    return agent.guardrails.some((id) => guardrails.get(id)?.action === 'escalate');
  });
}

/** Whether a tool call the agent may make writes anything. Mirrors `delivery.ts`. */
function writes(ir: IR, agent: AgentShape): boolean {
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  return agent.tools
    .map((id) => tools.get(id))
    .some((tool) => tool?.sideEffects === 'write' || tool?.sideEffects === 'destructive');
}

/** The key is a name, and it is not another credential the app already holds. */
function checkKeyPlacement(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  const stores: AgentStateShape[] = [];
  if (ir.state !== undefined) stores.push(ir.state);
  for (const agent of ir.agents) {
    if (agent.state !== undefined) stores.push(agent.state);
  }

  // Every variable the document already names as a credential, with what it holds. A
  // signing key that aliases one of them is not a checkpoint key: it is that credential
  // with a second job, and neither can be rotated without the other.
  const credentials = new Map<string, string>();
  for (const state of stores) {
    credentials.set(state.urlEnv, 'the run-store connection string');
  }
  for (const model of ir.models) {
    if (model.apiKeyEnv !== undefined) {
      credentials.set(model.apiKeyEnv, `the provider key for model "${model.id}"`);
    }
  }
  const endpointEnv = ir.observability?.endpointEnv;
  if (endpointEnv !== undefined) credentials.set(endpointEnv, 'the OTLP collector address');
  for (const entry of ir.deployments.flatMap((deployment) => deployment.env)) {
    if (entry.secret === true && !credentials.has(entry.name)) {
      credentials.set(entry.name, 'a deployment secret');
    }
  }

  // One report per distinct key. An agent that inherits the document store carries a
  // projected copy of it, so iterating members would report the same key twice.
  const keys = new Map<string, (string | number)[]>();
  for (const agent of ir.agents) {
    const key = agent.state?.signingKeyEnv;
    if (key === undefined || keys.has(key)) continue;
    keys.set(key, agent.state === ir.state ? ['state'] : ['agents', agent.id, 'state']);
  }
  const documentKey = ir.state?.signingKeyEnv;
  if (documentKey !== undefined && !keys.has(documentKey)) keys.set(documentKey, ['state']);

  for (const [key, path] of keys) {
    const role = credentials.get(key);
    if (role === undefined) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.resumeKeyAlias,
        message: `the resume gate rejected \`signingKeyEnv\`: it names "${key}", which already holds ${role}, so the same secret would sign every checkpoint and reach that -- the checkpoint key could not be rotated without rotating the credential, and every process that holds it could mint a resume for a paused write`,
        path: [...path, 'signingKeyEnv'],
        hint: 'declare a variable the app uses for nothing else, for example `signingKeyEnv: AID_CHECKPOINT_KEY`, so the checkpoint key can be rotated on its own',
      }),
    );
  }
}
export function resumeGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const pausing = pausingAgents(ir);
  if (pausing.length === 0) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  const enterprise = ir.profile === 'enterprise';
  const enforceable = specVersionAtLeast(ir.specVersion, RESUME_SIGNING_ENFORCED_MIN_VERSION);

  checkUnsigned(ir, pausing, diagnostics, report, enterprise, enforceable);
  checkReplay(ir, pausing, diagnostics, report, enterprise);
  checkAgreement(pausing, diagnostics, report);
  checkKeyPlacement(ir, diagnostics, report);
  checkOwnerBinding(ir, pausing, diagnostics, report, enterprise);

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/**
 * A signed checkpoint stops a stranger editing it. It does not stop a stranger who holds
 * one from spending it: the signature says the app issued it, not who may resume it.
 *
 * The generated route binds a checkpoint to the resuming caller when the caller arrives
 * with a subject -- `Principal.subject`, which the app populates from whatever verified the
 * token. That is only possible if somebody verifies tokens, and AID emits no verification
 * of its own (`identity.verifiedBy` says so). So this refusal names the missing
 * declaration, and `standard` -- which requires no identity at all -- warns, because there
 * the checkpoint stays a bearer capability and holding it is still authority to approve the
 * held call.
 *
 * Under `enterprise` the profile gate already refuses a delivery deployment that names no
 * `verifiedBy`, and it reports the same absence. This check stays quiet where that one
 * speaks rather than telling an author to make one change and calling it two problems; it
 * speaks where the profile gate cannot, which is a document with no delivery deployment at
 * all. Below {@link RESUME_OWNER_BINDING_MIN_VERSION} it says nothing at all: a 0.33
 * document was written before this rule existed and this build cannot tell it apart from a
 * new one.
 */
function checkOwnerBinding(
  ir: IR,
  pausing: AgentShape[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
  enterprise: boolean,
): void {
  const enforceable = specVersionAtLeast(ir.specVersion, RESUME_OWNER_BINDING_MIN_VERSION);
  if (!enforceable) return;
  const [first] = pausing;
  if (first === undefined) return;
  if (ir.deployments.some((deployment) => deployment.identity?.verifiedBy !== undefined)) return;
  // From 0.26 the profile gate requires every deployment to declare an identity, and from
  // 0.33 to say who verifies; an `enterprise` document that reaches here without one of
  // those has already been told so there.
  if (
    enterprise &&
    ir.deployments.some((deployment) => deployment.identity?.verifiedBy === undefined)
  ) {
    return;
  }

  const ids = pausing.map((agent) => `"${agent.id}"`).join(', ');
  const init = {
    code: IR_DIAGNOSTIC_CODES.resumeOwnerUnbound,
    message: enterprise
      ? `the resume gate rejected ${ids}: ${pausing.length === 1 ? 'this agent can pause' : 'these agents can pause'}, no deployment names \`identity.verifiedBy\`, and the generated resume route binds a checkpoint to the caller only when that caller arrives with a subject -- so the signature proves the app issued the checkpoint, not who may spend it`
      : `the resume gate flagged ${ids}: ${pausing.length === 1 ? 'this agent can pause' : 'these agents can pause'} and no deployment names \`identity.verifiedBy\`, so no caller arrives with a subject and a signed checkpoint stays a bearer capability -- anyone holding one can resume the run and approve the held call until it expires`,
    path: ['agents', first.id],
    hint: 'name who verifies tokens before they reach the route, for example `deployments: { prod: { identity: { kind: oidc, issuer: https://<your-idp>, verifiedBy: api-gateway } } }`, so the app can bind a checkpoint to the principal that paused it',
  };
  diagnostics.push(enterprise ? report.error(init) : report.warn(init));
}

/**
 * A checkpoint with no signature is a bearer capability, and the enterprise profile is
 * where that is not acceptable: the route can approve a paused write.
 */
function checkUnsigned(
  ir: IR,
  pausing: AgentShape[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
  enterprise: boolean,
  enforceable: boolean,
): void {
  const unsigned = pausing.filter((agent) => agent.state?.signingKeyEnv === undefined);
  const [first] = unsigned;
  if (first === undefined) return;
  const ids = unsigned.map((agent) => `"${agent.id}"`).join(', ');
  const enforced = enterprise && enforceable;

  if (enterprise && !enforceable) {
    diagnostics.push(
      report.warn({
        code: IR_DIAGNOSTIC_CODES.resumeUnsigned,
        message: `the resume gate flagged ${ids}: ${unsigned.length === 1 ? 'this agent can pause' : 'these agents can pause'}, the document names no checkpoint signing key, and specVersion "${ir.specVersion}" is before ${RESUME_SIGNING_ENFORCED_MIN_VERSION} -- so POST /agents/resume accepts any well-formed checkpoint and a caller can approve the held call`,
        path: ['agents', first.id, 'state'],
        hint: `set specVersion: "${RESUME_SIGNING_ENFORCED_MIN_VERSION}" and declare \`state: { kind: postgres, urlEnv: DATABASE_URL, signingKeyEnv: AID_CHECKPOINT_KEY }\`; before ${RESUME_SIGNING_ENFORCED_MIN_VERSION} a document cannot name the key, so this cannot be enforced`,
      }),
    );
    return;
  }

  diagnostics.push(
    enforced
      ? report.error({
          code: IR_DIAGNOSTIC_CODES.resumeUnsigned,
          message: `the resume gate rejected ${ids}: ${unsigned.length === 1 ? 'this agent can pause' : 'these agents can pause'}, and an unsigned checkpoint is a bearer capability over the pending call -- under profile enterprise anyone holding one can approve the paused write`,
          path: ['agents', first.id, 'state'],
          hint: 'declare `state.signingKeyEnv` naming the environment variable that holds the signing key, so a checkpoint this app did not issue and one whose answer was edited are both refused',
        })
      : report.warn({
          code: IR_DIAGNOSTIC_CODES.resumeUnsigned,
          message: `the resume gate flagged ${ids}: ${unsigned.length === 1 ? 'this agent can pause' : 'these agents can pause'} and no checkpoint signing key is declared, so a resume accepts any well-formed checkpoint and a caller can approve or edit the held call`,
          path: ['agents', first.id, 'state'],
          hint: 'declare `state.signingKeyEnv` naming the environment variable that holds the signing key; the generated resume route then refuses a checkpoint it did not issue',
        }),
  );
}

/**
 * A nonce has to be remembered by something that outlives the request. With no store the
 * generated app keeps it in process memory, which refuses a replay against the same worker
 * and accepts one against any other -- a limit worth a warning, and an error where the
 * profile promised replay protection.
 */
function checkReplay(
  ir: IR,
  pausing: AgentShape[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
  enterprise: boolean,
): void {
  // The delivery gate already refuses an enterprise agent with a side-effecting tool and
  // no store. Reporting the same absence twice would tell the author to make one change
  // and call it two problems.
  const uncovered = pausing.filter(
    (agent) => agent.state === undefined && !(enterprise && writes(ir, agent)),
  );
  if (uncovered.length === 0) return;
  const ids = uncovered.map((agent) => `"${agent.id}"`).join(', ');
  const init = {
    code: IR_DIAGNOSTIC_CODES.resumeReplayWeak,
    message: enterprise
      ? `the resume gate rejected ${ids}: ${uncovered.length === 1 ? 'this agent can pause' : 'these agents can pause'} and the document declares no durable store, so a spent checkpoint is remembered only in the process that answered it -- profile enterprise is refused a replay protection that a second replica defeats`
      : `the resume gate flagged ${ids}: ${uncovered.length === 1 ? 'this agent can pause' : 'these agents can pause'} and no durable store is declared, so a spent checkpoint is refused only by the process that issued it; a replay against another replica, or after a restart, is accepted`,
    path: ['state'],
    hint: enterprise
      ? 'declare `state: { kind: postgres, urlEnv: DATABASE_URL, signingKeyEnv: AID_CHECKPOINT_KEY }`, so the nonce is claimed where the store already points; or declare profile: standard to accept a signed-but-replayable checkpoint'
      : 'declare `state` so a spent checkpoint is remembered durably, or keep the default and accept that a replay across processes is not refused',
  };
  diagnostics.push(enterprise ? report.error(init) : report.warn(init));
}

/**
 * One route serves every agent, so it resolves one key and one store. Two pausable agents
 * that disagree cannot both be honoured, and choosing one silently would verify a
 * checkpoint against a key its author did not name.
 */
function checkAgreement(
  pausing: AgentShape[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  const keys = new Set<string>();
  const stores = new Set<string>();
  const ttls = new Set<number>();
  for (const agent of pausing) {
    const state: AgentStateShape | undefined = agent.state;
    if (state?.signingKeyEnv !== undefined) keys.add(state.signingKeyEnv);
    if (state?.checkpointTtlMinutes !== undefined) ttls.add(state.checkpointTtlMinutes);
    if (state !== undefined) stores.add(`${state.kind}:${state.urlEnv}`);
  }

  if (keys.size > 1) {
    const names = [...keys]
      .sort()
      .map((key) => `"${key}"`)
      .join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.resumeKeyConflict,
        message: `the resume gate rejected the document: the pausable agents name different checkpoint signing keys (${names}), and POST /agents/resume is one route with one key, so a checkpoint signed with either would have to be verified against a key the other agent's author did not declare`,
        path: ['agents'],
        hint: 'declare one `signingKeyEnv` in the document-level `state` and let the agents inherit it, so every checkpoint this app issues is signed with the same key',
      }),
    );
  }

  if (stores.size > 1) {
    const names = [...stores].sort().join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.resumeKeyConflict,
        message: `the resume gate rejected the document: the pausable agents declare different stores (${names}), and a nonce has to be claimed in the store the checkpoint's own run belongs to, which one route cannot resolve before it has verified the checkpoint`,
        path: ['agents'],
        hint: 'declare one store in the document-level `state` and let the agents inherit it',
      }),
    );
  }

  // The signer is per app, not per agent, so one route has one window. Two windows would
  // make the emitted `ttl_seconds` an arbitrary choice between them.
  if (ttls.size > 1) {
    const minutes = [...ttls].sort((left, right) => left - right).join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.resumeKeyConflict,
        message: `the resume gate rejected the document: the pausable agents declare different checkpoint lifetimes (${minutes} minutes), and one app signs with one signer, so the emitted window would be whichever value the generator happened to read first`,
        path: ['agents'],
        hint: 'declare one `checkpointTtlMinutes` in the document-level `state` and let the agents inherit it, or declare it in no agent and take the runtime default',
      }),
    );
  }
}
