# Security Policy

AID Framework generates and runs AI applications, which means security issues here can be unusually
consequential: generated code runs with your credentials, tools take real-world actions, and prompts and
traces can carry sensitive data. We take that seriously.

## Supported versions

AID Framework is **pre-alpha** and has no releases yet. There are no supported versions to patch at this time.

| Version | Supported |
| --- | --- |
| `main` (pre-alpha) | ❌ No — not for production use |
| Latest tagged release | ❌ None published yet |

This table will be updated when the first release is published.

## Secret scanning

GitHub secret scanning and **push protection** are enabled on this repository, so a commit containing a
recognized provider token is rejected before it can reach a branch. Two gaps are known:

- **Non-provider patterns are disabled.** Generic credential shapes — private keys, connection strings,
  high-entropy strings — are not detected. Report anything you notice; do not assume the scanner caught it.
- **Secret-scanning alerts are not status checks.** A detected secret does not fail CI and does not block a
  pull request. Alerts are reviewed by a human in the Security tab, which means detection is not the same as
  enforcement.

**Contributor rule:** never commit a real provider token, or a realistic-looking one, anywhere in this
repository — not in a test fixture, golden file, dataset, or documentation example. Push protection will
reject the push, and a secret that reaches a branch is handled as a live incident. Use obviously fake
sentinel values instead.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use **GitHub Private Vulnerability Reporting**: on this repository's **Security** tab, click
**Report a vulnerability** — or open the [private advisory form](https://github.com/aid-framework/aid-framework/security/advisories/new)
directly.

That private advisory form is the only supported reporting channel; we do not accept security reports by
email.

Include, as applicable:

- A description of the issue and its impact.
- Affected component (spec parser, IR, a specific generator plugin, a runtime library, the CLI) and version/commit.
- A minimal reproduction — a spec fragment, generated file, or command is ideal.
- Any known mitigations or workarounds.

Please **do not include real secrets, API keys, credentials, or personal data** in a report. Use redacted or
synthetic values.

## What to expect

We aim to:

- Acknowledge your report within **5 business days**.
- Provide an initial assessment (accepted / needs more info / out of scope) within **10 business days**.
- Keep you informed of progress and credit you in the advisory if you wish.

These timelines are best-effort while the project is small, and will be revisited once it has maintainers on
rotation. Please give us a reasonable window to fix an issue before disclosing it publicly.

## Scope

**In scope** — anything that undermines the guarantees AID Framework claims:

- The spec parser, IR builder, and validator (including validation bypasses).
- Generator plugins and the regeneration/drift machinery (e.g. silently overwriting developer-owned files).
- Runtime libraries: model gateway, prompt registry, retrieval, agent loop, tool executor, memory,
  guardrails, eval harness, tracing.
- The CLI and its handling of credentials, config, and subprocesses.
- **Insecure defaults in generated code** — e.g. a destructive tool generated without its declared `auth`
  check, missing confirmation, or a pipeline that skips a declared input guardrail.

**Out of scope** (report to the relevant upstream project, or treat as expected behavior):

- Model hallucination, factual errors, or general model quality — these are what evals and guardrails are
  for, not security bugs.
- Vulnerabilities in third-party ecosystems we generate against (LangGraph, LlamaIndex, Pydantic AI, …) or in
  provider APIs.
- Issues that require the operator to have already disabled a documented safety control.

## AI-specific issue classes

Because this is an AI framework, the following classes of issue are explicitly in scope and we want to hear
about them:

- **Prompt injection & jailbreaks** — a guardrail policy, stage placement, or context-assembly path that
  allows untrusted content (retrieved documents, tool output, user input) to override instructions or steer
  tool use. Includes guardrail bypasses through encoding, tool results, or multi-turn state.
- **Tool misuse & excessive agency** — a tool executed without its declared `auth` check, without required
  confirmation for `destructive` side effects, or without idempotency; a tool granted broader permissions or
  side effects than the spec declares; unbounded tool-call or step loops.
- **PII & secret leakage** — sensitive data reaching logs, traces, eval datasets, caches, or model providers
  when the spec declares it should be redacted; a tracing or observability path that ignores the declared
  redaction list; secrets baked into generated code or manifests instead of read from the environment.
- **Budget & prompt-injection of the framework itself** — bypassing declared token/cost/step budgets,
  including via attacker-controlled input that inflates a run.
- **RAG-specific** — cross-tenant retrieval leakage, citation spoofing, or ingestion of untrusted documents
  that bypass guardrail stages.

If you are unsure whether something is in scope, report it privately and let us triage.

## Safe harbor

We will not pursue or support legal action against researchers who make a good-faith effort to comply with
this policy, avoid privacy violations and destructive actions against real systems, and give us reasonable
time to remediate before public disclosure. Test against your own deployments and synthetic data.
