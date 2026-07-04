# ChipMate Live VS Code System Tests

This folder contains the first product-level system test harness for ChipMate.
It targets the installed VS Code extension, not the development extension host.

Commands:

```bash
bun run test:system:doctor
bun run test:system:inventory
bun run test:system:smoke
bun run test:system:full
bun run test:system:soak
bun run test:system:ui-smoke
bun run test:system:ui-full
bun run test:system:ui-visual
bun run test:system:report
```

Modes:

- `doctor` checks the local VS Code, installed ChipMate extension, user profile,
  globalStorage, and macOS automation prerequisites.
- `inventory` reads package contributions plus the system case catalog and emits
  a feature coverage matrix.
- `smoke` runs non-destructive checks against the real profile.
- `full` runs automated cases in a cloned profile with fixture workspaces.
- `soak` repeats the automated full subset for lifecycle and log-stability
  evidence.
- `ui-smoke` runs the currently automated user-facing UI gates and writes the
  UI matrix evidence.
- `ui-full` emits the full user-level UI acceptance matrix and marks gaps that
  still need DOM/click automation as `planned`.
- `ui-visual` focuses on Liquid Glass, icon layout, tooltip/aria, responsive
  width, and visual-overlap oracles.

Reports are written under `test/live-vscode/reports/` and redact API keys,
tokens, home paths, and configured sensitive values.

Important report files:

- `inventory.json` / `inventory.md`: package command/settings inventory plus
  system and UI coverage matrices.
- `ui-matrix.json` / `ui-matrix.md`: user-level UI cases with scenario, steps,
  expected result, boundaries, oracle type, allowed failures, and evidence.
- `ui-visual-contract.json`: static visual contract checks for Liquid Glass
  markers, icon-button labels, and normal-flow icon layout.
- `ui-visual-summary.json`: visual/accessibility coverage accounting, including
  how many UI cases remain planned.
- `globalStorage-summary.json`, `codegraph-summary.json`, `rag-summary.json`:
  storage evidence without dumping source or vector contents.

The first full-system baseline is allowed to contain `planned` cases. A planned
case is not a pass; it is a tracked acceptance gap with a defined user scenario
and oracle. Replace planned UI cases with DOM/click automation as the runner
gains deeper VS Code webview access.
