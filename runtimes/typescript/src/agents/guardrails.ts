/**
 * The guardrails engine: the IR's `guardrails` collection, actually evaluated.
 *
 * The IR already carries the *declaration* -- stages, policy kinds, an action, the fields
 * a redaction may touch. This module is the missing other half: something that looks at
 * text and decides. It is deliberately small and offline. Every detector is a regular
 * expression, so the answer for a given input does not depend on a model, a network call,
 * or a random seed, and a spec that passes here will pass here again tomorrow.
 *
 * Four stages, in the order a run meets them:
 *
 * - `input` -- before the model sees the user's turn.
 * - `retrieval` -- around the chunks a retriever would splice into the prompt.
 * - `tool-call` -- before a tool's handler body runs, over the call's arguments.
 * - `output` -- after the model answers.
 *
 * Three decisions this module owns:
 *
 * **Undecidable is a block.** A guardrail naming a policy with no evaluator, or whose
 * `redact` fields do not cover the text it matched, raises {@link GuardrailBlockedError}.
 * There is no path from "the check could not run" to "no violation found".
 *
 * **Evaluation order is declaration order, except that `block` outranks it.** At one stage
 * the engine walks the agent's guardrails in the order the IR declared them and collects
 * every guardrail that fired. If *any* of them is a `block`, the first such guardrail
 * decides -- a later `flag` cannot talk an earlier `block` down. Otherwise the first
 * guardrail that fired decides.
 *
 * **`flag` cannot be ignored, but it does not stop anything.** A flag is recorded on the
 * run (`RunResult.guardrails`) and the guarded text passes through unchanged. The consumer
 * is whoever reads the run result -- an eval, a log shipper, a reviewer. It is *not* an
 * allow: a flag means a detector matched, and the run carried on because the spec said the
 * run may.
 */

import type { DecisionResponse } from '../decisions.js';
import { DecisionClient, DecisionQuestion } from '../decisions.js';
import { ConfigurationError, GuardrailBlockedError } from '../errors.js';
import { repr } from '../internal/json.js';
import type { DecisionDefinition, GuardrailDefinition } from './ir.js';

export type GuardrailStage = 'input' | 'output' | 'retrieval' | 'tool-call';
export type GuardrailAction = 'block' | 'redact' | 'flag' | 'escalate';

export const ACTION_BLOCK: GuardrailAction = 'block';
export const ACTION_REDACT: GuardrailAction = 'redact';
export const ACTION_FLAG: GuardrailAction = 'flag';
export const ACTION_ESCALATE: GuardrailAction = 'escalate';

/**
 * What a decision answer can mean. `allow` is not a guardrail action: it is the one
 * answer that produces no record at all, because "the model saw nothing wrong" is the
 * absence of a finding rather than a finding that says so.
 */
export const ACTION_ALLOW = 'allow';

/** The outcomes an `onDecision` map may name. */
export const DECISION_OUTCOMES: ReadonlySet<string> = new Set([
  ACTION_ALLOW,
  ACTION_BLOCK,
  ACTION_FLAG,
  ACTION_ESCALATE,
]);

export const GUARDRAIL_STAGES: readonly GuardrailStage[] = [
  'input',
  'retrieval',
  'tool-call',
  'output',
];
export const GUARDRAIL_ACTIONS: readonly GuardrailAction[] = [
  ACTION_BLOCK,
  ACTION_REDACT,
  ACTION_FLAG,
  ACTION_ESCALATE,
];

/** What a redacted span is replaced with. Carrying the policy name says *why* it vanished. */
const REDACTION = '[REDACTED:{policy}]';

/** One match: which policy fired, and the half-open span it fired on. */
export interface Detection {
  readonly policy: string;
  readonly start: number;
  readonly end: number;
}

/** One guardrail that fired at one stage. The audit trail's unit. */
export interface GuardrailRecord {
  readonly guardrail: string;
  readonly stage: GuardrailStage;
  readonly action: GuardrailAction;
  readonly policies: readonly string[];
  readonly message: string;
  /** The decision that answered, when a model rather than a detector decided. */
  readonly decision?: string;
  /** The label the decision answered with, when it answered. */
  readonly label?: string;
  /** The confidence the answer carried, when the question type reports one. */
  readonly confidence?: number;
}

