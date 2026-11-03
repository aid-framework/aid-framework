/**
 * Managed guardrails, spliced into every AWS module that runs the app.
 *
 * A guardrail is per service and belongs beside the compute that calls it, so it is a
 * fragment each module includes rather than a module of its own. The policies arrive as a
 * tfvar and the resources loop over it, which is what keeps the module plan-independent:
 * `tofu validate` sees one shape whether the plan carries one guardrail or none.
 *
 * `ApplyGuardrail` is a runtime call, not a provisioning one, so the compute role is
 * granted exactly that and nothing else. The app is wired to the numbered version because
 * `DRAFT` keeps changing under a running deployment.
 */

/**
 * The inputs each module declares. `guardrails` carries only services whose spec names
 * both the engine and the policy; a service that names the engine alone leaves the
 * guardrail to its operator, so there is nothing here to provision for it.
 */
export const GUARDRAIL_VARIABLES = [
  '',
  'variable "guardrails" {',
  '  description = "Managed guardrails to provision, keyed by service id. Empty means no service owns one."',
  '  type = map(object({',
  '    id      = string',
  '    message = string',
  '    content = list(object({ type = string, strength = string }))',
  '    topics  = list(object({ name = string, definition = string }))',
  '    words   = list(string)',
  '    pii     = list(object({ type = string, action = string }))',
  '  }))',
  '  default = {}',
  '}',
];

/**
 * The local the resources loop over. Filtering to this module's own services matters
 * because every module receives the same tfvar: without it, a plan with a serverless and
 * a container service would create the guardrail twice.
 */
export function guardrailLocals(servicesLocal: string): string[] {
  return [
    '',
    '  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.',
    '  managed_guardrails = {',
    '    for id, guardrail in var.guardrails : id => guardrail',
    `    if contains(keys(local.${servicesLocal}), id) && contains(local.${servicesLocal}[id].guardrail_engines, "bedrock")`,
    '  }',
  ];
}

/**
 * The provisioning resources, appended beside the compute that calls them.
 *
 * `roleRef` is the full HCL reference to the compute role, because the modules spell it
 * differently: serverless and container key their role by service, while batch runs every
 * job under one task role and indexes it by count.
 */
export function guardrailResources(roleRef: string): string[] {
  return [
    '',
    '# The spec names filters and strengths, never a vendor enum -- `aid infra gen` maps them',
    '# once, so this resource reads like the policy the author wrote.',
    'resource "aws_bedrock_guardrail" "managed" {',
    '  for_each = local.managed_guardrails',
    '',
    '  # A guardrail name caps at 50 characters and allows letters, digits, hyphens and',
    '  # underscores; `local.name` is already sanitised, so only the cap is left.',
    '  name = substr("@{local.name[each.key]}-guardrail", 0, 50)',
    '',
    '  description               = each.value.message',
    '  blocked_input_messaging   = each.value.message',
    '  blocked_outputs_messaging = each.value.message',
    '',
    '  dynamic "content_policy_config" {',
    '    for_each = length(each.value.content) > 0 ? [1] : []',
    '    content {',
    '      dynamic "filters_config" {',
    '        for_each = each.value.content',
    '        content {',
    '          type            = filters_config.value.type',
    '          input_strength  = filters_config.value.strength',
    '          output_strength = filters_config.value.strength',
    '        }',
    '      }',
    '    }',
    '  }',
    '',
    '  dynamic "topic_policy_config" {',
    '    for_each = length(each.value.topics) > 0 ? [1] : []',
    '    content {',
    '      dynamic "topics_config" {',
    '        for_each = each.value.topics',
    '        content {',
    '          name       = topics_config.value.name',
    '          definition = topics_config.value.definition',
    '          type       = "DENY"',
    '        }',
    '      }',
    '    }',
    '  }',
    '',
    "  # Only the author's own words, never a managed list: adding one here would block",
    '  # vocabulary the spec did not ask for.',
    '  dynamic "word_policy_config" {',
    '    for_each = length(each.value.words) > 0 ? [1] : []',
    '    content {',
    '      dynamic "words_config" {',
    '        for_each = each.value.words',
    '        content {',
    '          text = words_config.value',
    '        }',
    '      }',
    '    }',
    '  }',
    '',
    '  dynamic "sensitive_information_policy_config" {',
    '    for_each = length(each.value.pii) > 0 ? [1] : []',
    '    content {',
    '      dynamic "pii_entities_config" {',
    '        for_each = each.value.pii',
    '        content {',
    '          type   = pii_entities_config.value.type',
    '          action = pii_entities_config.value.action',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
    '# A guardrail is mutable and every change mints a new immutable version, so the app is',
    '# pinned to this one. Pointing it at DRAFT would let a later edit change a live',
    '# deployment without a plan.',
    'resource "aws_bedrock_guardrail_version" "managed" {',
    '  for_each      = local.managed_guardrails',
    '  guardrail_arn = aws_bedrock_guardrail.managed[each.key].guardrail_arn',
    '  description   = "Published by aid infra gen from the spec."',
    '}',
    '',
    "# Evaluating a guardrail is the app's job; provisioning it is this module's. Scoping the",
    '# grant to the ARN means a compromised function cannot apply or edit another guardrail.',
    'resource "aws_iam_role_policy" "guardrail" {',
    '  for_each = local.managed_guardrails',
    '  name     = substr("@{local.name[each.key]}-guardrail", 0, 64)',
    `  role     = ${roleRef}`,
    '',
    '  policy = jsonencode({',
    '    Version = "2012-10-17"',
    '    Statement = [{',
    '      Effect   = "Allow"',
    '      Action   = ["bedrock:ApplyGuardrail"]',
    '      Resource = [aws_bedrock_guardrail.managed[each.key].guardrail_arn]',
    '    }]',
    '  })',
    '}',
  ];
}
