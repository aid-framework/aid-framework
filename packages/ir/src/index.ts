/**
 * `@aid/ir` — the packed intermediate representation, its builder, its build-time
 * gates, the canonical serializer, and the PolicyExpr front end.
 *
 * The public entry point layer 3 (`generator-sdk`) consumes: `buildIR` turns a
 * parsed spec value into an `IR`, `runGates` decides whether that IR is buildable
 * for a set of target capability declarations, and `serializeIR` renders it as
 * canonical JSON whose bytes are a function of identity alone.
 */

export type { BuildContext, BuildOptions, BuildResult } from './build.js';
export {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  buildEvalTarget,
  buildIR,
  buildTypeRef,
  DEFAULT_EVAL_MAX_REGRESSION,
  DEFAULT_EVAL_SAMPLES,
  DEFAULT_IDEMPOTENCY,
  DEFAULT_TARGET,
  DEFAULT_TOOL_RETRIES,
  DEFAULT_TOOL_TIMEOUT_MS,
  isBindingName,
  isSensitiveName,
  sensitiveNames,
  sortedKeys,
  templatePlaceholders,
} from './build.js';
export type { ModelCapability, RequiredCapability } from './capabilities.js';
export {
  deriveRequiredCapabilities,
  isModelCapability,
  isRequiredCapability,
  MODEL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  resolveRequiredCapability,
  SPEC_MODEL_CAPABILITY_MAP,
  TARGET_CAPABILITY_ALIASES,
} from './capabilities.js';
export type { CatalogModel, TargetCapabilityDeclarations } from './catalog/index.js';
export {
  CATALOG_VERSION,
  catalogCostProfile,
  catalogCostProfiles,
  catalogModel,
  PHASE_0_TARGET_CAPABILITIES,
  phase0TargetCapabilities,
} from './catalog/index.js';
export type { IrDiagnostic, IrDiagnosticCode } from './diagnostics.js';
export {
  IR_DIAGNOSTIC_CODES,
  irError,
  irWarning,
  offsetPosition,
  withPosition,
} from './diagnostics.js';
export type {
  EvalCostEstimate,
  Gate,
  GateId,
  GateName,
  GateOptions,
  GateReporter,
  GateResult,
  GateRunResult,
  ModelCostEstimate,
  SuppressedCheck,
} from './gates/index.js';
export {
  capabilityGate,
  costGate,
  diffPaths,
  estimateEvalCost,
  evalCoverageGate,
  GATES,
  isNormalized,
  normalize,
  normalizeGate,
  policyAuthenticates,
  referentialGate,
  reporter,
  runGates,
  securityGate,
} from './gates/index.js';
export type {
  ComparisonOperator,
  LexResult,
  PolicyBuiltin,
  PolicyCall,
  PolicyComparison,
  PolicyContext,
  PolicyExpr,
  PolicyLogical,
  PolicyNode,
  PolicyNot,
  PolicyOperand,
  PolicyParseResult,
  PolicyToken,
  PolicyTokenType,
} from './policy/index.js';

export {
  COMPARISON_OPERATORS,
  formatPolicyExpr,
  isPolicyBuiltin,
  POLICY_BUILTIN_ARITY,
  POLICY_BUILTINS,
  parsePolicyExpr,
  tokenize,
  tokenText,
} from './policy/index.js';
export { CANONICAL_INDENT, canonicalJson, serializeIR } from './serialize.js';
export type {
  AgentShape,
  CostProfile,
  DeploymentShape,
  EmbeddingShape,
  EmitStep,
  ErrorPolicy,
  EvalDataset,
  EvalGate,
  EvalShape,
  EvalTarget,
  EvalTargetKind,
  GenerateStep,
  GuardrailShape,
  Idempotency,
  IR,
  IrCollection,
  MemoryShape,
  MetricShape,
  ModelLimits,
  ModelParams,
  ModelShape,
  ObservabilityShape,
  PipelineShape,
  PipelineTrigger,
  PrimitiveType,
  ProjectShape,
  PromptOutput,
  PromptShape,
  PromptVariable,
  Provider,
  RetrieverShape,
  RuntimeShape,
  SideEffects,
  StepInput,
  StepInputValue,
  StepShape,
  ToolHandler,
  ToolShape,
  ToolStep,
  Trait,
  TypeField,
  TypeRef,
  TypeShape,
  VectorStoreShape,
} from './shapes.js';
export {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  EVAL_TARGET_KINDS,
  IR_COLLECTIONS,
  IR_ONLY_COLLECTIONS,
  IR_VERSION,
  isProvider,
  modelIdentity,
  NON_COLLECTION_SECTIONS,
  PHASE_0_PROVIDERS,
  POPULATED_COLLECTION_BY_SECTION,
  PRIMITIVE_TYPES,
  PROVIDERS,
  pipelineIdentity,
  promptIdentity,
  toolIdentity,
} from './shapes.js';
