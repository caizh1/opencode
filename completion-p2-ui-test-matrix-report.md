# P2 UI Test Matrix Report

generatedAt: 2026-06-07T01:42:14.520Z

source workspace: `/Users/archer/Work/qemu`

matrix output: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui`

## Goal

验证 P2 intent-driven evidence builder 在真实 VS Code inline completion UI 中是否真的生效，而不是只在 benchmark/mock/dry-run 中出现。

核心验收信号不是模型输出是否偶然可用，而是 `p2-codegraph-on` 变体中是否出现 `c-*` evidence kind，例如 `c-base-type`、`c-struct-definition`、`c-call-example`、`c-error-labels`、`c-state-machine`、`c-register-macro`。

## Matrix Design

| variant | codegraph | purpose |
|---|---|---|
| `baseline-codegraph-off` | off | 真实 direct Qwen UI 补全 baseline，只看 prefix/open-tab/include 等旧上下文 |
| `p2-codegraph-on` | on | 先触发 QEMU codegraph rebuild，再跑同一组场景，观察 P2 `c-*` evidence 是否进入 UI prompt |

场景覆盖：

| category | count |
|---|---:|
| QEMU P2 member-access | 2 |
| QEMU P2 call-args | 2 |
| QEMU P2 initializer | 2 |
| QEMU P2 error-path | 2 |
| QEMU P2 state-machine | 2 |
| QEMU P2 mmio-register | 2 |

运行命令：

```sh
bun run ui:completion-c-embedded -- --qemu-p2-matrix --source-workspace /Users/archer/Work/qemu --scenario-limit 12 --restore-after-each
```

## Actual Result

| variant | scenarios | inline returned | accepted/applied | c-* evidence scenarios | c-* evidence rows | selected evidence avg |
|---|---:|---:|---:|---:|---:|---:|
| `baseline-codegraph-off` | 12 | 8 | 1 | 0 | 0 | 0.00 |
| `p2-codegraph-on` | 12 | 10 | 2 | 0 | 0 | 0.00 |

`p2-codegraph-on` 确认完成了 QEMU codegraph indexing：

```text
[codegraph] indexed 5000 file(s), 51984 function(s) (truncated) into 243 shard(s)
```

但是 `p2-codegraph-on` 的 UI completion telemetry 中没有任何 `c-*` evidence：

```text
p2 c-* evidence scenarios: 0
p2 c-* evidence rows: 0
p2 evidence kinds: none
```

## Interpretation

这次 UI 矩阵证明了三件事：

1. VS Code UI 路径确实跑了真实 direct Qwen inline completion。
2. QEMU codegraph 在 P2 变体中确实完成索引。
3. P2 evidence builder 的 `c-*` evidence 没有进入真实 UI completion prompt。

所以当前不能把 `p2-codegraph-on` 的 inline returned/accepted 变化解释为 P2 evidence 的质量提升。它更像是真实模型/缓存/UI 接受稳定性的自然波动。

## Notable Rows

| fixture | actual plan | actual intent | retrieval | evidence kinds |
|---|---|---|---|---|
| `P2-initializer-1` | `c-embedded-code` | `initializer` | `none` | `current-prefix, open-tab` |
| `P2-mmio-register-2` | `c-embedded-code` | `error-path` | `graph-only` | `current-prefix, open-tab` |
| `P2-state-machine-1` | `disabled` | none | `none` | none |
| `P2-member-access-1` | `ordinary-code` | `top-level-decl` | `none` | `current-prefix, include, open-tab` |

## Artifacts

- comparison report: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui/qemu-p2-ui-comparison-report.md`
- summary JSON: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui/qemu-p2-ui-summary.json`
- P2 UI report: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui/p2-codegraph-on/qemu-ui-report.md`
- P2 raw Output copy: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui/p2-codegraph-on/qemu-output-copy.txt`
- baseline UI report: `/Users/archer/Work/opencode/.completion-quality/qemu-p2-ui/baseline-codegraph-off/qemu-ui-report.md`

## Next Fix Plan

- Verify why `completion-c-embedded-evidence` trace is absent in UI telemetry even when `planKind=c-embedded-code`.
- Check whether `retrieveCompletionAnalysisEvidence()` is called for direct Qwen FIM UI route.
- Check whether `completionEvidenceQuestion()` returns an intent question for P2 intents in this route.
- Check whether `buildCEmbeddedCompletionEvidence()` returns empty for real QEMU cursor contexts or its output is dropped before `completion-context`.
- Add one focused UI/debug fixture for `initializer` at `backends/cryptodev-vhost-user.c` and require `c-struct-definition` or `c-initializer-example` to appear before treating P2 as effective.
