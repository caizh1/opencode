# P1 Verification Report

Generated from:

```bash
bun run benchmark:completion-quality -- --mock --dump-prompts --dump-evidence --sample-seed 1234 --sample-prompts 10
```

The benchmark is a mock dry-run. It validates planner, retrieval wiring, prompt dump, and candidate pipeline observability; it is not a live model quality score.

## Plan Kind Distribution

| actualPlanKind | count |
|---|---:|
| c-embedded-code | 50 |
| disabled | 0 |
| comment-to-test | 0 |
| natural-command | 0 |
| comment-symbol-reference | 0 |
| other old plans | 0 |

All benchmark fixtures entered the P1 C embedded planner path. No legacy `ordinary-code`, `body-continuation`, `top-level-declaration`, or `symbol-completion` plan kind appeared in the latest report.

## C Intent Distribution

| actualCIntent | count |
|---|---:|
| member-access | 4 |
| symbol-prefix | 9 |
| call-args | 4 |
| initializer | 4 |
| condition | 4 |
| assignment-rhs | 1 |
| error-path | 4 |
| switch-case | 2 |
| top-level-decl | 4 |
| preprocessor | 1 |
| mmio-register | 2 |
| state-machine | 7 |
| body-statement | 4 |

`latest-report.json` now includes real `state-machine` intent records.

## State-Machine Fixtures

Added or verified real state-machine shapes:

| fixture | shape | actualCIntent |
|---|---|---|
| `generic-c-state-machine-state-assign` | `state = |` | state-machine |
| `embedded-driver-state-machine-ctx-state-assign` | `ctx->state = |` | state-machine |
| `qemu-ufs-state-machine-switch-case` | `switch (ctx->state) { case X: | }` | state-machine |
| `ssd-domain-state-machine-state-prefix` | `if (state == SSD_STATE_|)` | state-machine |

State-like switch-case bodies are classified as `state-machine`; opcode-style switch bodies remain `switch-case`.

## Domain Hints

Domain tokens are hints only. No domain-specific intent exists.

Observed hint records include:

| hint | example fixture | actualCIntent |
|---|---|---|
| ufs | `qemu-ufs-member-access` | member-access |
| nand | `generic-c-nand-domain-hint` | symbol-prefix |
| ftl | `generic-c-ftl-domain-hint` | symbol-prefix |
| rpmb | `generic-c-rpmb-domain-hint` | symbol-prefix |

No `ufs`, `nand`, `ftl`, `rpmb`, or SSD-specific intent value appeared in `latest-report.json`.

## Deterministic Symbol Short-Circuit

`promptKind` distribution:

| promptKind | count |
|---|---:|
| qwen-fim | 41 |
| deterministic-symbol | 9 |

Deterministic short-circuit cases:

| fixture | intent |
|---|---|
| `embedded-driver-symbol-prefix` | symbol-prefix |
| `generic-c-symbol-prefix` | symbol-prefix |
| `generic-c-mmio-register` | symbol-prefix |
| `generic-c-nand-domain-hint` | symbol-prefix |
| `generic-c-ftl-domain-hint` | symbol-prefix |
| `generic-c-rpmb-domain-hint` | symbol-prefix |
| `qemu-ufs-symbol-prefix` | symbol-prefix |
| `qemu-ufs-mmio-register` | symbol-prefix |
| `ssd-domain-symbol-prefix` | symbol-prefix |

All other 41 fixtures entered Qwen FIM and current retrieval/evidence wiring. The deterministic path does not bypass `c-embedded-code`; it short-circuits after the plan has already been classified as `c-embedded-code`.

## Retrieval Policy Shape

`retrievalPolicy` is structured data in `latest-report.json`, not a plain string. Example:

```json
{
  "label": "c-member-access",
  "intent": "member-access",
  "queryMode": "c-embedded-intent",
  "preferredKinds": ["field", "type", "function", "global"]
}
```

P2 can consume `label`, `intent`, `queryMode`, and `preferredKinds` directly without parsing an opaque string.

## Verification

Passed:

```bash
bun test
bun run compile
bun run package
```

No hard gate was added. Prompt generation and retrieval strategy were not changed.
