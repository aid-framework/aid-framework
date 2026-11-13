/**
 * The IR layer's diagnostic codes and factories. Codes are namespaced `ir/<slug>`
 * and are part of the public contract, exactly like the spec layer's `spec/*`.
 */

import {
  type Diagnostic,
  type DiagnosticInit,
  errorDiagnostic,
  warningDiagnostic,
} from '@aid-framework/spec';

/** Every diagnostic code this package emits. */
export const IR_DIAGNOSTIC_CODES = {
  typeUnresolved: 'ir/type-unresolved',
  typeCycle: 'ir/type-cycle',
  refUnresolved: 'ir/ref-unresolved',
  refKindMismatch: 'ir/ref-kind-mismatch',
  evalTargetInvalid: 'ir/eval-target-invalid',
  fallbackCycle: 'ir/fallback-cycle',
  metricToolUnresolved: 'ir/metric-tool-unresolved',
  promptVariableUndeclared: 'ir/prompt-variable-undeclared',
  promptVariableUnused: 'ir/prompt-variable-unused',
  promptInputMissing: 'ir/prompt-input-missing',
  bindingDuplicate: 'ir/binding-duplicate',
  bindingForwardReference: 'ir/binding-forward-reference',
  normalizationIncomplete: 'ir/normalization-incomplete',
  dimensionMismatch: 'ir/dimension-mismatch',
  indexMetricUnknown: 'ir/index-metric-unknown',
  paramExceedsLimit: 'ir/param-exceeds-limit',
  providerUnsupported: 'ir/provider-unsupported',
  targetUnknown: 'ir/target-unknown',
  capabilityUnknown: 'ir/capability-unknown',
  capabilityMissing: 'ir/capability-missing',
  modelCapabilityMissing: 'ir/model-capability-missing',
  costProfileUnknown: 'ir/cost-profile-unknown',
  costBudgetExceeded: 'ir/cost-budget-exceeded',
  securityMissingAuth: 'ir/security-missing-auth',
  securityMissingConfirmation: 'ir/security-missing-confirmation',
  securityRedactionIncomplete: 'ir/security-redaction-incomplete',
  securityUnauthenticatedPath: 'ir/security-unauthenticated-path',
  securityStoreSecret: 'ir/security-store-secret',
  securityInputGuardrail: 'ir/security-input-guardrail',
  agentsRefUnresolved: 'ir/agents-ref-unresolved',
  agentsHandoffCycle: 'ir/agents-handoff-cycle',
  agentsBudget: 'ir/agents-budget',
  agentsBudgetDegrade: 'ir/agents-budget-degrade',
  guardrailCoverage: 'ir/guardrail-coverage',
  guardrailPolicy: 'ir/guardrail-policy',
  hitlSideEffect: 'ir/hitl-side-effect',
  memoryRef: 'ir/memory-ref',
  knowledgeBaseEmbedder: 'ir/knowledge-base-embedder',
  knowledgeBaseRefUnresolved: 'ir/knowledge-base-ref-unresolved',
  knowledgeBaseFilter: 'ir/knowledge-base-filter',
  knowledgeBaseRerank: 'ir/knowledge-base-rerank',
  deployStreaming: 'ir/deploy-streaming',
  deployTargetUnknown: 'ir/deploy-target-unknown',
  deployAutoscaleIncomplete: 'ir/deploy-autoscale-incomplete',
  deployImageIncomplete: 'ir/deploy-image-incomplete',
  deployImageCredentials: 'ir/deploy-image-credentials',
  deployRuntimeIncomplete: 'ir/deploy-runtime-incomplete',
  profileUnknown: 'ir/profile-unknown',
  profileRegion: 'ir/profile-region',
  profileAudit: 'ir/profile-audit',
  profileGuardrail: 'ir/profile-guardrail',
  profileIdentity: 'ir/profile-identity',
  profileNetwork: 'ir/profile-network',
  identityVerifiedBy: 'ir/identity-verified-by',
  profileApprovals: 'ir/profile-approvals',
  agentsStateStore: 'ir/agents-state-store',
  resumeUnsigned: 'ir/resume-unsigned',
  resumeReplayWeak: 'ir/resume-replay-weak',
  resumeKeyConflict: 'ir/resume-key-conflict',
  resumeKeyAlias: 'ir/resume-key-alias',
  approvalStepTool: 'ir/approval-step-tool',
  cloudUnsupported: 'ir/cloud-unsupported',
  regionTarget: 'ir/region-target',
  auditTarget: 'ir/audit-target',
  cloudConflict: 'ir/cloud-conflict',
  auditConflict: 'ir/audit-conflict',
  orchestrationDeepagents: 'ir/orchestration-deepagents',
  evalUncovered: 'ir/eval-uncovered',
  evalTrajectory: 'ir/eval-trajectory',
  evalMetricVacuous: 'ir/eval-metric-vacuous',
  observabilityExport: 'ir/observability-export',
  promptVersionStale: 'ir/prompt-version-stale',
  promotionRegression: 'ir/promotion-regression',
  promotionCost: 'ir/promotion-cost',
  promotionApproval: 'ir/promotion-approval',
  feedbackPii: 'ir/feedback-pii',
  alertsUnexported: 'ir/alerts-unexported',
  alertsUnproduced: 'ir/alerts-unproduced',
  alertsAggregate: 'ir/alerts-aggregate',
  alertsSource: 'ir/alerts-source',
  gateFailed: 'ir/gate-failed',
  policyEmpty: 'ir/policy-empty',
  policySyntax: 'ir/policy-syntax',
  policyUnknownBuiltin: 'ir/policy-unknown-builtin',
  policyUnknownIdentifier: 'ir/policy-unknown-identifier',
  policyUnterminatedString: 'ir/policy-unterminated-string',
  policyUnclosedParen: 'ir/policy-unclosed-paren',
  policyTrailingToken: 'ir/policy-trailing-token',
  policyArity: 'ir/policy-arity',
  policyArgumentType: 'ir/policy-argument-type',
  policyExpected: 'ir/policy-expected',
  predicateEmpty: 'ir/predicate-empty',
  predicateSyntax: 'ir/predicate-syntax',
  predicateUnknownBuiltin: 'ir/predicate-unknown-builtin',
  predicateUnknownPath: 'ir/predicate-unknown-path',
  predicateUnterminatedString: 'ir/predicate-unterminated-string',
  predicateUnclosedParen: 'ir/predicate-unclosed-paren',
  predicateTrailingToken: 'ir/predicate-trailing-token',
  predicateArity: 'ir/predicate-arity',
  predicateExpected: 'ir/predicate-expected',
  predicateNotBoolean: 'ir/predicate-not-boolean',
} as const;