/**
 * A guardrail that entered human-in-the-loop instead of deciding by itself.
 *
 * `text` is the guarded payload, kept so that approving an `output` escalation can release
 * the model's answer without re-running the model -- and so that a rejection can show the
 * human what they rejected.
 */
export interface GuardrailEscalation {
  readonly guardrail: string;
  readonly stage: GuardrailStage;
  readonly message: string;
  readonly channel: string;
  readonly text: string;
}

/**
 * The engine's answer for one stage of one turn.
 *
 * `records` is every guardrail that fired, not only the deciding one: a `flag` next to a
 * `block` still has to reach the audit trail. `action` and `deciding` are the outcome;
 * `text` and `arguments` are the payload after any `redact` was applied.
 */
export interface GuardrailVerdict {
  readonly stage: GuardrailStage;
  readonly records: readonly GuardrailRecord[];
  readonly action: string | undefined;
  readonly deciding: GuardrailRecord | undefined;
  readonly text: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Whether any guardrail matched, whatever it decided to do about it. */
export function fired(verdict: GuardrailVerdict): boolean {
  return verdict.records.length > 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrase(...phrases: readonly string[]): RegExp {
  const joined = phrases.map((item) => escapeRegExp(item)).join('|');
  return new RegExp(`\\b(?:${joined})\\b`, 'i');
}

/**
 * One entry per `GuardrailPolicyKind` in `packages/ir/src/shapes.ts`.
 *
 * These are *heuristics*, and saying so is the honest description. They catch the shapes a
 * red-team corpus is built from -- an instruction-override phrase, a well-formed email or
 * card-like digit run, a jailbreak persona -- and they will not catch a paraphrase.
 */
export const DETECTORS: Readonly<Record<string, readonly RegExp[]>> = {
  'prompt-injection': [
    phrase(
      'ignore previous instructions',
      'ignore all previous instructions',
      'ignore the previous instructions',
      'ignore your instructions',
      'disregard previous instructions',
      'disregard your instructions',
      'forget your instructions',
      'override your instructions',
      'ignore the system prompt',
      'reveal the system prompt',
      'reveal your system prompt',
      'print the system prompt',
      'show me your system prompt',
    ),
    /\byou are now (?:a|an|the|in|no longer)\b/i,
    /<\|\s*im_start\s*\|>/i,
  ],
  jailbreak: [
    phrase(
      'do anything now',
      'developer mode',
      'jailbreak mode',
      'dan mode',
      'without any restrictions',
      'no ethical guidelines',
      'no restrictions apply',
    ),
    /\bpretend (?:that )?you (?:have no|are not bound)/i,
    /\bact as (?:an? )?(?:unrestricted|uncensored)\b/i,
  ],
  'pii-detect': [
    /[\w.+-]+@[\w-]+\.[\w.-]+/,
    /(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}(?!\d)/,
    /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/,
    /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/,
  ],
  'pii-redact': [
    /[\w.+-]+@[\w-]+\.[\w.-]+/,
    /(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}(?!\d)/,
    /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/,
    /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/,
  ],
  'secret-scan': [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
    /\bsk-[A-Za-z0-9]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ],
  moderation: [
    phrase(
      'how to build a bomb',
      'how to make a bomb',
      'build an explosive device',
      'synthesize sarin',
      'make nerve agent',
    ),
  ],
  toxicity: [phrase('kill yourself', 'go die', 'you should die', 'subhuman')],
};

/**
 * Policy kinds whose detection is about a *value* that a redaction can erase. The others
 * match intent, and masking an intent phrase would not make the request safe -- which is
 * why a `redact` guardrail over them fails closed below.
 */
const REDACTABLE: ReadonlySet<string> = new Set(['pii-detect', 'pii-redact', 'secret-scan']);

/**
 * Every match of `policy` in `text`, in document order.
 *
 * Raises {@link ConfigurationError} for an unknown policy: that is a caller bug, not
 * untrusted input, and the engine reports it as a block before it ever gets here.
 */
export function detect(policy: string, text: string): readonly Detection[] {
  const patterns = DETECTORS[policy];
  if (patterns === undefined) {
    throw new ConfigurationError(
      `no detector for guardrail policy ${repr(policy)}; known policies: ` +
        `[${Object.keys(DETECTORS)
          .sort()
          .map((name) => repr(name))
          .join(', ')}]`,
    );
  }
  const hits: Detection[] = [];
  for (const pattern of patterns) {
    // A fresh global copy per call: a shared RegExp carries `lastIndex` between calls,
    // which would make the second evaluation of the same text miss a match.
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const start = match.index ?? 0;
      hits.push({ policy, start, end: start + match[0].length });
    }
  }
  hits.sort((left, right) => left.start - right.start || left.end - right.end);
  return hits;
}

function mask(policy: string, text: string): string {
  const hits = detect(policy, text);
  const replacement = REDACTION.replace('{policy}', policy);
  let masked = text;
  // Right to left, so an earlier replacement cannot move a later span's offsets.
  for (const hit of [...hits].reverse()) {
    masked = `${masked.slice(0, hit.start)}${replacement}${masked.slice(hit.end)}`;
  }
  return masked;
}

/**
 * The `(field, value)` pairs a detector may look at.
 *
 * Only strings: a detector that coerced a number or a nested object to text would fire on
 * payloads a redaction cannot edit, and the redaction's fail-closed re-check below would
 * then block a run it could have repaired.
 */
function texts(payload: Readonly<Record<string, unknown>>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === 'string' && value !== '') pairs.push([name, value]);
  }
  return pairs;
}

