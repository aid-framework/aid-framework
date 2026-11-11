---
description: "A 0.29 base spec that offers four overridable paths, five customer overlays the gate refuses -- an unlisted path, a weakened guardrail, a value past its bound, a model outside its list, a contradicting profile -- their fixes, and the fleet table they resolve into."
---

# Walkthrough: one base spec, one overlay per customer

Spec 0.29 adds the part of "agents at scale" that has nothing to do with a server: a base spec
declares **which paths a customer may change and within what bound**, each customer gets a small
overlay file naming only their differences, and `aid resolve` produces the one concrete spec that
`aid validate` and `aid gen` already understand.

The control plane is still git. There is no registry, no API, and no per-customer database: an
overlay is a file that diff-reviewers can read, and `aid fleet` is a report over those files.

This walkthrough starts from a base that passes, writes five overlays that fail, fixes them, and
ends with the fleet table. Every console block below is real output from this repository's CLI.

## The base spec

Start from the enterprise golden path, which is already a complete, gate-clean spec:

```console
$ aid init desk --template enterprise-approvals
created app/app.spec.yaml
created README.md
next: aid validate, then aid gen
$ cd desk
$ aid validate
app/app.spec.yaml: ok (0 errors, 0 warnings)
```

The template is the base. It names what a customer is allowed to decide, and nothing else:

```yaml
overridable:
  deployments.prod.region:
    from: [eu-central-1, us-east-1, ap-southeast-2]
  models.triage.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 2.5
  deployments.prod.audit.retentionDays:
    max: 730
```

Four paths, each with a bound. `from` lists the values that are acceptable; `max` is a ceiling
that may be lowered freely and raised not at all. A path that is not here is not overridable, and
listing a path does not open what is underneath it.

## An overlay names only the differences

```bash
mkdir customers
```

```yaml
# customers/acme.yaml
base: ../app/app.spec.yaml
customer: acme-eu
profile: enterprise
overrides:
  deployments.prod.region: ap-southeast-2
  models.triage.modelId: gpt-4.1-mini
  agents.triage_agent.maxCostBudget: 1.5
```

```console
$ aid resolve customers/acme.yaml --out customers/acme.spec.yaml
wrote customers/acme.spec.yaml (3 overrides applied)
```

Three overrides, one spec. The result is a plain 0.29 document: it has `profile: enterprise`, the
base's guardrails, identity, network and approval policy, the customer's region and model, and the
customer's ceiling of 1.5 -- and it is what you commit next to the overlay so a reviewer can see
both the intent and the effect.

## Five overlays the gate refuses

Each one is refused before generation, with a diagnostic naming the path.

### A path the base never offered

```yaml
overrides:
  project.name: acme-support
```

```console
$ aid resolve customers/acme.yaml
customers/acme.yaml: refused for "acme-eu"
customers/acme.yaml: error: the overlay gate rejected "acme-eu": overrides "project.name" is not an overridable path in the base spec [overlay/path-not-overridable]
    at project.name
    hint: add project.name to the base spec's overridable block
```

