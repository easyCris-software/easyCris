# LMM Simple Effects Dialog Design

**Goal:** Give LMM a distinct user-facing simple-effects dialog so users do not see ANOVA-specific wording during the LMM flow.

## Problem

The current LMM flow reuses `MultiFactorialSimpleEffectsDialog` directly. The controller behavior is correct, but the dialog title, description, and educational copy are framed as multi-factorial ANOVA, which is misleading in an LMM workflow.

## Design

Create a shared internal dialog body for simple-effects selection, then wrap it with two thin user-facing components:

- `MultiFactorialSimpleEffectsDialog`
- `LmmSimpleEffectsDialog`

Both wrappers will share:

- factor pair generation
- enabled-pair state
- optional adjustment controls
- confirmation payload shape

The LMM wrapper will provide:

- LMM-specific title
- LMM-specific description
- LMM-specific explanatory copy

The multifactorial wrapper keeps the current ANOVA wording.

## Scope

In scope:

- split the user-facing dialog components
- keep the same controller/service contract
- preserve `testIdPrefix` behavior
- keep LMM adjustment controls hidden in the follow-up dialog

Out of scope:

- backend changes
- simple-effects payload changes
- controller orchestration changes

## Testing

- Add a failing UI test proving the LMM path renders LMM-specific title/copy.
- Keep/verify a multifactorial dialog test so ANOVA wording is preserved.
- Re-run affected controller and typecheck suites.