/** The narrow decision seam the engine needs; a test can supply its own. */
export interface DecisionAsker {
  decide(options: {
    readonly model: string;
    readonly state: unknown;
    readonly questions: Readonly<Record<string, DecisionQuestion>>;
    readonly reproducible?: boolean;
  }): Promise<DecisionResponse>;
}

export interface GuardrailEngineOptions {
  /** The decisions this app's guardrails may ask, keyed by decision id. */
  readonly decisions?: ReadonlyMap<string, DecisionDefinition>;
  /**
   * Built on first use, not at import: an app with no TypeSafe key must still boot when
   * no request reaches a decision-backed guardrail.
   */
  readonly decisionClient?: () => DecisionAsker;
}

/** Evaluates an agent's guardrails at one stage. */
export class GuardrailEngine {
  readonly #declared: ReadonlyMap<string, GuardrailDefinition>;
  readonly #decisions: ReadonlyMap<string, DecisionDefinition>;
  readonly #ask: () => DecisionAsker;
  #client: DecisionAsker | undefined;

  constructor(
    guardrails?: ReadonlyMap<string, GuardrailDefinition>,
    options: GuardrailEngineOptions = {},
  ) {
    this.#declared = new Map(guardrails ?? []);
    this.#decisions = new Map(options.decisions ?? []);
    this.#ask = options.decisionClient ?? (() => new DecisionClient());
  }

  declared(guardrailId: string): GuardrailDefinition | undefined {
    return this.#declared.get(guardrailId);
  }

  checkInput(guardrails: readonly GuardrailDefinition[], text: string): GuardrailVerdict {
    return this.check('input', guardrails, { text }, undefined);
  }

  checkOutput(guardrails: readonly GuardrailDefinition[], text: string): GuardrailVerdict {
    return this.check('output', guardrails, { text }, undefined);
  }

  /**
   * Guard what a retriever would splice into the prompt.
   *
   * Only the *results* are in the payload, not the query. The stage is about the text a
   * model is handed, and putting the user's question in the same payload would let a
   * `redact` guardrail over the `text` field fire on a violation it cannot remove -- which
   * fails closed as a block and hides the real cause. The query's own checks belong to the
   * `input` stage.
   */
  checkRetrieval(
    guardrails: readonly GuardrailDefinition[],
    results: readonly string[],
  ): GuardrailVerdict {
    return this.check('retrieval', guardrails, { text: results.join('\n') }, undefined);
  }

  checkToolCall(
    guardrails: readonly GuardrailDefinition[],
    toolId: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): GuardrailVerdict {
    return this.check('tool-call', guardrails, { ...arguments_ }, toolId);
  }

