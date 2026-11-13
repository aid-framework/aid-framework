/**
 * The hand-written half of the boundary table in `docs/guide/boundary.md`.
 *
 * The table has five columns and they have two different owners. The second column -- the code,
 * its severity and the condition that triggers it -- is derived from the diagnostics registry by
 * `gen-reference`, because a doc that restates a severity by hand can restate it wrongly, and did:
 * `docs/rfcs/0006-citation-gate.md` records five citations in this page that disagreed with the
 * code. The other columns are judgement: what is generated, what is yours, and what remains if
 * you provide nothing. No registry holds those, so they live here, reviewed by a person.
 *
 * A row cites the published code strings, not enum keys. The generator resolves each one against
 * the registry and refuses a citation it cannot resolve, so a retired code fails the build here
 * rather than reading as true on the site.
 *
 * `{policyCodes}` is substituted with the derived number of registered `ir/policy-*` and
 * `ir/predicate-*` codes. The sentence used to spell the number by hand, and got it wrong by ten.
 */

/** The concerns, in table order. A row key must appear here and here must be no other row. */
export const BOUNDARY_CONCERNS = Object.freeze([
  'Profile selection',
  'Region pin',
  'Audit sink',
  'Private network',
  'Input and output guardrails',
  'Redaction of recorded text',
  'Change approval',
  'Identity and token verification',
  'Authorization',
  'Durable state',
  'Secrets',
  'Model pinning and cost',
  'Eval coverage',
  'Trajectory evals',
  'Observability export',
  'Promotion and self-improvement',
  'Deployment',
]);

export const BOUNDARY_TABLE_METADATA = Object.freeze({
  'Profile selection': {
    codes: ['ir/profile-unknown'],
    generated: "The profile's requirements, as refusals on every deployment",
    provide: 'The choice: `standard` or `enterprise`',
    risk: '`standard` ships with weaker required controls, by design',
  },
  'Region pin': {
    codes: ['ir/profile-region'],
    generated: 'The region in the OpenTofu modules',
    provide: 'The region, and the residency obligation it satisfies',
    risk: 'Nothing places data in a region you did not name; the obligation itself is yours',
  },
  'Audit sink': {
    codes: ['ir/profile-audit', 'ir/audit-target'],
    generated: 'The log group or sink, and the archive only when the document pins one',
    provide: 'The sink you already own, its retention, and someone who reads it',
    risk: 'AID emits the sink, never its contents or its policy',
  },
  'Private network': {
    codes: ['ir/profile-network'],
    generated:
      'The container module builds a two-AZ VPC with one NAT gateway when you do not supply `vpc_id`; the agent runtime is generated with `network_mode = "PUBLIC"`',
    provide: 'Your VPC, its two private subnet ids, the egress rules, the peering and the DNS',
    risk: '`network.private: true` satisfies the profile gate, and no module reads it: a task that must not reach the internet is your configuration, not the flag',
  },
  'Input and output guardrails': {
    codes: ['ir/profile-guardrail', 'ir/security-input-guardrail'],
    generated: 'The guardrail call, before the model and after it',
    provide: 'The class, threshold and fallback',
    risk: 'A classifier is not a policy: its accuracy is the limit',
  },
  'Redaction of recorded text': {
    codes: ['ir/security-redaction-incomplete', 'ir/feedback-pii'],
    generated:
      'The redaction at the recording boundary, and the same set applied by `aid trace export`',
    provide: "The field names, and the fields' owners in your data",
    risk: 'A value that arrives only in prose has no field to match and is recorded as written',
  },
  'Change approval': {
    codes: ['ir/profile-approvals', 'ir/hitl-side-effect'],
    generated: 'The pause, the signed checkpoint and the resume route',
    provide: 'Someone to approve, and authentication in front of `/agents/resume`',
    risk: 'A checkpoint proves the app issued it, not that the holder should have it',
  },
  'Identity and token verification': {
    codes: ['ir/profile-identity', 'ir/identity-verified-by'],
    generated: 'One `current_principal` dependency, whose default principal is anonymous',
    provide: 'The verifier itself, named in `identity.verifiedBy`',
    risk: '**Nothing verifies a token until you do.** The gate proves you named who does',
  },
  Authorization: {
    codes: ['ir/security-missing-auth', 'ir/security-unauthenticated-path', 'ir/policy-syntax'],
    generated:
      'The policy check, evaluated per request, with a separate registered code for each of the {policyCodes} parse and predicate failures it can report',
    provide: 'The principal it evaluates against, from your verifier',
    risk: 'A policy requiring a signed-in caller refuses rather than trusts, but only if the principal is real',
  },
  'Durable state': {
    codes: ['ir/agents-state-store', 'ir/resume-replay-weak'],
    generated:
      'The nonce claimed in the store the `state` block names, so a replay is refused across replicas and restarts',
    provide: 'The database, and persisting the paused run if it must outlive the process',
    risk: 'Under `standard` the checkpoint is signed but replayable; `enterprise` refuses that document',
  },
  Secrets: {
    codes: [
      'ir/security-store-secret',
      'ir/resume-unsigned',
      'ir/resume-key-conflict',
      'ir/resume-key-alias',
    ],
    generated: 'Environment-variable references in the infra, never the value',
    provide: 'The value in your secret store, and a rotation plan',
    risk: 'Rotating the signing key invalidates the checkpoints outstanding at that moment',
  },
  'Model pinning and cost': {
    codes: ['ir/cost-profile-unknown', 'ir/cost-budget-exceeded'],
    generated: 'The pinned model id and the spend recorded per run',
    provide: 'The version bump when a pin changes, and the pricing when a provider moves',
    risk: 'A pin holds the id, not the behaviour behind it',
  },
  'Eval coverage': {
    codes: ['ir/eval-uncovered', 'ir/eval-metric-vacuous'],
    generated: 'The offline evaluator, its cases and its baseline comparison',
    provide: 'The cases, and the curation that keeps them honest',
    risk: 'An eval measures the cases it was given',
  },
  'Trajectory evals': {
    codes: ['ir/eval-trajectory'],
    generated:
      'An evaluator that scores the calls a run made: reachable tools, order, step count, cost, and whether an approval was respected',
    provide: 'A recorded run when you want a model that is not scripted',
    risk: 'A scripted trajectory verifies policy and plumbing, **not** model behaviour',
  },
  'Observability export': {
    codes: ['ir/observability-export', 'ir/alerts-unexported', 'ir/alerts-unproduced'],
    generated: 'The OTel spans and the declared dashboards and alerts as code',
    provide: 'A collector endpoint, and calling `metrics_export_status()` for the alerts to fire',
    risk: 'Traces are opt-in; an undeclared signal has no dashboard',
  },
  'Promotion and self-improvement': {
    codes: ['ir/promotion-regression', 'ir/promotion-cost', 'ir/promotion-approval'],
    generated: 'Nothing that deploys: the comparison, and the gate result',
    provide: 'The approval, and the merge that carries it',
    risk: 'Nothing auto-promotes; the record in the tree is what an auditor reads',
  },
  Deployment: {
    codes: [
      'ir/cloud-unsupported',
      'ir/deploy-target-unknown',
      'ir/cloud-conflict',
      'ir/region-target',
      'cli/infra-cloud-conflict',
    ],
    generated: 'The modules, the generated CI, and the plan',
    provide: 'The account, the apply, and the rollback',
    risk: 'AID plans and generates; it never applies for you',
  },
});
