---
description: "The aid command reference, generated from the CLI command table so it cannot list a flag the parser rejects."
---

# CLI reference

The `aid` command, generated from the `COMMANDS` table in `packages/cli/src/main.ts`. The table is also what the parser enforces and what `aid --help` prints, so this page cannot list a flag the CLI does not accept.

```sh
npx @aid-framework/cli --help
```

Every command accepts `-h` / `--help` for its own usage, and `--json` for one JSON document on stdout. Human-readable text and progress go to stderr, so `aid validate --json | jq` needs no filtering.

## Commands at a glance

| Command | What it does |
| --- | --- |
| [`init`](#init) | scaffold a project: a starter spec and a README |
| [`validate`](#validate) | parse the spec, build the IR, and run every build-time gate |
| [`gen`](#gen) | compile the spec and reconcile the tree with it |
| [`ingest`](#ingest) | index a retriever corpus into the store the spec declares |
| [`eval`](#eval) | run the eval gate, or record the baseline it measures against |
| [`doctor`](#doctor) | diagnose the tree against the spec: drift, versions, missing files |

## `init`

scaffold a project: a starter spec and a README

```sh
aid init [dir] [--from <spec>] [--target <name>] [--force] [--gen]
```

| Option | Description |
| --- | --- |
| `--from <spec>` | import an existing spec instead of writing the starter |
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

## `gen`

compile the spec and reconcile the tree with it

```sh
aid gen [spec] [--target <name>] [--dry-run] [--force]
```

| Option | Description |
| --- | --- |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--dry-run` | report what would change, and write nothing |
| `--force` | overwrite generated files that were edited by hand |
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

## `eval`

run the eval gate, or record the baseline it measures against

```sh
aid eval [spec] [--target <name>] [--suite <id>] [--baseline]
```

| Option | Description |
| --- | --- |
| `--suite <id>` | run one eval instead of all of them |
| `--target <name>` | generator target; one of py-fastapi, ts-vercel |
| `--baseline` | record a fresh baseline instead of gating |
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