AID does not infer that a nearby listed path implies this one, and it does not offer a wildcard.
**The fix** is a decision in the base repo: either add `project.name` to `overridable` (visible in
the base's diff, reviewed once, applied to every customer) or drop the override.

### A guardrail turned down

```yaml
overrides:
  deployments.prod.audit.retentionDays: 30
```

```console
$ aid resolve customers/acme.yaml
customers/acme.yaml: refused for "acme-eu"
customers/acme.yaml: error: the overlay gate rejected "acme-eu": it lowers "deployments.prod.audit.retentionDays" from 400 to 30, which relaxes a control, and the base does not permit weakening at that path [overlay/weakens-control]
    at deployments.prod.audit.retentionDays
    hint: mark the path allowWeaken: true in the base, or keep the base value
```

Being inside `max: 730` is not enough: a value below what the base declared also relaxes the
control, so it needs a separate permission. **The fix** is
`deployments.prod.audit.retentionDays: { allowWeaken: true }` in the base -- one line, reviewed
once, and every customer's weaker retention is then a fact the base owner approved.

### A budget past its ceiling

```yaml
overrides:
  agents.triage_agent.maxCostBudget: 9
```

```console
$ aid resolve customers/acme.yaml
customers/acme.yaml: refused for "acme-eu"
customers/acme.yaml: error: the overlay gate rejected "acme-eu": 9 exceeds the 2.5 the base allows at "agents.triage_agent.maxCostBudget" [overlay/value-out-of-bounds]
    at agents.triage_agent.maxCostBudget
    hint: use a value of at most 2.5, or raise 'max' in the base
```

This is also a relaxation, and the refusal names the bound rather than the relaxation, because
`allowWeaken` would not admit 9 either. **The fix** is a value of 2.5 or less, or a base that
actually offers a bigger ceiling.

### A model outside the list

```yaml
overrides:
  models.triage.modelId: gpt-4o
```

```console
$ aid resolve customers/acme.yaml
customers/acme.yaml: refused for "acme-eu"
customers/acme.yaml: error: the overlay gate rejected "acme-eu": "gpt-4o" is not one of "gpt-4o-mini", "gpt-4.1-mini" at "models.triage.modelId" [overlay/value-out-of-bounds]
    at models.triage.modelId
    hint: use one of "gpt-4o-mini", "gpt-4.1-mini", or widen 'from' in the base
```

The model is pinned by the base because the eval baseline, the cost profile and the prompt versions
were all measured against one of those two. A customer does not get to change what was measured.
**The fix** is a listed model, or a base that widens `from` and re-measures.

### A profile that disagrees

```yaml
profile: standard
```

```console
$ aid resolve customers/acme.yaml
customers/acme.yaml: refused for "acme-eu"
customers/acme.yaml: error: the overlay gate rejected "acme-eu": it declares profile "standard", and the resolved specification is "enterprise" [overlay/profile-mismatch]
    at profile
    hint: drop `profile`, or set `profile: standard` in the base spec
```

`profile` on an overlay is a **label to check, not a second source of truth**. It exists so a
customer file that claims to be enterprise while resolving to a standard spec is caught. **The
fix** is to drop the line: the profile comes from the base.

## The artifact, and what happens when the base moves

```console
$ aid resolve customers/acme.yaml --out customers/acme.spec.yaml
wrote customers/acme.spec.yaml (3 overrides applied)
$ aid resolve customers/acme.yaml --check
customers/acme.spec.yaml: ok
```

`--check` is byte comparison, so it belongs in CI next to `aid validate`. When the base changes
underneath a customer, the committed artifact is stale and the check says so:

```console
$ aid resolve customers/acme.yaml --check
customers/acme.spec.yaml: outdated
<spec>: error: "customers/acme.spec.yaml" does not match what "customers/acme.yaml" resolves to [cli/resolve-outdated]
    at customers/acme.spec.yaml
    hint: Run `aid resolve customers/acme.yaml --out customers/acme.spec.yaml` and commit the result.
```

That is the whole point of committing the resolved spec: a base-spec change that silently moved a
customer's region, model or ceiling shows up as a failing check on the customer's pull request,
not as a surprise in production.

## The fleet view

```console
$ aid fleet
1 customer under customers

  customer  profile     models        region          ceiling  status
  acme-eu   enterprise  gpt-4.1-mini  ap-southeast-2  $1.50    ok
```

The report is derived from the repository: the overlay in `customers/`, the base it names, the
gates re-run today, and the ceiling the overlay leaves in place. `ok` means the resolved spec
passes its gates now, not that it passed when it was committed.

The directory argument is a convenience for a repository that keeps overlays in more than one
place -- `aid fleet customers/dist` reads as well:

```console
$ aid fleet customers
1 customer under customers

  customer  profile     models        region          ceiling  status
  acme-eu   enterprise  gpt-4.1-mini  ap-southeast-2  $1.50    ok
```

`--json` emits the same content as one document, for a CI step that wants to fail on the first
`refused` row or post the table as a comment.

## What stays refused, whatever the overlay says

- Removing an eval with `gate.ci: true` (`overlay/removes-eval`).
- Deleting the `gate.ci` flag itself while keeping the eval -- the check is gone either way, and
  the flag is not a value that can be weakened.
- Any path the base did not list, and any path beneath one it did.
- A relaxation of a listed path whose rule does not say `allowWeaken: true`.

`allowWeaken` buys a weaker **value** and nothing more. It is written by the base owner, in the
base repo, in a reviewed diff -- which is what keeps "the customer asked for something looser" a
visible decision instead of a per-customer edit nobody compared.

## What this is not

No hosted control plane, no request proxy, no registry: `aid fleet` reads files and prints a table,
and every gate above runs from `aid validate` in the customer's own CI. If the repository is
deleted, nothing about a deployment is lost.