  /**
   * The `input` stage when a guardrail is answered by a decision.
   *
   * A decision is a network round trip, so the synchronous `checkInput` cannot ask one.
   * This is the twin a caller awaits when the spec declares decision-backed guardrails.
   */
  async checkInputAsync(
    guardrails: readonly GuardrailDefinition[],
    text: string,
  ): Promise<GuardrailVerdict> {
    return this.checkAsync('input', guardrails, { text }, undefined);
  }

  async checkOutputAsync(
    guardrails: readonly GuardrailDefinition[],
    text: string,
  ): Promise<GuardrailVerdict> {
    return this.checkAsync('output', guardrails, { text }, undefined);
  }

  async checkRetrievalAsync(
    guardrails: readonly GuardrailDefinition[],
    results: readonly string[],
  ): Promise<GuardrailVerdict> {
    return this.checkAsync('retrieval', guardrails, { text: results.join('\n') }, undefined);
  }

  async checkToolCallAsync(
    guardrails: readonly GuardrailDefinition[],
    toolId: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<GuardrailVerdict> {
    return this.checkAsync('tool-call', guardrails, { ...arguments_ }, toolId);
  }

  check(
    stage: GuardrailStage,
    guardrails: readonly GuardrailDefinition[],
    payload: Readonly<Record<string, unknown>>,
    toolId: string | undefined,
  ): GuardrailVerdict {
    const applicable = guardrails.filter(
      (guardrail) => guardrail.stages.includes(stage) && covers(guardrail, stage, toolId),
    );
    const records: GuardrailRecord[] = [];
    const firedGuardrails: GuardrailDefinition[] = [];
    for (const guardrail of applicable) {
      const policies = firingPolicies(guardrail, stage, payload);
      if (policies.length === 0) {
        if (guardrail.decision !== undefined) {
          // Fail closed rather than skip: a synchronous caller cannot await the model,
          // and returning "no violation" would be an allow nobody declared. The agent
          // loop and the generated routes call the async variant instead.
          throw new GuardrailBlockedError(
            guardrail.id,
            stage,
            `guardrail is answered by decision ${repr(guardrail.decision)}, which needs the async check`,
          );
        }
        continue;
      }
      firedGuardrails.push(guardrail);
      records.push({
        guardrail: guardrail.id,
        stage,
        action: actionOf(guardrail),
        policies,
        message: guardrail.message,
      });
    }

    const deciding = decide(records);
    if (deciding === undefined) {
      return {
        stage,
        records: [],
        action: undefined,
        deciding: undefined,
        text: textOf(payload),
        arguments: { ...payload },
      };
    }

    let redacted = payload;
    if (deciding.action === ACTION_REDACT) {
      redacted = redact(
        stage,
        firedGuardrails.filter((guardrail) => guardrail.action === ACTION_REDACT),
        payload,
      );
    }
    return {
      stage,
      records,
      action: deciding.action,
      deciding,
      text: textOf(redacted),
      arguments: { ...redacted },
    };
  }

  /**
   * One stage, allowing the guardrails that need an await.
   *
   * Order and precedence are the synchronous path's: a policy hit is recorded before the
   * decision is considered, declaration order still decides between comparable actions,
   * and `block` still outranks it. A policy hit is a finding the detectors made locally,
   * so the model is not asked to second-guess it.
   */
  async checkAsync(
    stage: GuardrailStage,
    guardrails: readonly GuardrailDefinition[],
    payload: Readonly<Record<string, unknown>>,
    toolId: string | undefined,
  ): Promise<GuardrailVerdict> {
    const applicable = guardrails.filter(
      (guardrail) => guardrail.stages.includes(stage) && covers(guardrail, stage, toolId),
    );
    const records: GuardrailRecord[] = [];
    const firedGuardrails: GuardrailDefinition[] = [];
    for (const guardrail of applicable) {
      const policies = firingPolicies(guardrail, stage, payload);
      let record: GuardrailRecord | undefined;
      if (policies.length > 0) {
        record = {
          guardrail: guardrail.id,
          stage,
          action: actionOf(guardrail),
          policies,
          message: guardrail.message,
        };
      } else if (guardrail.decision !== undefined) {
        record = await this.#askDecision(guardrail, stage, textOf(payload));
      }
      if (record === undefined) continue;
      firedGuardrails.push(guardrail);
      records.push(record);
    }

    const deciding = decide(records);
    if (deciding === undefined) {
      return {
        stage,
        records: [],
        action: undefined,
        deciding: undefined,
        text: textOf(payload),
        arguments: { ...payload },
      };
    }

    let redacted = payload;
    if (deciding.action === ACTION_REDACT) {
      redacted = redact(
        stage,
        firedGuardrails.filter((guardrail) => guardrail.action === ACTION_REDACT),
        payload,
      );
    }
    return {
      stage,
      records,
      action: deciding.action,
      deciding,
      text: textOf(redacted),
      arguments: { ...redacted },
    };
  }

  /**
   * Ask one `choice` decision and turn its label into a record, or `undefined`.
   *
   * An undeclared decision, an unmapped label, an unknown outcome, or a confidence
   * below the declared floor is a {@link GuardrailBlockedError}: an answer the guardrail
   * can read but cannot act on blocks. A call that produced no label at all -- it threw,
   * named no answer, or carried no choice -- follows the decision's `onError` instead:
   * `allow` returns `undefined` so an advisory check does not stop traffic, and `block`
   * (the default) throws. `onError` governs whether the answer arrived, never what a
   * present answer means, so the policy path's rule holds: there is no path from "the
   * check could not run" to "no violation found" unless the spec declares one.
   */
  async #askDecision(
    guardrail: GuardrailDefinition,
    stage: GuardrailStage,
    text: string,
  ): Promise<GuardrailRecord | undefined> {
    const name = guardrail.decision ?? '';
    const definition = this.#decisions.get(name);
    if (definition === undefined) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} has no definition in this runtime`,
      );
    }
    const outcomes = guardrail.onDecision;
    if (Object.keys(outcomes).length === 0) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} maps no answer label, so no answer could be acted on`,
      );
    }
    this.#client ??= this.#ask();
    const question = new DecisionQuestion({
      type: 'choice',
      instructions: definition.instructions,
      criteria: definition.criteria,
    });
    let response: DecisionResponse;
    try {
      response = await this.#client.decide({
        model: definition.model,
        state: text,
        questions: { [name]: question },
      });
    } catch (error) {
      if (definition.onError === 'allow') return undefined;
      const detail = error instanceof Error ? error.message : String(error);
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} could not answer: ${detail}`,
      );
    }

    const answer = response.answers[name];
    if (answer === undefined) {
      if (definition.onError === 'allow') return undefined;
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} returned no answer for its own question`,
      );
    }
    const label = answer.choice;
    if (label === undefined) {
      if (definition.onError === 'allow') return undefined;
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} returned an answer with no choice`,
      );
    }
    if (!Object.hasOwn(outcomes, label)) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} answered ${repr(label)}, which this guardrail does not map`,
      );
    }
    const floor = guardrail.minConfidence;
    if (floor > 0 && answer.confidence === undefined) {
      // A `noul` answer carries no confidence, and the wire contract forbids one on it.
      // A floor that cannot be read must not pass: treating the missing value as "no
      // opinion, therefore allow" is exactly the failure this check exists to stop.
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} answered without a confidence, and this guardrail ` +
          `requires at least ${floor}`,
      );
    }
    if (answer.confidence !== undefined && answer.confidence < floor) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} answered ${repr(label)} with confidence ` +
          `${answer.confidence}, below the declared minimum ${floor}`,
      );
    }
    const outcome = outcomes[label];
    if (outcome === undefined) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} maps ${repr(label)} to no outcome`,
      );
    }
    if (!DECISION_OUTCOMES.has(outcome)) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `decision ${repr(name)} maps ${repr(label)} to unknown outcome ${repr(outcome)}`,
      );
    }
    if (outcome === ACTION_ALLOW) return undefined;
    return {
      guardrail: guardrail.id,
      stage,
      action: outcome as GuardrailAction,
      policies: [],
      message: guardrail.message,
      decision: name,
      label,
      confidence: answer.confidence,
    };
  }
}

/**
 * Whether `guardrail` applies to this particular call.
 *
 * `tools` is only meaningful on a `tool-call` guardrail, and an empty list means "every
 * tool that reaches the stage" -- absent and empty are the same thing in the IR, and
 * reading them differently here would be a second, undocumented meaning for an empty array.
 */
function covers(
  guardrail: GuardrailDefinition,
  stage: string,
  toolId: string | undefined,
): boolean {
  if (stage !== 'tool-call' || guardrail.tools.length === 0) return true;
  return toolId !== undefined && guardrail.tools.includes(toolId);
}

function textOf(payload: Readonly<Record<string, unknown>>): string {
  const value = payload.text;
  return typeof value === 'string' ? value : '';
}

function firingPolicies(
  guardrail: GuardrailDefinition,
  stage: GuardrailStage,
  payload: Readonly<Record<string, unknown>>,
): string[] {
  const fields = texts(payload);
  const hits: string[] = [];
  for (const policy of guardrail.policies) {
    if (DETECTORS[policy] === undefined) {
      // Fail closed: a policy the engine cannot evaluate is a block, and it is reported
      // with the guardrail that named it so an operator knows which declaration to fix.
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `policy ${repr(policy)} has no evaluator in this runtime`,
      );
    }
    if (fields.some(([, text]) => detect(policy, text).length > 0)) hits.push(policy);
  }
  return hits;
}

/**
 * The guardrail's action, refused if it is outside the closed vocabulary.
 *
 * `GuardrailDefinition.action` is a `string` because the IR layer reads it out of JSON, so
 * this is where the closed set is enforced. It has to be enforced rather than assumed:
 * `decide` looks for `block` by equality, so an unrecognised action could not decide a
 * block and would otherwise fall through to whatever the caller does with "not block" -- an
 * allow nobody declared.
 */
function actionOf(guardrail: GuardrailDefinition): GuardrailAction {
  const action = guardrail.action;
  if (!GUARDRAIL_ACTIONS.includes(action as GuardrailAction)) {
    throw new ConfigurationError(
      `guardrail ${repr(guardrail.id)} declares unknown action ${repr(action)}; ` +
        `expected one of ${GUARDRAIL_ACTIONS.join(', ')}`,
    );
  }
  return action as GuardrailAction;
}

/**
 * The deciding record: the first `block`, else the first record.
 *
 * `block` outranks declaration order deliberately. Ordering is about which of two
 * *comparable* actions wins, and "stop the run" is not comparable to "let it continue with
 * a note"; if declaration order could overrule a block, an author could neuter a strict
 * guardrail by declaring a permissive one first.
 */
function decide(records: readonly GuardrailRecord[]): GuardrailRecord | undefined {
  for (const record of records) {
    if (record.action === ACTION_BLOCK) return record;
  }
  return records.length > 0 ? records[0] : undefined;
}

/**
 * Mask the declared fields, then prove nothing the detectors saw survived.
 *
 * The re-check is the part that matters. A spec that declares `redact: [answer]` for a
 * payload whose violation is in some other field would otherwise "redact" successfully
 * while shipping the violation, so this raises instead of returning a payload it could not
 * clean.
 */
function redact(
  stage: GuardrailStage,
  guardrails: readonly GuardrailDefinition[],
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...payload };
  for (const guardrail of guardrails) {
    for (const name of guardrail.redact) {
      const current = redacted[name];
      if (typeof current !== 'string') continue;
      let value: string = current;
      for (const policy of guardrail.policies) {
        if (!REDACTABLE.has(policy)) {
          throw new GuardrailBlockedError(
            guardrail.id,
            stage,
            `policy ${repr(policy)} detects intent, which masking field ${repr(name)} ` +
              "cannot remove; use 'block', 'flag' or 'escalate'",
          );
        }
        value = mask(policy, value);
      }
      redacted[name] = value;
    }
  }

  for (const guardrail of guardrails) {
    const remaining = firingPolicies(guardrail, stage, redacted);
    if (remaining.length > 0) {
      throw new GuardrailBlockedError(
        guardrail.id,
        stage,
        `redacting [${guardrail.redact.map((field) => repr(field)).join(', ')}] left a ` +
          `${repr(remaining[0] ?? '')} match; the declared fields do not cover the payload`,
      );
    }
  }
  return redacted;
}
