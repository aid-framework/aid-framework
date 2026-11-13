---
description: "The aid command reference, generated from the CLI command table so it cannot list a flag the parser rejects."
---

# CLI reference

The `aid` command, generated from the `COMMANDS` table in `packages/cli/src/main.ts`. The table is also what the parser enforces and what `aid --help` prints, so this page cannot list a flag the CLI does not accept.

```sh
npx @aid-framework/cli --help
```

Every command accepts `-h` / `--help` for its own usage. All except `dev` accept `--json` for one JSON document on stdout; a running server or stream is not a finished run. Human-readable text and progress go to stderr, so `aid validate --json | jq` needs no filtering.

## Commands at a glance

| Command | What it does |
| --- | --- |
| [`init`](#init) | scaffold a project: a starter spec and a README |
| [`validate`](#validate) | parse the spec, build the IR, and run every build-time gate |
| [`resolve`](#resolve) | resolve a customer overlay into the concrete spec it means |
| [`fleet`](#fleet) | report every customer overlay, its profile, pins, ceilings and gate status |
| [`gen`](#gen) | compile the spec and reconcile the tree with it |
| [`dev`](#dev) | regenerate the tree and run the application on a local server |
| [`guard`](#guard) | measure the guardrails against a red-team corpus |
| [`migrate`](#migrate) | emit the SQL the declared vector stores need, for an operator to apply |
| [`ingest`](#ingest) | index a retriever corpus into the store the spec declares |
| [`kb`](#kb) | ask the engine that owns a managed knowledge base to re-ingest it |
| [`eval`](#eval) | run the eval gate, record the baseline it measures against, or apply a promotion policy |
| [`cost`](#cost) | report cost and latency from the local trace sink |
| [`trace`](#trace) | inspect a traced run, or export runs as a dataset an eval can read |
| [`report`](#report) | compare many deployments from their trace sinks and recorded eval baselines |
| [`doctor`](#doctor) | diagnose the tree against the spec: drift, versions, missing files |
| [`eject`](#eject) | take ownership of a generated file: move it to business/ and stop generating it |
| [`infra`](#infra) | derive the deployment wiring from the spec and drive OpenTofu or AWS CDK |
| [`package`](#package) | build the archive an `edge` deployment hands to Lambda@Edge |

## `init`

scaffold a project: a starter spec and a README

```sh
aid init [dir] [--from <spec>] [--template <name>] [--target <name>] [--force] [--gen]
```

| Option | Description |
| --- | --- |
| `--from <spec>` | import an existing spec instead of writing the starter |
| `--template <name>` | scaffold a shipped golden path instead of the minimal starter |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--force` | replace a spec or README that is already there |
| `--gen` | generate immediately after scaffolding |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `validate`

parse the spec, build the IR, and run every build-time gate

```sh
aid validate [spec]
```

| Option | Description |
| --- | --- |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `resolve`

resolve a customer overlay into the concrete spec it means

```sh
aid resolve <overlay> [--out <file>] [--check]
```

| Option | Description |
| --- | --- |
| `--out <file>` | write the resolved spec here instead of printing it |
| `--check` | fail when the resolved spec in the tree does not match its overlay |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `fleet`

report every customer overlay, its profile, pins, ceilings and gate status

```sh
aid fleet [dir]
```

| Option | Description |
| --- | --- |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `gen`

compile the spec and reconcile the tree with it

```sh
aid gen [spec] [--target <name>] [--dry-run] [--check] [--force]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--dry-run` | report what would change, and write nothing |
| `--check` | fail when the committed tree does not match the spec; writes nothing |
| `--force` | overwrite generated files that were edited by hand |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `dev`

regenerate the tree and run the application on a local server

```sh
aid dev [spec] [--target <name>] [--port <n>] [--no-gen] [--no-reload]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--port <n>` | the port to serve on; defaults to 8000, the uvicorn default |
| `--no-gen` | serve the tree as it is, without regenerating it first |
| `--no-reload` | turn off the reloader that restarts the server on code changes |
| `-h`, `--help` | print this command's usage |

## `guard`

measure the guardrails against a red-team corpus

```sh
aid guard [spec] [--target <name>] [--red-team <file>]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--red-team <file>` | the corpus to measure against; defaults to redteam.json beside the spec, then at the project root |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `migrate`

emit the SQL the declared vector stores need, for an operator to apply

```sh
aid migrate [spec] [--out <dir>] [--check] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--out <dir>` | directory for the migration file; defaults to `migrations` |
| `--check` | fail when the committed file does not match the spec; writes nothing |
| `--dry-run` | report what would change, and write nothing |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `ingest`

index a retriever corpus into the store the spec declares

```sh
aid ingest [spec] [--target <name>] [--retriever <id> | --all] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--retriever <id>` | ingest one declared retriever, by the id the spec used |
| `--all` | ingest every retriever the spec declares |
| `--dry-run` | report what a run would write, and write nothing |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `kb`

ask the engine that owns a managed knowledge base to re-ingest it

```sh
aid kb sync [spec] [--target <name>] [--retriever <id> | --all] [--wait]
```

| Option | Description |
| --- | --- |
| `--retriever <id>` | sync one managed retriever, by the id the spec used |
| `--all` | sync every managed retriever the spec declares |
| `--wait` | follow the ingestion job until the engine reports it done |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `eval`

run the eval gate, record the baseline it measures against, or apply a promotion policy

```sh
aid eval [spec] [--target <name>] [--suite <id>] [--baseline] [--record <transcript.json>] [--compare <baseline.json> --candidate <candidate.json>]
```

| Option | Description |
| --- | --- |
| `--suite <id>` | run one eval instead of all of them |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--baseline` | record a fresh baseline instead of gating |
| `--record <path>` | run one agent eval live and write its model calls to a transcript `AID_EVAL_TRANSCRIPT` can replay. Refuses to overwrite an existing transcript, to capture a scripted provider, or to capture while replaying |
| `--compare <path>` | apply gate.promotion to an accepted baseline and a candidate one. The quality allowance is judged; a declared cost ceiling is reported as unjudged because no runtime records cost |
| `--candidate <path>` | the candidate baseline --compare reads |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `cost`

report cost and latency from the local trace sink

```sh
aid cost [dir] [--since <date>] [--budget <usd>]
```

| Option | Description |
| --- | --- |
| `--since <date>` | only count spans that started at or after this date (YYYY-MM-DD or an ISO 8601 instant) |
| `--budget <usd>` | fail when the measured cost exceeds this ceiling |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `trace`

inspect a traced run, or export runs as a dataset an eval can read

```sh
aid trace [run | export] [--dir <dir>] [--all] [--dataset <name>] [--from <dir>] [--filter agent=<id>] [--spec <path>] [--version <v>] [--out <path>] [--force]
```

| Option | Description |
| --- | --- |
| `--dir <dir>` | the trace directory to read (default: $AID_TRACE_DIR) |
| `--all` | print every run in the directory, not just the run list |
| `--dataset <name>` | export: the dataset name, which becomes datasets/&lt;name&gt;.json |
| `--from <dir>` | export: the trace directory to read (same as --dir) |
| `--filter <agent-id>` | export: only export runs whose agent span names this agent |
| `--spec <path>` | export: the spec whose redaction policy governs it (default: app/app.spec.yaml) |
| `--version <v>` | export: the dataset version (default: 1) |
| `--out <path>` | export: the file to write (default: datasets/&lt;name&gt;.json) |
| `--force` | export: replace an existing dataset file |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `report`

compare many deployments from their trace sinks and recorded eval baselines

```sh
aid report <dir> [--budget <usd>]
```

| Option | Description |
| --- | --- |
| `--budget <usd>` | fail when the fleet total exceeds this ceiling |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `doctor`

diagnose the tree against the spec: drift, versions, missing files

```sh
aid doctor [spec] [--target <name>]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `eject`

take ownership of a generated file: move it to business/ and stop generating it

```sh
aid eject <path> [--target <name>] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--dry-run` | report the move, and write nothing |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `infra`

derive the deployment wiring from the spec and drive OpenTofu or AWS CDK

```sh
aid infra <gen|plan|apply|drift> [spec] [--dry-run|--check] [--env <name>] [--iac <tofu|cdk>] [--cloud <aws|gcp>] [--force]
```

| Option | Description |
| --- | --- |
| `--dry-run` | gen: report what would change, and write nothing |
| `--check` | gen: exit non-zero when the generated tree is out of date |
| `--env <name>` | environment root (infra/envs/&lt;name&gt;, infra/envs/gcp-&lt;name&gt;, or infra/cdk/&lt;name&gt;); plan, apply and drift use dev |
| `--iac <tofu\|cdk>` | plan, apply and drift: which backend to drive; defaults to tofu |
| `--cloud <aws\|gcp>` | which cloud the module set targets, and so which env root an action runs in; defaults to aws |
| `--confirm-prod` | required to apply to prod |
| `--force` | gen: overwrite generated files that were edited by hand |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## `package`

build the archive an `edge` deployment hands to Lambda@Edge

```sh
aid package <edge> [spec] [--target <name>] [--out <file>]
```

| Option | Description |
| --- | --- |
| `--out <file>` | archive to write, relative to the working directory; defaults to `edge.zip` |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--json` | print one JSON document on stdout |
| `-h`, `--help` | print this command's usage |

## Maturity and versioning

The framework is pre-1.0: a minor release may still change an interface. The spec language is versioned separately, and `specVersion` decides which constructs a spec may use — asking for a construct newer than the declared version is refused with `spec/not-supported`, naming the version that introduced it.

A command, flag or construct that is specified but not built is recorded here as not built rather than implied to work. This page is generated from the `COMMANDS` table and the [features page](../features.md) from the source, so neither can list a capability the compiler does not generate, test and gate.

## Exit codes

The exit code is the contract CI reads, so the three values are distinct on purpose.

| Code | Meaning |
| --- | --- |
| `0` | The project is in the shape the command asked for |
| `1` | The spec, a gate, the target, or the working tree said no |
| `2` | The invocation was wrong, or the CLI failed internally |

A red build caused by `1` is fixed in the spec; a red build caused by `2` is fixed in the invocation or is a bug. Collapsing them sends people to the wrong file.

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [the spec reference](./spec.md) or [getting started](../guide/getting-started.md).
