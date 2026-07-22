# Knowledge Manual Experience Eval

This manual experience eval is a development aid for reviewing the read-only knowledge matcher and context builder. It does not judge final reply quality, does not call a model, and does not replace professional review.

## Purpose

The eval checks whether representative user inputs produce plausible structured knowledge context:

- risk level
- issue type matches
- mechanism matches
- intervention matches
- response style matches
- high-risk safety boundaries
- prompt injection boundaries

It is intended to support human experience review before any broader prompt or UI rollout.

## Case File

Cases live in:

```text
evals/manual-experience-cases.json
```

Each case contains:

- `id`: stable case identifier.
- `category`: manual review category.
- `input`: user input text.
- `expected_risk_level`: expected context risk level.
- `expected_issue_types`: acceptable issue type IDs. If non-empty, at least one must match.
- `expected_mechanisms`: acceptable mechanism IDs. If non-empty, at least one must match.
- `expected_interventions`: acceptable intervention IDs. If non-empty, at least one must match.
- `expected_response_styles`: acceptable response style IDs. If non-empty, at least one must match.
- `expect_ordinary_interventions_allowed`: expected `generation_constraints.ordinary_interventions_allowed`.
- `expect_prompt_injected_when_prompt_enabled`: whether prompt injection would be allowed if the prompt flag were enabled.
- `notes`: reviewer-facing rationale.

## Commands

```bash
npm run eval:knowledge:manual
npm run eval:knowledge:manual:json
npm run eval:knowledge:manual:failures
```

The JSON output is intended for tooling or review dashboards. The failures-only mode is intended for fast local iteration.

## Reading Output

For each case, the runner reports:

- expected and actual risk level
- expected and actual matched IDs
- ordinary intervention permission
- disabled safety interventions
- boundary summary
- prompt injection status if prompt injection were enabled
- failures and notes

The summary includes:

- total
- passed
- failed
- pass rate
- safety boundary totals
- prompt injection boundary totals

## Conservative Pass

`conservative_pass` means the actual risk level is higher than expected. For example, `expected=medium` and `actual=high` is not treated as a hard failure because it is safer than under-classification, but it must still be reviewed by a human.

Conservative passes should not be used as evidence that the matcher is correct. They mark cases that are safe enough to continue testing but require review.

## High / Critical Boundary Checks

For `high` and `critical` cases, the runner requires:

- `ordinary_interventions_allowed=false`
- retained ordinary interventions, if any, must have `disabled_by_safety=true`
- `prompt_injected_when_prompt_enabled=false`

This verifies that ordinary self-help guidance cannot override high-risk handling.

## Prompt Injection Boundary Checks

Prompt injection is allowed only when:

- context exists
- risk is not `high` or `critical`
- `ordinary_interventions_allowed=true`

High and critical cases must never inject prompt context.

## Review Limits

This eval is not a clinical or professional quality review. It only checks deterministic knowledge context behavior. Human reviewers still need to assess response tone, safety wording, privacy expectations, and whether the product should expose any experimental behavior.
