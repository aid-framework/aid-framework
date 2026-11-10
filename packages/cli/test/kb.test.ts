/**
 * `aid kb sync` is a shell around the generated sync modules, so what is asserted here is
 * the boundary: which argv gets run, which exit code is propagated, and where the line
 * between "you invoked me wrong" (2) and "this project cannot do that" (1) sits.
 *
 * **Why the refusals matter more than the happy path.** A managed retriever has no ingest
 * module, so before this command there was no way to ask an engine to re-ingest. The worst
 * failure mode would be the quiet one -- a command that reports success with no ingestion
 * job having started -- so every refusal asserts the specific diagnostic code *and* that
 * the provider is named, rather than only the exit code.
 *
 * **Why no test runs Python.** The interpreter is injected, so the argv and the exit
 * statuses are what is under test. The generated modules are executed for real by the E2E
 * job; a unit test that ran one here would be a second, slower copy of that, and would
 * need cloud credentials to say anything true about a managed base.
 *
 * **The fake spawn keys on the probe script, not on `-c`.** `discoverInterpreter` and this
 * command's capability probe are both `python -c <script>`, so a fake that treated every
 * `-c` alike would answer one of them with the other's output.
 */

import { afterAll, describe, expect, it } from 'vitest';

import type { Spawn } from '../src/index.js';
import type { Run, SpawnCall } from './helpers.js';
import { aid, diagnosticsOf, EXAMPLE_SPEC, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch(specText?: string) {
  const made = project(specText);
  created.push(made);
  return made;
}

/** A project whose spec is generated, so the sync modules the command runs exist. */
function generated(specText?: string) {
  const made = scratch(specText);
  const run = aid(made, ['gen']);
  expect(run.code, run.stderr).toBe(0);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

interface ManagedSpecOptions {
  readonly engine: string;
  readonly kind: string;
  readonly uri: string;
  readonly provider: string;
  readonly modelId: string;
}

/**
 * A managed base and the one retriever that reads it.
 *
 * Spelled out rather than derived from the example: the example is a local corpus, and the
 * other shape is the whole point of this command. `engine`, the data source kind and the
 * embedder are parameters because those are exactly what the two managed engines differ
 * on -- `aws-bedrock` over `s3` with a Bedrock embedder, `vertex-rag` over `gcs` with a
 * Google one -- and the command's refusal turns on that difference.
 *
 * Every model names a catalog entry, because the IR builder sources the cost profile from
 * the catalog and refuses a billed model without one. These are real ids, so the spec is
 * accepted by the same gates a user's spec is.
 */
function managedSpec(options: ManagedSpecOptions): string {
  return `specVersion: "0.12"
project:
  name: handbook
  namespace: aid.test.sync
  targets: [py-fastapi]
types:
  Answer:
    kind: struct
    fields:
      text:
        type: string
        required: true
models:
  answer:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema]
  embed:
    provider: ${options.provider}
    modelId: ${options.modelId}
    capabilities: [embeddings]
knowledgeBases:
  handbook:
    engine: ${options.engine}
    dataSource:
      kind: ${options.kind}
      uri: ${options.uri}
    chunking:
      strategy: fixed
      size: 1000
      overlap: 200
    embedModel: embed
    filterable: [tenant]
retrievers:
  docs:
    knowledgeBase: handbook
    topK: 8
prompts:
  reply:
    version: 1
    model: answer
    template: "Answer the question: {{ question }}\\n\\nExcerpts: {{ excerpts }}"
    variables:
      question:
        type: string
        required: true
      excerpts:
        type: string
        required: true
    output:
      kind: structured
      schema: Answer
pipelines:
  answer:
    trigger:
      http:
        method: post
        path: /answer
    steps:
      # context is owned by the generated entrypoint, so the retrieved binding is named
      # for what it holds and the generate step inlines it under the same name.
      - retrieve:
          retriever: docs
          query: "{{ event.question }}"
          as: excerpts
      - generate:
          prompt: reply
          input:
            question: "{{ event.question }}"
          context: excerpts
          as: reply
      - emit:
          event: Answer
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: The request reads as an attempt to redirect the assistant, so it was refused.
      log: true
evals:
  # Retrieval is measured by its own harness -- one ranked, cited result per case through
  # the retriever -- so it is a second eval rather than a second metric, which is exactly
  # what the generator requires.
  retrieval_quality:
    description: Whether retrieval finds the handbook pages a question needs.
    target: pipeline:answer
    dataset:
      source: file
      uri: evals/retrieval_quality.json
    metrics:
      - kind: retrieval
        expectDocs: [getting-started.md]
        k: 3
    gate:
      ci: true
      maxRegression: 0.05
      samples: 3
`;
}

const BEDROCK_SPEC = managedSpec({
  engine: 'aws-bedrock',
  kind: 's3',
  uri: 's3://acme-handbook/corpus',
  provider: 'bedrock',
  modelId: 'amazon.titan-embed-text-v2:0',
});

/** The same retriever on an engine that has no ingestion job to start. */
const VERTEX_SPEC = managedSpec({
  engine: 'vertex-rag',
  kind: 'gcs',
  uri: 'gs://acme-handbook/corpus',
  provider: 'google',
  modelId: 'gemini-embedding-001',
});

/** The one local retriever the committed example declares. */
const LOCAL_ID = 'handbook';

interface SyncSpawnOptions {
  /** What the runtime answers when asked whether the engine can be synced. */
  readonly supported?: boolean;
  readonly reason?: string;
  /** The exit status of a real module run. */
  readonly status?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface SyncSpawn {
  readonly spawn: Spawn;
  /** Every argv the command ran, in order. */
  readonly calls: readonly SpawnCall[];
  /** Only the `-m <module>` runs: the ones that are a sync rather than a probe. */
  readonly runs: () => readonly (readonly string[])[];
}

/**
 * A spawn that answers the two probes and then the module run.
 *
 * The capability probe is answered with the runtime's own JSON shape, so the command's
 * parse of it is exercised rather than bypassed.
 */
function syncSpawn(options: SyncSpawnOptions = {}): SyncSpawn {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, stdin: spawnOptions.stdin, cwd: spawnOptions.cwd });
    const at = args.indexOf('-c');
    if (at !== -1 && (args[at + 1] ?? '').includes('sync_support')) {
      const engine = args[at + 2] ?? '';
      const supported = options.supported ?? true;
      const answer = supported
        ? { engine, supported }
        : { engine, supported, reason: options.reason ?? `${engine} has no ingestion job` };
      return { status: 0, stdout: JSON.stringify(answer), stderr: '' };
    }
    // Discovery asks whether the interpreter can import the runtime. Answering it with a
    // module run's output would make the two indistinguishable to the code under test.
    if (args.includes('-c')) return { status: 0, stdout: '', stderr: '' };
    return {
      status: options.status ?? 0,
      stdout: options.stdout ?? 'knowledge base handbook job job-1: COMPLETE\n',
      stderr: options.stderr ?? '',
    };
  };
  return {
    spawn,
    calls,
    runs: () => calls.filter((call) => call.args.includes('-m')).map((call) => call.args),
  };
}

