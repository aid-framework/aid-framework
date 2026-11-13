import { describe, expect, it } from 'vitest';

import {
  buildIR,
  type IR,
  IR_DIAGNOSTIC_CODES,
  type IrDiagnosticCode,
  runGates,
} from '../../src/index.js';
import { codesOf, first } from '../helpers.js';

/**
 * The resume route is one route for every agent, and what it accepts decides whether
 * holding a checkpoint is authority to run a paused write. These tests drive the gate
 * directly: the negative cases are all valid documents, so layer 1 lets them through and
 * the gate is the only thing that can refuse them.
 */

interface Options {
  specVersion?: string;
  profile?: string;
  /** Omitted means the document declares no store at all. */
  state?: Record<string, unknown>;
  agentState?: Record<string, unknown>;
  guardrailAction?: string;
  /** Adds a second pausable agent, for the agreement cases. */
  second?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}

const TYPES = {
  Claim: {
    kind: 'struct' as const,
    fields: { id: { type: 'string' as const, required: true } },
  },
};

const READ_TOOL = {
  lookup_claim: {
    description: 'Look up a claim.',
    input: 'Claim',
    output: 'Claim',
    handler: { kind: 'business' as const, symbol: 'lookup_claim' },
    sideEffects: 'read' as const,
  },
};

const WRITE_TOOL = {
  ...READ_TOOL,
  file_claim: {
    description: 'File a claim.',
    input: 'Claim',
    output: 'Claim',
    handler: { kind: 'business' as const, symbol: 'file_claim' },
    sideEffects: 'write' as const,
  },
};

/**
 * A document whose only agent can pause, so the gate has something to judge.
 *
 * The pause comes from `action: escalate` on a guardrail the agent carries -- the third
 * route `agentCanPause` honours -- which keeps every case independent of whether the agent
 * also reaches a write tool. That independence matters: the delivery gate already refuses
 * an enterprise write with no store, and the replay case has to be observed on an agent
 * that gate leaves alone.
 */