export type IrDiagnosticCode = (typeof IR_DIAGNOSTIC_CODES)[keyof typeof IR_DIAGNOSTIC_CODES];

/**
 * What the published pages need to know about a code beyond its name.
 *
 * Only codes a page publishes carry an entry: the map is partial so that adding a code does
 * not oblige anyone to invent a condition for a case no page describes. Coverage is enforced
 * where it matters -- every code the boundary table cites must have one.
 */
export interface DiagnosticMetadata {
  /** The case this code refuses in, as a reader deciding whether their document passes. */
  readonly condition: string;
  /** What decides the severity, set only where the emit sites disagree. */
  readonly escalation?: string;
}

/**
 * The one-line condition each published refusal covers.
 *
 * A code has one condition even when it has several emit sites, because a reader deciding
 * whether a document will pass needs the case, not the message. `escalation` is only set
 * where the emit sites disagree about severity, and says what decides it -- the reference
 * generator refuses to publish a code that emits both severities without one.
 */
export const IR_DIAGNOSTIC_METADATA = {
  'ir/agents-state-store': {
    condition: 'a writing agent with no durable state, or a `state` block AID cannot use',
  },
  'ir/alerts-unexported': {
    condition: 'alerts declared with no signal exported for a collector to read',
  },
  'ir/alerts-unproduced': { condition: 'an alert whose metric nothing in the build records' },
  'ir/audit-target': { condition: 'an audit sink the cloud a deployment names cannot serve' },
  'ir/cloud-conflict': { condition: 'deployments naming different clouds for one module set' },
  'ir/cloud-unsupported': { condition: 'a cloud AID does not provision' },
  'ir/cost-budget-exceeded': { condition: 'an eval estimated above its declared budget' },
  'ir/cost-profile-unknown': {
    condition: 'an eval pricing a model or knowledge base that has no cost profile',
    escalation: 'a declared budget makes it a refusal; without one it warns',
  },
  'ir/deploy-target-unknown': { condition: 'a deployment target that is not one of the clouds' },
  'ir/eval-metric-vacuous': {
    condition:
      'a metric that can only pass: a ceiling the agent already enforces, or an approval on an agent that never pauses',
  },
  'ir/eval-trajectory': { condition: 'an agent eval whose target cannot run one' },
  'ir/eval-uncovered': {
    condition: 'an HTTP pipeline that no gate.ci eval claims',
    escalation:
      '`enterprise` at spec {const:EVAL_COVERAGE_ENFORCED_MIN_VERSION} or later refuses it; everything else warns',
  },
  'ir/feedback-pii': {
    condition:
      'a feedback signal with no retention, or a persistent one whose `pii.redact` misses a sensitive field',
  },
  'ir/hitl-side-effect': { condition: 'a side-effecting tool with no approval policy' },
  'ir/identity-verified-by': { condition: 'enterprise with an identity and no named verifier' },
  'ir/observability-export': {
    condition: 'activity exported with `trace` off, or enterprise with no export',
  },
  'ir/policy-syntax': { condition: 'a policy expression that does not parse' },
  'ir/profile-approvals': {
    condition: 'enterprise production with no approval policy, or one that cannot gate',
  },
  'ir/profile-audit': { condition: 'enterprise with no audit sink pinned' },
  'ir/profile-guardrail': { condition: 'enterprise with no guardrail inspecting model output' },
  'ir/profile-identity': {
    condition: 'enterprise with no identity, or an identity kind AID does not define',
  },
  'ir/profile-network': { condition: 'enterprise with no `network.private` flag' },
  'ir/profile-region': { condition: 'enterprise with no region pinned' },
  'ir/profile-unknown': { condition: 'a profile AID does not define' },
  'ir/promotion-approval': { condition: 'an enterprise promotion with no recorded approval' },
  'ir/promotion-cost': {
    condition:
      'a cost allowance on an eval with no cost ceiling, or a build where no target records spend',
  },
  'ir/promotion-regression': {
    condition: 'a quality allowance on an eval measuring no quality metric',
  },
  'ir/region-target': { condition: 'a region the cloud a deployment names does not offer' },
  'ir/resume-key-alias': {
    condition: 'a signing key variable that already holds another credential',
  },
  'ir/resume-key-conflict': {
    condition: 'pausable agents naming different keys, stores or lifetimes behind one resume route',
  },
  'ir/resume-replay-weak': {
    condition: 'a pausable agent with no store to claim a nonce in',
    escalation: 'enterprise refuses it; `standard` warns',
  },
  'ir/resume-unsigned': {
    condition: 'a pausable agent with no checkpoint signing key',
    escalation:
      '`enterprise` at spec {const:RESUME_SIGNING_ENFORCED_MIN_VERSION} or later refuses it; `standard`, and `enterprise` before {const:RESUME_SIGNING_ENFORCED_MIN_VERSION}, warn',
  },
  'ir/security-input-guardrail': {
    condition: 'caller text reaching a prompt with no input guardrail',
  },
  'ir/security-missing-auth': { condition: 'a side-effecting tool with no auth in its policy' },
  'ir/security-redaction-incomplete': {
    condition: 'a trace config that is on but does not redact a sensitive field',
  },
  'ir/security-store-secret': { condition: 'a store whose `uri` is a literal connection string' },
  'ir/security-unauthenticated-path': {
    condition: 'a route that reaches a writing tool with no authentication',
  },
} as const satisfies Readonly<Partial<Record<IrDiagnosticCode, DiagnosticMetadata>>>;

/** The diagnostic carrier this layer emits: the shared shape, the IR's own codes. */
export type IrDiagnostic = Diagnostic<IrDiagnosticCode>;

/** `C` infers from the `code` field, so call sites need no explicit type argument. */
export function irError(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic {
  return errorDiagnostic(init);
}

export function irWarning(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic {
  return warningDiagnostic(init);
}

/**
 * The shared init carries only what a factory needs, so the source position a
 * policy error points at is attached to the finished diagnostic instead.
 */
export function withPosition(
  diagnostic: IrDiagnostic,
  position: { file?: string; line?: number; column?: number },
): IrDiagnostic {
  const located: IrDiagnostic = { ...diagnostic };
  if (position.file !== undefined) located.file = position.file;
  if (position.line !== undefined) located.line = position.line;
  if (position.column !== undefined) located.column = position.column;
  return located;
}

/** 1-based line/column of a 0-based offset, for position-bearing policy errors. */
export function offsetPosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