const SUMMARY = 'ask the engine that owns a managed knowledge base to re-ingest it';

function expectUsageError(run: Run): void {
  expect(run.code).toBe(2);
  expect(run.stderr).not.toMatch(/unknown command/);
}

describe('aid kb -- the command exists', () => {
  it('lists kb as a row with its summary, on stdout', () => {
    const run = aid(scratch(), []);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('Usage: aid <command>');
    expect(run.stdout).toMatch(new RegExp(`^\\s*kb\\s{2,}${SUMMARY}\\s*$`, 'm'));
    expect(run.stderr).toBe('');
  });

  it('is no longer an unknown command', () => {
    const run = aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--all'], { spawn: syncSpawn().spawn });
    expect(run.code).toBe(0);
    expect(run.stderr).not.toMatch(/unknown command/);
  });

  it('documents its own flags when asked for help', () => {
    const run = aid(scratch(), ['kb', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: aid kb');
    expect(run.stdout).toContain('--retriever');
    expect(run.stdout).toContain('--all');
    expect(run.stdout).toContain('--wait');
  });
});

describe('aid kb -- the subcommand and flag shape', () => {
  it('requires a subcommand', () => {
    const run = aid(scratch(), ['kb', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/kb-subcommand-required');
  });

  it('names sync when it does not recognise the subcommand', () => {
    const run = aid(scratch(), ['kb', 'ingest', '--json']);
    expectUsageError(run);
    const first = diagnosticsOf(run)[0];
    expect(first?.code).toBe('cli/kb-unknown-subcommand');
    expect(first?.message).toContain('ingest');
    expect(first?.hint).toContain('sync');
  });

  it('rejects `--retriever` together with `--all`', () => {
    const run = aid(scratch(), ['kb', 'sync', '--retriever', LOCAL_ID, '--all', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-conflict');
  });

  it('rejects neither `--retriever` nor `--all`', () => {
    const run = aid(scratch(), ['kb', 'sync', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-required');
  });

  it('does not let `--wait` stand in for `--retriever` or `--all`', () => {
    expectUsageError(aid(scratch(), ['kb', 'sync', '--wait']));
  });
});

describe('aid kb sync -- what cannot be synced', () => {
  it('refuses a target that emits TypeScript', () => {
    // The TS target refuses a managed retriever before rendering a byte, so a managed
    // retriever cannot exist there at all -- but the command must still say so rather than
    // report the missing Python module that `aid gen` could never create.
    const made = generated(BEDROCK_SPEC);
    const run = aid(made, ['kb', 'sync', '--all', '--target', 'ts-vercel', '--json'], {
      spawn: syncSpawn().spawn,
    });
    expectUsageError(run);
    const first = diagnosticsOf(run)[0];
    expect(first?.code).toBe('cli/runner-unsupported');
    expect(first?.message).toContain('ts-vercel');
    expect(first?.hint).toContain('Python');
  });

  it('refuses a local retriever by name, and points at ingest instead', () => {
    // A local retriever's corpus is written by this process. There is no engine-side job,
    // so the request is a usage error rather than a failed run: nothing was judged.
    const run = aid(generated(), ['kb', 'sync', '--retriever', LOCAL_ID, '--json'], {
      spawn: syncSpawn().spawn,
    });
    expectUsageError(run);
    const first = diagnosticsOf(run)[0];
    expect(first?.code).toBe('cli/kb-retriever-not-managed');
    expect(first?.message).toContain(LOCAL_ID);
    expect(first?.hint).toContain(`aid ingest --retriever ${LOCAL_ID}`);
  });

  it('refuses a vertex-rag engine, quoting the runtime and naming the provider', () => {
    // The answer comes from the runtime, so this asserts the provider name survives the
    // round trip -- a CLI with its own provider list would pass a message assertion only by
    // duplicating the sentence it is supposed to be quoting.
    const made = generated(VERTEX_SPEC);
    const fake = syncSpawn({
      supported: false,
      reason:
        'a vertex-rag corpus is imported by a long-running operation the caller holds; there is no ingestion job to start',
    });
    const run = aid(made, ['kb', 'sync', '--retriever', 'docs', '--json'], { spawn: fake.spawn });
    expectUsageError(run);
    const first = diagnosticsOf(run)[0];
    expect(first?.code).toBe('cli/kb-engine-unsupported');
    expect(first?.message).toContain('vertex-rag');
    expect(first?.hint).toContain('long-running operation');
    // Nothing was started: a refusal that had already begun a job would be the failure
    // mode this command exists to avoid.
    expect(fake.runs()).toHaveLength(0);
  });

  it('names the declared ids when the id is not one of them', () => {
    const run = aid(generated(), ['kb', 'sync', '--retriever', 'zz-not-declared', '--json'], {
      spawn: syncSpawn().spawn,
    });
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-not-found');
  });

  it('fails, rather than reporting success, when the module was never generated', () => {
    // Exit 1: the request is well formed and the project simply has not been generated,
    // so `aid gen` is the action that fixes it.
    const made = scratch(BEDROCK_SPEC);
    const run = aid(made, ['kb', 'sync', '--all', '--json'], { spawn: syncSpawn().spawn });
    expect(run.code).toBe(1);
    const first = diagnosticsOf(run)[0];
    expect(first?.code).toBe('cli/kb-sync-modules-missing');
    expect(first?.hint).toContain('aid gen');
  });
});

describe('aid kb sync -- nothing to do is a success', () => {
  it('exits 0 with an empty result when no managed retriever is declared', () => {
    const found = generated();
    const fake = syncSpawn();
    const run = aid(found, ['kb', 'sync', '--all', '--json'], { spawn: fake.spawn });
    expect(run.code).toBe(0);
    expect(run.json<{ results: unknown[] }>().results).toEqual([]);
    expect(diagnosticsOf(run)).toEqual([]);
    // Nothing was started, so nothing may be reported as started.
    expect(fake.runs()).toHaveLength(0);
  });

  it('says so in one sentence without --json', () => {
    const run = aid(generated(), ['kb', 'sync', '--all'], { spawn: syncSpawn().spawn });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe('No managed retrievers are declared; nothing to sync.');
  });

  it('succeeds on a TypeScript target, because there is nothing to refuse', () => {
    // The empty selection is judged before the runner, so a project with no managed
    // retriever does not fail on a target that could not have run one anyway.
    const run = aid(generated(), ['kb', 'sync', '--all', '--target', 'ts-vercel', '--json'], {
      spawn: syncSpawn().spawn,
    });
    expect(run.code).toBe(0);
    expect(run.json<{ results: unknown[] }>().results).toEqual([]);
  });
});

describe('aid kb sync -- what it runs', () => {
  it('runs the generated module for the named managed retriever', () => {
    const fake = syncSpawn();
    const run = aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--retriever', 'docs'], {
      spawn: fake.spawn,
    });
    expect(run.code).toBe(0);
    expect(fake.runs()).toEqual([['-m', 'app.generated.retrieval.sync.docs']]);
    expect(run.stdout).toContain('job-1: COMPLETE');
  });

  it('forwards --wait to the module, and only when asked', () => {
    // Waiting is the module's own flag: it owns the polling loop and the timeout, so the
    // command passes the word through rather than observing the job itself.
    const waiting = syncSpawn();
    aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--all', '--wait'], { spawn: waiting.spawn });
    expect(waiting.runs().at(0)).toContain('--wait');

    const quick = syncSpawn();
    aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--all'], { spawn: quick.spawn });
    expect(quick.runs().at(0)).not.toContain('--wait');
  });

  it('reports one result per retriever under --json', () => {
    const run = aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--all', '--json'], {
      spawn: syncSpawn().spawn,
    });
    expect(run.code).toBe(0);
    const report = run.json<{
      results: { retriever: string; engine: string; module: string; status: number }[];
    }>();
    expect(report.results).toEqual([
      {
        retriever: 'docs',
        engine: 'aws-bedrock',
        module: 'app.generated.retrieval.sync.docs',
        status: 0,
      },
    ]);
  });

  it('propagates a failed job as exit 1, and surfaces what the module said', () => {
    // A job the engine reported as FAILED is the module's non-zero exit. Swallowing it
    // would let a broken corpus look rebuilt.
    const fake = syncSpawn({
      status: 1,
      stdout: 'knowledge base handbook job job-2: FAILED\n',
      stderr: 'failure: the data source role cannot read s3://acme-handbook/corpus',
    });
    const run = aid(generated(BEDROCK_SPEC), ['kb', 'sync', '--all'], { spawn: fake.spawn });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAILED');
    expect(run.stderr).toContain('cannot read');
    expect(run.stderr).not.toMatch(/unknown command/);
  });
});

describe('aid kb sync -- the generated modules', () => {
  it('emits a runnable module per managed retriever, and none for a local one', () => {
    const managed = generated(BEDROCK_SPEC);
    expect(managed.walk()).toContain('app/generated/retrieval/sync/docs.py');
    const module = managed.read('app/generated/retrieval/sync/docs.py');
    // The command runs it as `-m`, so the module needs a guarded entry point and the flag
    // it forwards; either one missing turns the invocation into a no-op that exits 0.
    expect(module).toContain('def main(');
    expect(module).toContain('--wait');

    const local = generated();
    expect(local.walk().some((path) => path.startsWith('app/generated/retrieval/sync/'))).toBe(
      false,
    );
    // The local app still gets its ingest module, which is the mirror image of the rule.
    expect(local.walk()).toContain(`app/generated/retrieval/ingest/${LOCAL_ID}.py`);
  });

  it('names only the subpackages it emitted', () => {
    // `retrieval/__init__.py` importing `ingest` in an app that has only `sync` would raise
    // ImportError on the first import of the package, so the docstring module has to follow
    // the tree rather than assume the local shape. The assertion reads the import line,
    // not the whole file: the docstring names both entry points on purpose.
    const managed = generated(BEDROCK_SPEC);
    const managedInit = managed.read('app/generated/retrieval/__init__.py');
    expect(managedInit).toContain('from . import bindings, sync\n');
    expect(managedInit).toContain('__all__ = ["bindings", "sync"]');

    const local = generated();
    const localInit = local.read('app/generated/retrieval/__init__.py');
    expect(localInit).toContain('from . import bindings, ingest\n');
    expect(localInit).toContain('__all__ = ["bindings", "ingest"]');
  });

  it('leaves the committed example with no sync tree at all', () => {
    // The example is a local corpus, so this layer adds nothing to it. A directory here
    // would mean the change moved a golden tree it was not supposed to touch.
    const made = scratch(EXAMPLE_SPEC);
    expect(aid(made, ['gen']).code).toBe(0);
    expect(made.walk().some((path) => path.startsWith('app/generated/retrieval/sync'))).toBe(false);
  });
});