function document(options: Options = {}): unknown {
  const agent: Record<string, unknown> = {
    model: 'm',
    instructions: 'Review the claim.',
    tools: ['lookup_claim'],
    maxSteps: 6,
    maxCostBudget: 1,
    guardrails: ['escalate_to_human'],
    ...options.agents,
  };
  if (options.agentState !== undefined) agent.state = options.agentState;

  const doc: Record<string, unknown> = {
    specVersion: options.specVersion ?? '0.32',
    project: { name: 'p' },
    profile: options.profile ?? 'standard',
    types: TYPES,
    models: {
      m: { provider: 'openai', modelId: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    },
    tools: options.tools ?? READ_TOOL,
    guardrails: {
      escalate_to_human: {
        stages: ['output'],
        policies: ['pii-detect'],
        action: options.guardrailAction ?? 'escalate',
      },
    },
    agents: { reviewer: agent },
  };
  if (options.second !== undefined) {
    (doc.agents as Record<string, unknown>).second = {
      model: 'm',
      instructions: 'Review it again.',
      tools: ['lookup_claim'],
      maxSteps: 6,
      maxCostBudget: 1,
      guardrails: ['escalate_to_human'],
      ...options.second,
    };
  }
  if (options.state !== undefined) doc.state = options.state;
  return doc;
}

interface Outcome {
  ir: IR;
  codes: string[];
  diagnostics: { code: IrDiagnosticCode; severity: string; message: string }[];
}

function resume(options: Options = {}): Outcome {
  const built = buildIR(document(options));
  const diagnostics = runGates(built.ir).byGate.resume.diagnostics;
  return {
    ir: built.ir,
    codes: codesOf(diagnostics),
    diagnostics: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
}

function severityOf(options: Options, code: IrDiagnosticCode): string {
  return only(resume(options), code).severity;
}

/** The one diagnostic with `code`, or a failure naming what was actually emitted. */
function only(outcome: Outcome, code: IrDiagnosticCode) {
  const matches = outcome.diagnostics.filter((entry) => entry.code === code);
  const head = matches[0];
  if (head === undefined || matches.length !== 1) {
    throw new Error(
      `expected exactly one ${code}, found ${matches.length} in:\n${outcome.codes.join(', ')}`,
    );
  }
  return head;
}

const SIGNED = { kind: 'postgres', urlEnv: 'DATABASE_URL', signingKeyEnv: 'AID_CHECKPOINT_KEY' };

describe('the resume gate', () => {
  it('says nothing about a document whose agents cannot pause', () => {
    const outcome = resume({ guardrailAction: 'block' });
    expect(outcome.codes).toEqual([]);
  });

  it('accepts an enterprise document that signs its checkpoints and stores their nonces', () => {
    const outcome = resume({ profile: 'enterprise', state: SIGNED });
    expect(outcome.codes).toEqual([]);
  });

  it('refuses an enterprise document whose paused runs are unsigned', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: { kind: 'postgres', urlEnv: 'DATABASE_URL' },
    });
    expect(outcome.codes).toEqual([IR_DIAGNOSTIC_CODES.resumeUnsigned]);
    const unsigned = only(outcome, IR_DIAGNOSTIC_CODES.resumeUnsigned);
    expect(unsigned.severity).toBe('error');
    expect(unsigned.message).toContain('bearer capability');
  });

  it('warns rather than errors about an unsigned resume under standard', () => {
    const outcome = resume({ state: { kind: 'postgres', urlEnv: 'DATABASE_URL' } });
    expect(outcome.codes).toEqual([IR_DIAGNOSTIC_CODES.resumeUnsigned]);
    expect(
      severityOf(
        { state: { kind: 'postgres', urlEnv: 'DATABASE_URL' } },
        IR_DIAGNOSTIC_CODES.resumeUnsigned,
      ),
    ).toBe('warning');
  });

  it('warns instead of errors when the document is too old to name a signing key', () => {
    // An author before 0.32 has no key to declare, so an error would be a refusal with no
    // available fix. The warning names the version that makes it fixable.
    const options: Options = {
      profile: 'enterprise',
      specVersion: '0.31',
      state: { kind: 'postgres', urlEnv: 'DATABASE_URL' },
    };
    expect(severityOf(options, IR_DIAGNOSTIC_CODES.resumeUnsigned)).toBe('warning');
    expect(first(resume(options).diagnostics).message).toContain('0.32');
  });

  it('refuses an enterprise document that cannot refuse a replay', () => {
    const outcome = resume({ profile: 'enterprise' });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeReplayWeak);
    expect(severityOf({ profile: 'enterprise' }, IR_DIAGNOSTIC_CODES.resumeReplayWeak)).toBe(
      'error',
    );
  });

  it('warns that a standard document refutes a replay only within one process', () => {
    const outcome = resume();
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeReplayWeak);
    expect(severityOf({}, IR_DIAGNOSTIC_CODES.resumeReplayWeak)).toBe('warning');
    expect(
      first(
        outcome.diagnostics.filter((entry) => entry.code === IR_DIAGNOSTIC_CODES.resumeReplayWeak),
      ).message,
    ).toContain('another replica');
  });

  it('leaves the missing store to the delivery gate when the agent writes', () => {
    // One absence, one diagnostic: the delivery gate already refuses this and naming the
    // same missing `state` twice would tell the author to make two changes to fix one.
    const outcome = resume({
      profile: 'enterprise',
      tools: WRITE_TOOL,
      agents: { tools: ['file_claim'] },
    });
    expect(outcome.codes).not.toContain(IR_DIAGNOSTIC_CODES.resumeReplayWeak);
  });

  it('refuses two pausable agents that name different signing keys', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: SIGNED,
      second: { state: { kind: 'postgres', urlEnv: 'DATABASE_URL', signingKeyEnv: 'OTHER_KEY' } },
    });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeKeyConflict);
    const conflict = only(outcome, IR_DIAGNOSTIC_CODES.resumeKeyConflict);
    expect(conflict.message).toContain('AID_CHECKPOINT_KEY');
    expect(conflict.message).toContain('OTHER_KEY');
  });

  it('refuses two pausable agents that declare different checkpoint lifetimes', () => {
    // One app, one signer, one window: the emitted `ttl_seconds` would otherwise be
    // whichever declaration the generator read first.
    const outcome = resume({
      profile: 'enterprise',
      state: { ...SIGNED, checkpointTtlMinutes: 15 },
      second: { state: { ...SIGNED, checkpointTtlMinutes: 60 } },
    });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeKeyConflict);
    const conflict = only(outcome, IR_DIAGNOSTIC_CODES.resumeKeyConflict);
    expect(conflict.message).toContain('15');
    expect(conflict.message).toContain('60');
  });

  it('accepts one document-level lifetime shared by both pausable agents', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: { ...SIGNED, checkpointTtlMinutes: 30 },
    });
    expect(outcome.codes).not.toContain(IR_DIAGNOSTIC_CODES.resumeKeyConflict);
  });

  it('refuses two pausable agents that declare different stores', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: SIGNED,
      second: {
        state: { kind: 'sqlite', urlEnv: 'RUN_DB_PATH', signingKeyEnv: 'AID_CHECKPOINT_KEY' },
      },
    });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeKeyConflict);
  });

  it('refuses a signing key that is the connection string', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: { kind: 'postgres', urlEnv: 'DATABASE_URL', signingKeyEnv: 'DATABASE_URL' },
    });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeKeyAlias);
    const alias = only(outcome, IR_DIAGNOSTIC_CODES.resumeKeyAlias);
    expect(alias.message).toContain('run-store connection string');
  });

  it('refuses a signing key that is another credential the app already uses', () => {
    // The provider key is already a name the document carries, so aliasing it is visible
    // at build time -- and a checkpoint key that is also the model key cannot be rotated
    // without rotating both.
    const outcome = resume({
      profile: 'enterprise',
      state: { kind: 'postgres', urlEnv: 'DATABASE_URL', signingKeyEnv: 'OPENAI_API_KEY' },
    });
    expect(outcome.codes).toContain(IR_DIAGNOSTIC_CODES.resumeKeyAlias);
    const alias = only(outcome, IR_DIAGNOSTIC_CODES.resumeKeyAlias);
    expect(alias.message).toContain('provider key for model "m"');
  });

  it('reads the agent store over the document store, exactly as the generator does', () => {
    // The agent's own declaration wins, so an agent left unsigned under a signed document
    // is still unsigned -- and the gate has to see that rather than reading the document.
    const outcome = resume({
      profile: 'enterprise',
      state: SIGNED,
      agentState: { kind: 'postgres', urlEnv: 'DATABASE_URL' },
    });
    expect(outcome.codes).toEqual([IR_DIAGNOSTIC_CODES.resumeUnsigned]);
  });

  it('judges an agent that inherits the document store as signed', () => {
    const outcome = resume({ profile: 'enterprise', state: SIGNED });
    expect(outcome.codes).toEqual([]);
    expect(first(outcome.ir.agents).state).toEqual(SIGNED);
  });

  it('carries the resume window into the IR', () => {
    const outcome = resume({
      profile: 'enterprise',
      state: { ...SIGNED, checkpointTtlMinutes: 45 },
    });
    expect(outcome.ir.state?.checkpointTtlMinutes).toBe(45);
    expect(outcome.ir.state?.signingKeyEnv).toBe('AID_CHECKPOINT_KEY');
  });
});
